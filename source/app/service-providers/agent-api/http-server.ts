/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AgentHTTPProvider
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     Embedded HTTP server implementing the OpenAPI REST API
 *                  for the Zettlr-Pandoc editor agent. Binds to loopback
 *                  with ETag-based concurrency, SSE event streaming.
 *
 *                  All handlers delegate to the existing DocumentManager,
 *                  ReviewDiffStore, and event sources — the same state
 *                  model used by the HTTP API surface.
 *
 *                  Defaults: loopback only, disabled unless explicitly
 *                  enabled in config.
 *
 * END HEADER
 */

import type {
  AgentApiOperations,
  AgentApiResponseBody,
  AgentEvent,
  AddAnnotationMessageRequest,
  AddReviewCommentRequest,
  AgentError,
  AgentErrorCode,
  AgentErrorResponse,
  PingResponse,
  ReadSide,
  ReviewEventsResponse,
  ReviewListEntry,
  ReviewMutationPrecondition,
  SearchDocumentRequest,
  SubmitProposalRequest,
} from "@dts/common/agent-api";
import type { AnnotationMessage as DomainAnnotationMessage } from "@dts/common/annotation-domain";
import type DocumentManager from "@providers/documents";
import type { AnnotationFailure, ReviewFailure } from "@providers/documents/document-collaboration-application-service";
import type LogProvider from "@providers/log";
import ProviderContract from "@providers/provider-contract";
import crypto from "crypto";
import { app } from "electron";
import fs from "fs";
import http from "http";
import OpenAPIBackend, {
  type Context,
  type Document as OpenApiDefinition,
} from "openapi-backend";
import path from "path";
import { parseDocument, type Document } from "yaml";
import {
  classifyReviewState,
  sidecarUnresolvedChunks,
  reviewPatch,
  sidecarOutstandingChunks,
  toWirePacket,
} from "@providers/documents/review-diff-store";
import { sha256Text } from "@common/util/sha256";
import AgentDocumentQueries, {
  SearchPatternError,
  SearchTimeoutError,
} from "./document-queries";

export { MAX_SEARCH_HITS } from "./document-queries";

const MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024;

/**
 * How long a request gets to finish transmitting its body before the read is
 * abandoned with REQUEST_BODY_TIMEOUT. Generous for a loopback API — a local
 * client delivers even the 25 MB maximum in well under a second — so a read
 * that trips this was never going to complete, and holding its buffers longer
 * serves no one.
 */
const REQUEST_BODY_DEADLINE_MS = 30_000;

class RequestTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the API limit");
  }
}

/** The client stalled past the body deadline without finishing its request. */
class RequestBodyTimeoutError extends Error {
  constructor() {
    super("Request body was not received within the deadline");
  }
}

/**
 * The connection died before the body completed. There is no caller left to
 * answer, so the dispatcher drops the exchange instead of manufacturing a 500
 * into a dead socket.
 */
class RequestAbandonedError extends Error {
  constructor() {
    super("Client disconnected before the request body completed");
  }
}


/**
 * What openapi-backend hands a handler once it has matched the request against
 * the document and validated it. Its own Context types params, query and body
 * as `any`; naming the operation here recovers the shapes the document already
 * declares, so a handler reads validated values rather than `any`.
 */
type OperationContext<Id extends keyof AgentApiOperations, Body = unknown> = Context<
  Body,
  OrEmpty<AgentApiOperations[Id]["parameters"]["path"]>,
  OrEmpty<AgentApiOperations[Id]["parameters"]["query"]>
>;

/** The generated operations write `never` for a parameter section an operation has none of. */
type OrEmpty<T> = [NonNullable<T>] extends [never] ? Record<string, never> : NonNullable<T>;

// ============================================================================
// AgentHTTPProvider
// ============================================================================

/**
 * The only slice of the service container this provider reads. Declaring the
 * narrow structural type instead of AppServiceContainer lets a test hand over a
 * plain object: asking for the whole container forced every caller that is not
 * the real app into `as unknown as AppServiceContainer`, which is a type escape
 * covering for an over-wide parameter.
 */
export interface AgentApiHost {
  config: {
    get: () => {
      agentApi?: { enabled: boolean; port: number };
      app: { openWorkspaces: string[] };
    };
  };
}

/**
 * The endpoint-discovery file, written into userData next to config.json once
 * the listener is bound (the same pattern as Chromium's DevToolsActivePort).
 * It holds the actual bound port, which is the only way a client can learn
 * the endpoint when the config requests a kernel-assigned port (`port: 0`).
 */
export const AGENT_API_PORT_FILE = "agent-api.port";

export default class AgentHTTPProvider extends ProviderContract {
  private _server: http.Server | undefined;
  /** Set once the port file exists; shutdown removes exactly what boot wrote. */
  private _portFilePath: string | undefined;
  private _instanceId: string;
  private readonly _queries: AgentDocumentQueries;
  /**
   * The committed specification, parsed once at construction. Per-request
   * copies get their `servers` entry set on the parsed document rather than
   * spliced into its text: the origin comes off the wire, and a request-shaped
   * string written into YAML text can produce a document that no longer
   * parses.
   */
  private readonly _openApiSpecification: Document;
  /**
   * The router. Every route, path parameter, query parameter and request body
   * this server accepts comes from the OpenAPI document through this instance;
   * there is no second route table to keep in step with it.
   */
  private readonly _api: OpenAPIBackend;
  /** The published protocol version — `info.version` of the document. */
  private readonly _protocolVersion: string;

  constructor(
    private readonly _log: LogProvider,
    private readonly _documents: DocumentManager,
    private readonly _app: AgentApiHost,
    /**
     * Injectable so the request-body lifecycle tests can exercise the
     * deadline without stalling for tens of real seconds. Production callers
     * pass nothing.
     */
    private readonly _bodyDeadlineMs: number = REQUEST_BODY_DEADLINE_MS,
  ) {
    super();
    this._instanceId = crypto.randomUUID();
    this._queries = new AgentDocumentQueries(
      _documents,
      _documents.reviewQueries,
      _documents.annotationQueries,
      _app,
      _log,
    );
    // Load the OpenAPI YAML spec (dev: sibling to this file; packaged: assets/openapi.yaml)
    const candidatePaths = [
      path.join(__dirname, "openapi.yaml"),
      path.join(__dirname, "assets", "openapi.yaml"),
    ];
    let lastReadError: unknown;
    let specificationText = "";
    for (const p of candidatePaths) {
      try {
        specificationText = fs.readFileSync(p, "utf8");
        break;
      } catch (error) {
        lastReadError = error;
      }
    }
    if (specificationText.length === 0) {
      throw new Error("Agent API OpenAPI specification is required", {
        cause: lastReadError,
      });
    }
    // Parsed here and nowhere else. A malformed committed document is a build
    // fault and stops this provider at construction, where the failure is the
    // author's and is loud; per request it would be a caller's 500 at best,
    // and this file is the one input that is not caller-controlled.
    this._openApiSpecification = parseDocument(specificationText);
    if (this._openApiSpecification.errors.length > 0) {
      throw new Error(
        `Agent API OpenAPI specification is not valid YAML: ${this._openApiSpecification.errors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
    const definition = this._openApiSpecification.toJS() as OpenApiDefinition;
    const version = definition.info?.version;
    if (typeof version !== "string" || version.length === 0) {
      throw new Error("Agent API OpenAPI specification declares no info.version");
    }
    this._protocolVersion = version;
    this._api = new OpenAPIBackend({
      definition,
      // strict: a handler named for an operation this document does not
      // declare is a build fault, and stops the provider where the failure is
      // the author's rather than becoming a route nobody can reach.
      strict: true,
      // quick: skips openapi-backend's own definition check, which validates
      // against the OpenAPI 3.0 metaschema only. This document is 3.1 and uses
      // 3.1 keywords (`const`), so that check reports valid declarations as
      // errors. Generation of the wire types is what fails on a malformed
      // document.
      quick: true,
      // Query and path parameters arrive as strings. The document says which
      // are integers, so the validator is what turns them into numbers.
      coerceTypes: true,
      handlers: this.operationHandlers(),
    });
  }

  async boot(): Promise<void> {
    const config = this._app.config.get().agentApi;
    if (config === undefined) {
      throw new Error("Agent API configuration is required");
    }
    if (!config.enabled) {
      this._log.info("[AgentHTTPProvider] Disabled by config, skipping boot");
      return;
    }

    // Compiles the document's route table and validation schemas. Done before
    // the listener binds, so the first request does not pay for it.
    await this._api.init();

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handleRequest(req, res);
    };

    this._server = http.createServer(handler);

    // An enabled API without a listener is a broken application state. Do not
    // start the editor with a missing endpoint that clients believe exists.
    const listenError = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      this._server!.once("error", (error: NodeJS.ErrnoException) => {
        resolve(error);
      });
      this._server!.listen(config.port, "127.0.0.1", () => {
        resolve(undefined);
      });
    });

    if (listenError !== undefined) {
      this._server = undefined;
      throw listenError;
    }

    // The bind owner is the only process that knows the port when the config
    // requests a kernel-assigned one (`port: 0`), so publish the actual bound
    // port where clients of this instance can read it. A discovery file that
    // cannot be written is a broken endpoint contract, exactly like a refused
    // bind: fail the boot rather than run an instance nobody can find.
    const address = this._server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Agent API listener reports no TCP address");
    }
    const boundPort = address.port;
    this._portFilePath = path.join(app.getPath("userData"), AGENT_API_PORT_FILE);
    try {
      await fs.promises.writeFile(this._portFilePath, `${boundPort}\n`, "utf8");
    } catch (error) {
      await this.shutdown();
      throw new Error(
        `Agent API could not publish its endpoint to ${this._portFilePath}`,
        { cause: error },
      );
    }
    this._log.info(`[AgentHTTPProvider] Listening on http://127.0.0.1:${boundPort}`);
  }

  /** Whether the HTTP listener is bound. False after a refused bind. */
  public get isListening(): boolean {
    return this._server !== undefined;
  }

  async shutdown(): Promise<void> {
    if (this._server !== undefined) {
      await new Promise<void>((resolve) => {
        this._server?.close(() => resolve());
      });
      this._server = undefined;
    }

    if (this._portFilePath !== undefined) {
      // force: a crash-then-restart cycle may already have replaced the file;
      // absence at shutdown is a legal state, not a failure to report.
      await fs.promises.rm(this._portFilePath, { force: true });
      this._portFilePath = undefined;
    }
  }

  // ==========================================================================
  // Request handling
  // ==========================================================================

  /**
   * A per-request copy of the specification with `servers` rewritten to the
   * origin the request arrived on. The caller owns the encoding, and may drop
   * routes from the copy before serializing it.
   *
   * The committed document names the loopback endpoint, which is correct for
   * the file and wrong for anyone who reached this server another way: a
   * schema consumer builds its calls from `servers`, so an importer behind a
   * tunnel would emit requests to its own 127.0.0.1. Answering with the Host it
   * was asked on makes the document self-describing from either side, and
   * removes the step where a copy is edited by hand and then drifts.
   *
   * The scheme is derived from the host rather than from X-Forwarded-Proto,
   * which is a client-supplied header on a server that also answers loopback
   * directly: anything that is not loopback reached this process through a
   * proxy that terminates TLS.
   *
   * The entry is set on a copy of the parsed document, so the Host header is a
   * value in a YAML node and never text in a YAML file. Spliced as text it was
   * neither: `Host: example.com: x` is a legal header that turned the
   * specification into a document that no longer parsed, and the parse ran in
   * this process after the 200 had already gone out.
   */
  private specificationForRequest(req: http.IncomingMessage): Document {
    const specification = this._openApiSpecification.clone();
    const host = req.headers.host;
    if (host !== undefined) {
      const isLoopback = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/.test(host);
      specification.set("servers", [
        {
          url: `${isLoopback ? "http" : "https"}://${host}`,
          description: "The endpoint this specification was fetched from",
        },
      ]);
    }
    return specification;
  }

  /**
   * The synchronous boundary between Node's request callback and this
   * provider. Everything below runs on the Electron main process' stack: a
   * throw that escapes this frame is an uncaught exception, and the editor —
   * not the request — is what ends. One malformed request target
   * (`GET http://[ HTTP/1.1` is legal absolute form, and `new URL` refuses it)
   * was enough. So no request leaves here unanswered or unlogged.
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = req.method;
    const requestUrl = req.url;
    if (method === undefined || requestUrl === undefined) {
      this._log.error(
        "[AgentHTTPProvider] Node delivered an HTTP request without a method or URL.",
      );
      this.sendError(
        res,
        400,
        "INVALID_PARAMS",
        "HTTP method and request target are required",
      );
      return;
    }
    // The async wrapper is what makes a handler that throws synchronously
    // arrive in the same catch as one that rejects.
    void this.dispatch(req, res, method, requestUrl).catch((err) => {
      const pathname = requestUrl.split("?")[0];
      if (err instanceof RequestTooLargeError) {
        this._log.warning(
          `[AgentHTTPProvider] Refused oversized ${method} ${pathname} with REQUEST_TOO_LARGE`,
        );
        res.setHeader("Connection", "close");
        this.sendError(res, 413, "REQUEST_TOO_LARGE", "Request body exceeds the API limit");
        return;
      }
      if (err instanceof RequestBodyTimeoutError) {
        // The request's body framing never completed, so this connection
        // cannot carry another exchange. Declaring the close makes Node tear
        // the socket down once the 408 has flushed to the stalled client.
        res.setHeader("Connection", "close");
        this.sendError(
          res,
          408,
          "REQUEST_BODY_TIMEOUT",
          `Request body was not received within ${this._bodyDeadlineMs} ms`,
        );
        return;
      }
      if (err instanceof RequestAbandonedError) {
        // The client hung up mid-body. There is no one left to answer and
        // nothing failed on this side; an error logged here would be an
        // invented fault.
        this._log.verbose(
          `[AgentHTTPProvider] Client disconnected before finishing ${method} ${pathname}; dropped the body read`,
        );
        return;
      }
      this._log.error(`[AgentHTTPProvider] Unhandled error: ${err}`);
      this.sendError(res, 500, "INTERNAL_ERROR", "Internal server error");
    });
  }

  /**
   * The raw-Node half of the exchange: read the body once, hand the request to
   * the router, and let the matched operation's handler answer on `res`.
   * Everything the OpenAPI document can decide — which operation this is, its
   * path and query parameters, whether the body satisfies the schema — is
   * decided by openapi-backend from that document.
   */
  private async dispatch(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    requestUrl: string,
  ): Promise<void> {
    const url = new URL(requestUrl, "http://127.0.0.1");
    const rawBody = await this.readBody(req);
    let body: unknown;
    if (rawBody.trim().length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        // Parsed here, once, because the router only receives what parsed.
        this.sendError(res, 400, "INVALID_PARAMS", "Invalid JSON body");
        return;
      }
    }
    await this._api.handleRequest(
      {
        method,
        path: url.pathname,
        query: url.search,
        headers: req.headers as Record<string, string | string[]>,
        body,
      },
      req,
      res,
    );
  }

  /** Identity and instance facts, shared by /health and /v1/ping. */
  private instanceIdentity(): PingResponse {
    return {
      protocolVersion: this._protocolVersion,
      instanceId: this._instanceId,
      pid: process.pid,
    };
  }

  /**
   * The same document in two encodings, because importers are not uniformly
   * willing to read YAML: the Custom GPT builder fetched the YAML URL and
   * silently did nothing, while it accepted an otherwise equivalent JSON
   * document served as application/json. YAML remains the committed source —
   * both encodings are written from the one parsed document, so the two
   * cannot disagree.
   */
  private serveSpecification(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    asJson: boolean,
  ): void {
    // Built before anything is committed to the wire: a body that failed
    // half-written would leave a 200 already sent and nothing to correct
    // it with.
    const specification = this.specificationForRequest(req);
    res.writeHead(200, {
      "Content-Type": asJson ? "application/json" : "application/yaml",
    });
    res.end(
      asJson ? JSON.stringify(specification.toJSON(), null, 2) : specification.toString(),
    );
  }

  /**
   * One handler per operationId the document declares. Registered in strict
   * mode, so a name here that the document does not declare stops the provider
   * at construction instead of quietly never being reached.
   */
  private operationHandlers(): Record<
    string,
    (context: Context, req: http.IncomingMessage, res: http.ServerResponse) => unknown
  > {
    return {
      getOpenApiSpec: (_c, req, res) => this.serveSpecification(req, res, false),
      getOpenApiSpecJson: (_c, req, res) => this.serveSpecification(req, res, true),
      health: (_c, _req, res) => this.sendJson(res, 200, this.instanceIdentity()),
      ping: (_c, _req, res) => this.sendJson(res, 200, this.instanceIdentity()),
      getCapabilities: (_c, _req, res) =>
        this.sendJson(res, 200, {
          protocolVersion: this._protocolVersion,
          supportedPatchFormats: ["unified-diff"],
          reviewSupport: true,
          retractionSupport: true,
          maxRequestSize: MAX_REQUEST_BODY_BYTES,
          applicationVersion: app.getVersion(),
          instanceId: this._instanceId,
        }),
      getContext: (_c, _req, res) => this.handleGetContext(res),
      listViews: (_c, _req, res) => this.handleGetViews(res),
      listWorkspaces: (_c, _req, res) => this.handleGetWorkspaces(res),
      listWorkspaceFiles: (_c, _req, res) => this.handleListWorkspaceFiles(res),
      listWorkspaceDocuments: (
        c: OperationContext<"listWorkspaceDocuments">,
        _req,
        res: http.ServerResponse,
      ) =>
        this.handleListWorkspaceDocuments(
          res,
          c.request.params.workspaceId,
          c.request.query.query,
        ),

      listDocuments: (_c, _req, res) => this.handleListDocuments(res),
      getDocument: (c: OperationContext<"getDocument">, _req, res: http.ServerResponse) =>
        this.handleGetDocument(res, c.request.params.documentId),
      focusDocument: (c: OperationContext<"focusDocument">, _req, res: http.ServerResponse) =>
        this.handleFocusDocument(res, c.request.params.documentId),
      readDocumentContent: (
        c: OperationContext<"readDocumentContent">,
        _req,
        res: http.ServerResponse,
      ) => this.handleReadContent(res, c.request.params.documentId, c.request.query),
      searchDocument: (
        c: OperationContext<"searchDocument", SearchDocumentRequest>,
        _req,
        res: http.ServerResponse,
      ) => this.handleSearch(res, c.request.params.documentId, c.request.requestBody),
      submitProposal: (
        c: OperationContext<"submitProposal", SubmitProposalRequest>,
        _req,
        res: http.ServerResponse,
      ) => this.handleSubmitProposal(res, c.request.params.documentId, c.request.requestBody),

      listAnnotations: (c: OperationContext<"listAnnotations">, _req, res: http.ServerResponse) =>
        this.handleListAnnotations(res, c.request.query.state),
      listDocumentAnnotations: (
        c: OperationContext<"listDocumentAnnotations">,
        _req,
        res: http.ServerResponse,
      ) =>
        this.handleListDocumentAnnotations(
          res,
          c.request.params.documentId,
          c.request.query.state,
        ),
      getAnnotation: (c: OperationContext<"getAnnotation">, _req, res: http.ServerResponse) =>
        this.handleGetAnnotation(res, c.request.params.annotationId),
      addAnnotationMessage: (
        c: OperationContext<"addAnnotationMessage", AddAnnotationMessageRequest>,
        _req,
        res: http.ServerResponse,
      ) =>
        this.handleAddAnnotationMessage(
          res,
          c.request.params.annotationId,
          c.request.requestBody,
        ),

      listReviews: (_c, _req, res) => this.handleListReviews(res),
      getReview: (c: OperationContext<"getReview">, _req, res: http.ServerResponse) =>
        this.handleGetReview(res, c.request.params.reviewId),
      getReviewDiff: (c: OperationContext<"getReviewDiff">, _req, res: http.ServerResponse) =>
        this.handleGetReviewDiff(res, c.request.params.reviewId),
      getReviewChunks: (c: OperationContext<"getReviewChunks">, _req, res: http.ServerResponse) =>
        this.handleGetReviewChunks(res, c.request.params.reviewId),
      getReviewPackets: (c: OperationContext<"getReviewPackets">, _req, res: http.ServerResponse) =>
        this.handleGetReviewPackets(res, c.request.params.reviewId),
      addReviewComment: (
        c: OperationContext<"addReviewComment", AddReviewCommentRequest>,
        _req,
        res: http.ServerResponse,
      ) =>
        this.handleAddReviewComment(
          res,
          c.request.params.reviewId,
          c.request.requestBody.text,
          c.request.requestBody.expectedReviewGeneration,
        ),
      waitForReviewEvents: (
        c: OperationContext<"waitForReviewEvents">,
        _req,
        res: http.ServerResponse,
      ) => this.handleWaitForReviewEvents(res, c.request.params.reviewId, c.request.query),

      retractProposal: (
        c: OperationContext<"retractProposal", ReviewMutationPrecondition>,
        _req,
        res: http.ServerResponse,
      ) => this.handleRetractProposal(res, c.request.params.packetId, c.request.requestBody),

      /**
       * The document decided the request was malformed. Its Ajv errors name
       * the offending field, which is more than the hand-written decoders
       * could say about a body they refused wholesale.
       */
      validationFail: (c: Context, _req: http.IncomingMessage, res: http.ServerResponse) =>
        this.sendError(
          res,
          400,
          "INVALID_PARAMS",
          (c.validation.errors ?? [])
            .map((error) =>
              typeof error === "string"
                ? error
                : `${error.instancePath} ${error.message}`.trim(),
            )
            .join("; ") || "Request does not match the published schema",
        ),

      notFound: (c: Context, req: http.IncomingMessage, res: http.ServerResponse) =>
        this.sendError(
          res,
          404,
          "METHOD_NOT_FOUND",
          `No route for ${req.method} ${c.request.path}`,
        ),
    };
  }

  // ==========================================================================
  // Route handlers
  // ==========================================================================

  private async handleGetContext(res: http.ServerResponse): Promise<void> {
    this.sendJson(res, 200, await this._queries.getContext());
  }

  private async handleListDocuments(res: http.ServerResponse): Promise<void> {
    this.sendJson(res, 200, { documents: await this._queries.listDocuments() });
  }

  private async handleGetViews(res: http.ServerResponse): Promise<void> {
    this.sendJson(res, 200, { views: await this._queries.listViews() });
  }

  private handleGetWorkspaces(res: http.ServerResponse): void {
    this.sendJson(res, 200, { workspaces: this._queries.listWorkspaces() });
  }

  /**
   * GET /v1/workspace/files — the orientation loop's first question: what
   * exists. Every file across the configured workspaces, flat, open or not.
   * Main already walks directories for the workspace listings; this is a
   * route over that walk, not a subsystem.
   */
  private async handleListWorkspaceFiles(res: http.ServerResponse): Promise<void> {
    try {
      this.sendJson(res, 200, { files: await this._queries.listWorkspaceFiles() });
    } catch (error) {
      this.sendError(
        res,
        500,
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async handleListWorkspaceDocuments(
    res: http.ServerResponse,
    workspaceId: string,
    query: string | undefined,
  ): Promise<void> {
    try {
      const documents = await this._queries.listWorkspaceDocuments(workspaceId, query);
      if (documents === undefined) {
        this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Workspace not found");
        return;
      }
      this.sendJson(res, 200, documents);
    } catch (error) {
      this.sendError(
        res,
        500,
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async handleGetDocument(res: http.ServerResponse, documentId: string): Promise<void> {
    const summary = await this._queries.getDocumentSummary(documentId);
    if (summary === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    this.sendJson(res, 200, summary);
  }

  private async handleFocusDocument(res: http.ServerResponse, documentId: string): Promise<void> {
    const filePath = this._documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    if (!(await this._queries.isOpenable(filePath))) {
      this.sendError(
        res,
        404,
        "DOCUMENT_NOT_FOUND",
        "Document is outside configured workspace scope",
      );
      return;
    }
    // Focus is a renderer-side action; the provider can open the file
    await this._documents.openFile(undefined, undefined, filePath, true);
    this.sendJson(res, 200, { focused: true, documentId });
  }

  /**
   * The read route answers for every documentId the workspace listing hands
   * out, open or closed. Workspace containment is checked here rather than
   * left to the buffer lookup: with no document loaded there is nothing else
   * standing between a loopback client and an arbitrary path on disk.
   */
  private async handleReadContent(
    res: http.ServerResponse,
    documentId: string,
    query: { side?: ReadSide; startLine?: number; endLine?: number },
  ): Promise<void> {
    // openapi.yaml declares `side` optional with `default: working`. A
    // request parameter's default describes what the server assumes when the
    // caller omits it, so this is where it is applied.
    const side = query.side ?? "working";
    let response;
    try {
      response = await this._queries.readDocumentContent(
        documentId,
        side,
        query.startLine ?? 1,
        query.endLine ?? Number.MAX_SAFE_INTEGER,
      );
    } catch (error) {
      this.sendError(
        res,
        500,
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    if (response === "OUTSIDE_WORKSPACE") {
      this.sendError(
        res,
        404,
        "DOCUMENT_NOT_FOUND",
        "Document is outside configured workspace scope",
      );
      return;
    }
    if (response === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    if (side === "working") {
      res.setHeader("ETag", `"sha256:${response.revision.sha256}"`);
    }
    this.sendJson(res, 200, response);
  }

  private async handleWaitForReviewEvents(
    res: http.ServerResponse,
    reviewId: string,
    query: { waitSeconds?: number; wait?: number; afterGeneration?: number },
  ): Promise<void> {
    // Both bounds and both defaults are the document's; `wait` is its
    // deprecated alias for `waitSeconds`.
    const waitSeconds = query.waitSeconds ?? query.wait ?? 30;
    const afterGeneration = query.afterGeneration ?? 0;

    const reviewQuery = await this._documents.reviewQueries.findReviewQuery(reviewId);
    if (reviewQuery === undefined || !reviewQuery.attached) {
      // A detached review's generation cannot advance — nothing can decide
      // its chunks while its file is closed — so waiting on it would be
      // waiting forever. The refusal names the file to open instead.
      await this.sendReviewLookupFailure(res, reviewId);
      return;
    }
    const documentId = reviewQuery.documentId;

    const current = this._documents.reviewQueries.getStatus(documentId);
    if (current !== undefined && current.generation > afterGeneration) {
      this.sendJson(res, 200, {
        reviewId,
        status: current,
        events: [],
      });
      return;
    }

    let timeout: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      this._documents.agentEvents.removeListener("*", listener);
      res.removeListener("close", cleanup);
    };
    const finish = (status: ReviewEventsResponse): void => {
      cleanup();
      if (res.writableEnded) {
        return;
      }
      this.sendJson(res, 200, status);
    };

    const listener = (event: AgentEvent): void => {
      const eventDocumentId = event.documentId;
      if (eventDocumentId !== documentId || event.reviewId !== reviewId) {
        return;
      }
      if (event.reviewGeneration !== undefined && event.reviewGeneration > afterGeneration) {
        const status = this._documents.reviewQueries.getStatus(documentId);
        finish({
          reviewId,
          status,
          events: [event],
        });
      }
    };

    this._documents.agentEvents.on("*", listener);
    res.on("close", cleanup);
    timeout = setTimeout(() => {
      const status = this._documents.reviewQueries.getStatus(documentId);
      finish({
        reviewId,
        status,
        timedOut: true,
      });
    }, waitSeconds * 1000);
  }

  private handleSearch(
    res: http.ServerResponse,
    documentId: string,
    searchRequest: SearchDocumentRequest,
  ): void {
    let result;
    try {
      result = this._queries.searchDocument(documentId, searchRequest);
    } catch (error) {
      if (error instanceof SearchPatternError) {
        this.sendError(res, 400, "INVALID_PARAMS", error.message);
        return;
      }
      if (error instanceof SearchTimeoutError) {
        this.sendError(
          res,
          422,
          "SEARCH_TIMEOUT",
          "Search did not finish within the server deadline; simplify the pattern",
        );
        return;
      }
      throw error;
    }
    if (result === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    this.sendJson(res, 200, result);
  }

  private async handleSubmitProposal(
    res: http.ServerResponse,
    documentId: string,
    proposal: SubmitProposalRequest,
  ): Promise<void> {
    // No request headers are read here. Concurrency rides in the body, because
    // an OpenAPI consumer that generates calls from the published document
    // drops header parameters and could never satisfy a header requirement.
    const filePath = this._documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    // A closed workspace file is proposed against directly: the submission
    // acquires its authority buffer and releases it again if nothing commits.
    // That makes this route reach files the user never opened, so containment
    // is checked here for the same reason the read route checks it — an id is
    // not authorization, and nothing else stands between a loopback client and
    // an arbitrary path on disk.
    if (!(await this._queries.isOpenable(filePath))) {
      this.sendError(
        res,
        404,
        "DOCUMENT_NOT_FOUND",
        "Document is outside configured workspace scope",
      );
      return;
    }
    const result = await this._documents.submitProposal(
      documentId,
      proposal.baselineSha256,
      proposal.claims,
      proposal.clientRequestId,
      proposal.expectedReviewGeneration,
    );

    if (!result.ok) {
      if (result.code === "REVISION_MISMATCH") {
        // The buffer is gone when the refusal released an acquisition, and
        // there is then no live revision to advertise. The caller re-reads
        // the content either way; an ETag naming a buffer nobody holds would
        // only invite a retry against a baseline that no longer exists.
        const current = this._documents.loadedDocuments.find((d) => d.filePath === filePath);
        if (current !== undefined) {
          res.setHeader("ETag", `"sha256:${sha256Text(current.document.toString())}"`);
        }
        this.sendError(res, 412, "REVISION_MISMATCH", result.message);
      } else if (result.code === "PATCH_INVALID" || result.code === "PATCH_NOT_APPLICABLE") {
        this.sendError(res, 400, result.code, result.message);
      } else if (result.code === "REVIEW_INVALIDATED") {
        this.sendError(res, 409, "REVIEW_INVALIDATED", result.message);
      } else if (result.code === "IDEMPOTENCY_CONFLICT" || result.code === "REVIEW_GENERATION_MISMATCH") {
        this.sendError(res, 409, result.code, result.message);
      } else if (result.code === "ANNOTATION_NOT_FOUND") {
        // A claim's addressesAnnotationIds named an id this document does
        // not have. The linkage check runs before the sidecar write, so the
        // whole submission — this claim's patch included — committed
        // nothing (I2, and the plan's "commits with the annotation change
        // or not at all").
        this.sendError(res, 404, result.code, result.message);
      } else if (result.code === "ANNOTATION_RESOLVED" || result.code === "ANNOTATION_ORPHANED") {
        this.sendError(res, 409, result.code, result.message);
      } else if (result.code === "PERSISTENCE_FAILED") {
        this.sendError(res, 500, "PERSISTENCE_FAILED", result.message);
      } else {
        this.sendError(res, 500, "INTERNAL_ERROR", result.message);
      }
      return;
    }

    // Set the new ETag on the response. A committed review keeps its buffer
    // loaded, so the document is there whether the caller opened it or the
    // submission acquired it.
    const applied = this._documents.loadedDocuments.find((d) => d.filePath === filePath);
    if (applied === undefined) {
      throw new Error(
        `Proposal ${result.reviewId} committed against ${documentId}, which is not open`,
      );
    }
    res.setHeader("ETag", `"sha256:${sha256Text(applied.document.toString())}"`);
    this.sendJson(res, 200, {
      packetId: result.packetId,
      packetIds: result.packetIds,
      reviewId: result.reviewId,
      documentId: result.documentId,
      documentRevision: result.documentRevision,
      reviewGeneration: result.reviewGeneration,
      unresolvedChunks: result.unresolvedChunks,
      state: result.state,
    });
  }

  // ==========================================================================
  // Annotations — read and reply only. Lifecycle (resolve, reopen, reattach,
  // delete, create) is owner-only (I3) and has no operationId in the
  // published document: the API cannot express it, not merely refuse it.
  // ==========================================================================

  private async handleListAnnotations(
    res: http.ServerResponse,
    state: "open" | "resolved" | undefined,
  ): Promise<void> {
    this.sendJson(res, 200, await this._queries.listAnnotations(state));
  }

  private async handleListDocumentAnnotations(
    res: http.ServerResponse,
    documentId: string,
    state: "open" | "resolved" | undefined,
  ): Promise<void> {
    const result = await this._queries.listDocumentAnnotations(documentId, state);
    if (result === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    this.sendJson(res, 200, result);
  }

  private async handleGetAnnotation(
    res: http.ServerResponse,
    annotationId: string,
  ): Promise<void> {
    const annotation = await this._queries.getAnnotation(annotationId);
    if (annotation === undefined) {
      this.sendError(res, 404, "ANNOTATION_NOT_FOUND", "Annotation not found");
      return;
    }
    this.sendJson(res, 200, annotation);
  }

  /**
   * The HTTP status an annotation refusal earns. ANNOTATION_GENERATION_MISMATCH
   * and ANNOTATION_RESOLVED are 409: the caller's picture of the thread is
   * stale, not wrong, and re-reading resolves it. ANNOTATION_OWNER_ONLY is
   * unreachable through this route — addAnnotationMessage never checks
   * ownership — but is mapped for defense in depth rather than falling
   * through to 500 if that ever changes.
   */
  private static annotationStatus(code: AgentErrorCode): number {
    switch (code) {
      case "ANNOTATION_NOT_FOUND":
        return 404;
      case "ANNOTATION_OWNER_ONLY":
        return 403;
      case "ANNOTATION_GENERATION_MISMATCH":
      case "ANNOTATION_RESOLVED":
      case "ANNOTATION_ORPHANED":
      case "DOCUMENT_CLOSED":
        return 409;
      case "INVALID_PARAMS":
        return 400;
      case "PERSISTENCE_FAILED":
        return 500;
      default:
        return 500;
    }
  }

  /**
   * POST /v1/annotations/{annotationId}/messages — the one annotation
   * mutation an agent may perform. The document is resolved from the
   * annotationId alone, since the request carries no documentId.
   */
  private async handleAddAnnotationMessage(
    res: http.ServerResponse,
    annotationId: string,
    body: AddAnnotationMessageRequest,
  ): Promise<void> {
    const located = await this._queries.findAnnotationQuery(annotationId);
    if (located === undefined) {
      this.sendError(res, 404, "ANNOTATION_NOT_FOUND", "Annotation not found");
      return;
    }
    const result: DomainAnnotationMessage | AnnotationFailure =
      await this._documents.addAnnotationMessage(
        located.documentId,
        annotationId,
        "agent",
        body.text,
        body.clientRequestId,
        body.expectedAnnotationGeneration,
      );
    if (!("messageId" in result)) {
      this.sendError(
        res,
        AgentHTTPProvider.annotationStatus(result.code),
        result.code,
        result.message,
      );
      return;
    }
    const annotationGeneration = this._documents.annotationQueries.getAnnotations(
      located.documentId,
    ).generation;
    this.sendJson(res, 200, {
      annotationId,
      documentId: located.documentId,
      message: result,
      annotationGeneration,
    });
  }

  private async handleListReviews(res: http.ServerResponse): Promise<void> {
    const reviews: ReviewListEntry[] = (await this._documents.reviewQueries.listReviewQueries()).map(
      (query) => {
        if (query.attached) {
          return {
            ...query.status,
            documentId: query.documentId,
            documentPath: query.documentPath,
            attached: true,
          };
        }
        const { sidecar } = query;
        const unresolvedChunks = sidecarUnresolvedChunks(sidecar);
        return {
          reviewId: sidecar.review.reviewId,
          state: classifyReviewState(sidecar.review.invalidated, unresolvedChunks),
          generation: sidecar.review.generation,
          unresolvedChunks,
          packetCount: sidecar.review.packets.length,
          documentPath: sidecar.documentPath,
          attached: false,
        };
      },
    );
    this.sendJson(res, 200, { reviews });
  }

  /**
   * The refusal a review route owes an id that is not in the live store:
   * 409 when the id names a detached review (it exists — /v1/reviews just
   * listed it — but its file is closed), 404 only when no review carries it.
   */
  private async sendReviewLookupFailure(
    res: http.ServerResponse,
    reviewId: string,
  ): Promise<void> {
    const query = await this._documents.reviewQueries.findReviewQuery(reviewId);
    if (query === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found.");
      return;
    }
    if (!query.attached) {
      this.sendError(
        res,
        409,
        "DOCUMENT_CLOSED",
        `The reviewed document ${query.sidecar.documentPath} is not open. ` +
          "Open it to reattach this review, then decide its chunks.",
      );
      return;
    }
    this.sendError(
      res,
      404,
      "REVIEW_NOT_FOUND",
      "Review not found.",
    );
  }

  private async handleGetReview(res: http.ServerResponse, reviewId: string): Promise<void> {
    const query = await this._documents.reviewQueries.findReviewQuery(reviewId);
    if (query === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
      return;
    }
    if (!query.attached) {
      const { sidecar } = query;
      const unresolvedChunks = sidecarUnresolvedChunks(sidecar);
      this.sendJson(res, 200, {
        reviewId: sidecar.review.reviewId,
        state: classifyReviewState(sidecar.review.invalidated, unresolvedChunks),
        generation: sidecar.review.generation,
        unresolvedChunks,
        packetCount: sidecar.review.packets.length,
        comments: sidecar.review.comments,
        attached: false,
      });
      return;
    }
    // The owner supplies the live text and review together. This cannot
    // fabricate a revision for a closed document.
    this.sendJson(res, 200, {
      ...query.status,
      comments: query.review.comments,
      attached: true,
      documentRevision: { sha256: sha256Text(query.workingText) },
    });
  }

  private async handleGetReviewDiff(
    res: http.ServerResponse,
    reviewId: string,
  ): Promise<void> {
    const query = await this._documents.reviewQueries.findReviewQuery(reviewId);
    if (query === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
      return;
    }
    if (!query.attached) {
      const { sidecar } = query;
      this.sendJson(res, 200, {
        reviewId: sidecar.review.reviewId,
        patch: reviewPatch(sidecar.review.suggestions, sidecar.workingText),
        generation: sidecar.review.generation,
      });
      return;
    }
    const diff = this._documents.reviewQueries.getReviewDiff(query.documentId);
    if (diff === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
      return;
    }
    this.sendJson(res, 200, {
      reviewId: query.review.reviewId,
      documentId: query.documentId,
      patch: diff,
      generation: query.review.generation,
    });
  }

  /**
   * The refusals that mean the caller's picture of the review is stale rather
   * than wrong: the file closed, the review was invalidated by disk drift, or
   * a precondition named a text or generation the review has moved past. All
   * are 409, and keeping the list in one place is what stops a code meaning
   * 409 on one route and 400 on another.
   */
  private static isConflict(code: AgentErrorCode): boolean {
    return (
      code === "DOCUMENT_CLOSED" ||
      code === "REVIEW_INVALIDATED" ||
      code === "REVISION_MISMATCH" ||
      code === "REVIEW_GENERATION_MISMATCH"
    );
  }

  /**
   * What a precondition refusal tells the caller to re-read from. Absent on
   * every other refusal, which has nothing to resynchronize against.
   */
  private static conflictDetail(
    result: ReviewFailure,
  ): Omit<AgentError, "code" | "message"> | undefined {
    return result.actual === undefined
      ? undefined
      : { actual: result.actual, reviewGeneration: result.reviewGeneration };
  }

  /**
   * POST /v1/reviews/{reviewId}/comments — attach a review-level comment.
   * No document text moves, so this goes straight to the store; the
   * generation advance is what wakes the agent's long-poll.
   */
  private async handleAddReviewComment(
    res: http.ServerResponse,
    reviewId: string,
    text: string,
    expectedReviewGeneration: number,
  ): Promise<void> {
    const documentId = this._documents.reviewQueries.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      await this.sendReviewLookupFailure(res, reviewId);
      return;
    }
    const result = await this._documents.addReviewComment(
      reviewId,
      text,
      expectedReviewGeneration,
    );
    if (!result.ok) {
      this.sendError(
        res,
        AgentHTTPProvider.isConflict(result.code)
          ? 409
          : result.code === "PERSISTENCE_FAILED"
            ? 500
            : 404,
        result.code,
        result.message,
        AgentHTTPProvider.conflictDetail(result),
      );
      return;
    }
    this.sendJson(res, 200, {
      reviewId: result.reviewId,
      documentId: result.documentId,
      reviewGeneration: result.reviewGeneration,
      comment: result.comment,
    });
  }

  private async handleGetReviewChunks(
    res: http.ServerResponse,
    reviewId: string,
  ): Promise<void> {
    const query = await this._documents.reviewQueries.findReviewQuery(reviewId);
    if (query === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
      return;
    }
    if (!query.attached) {
      const { sidecar } = query;
      this.sendJson(res, 200, {
        reviewId: sidecar.review.reviewId,
        generation: sidecar.review.generation,
        chunks: sidecarOutstandingChunks(sidecar),
      });
      return;
    }
    const chunks = this._documents.reviewQueries.getOutstandingChunks(query.documentId);
    if (chunks === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
      return;
    }
    this.sendJson(res, 200, {
      reviewId: query.review.reviewId,
      documentId: query.documentId,
      generation: query.review.generation,
      // The precondition a decision on any of these chunks must carry. A
      // detached review has no live buffer and so publishes none: it accepts
      // no decisions until its file is reopened.
      workingSha256: sha256Text(query.workingText),
      chunks,
    });
  }

  private async handleGetReviewPackets(
    res: http.ServerResponse,
    reviewId: string,
  ): Promise<void> {
    const query = await this._documents.reviewQueries.findReviewQuery(reviewId);
    if (query === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
      return;
    }
    if (!query.attached) {
      const { sidecar } = query;
      this.sendJson(res, 200, {
        reviewId: sidecar.review.reviewId,
        // A stored packet carries its reference spans and no patch format;
        // the wire packet is the ledger entry with the format stamped on.
        packets: sidecar.review.packets.map(toWirePacket),
      });
      return;
    }
    this.sendJson(res, 200, {
      reviewId: query.review.reviewId,
      documentId: query.documentId,
      packets: query.review.packets.map(toWirePacket),
    });
  }

  private async handleRetractProposal(
    res: http.ServerResponse,
    packetId: string,
    precondition: ReviewMutationPrecondition,
  ): Promise<void> {
    const result = await this._documents.retractProposal(packetId, precondition);
    if (result.ok) {
      this.sendJson(res, 200, {
        retracted: true,
        packetId: result.packetId,
        reviewId: result.reviewId,
        documentId: result.documentId,
        reviewGeneration: result.reviewGeneration,
        unresolvedChunks: result.unresolvedChunks,
        documentRevision: result.documentRevision,
      });
    } else {
      // Two different refusals share the 409: the packet is live but no
      // longer the retractable one, or its file is closed. Both name the
      // review that owns the packet, which is the only thing the caller can
      // re-read from — disposing of the suggestions is the reviewer's.
      this.sendError(res, result.code === "PERSISTENCE_FAILED" ? 500 : 409, result.code, result.message, {
        reviewId: result.reviewId,
        ...AgentHTTPProvider.conflictDetail(result),
      });
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Reads the request body, bounded in size and time. The promise settles
   * exactly once: with the body on a completed read, RequestTooLargeError
   * past the size cap, RequestBodyTimeoutError when the client stalls past
   * the deadline, or RequestAbandonedError when the connection dies first —
   * any 'error' on an incoming request stream is the transport failing
   * mid-body, which leaves nobody to answer. Every path clears the timer and
   * detaches all four listeners, so a request that never completes cannot
   * hold its buffers or closure alive beyond the deadline.
   */
  private async readBody(req: http.IncomingMessage): Promise<string> {
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let deadline: NodeJS.Timeout | undefined;
      const settle = (outcome: () => void): void => {
        clearTimeout(deadline);
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
        req.removeListener("close", onError);
        outcome();
      };
      const onData = (chunk: Buffer): void => {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
          settle(() => reject(new RequestTooLargeError()));
          // Keep the transport alive long enough for the dispatcher to answer
          // with its structured 413. Resuming after our listeners are removed
          // drains and discards the remainder without retaining more buffers.
          req.resume();
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        settle(() => resolve(Buffer.concat(chunks).toString("utf8")));
      };
      const onError = (): void => {
        settle(() => reject(new RequestAbandonedError()));
      };
      deadline = setTimeout(() => {
        // No req.destroy() here: the 408 the dispatcher answers with must
        // still reach the stalled client before the connection is torn down.
        settle(() => reject(new RequestBodyTimeoutError()));
      }, this._bodyDeadlineMs);
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("close", onError);
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: AgentApiResponseBody): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json, "utf8"),
    });
    res.end(json);
  }

  private sendError(
    res: http.ServerResponse,
    status: number,
    code: AgentErrorCode,
    message: string,
    detail?: Omit<AgentError, "code" | "message">,
  ): void {
    if (res.headersSent) {
      // The status line is already on the wire, so writeHead would throw here
      // — inside whatever failure path called this — and take the process with
      // it. The client gets a severed connection, which is what an incomplete
      // body deserves; the operator gets the reason.
      this._log.error(
        `[AgentHTTPProvider] ${code} after the response headers were sent, so the response is ` +
          `truncated and the connection is being closed: ${message}`,
      );
      res.destroy();
      return;
    }
    const error: AgentError = { code, message, ...detail };
    const json = JSON.stringify({ error } satisfies AgentErrorResponse);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json, "utf8"),
    });
    res.end(json);
  }
}
