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
  AgentEventType,
  AddReviewCommentRequest,
  AgentError,
  AgentErrorCode,
  AgentErrorResponse,
  DocumentSummary,
  EditorContext,
  EditorViewSummary,
  PingResponse,
  ReadDocumentResponse,
  ReadSide,
  ReviewEventsResponse,
  ReviewListEntry,
  ReviewMutationPrecondition,
  SearchDocumentRequest,
  SearchHit,
  SubmitProposalRequest,
  ViewSummary,
  WorkspaceDocumentEntry,
  WorkspaceFileEntry,
} from "@dts/common/agent-api";
import { DocumentType, DP_EVENTS } from "@dts/common/documents";
import type DocumentManager from "@providers/documents";
import type { ReviewFailure } from "@providers/documents/review-application-service";
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
import vm from "vm";
import { parseDocument, type Document } from "yaml";
import {
  classifyReviewState,
  sidecarUnresolvedChunks,
  reviewPatch,
  sidecarOutstandingChunks,
  toWirePacket,
} from "@providers/documents/review-diff-store";
import { sha256Text } from "@common/util/sha256";
import makeSearchRegex from "source/common/util/make-search-regex";

const SSE_REPLAY_BUFFER_SIZE = 100;
const SSE_HEARTBEAT_MS = 15000;
const MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024;

/**
 * How long a request gets to finish transmitting its body before the read is
 * abandoned with REQUEST_BODY_TIMEOUT. Generous for a loopback API — a local
 * client delivers even the 25 MB maximum in well under a second — so a read
 * that trips this was never going to complete, and holding its buffers longer
 * serves no one.
 */
const REQUEST_BODY_DEADLINE_MS = 30_000;

type BufferedAgentEvent = AgentEvent & { id: string };

/** The payload shape the document-provider events this server subscribes to carry. */
interface DocumentEventContext {
  filePath?: string;
}

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

/** The spec's published default for the search request's `context`. */
const SEARCH_CONTEXT_DEFAULT = 3;

/**
 * The search endpoint accepts raw regular expressions, and this server runs on
 * the Electron main process: a catastrophic pattern left unbounded does not
 * slow one request down, it freezes the editor. openapi.yaml caps the pattern
 * length and the per-hit context; this deadline bounds evaluation.
 *
 * A deadline polled between lines would be a lie for the one input class it
 * exists to survive: `/(a+)+$/` against a single non-matching line of a's
 * backtracks exponentially inside one `exec` call, and no loop condition runs
 * again until that call returns — minutes to never, with SEARCH_TIMEOUT
 * unreachable. So the whole match loop is entered through `vm` with a
 * `timeout`, which arms V8's execution terminator: V8 honours termination
 * from inside regex evaluation, so the ceiling holds for any pattern, not
 * just the ones that happen to yield between lines. The `vm` boundary is a
 * pre-emption device here, not a security boundary — the pattern is still
 * compiled and matched by this realm's code.
 */
const SEARCH_DEADLINE_MS = 1000;

/**
 * A frequent pattern can produce an unbounded number of hits even when its
 * regex evaluation finishes quickly. The endpoint returns a prefix in
 * document order and marks that prefix so callers can choose a narrower
 * search rather than receiving an unbounded main-process response.
 */
export const MAX_SEARCH_HITS = 1000;

/**
 * The match loop, factored out so it can be entered as one interruptible
 * call. Runs to completion or is terminated mid-`exec`; a terminated run
 * abandons this array, so partial hits never reach a response.
 */
function collectSearchHits(
  lines: string[],
  searchRegex: RegExp,
  contextSize: number,
  maxHits: number,
): { hits: SearchHit[]; truncated: boolean } {
  const hits: SearchHit[] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    searchRegex.lastIndex = 0;
    let match: RegExpExecArray | null = searchRegex.exec(lines[i]);
    while (match !== null) {
      const found = match.index;
      const hitLength = match[0].length;
      if (hitLength === 0) {
        searchRegex.lastIndex += 1;
        match = searchRegex.exec(lines[i]);
        continue;
      }
      if (hits.length >= maxHits) {
        truncated = true;
        return { hits, truncated };
      }
      hits.push({
        line: i + 1,
        column: found + 1,
        length: hitLength,
        contextBefore: lines.slice(Math.max(0, i - contextSize), i).join("\n"),
        contextAfter: lines.slice(i + 1, Math.min(lines.length, i + 1 + contextSize)).join("\n"),
      });
      if (searchRegex.lastIndex >= lines[i].length) {
        break;
      }
      match = searchRegex.exec(lines[i]);
    }
  }
  return { hits, truncated };
}

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

export default class AgentHTTPProvider extends ProviderContract {
  private _server: http.Server | undefined;
  private _instanceId: string;
  private _sseClients: Set<http.ServerResponse> = new Set();
  private _eventReplayBuffer: BufferedAgentEvent[] = [];
  private _eventSequence = 1;
  private _sseHeartbeat: NodeJS.Timeout | undefined;
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

    // A bind failure must not take the editor down with it. This provider is
    // enabled by default, and AppServiceContainer._informativeBoot rethrows
    // whatever boot rejects with — so before this, any unrelated process holding
    // the port meant Zettlr itself refused to launch. The API is optional; the
    // editor is not. Report the collision at error level, name the remedy, and
    // continue without a listener rather than substituting a different port
    // (a silently-moved endpoint is worse than an absent one: every configured
    // agent would keep talking to whatever now answers on the expected port).
    const listenError = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      this._server!.once("error", (error: NodeJS.ErrnoException) => {
        resolve(error);
      });
      this._server!.listen(config.port, "127.0.0.1", () => {
        this._log.info(`[AgentHTTPProvider] Listening on http://127.0.0.1:${config.port}`);
        resolve(undefined);
      });
    });

    if (listenError !== undefined) {
      this._server = undefined;
      if (listenError.code !== "EADDRINUSE") {
        throw listenError;
      }
      this._log.error(
        `[AgentHTTPProvider] Port ${config.port} on 127.0.0.1 is already in use, so the ` +
          "Agent API is NOT running for this session. The editor started normally. " +
          "Change agentApi.port in the configuration, or stop the process holding it " +
          `(lsof -nP -iTCP:${config.port} -sTCP:LISTEN).`,
        listenError,
      );
      return;
    }

    // Subscribe to committed review events
    this._documents.agentEvents.on("*", (event: AgentEvent) => {
      this.broadcastSseEvent(event);
    });

    // Subscribe to document-level events
    this.onDocumentEvent(DP_EVENTS.ACTIVE_FILE, "focus.changed");
    this.onDocumentEvent(DP_EVENTS.CHANGE_FILE_STATUS, "document.changed");
    this.onDocumentEvent(DP_EVENTS.CLOSE_FILE, "document.closed");
  }

  /**
   * The document provider's emitter is untyped (`(...args: unknown[]) => void`),
   * so every subscription would otherwise carry `unknown` into this file. This
   * is the single place that boundary is narrowed: the payload is checked once,
   * and a shape that does not match is reported against the emitting provider
   * rather than silently treated as an event with no document.
   */
  private onDocumentEvent(event: DP_EVENTS, agentEvent: AgentEventType): void {
    this._documents.on(event, (...args: unknown[]) => {
      const [context] = args;
      if (typeof context !== "object" || context === null) {
        this._log.error(
          `[AgentHTTPProvider] ${event} payload is not an object (got ${typeof context}); ` +
            "fix the emit site in service-providers/documents",
        );
        return;
      }
      const { filePath } = context as DocumentEventContext;
      if (filePath !== undefined && typeof filePath !== "string") {
        this._log.error(
          `[AgentHTTPProvider] ${event} payload has a non-string filePath; ` +
            "fix the emit site in service-providers/documents",
        );
        return;
      }
      this.broadcastSseEvent({
        event: agentEvent,
        timestamp: new Date().toISOString(),
        documentId: filePath !== undefined ? this._documents.getDocumentId(filePath) : undefined,
      });
    });
  }

  /** Whether the HTTP listener is bound. False after a refused bind. */
  public get isListening(): boolean {
    return this._server !== undefined;
  }

  async shutdown(): Promise<void> {
    // Close all SSE clients
    for (const res of this._sseClients) {
      res.end();
    }
    this._sseClients.clear();
    if (this._sseHeartbeat !== undefined) {
      clearInterval(this._sseHeartbeat);
      this._sseHeartbeat = undefined;
    }

    if (this._server !== undefined) {
      await new Promise<void>((resolve) => {
        this._server?.close(() => resolve());
      });
      this._server = undefined;
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
   * The same document minus the one route an Action cannot consume:
   * /v1/events is Server-Sent Events, and an importer that calls it waits on
   * it forever. Derived here from the parsed document rather than by a
   * command that curls this server and edits the result, so there is no
   * second copy of the contract to keep in step. The long-poll route
   * /v1/reviews/{reviewId}/events is an ordinary request and stays.
   */
  private serveActionSpecification(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const specification = this.specificationForRequest(req);
    specification.deleteIn(["paths", "/v1/events"]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(specification.toJSON(), null, 2));
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
      getOpenApiActionsJson: (_c, req, res) => this.serveActionSpecification(req, res),

      health: (_c, _req, res) => this.sendJson(res, 200, this.instanceIdentity()),
      ping: (_c, _req, res) => this.sendJson(res, 200, this.instanceIdentity()),
      getCapabilities: (_c, _req, res) =>
        this.sendJson(res, 200, {
          protocolVersion: this._protocolVersion,
          supportedPatchFormats: ["unified-diff"],
          reviewSupport: true,
          retractionSupport: true,
          maxRequestSize: MAX_REQUEST_BODY_BYTES,
          eventStreamSupport: true,
          eventReplayBufferSize: SSE_REPLAY_BUFFER_SIZE,
          applicationVersion: app.getVersion(),
          instanceId: this._instanceId,
        }),
      getContext: (_c, _req, res) => this.handleGetContext(res),
      listViews: (_c, _req, res) => this.handleGetViews(res),
      subscribeEvents: (_c, req, res) => this.handleSseSubscription(req, res),

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
    const focusedView = this._documents.getFocusedView();
    const focusedDocSummary =
      focusedView?.documentId !== undefined
        ? await this.getDocumentSummary(focusedView.documentId)
        : undefined;
    const openDocuments: DocumentSummary[] = [];
    for (const doc of this._documents.loadedDocuments) {
      const summary = await this.getDocumentSummary(doc.documentId);
      if (summary !== undefined) {
        openDocuments.push(summary);
      }
    }
    const context: EditorContext = {
      focusedView: focusedView
        ? {
            viewId: focusedView.viewId,
            windowId: focusedView.windowId,
            leafId: focusedView.leafId,
            documentId: focusedView.documentId ?? "",
          }
        : undefined,
      focusedDocument: focusedDocSummary,
      openDocuments,
    };
    this.sendJson(res, 200, context);
  }

  private async handleListDocuments(res: http.ServerResponse): Promise<void> {
    const documents: DocumentSummary[] = [];
    for (const doc of this._documents.loadedDocuments) {
      const summary = await this.getDocumentSummary(doc.documentId);
      if (summary !== undefined) {
        documents.push(summary);
      }
    }
    this.sendJson(res, 200, { documents });
  }

  private async handleGetViews(res: http.ServerResponse): Promise<void> {
    const focusedView = this._documents.getFocusedView();
    const views: ViewSummary[] = [];
    await this._documents.forEachLeaf(async (tabMan, windowId, leafId) => {
      const activePath = tabMan.activeFile?.path;
      const isFocused =
        focusedView !== undefined &&
        focusedView.windowId === windowId &&
        focusedView.leafId === leafId;
      views.push({
        viewId: `view-${windowId}-${leafId}`,
        windowId,
        leafId,
        documentId:
          activePath !== undefined ? this._documents.getDocumentId(activePath) : undefined,
        focused: isFocused,
        active: isFocused,
        documents: tabMan.openFiles.map((openFile) => ({
          documentId: this._documents.getDocumentId(openFile.path),
          path: openFile.path,
        })),
      });
      return false;
    });
    this.sendJson(res, 200, { views });
  }

  private handleGetWorkspaces(res: http.ServerResponse): void {
    const workspaces = this._app.config.get().app.openWorkspaces.map((workspacePath) => ({
      workspaceId: workspacePath,
      path: workspacePath,
    }));
    this.sendJson(res, 200, { workspaces });
  }

  /**
   * GET /v1/workspace/files — the orientation loop's first question: what
   * exists. Every file across the configured workspaces, flat, open or not.
   * Main already walks directories for the workspace listings; this is a
   * route over that walk, not a subsystem.
   */
  private async handleListWorkspaceFiles(res: http.ServerResponse): Promise<void> {
    const files: WorkspaceFileEntry[] = [];
    for (const workspacePath of this._app.config.get().app.openWorkspaces) {
      for (const filePath of await this._documents.getFilesForWorkspace(workspacePath)) {
        files.push({
          documentId: this._documents.ensureDocumentId(filePath),
          path: filePath,
          name: path.basename(filePath),
          workspaceId: workspacePath,
          open: this._documents.loadedDocuments.some((doc) => doc.filePath === filePath),
        });
      }
    }
    this.sendJson(res, 200, { files });
  }

  private handleListWorkspaceDocuments(
    res: http.ServerResponse,
    workspaceId: string,
    query: string | undefined,
  ): void {
    const workspacePath = workspaceId;
    const knownWorkspaces = this._app.config.get().app.openWorkspaces;
    if (!knownWorkspaces.includes(workspacePath)) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Workspace not found");
      return;
    }

    const normalizedQuery = query === undefined ? "" : query.toLowerCase().trim();
    const documents: WorkspaceDocumentEntry[] = [];

    this._documents
      .getFilesForWorkspace(workspacePath)
      .then(async (paths) => {
        for (const documentPath of paths) {
          const documentId = this._documents.ensureDocumentId(documentPath);
          if (normalizedQuery.length > 0) {
            const haystack = documentPath.toLowerCase();
            if (!haystack.includes(normalizedQuery)) {
              continue;
            }
          }
          const summary = await this.getDocumentSummary(documentId);
          documents.push(summary === undefined
            ? {
                documentId,
                uri: `safe-file://${documentPath}`,
                path: documentPath,
                name: path.basename(documentPath),
                workspaceId,
                loaded: false,
              }
            : { ...summary, workspaceId, loaded: true });
        }
        this.sendJson(res, 200, { workspaceId, documents });
      })
      .catch(() => {
        this.sendError(res, 500, "INTERNAL_ERROR", "Unable to list workspace documents");
      });
  }

  private async handleGetDocument(res: http.ServerResponse, documentId: string): Promise<void> {
    const summary = await this.getDocumentSummary(documentId);
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
    if (!(await this.isDocumentOpenableInCurrentWorkspaces(filePath))) {
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
    const applyRange = (
      text: string,
      lineCount: number,
      startLine: number,
      endLine: number,
    ): {
      content: string;
      startLine: number;
      endLine: number;
      truncated: boolean;
    } => {
      const safeStartLine = Math.max(1, Math.min(startLine, lineCount));
      const safeEndLine = Math.max(safeStartLine, Math.min(endLine, lineCount));
      const lines = text.split("\n");
      return {
        content: lines.slice(safeStartLine - 1, safeEndLine).join("\n"),
        startLine: safeStartLine,
        endLine: safeEndLine,
        truncated: safeEndLine < lineCount,
      };
    };

    // openapi.yaml declares `side` optional with `default: working`. A
    // request parameter's default describes what the server assumes when the
    // caller omits it, so this is where it is applied.
    const side = query.side ?? "working";
    const filePath = this._documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    if (!(await this.isDocumentOpenableInCurrentWorkspaces(filePath))) {
      this.sendError(
        res,
        404,
        "DOCUMENT_NOT_FOUND",
        "Document is outside configured workspace scope",
      );
      return;
    }

    let sides;
    try {
      sides = await this._documents.readDocumentSides(documentId);
    } catch (err) {
      this.sendError(
        res,
        500,
        "INTERNAL_ERROR",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (sides === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }

    // The whole side is the external identity: the hash a proposal binds to
    // is the document's, never the requested slice's.
    const text = side === "working" ? sides.working : sides.reference;
    const lineCount = text.split("\n").length;
    const range = applyRange(text, lineCount, query.startLine ?? 1, query.endLine ?? lineCount);

    const response: ReadDocumentResponse = {
      documentId,
      attached: sides.attached,
      side,
      revision: { sha256: sha256Text(text) },
      reviewGeneration: sides.reviewGeneration,
      range: {
        startLine: range.startLine,
        endLine: range.endLine,
        totalLines: lineCount,
      },
      content: range.content,
      truncated: range.truncated,
    };
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

    const documentId = this.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      // A detached review's generation cannot advance — nothing can decide
      // its chunks while its file is closed — so waiting on it would be
      // waiting forever. The refusal names the file to open instead.
      await this.sendReviewLookupFailure(res, reviewId);
      return;
    }

    const current = this._documents.reviewStatus(documentId);
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
        const status = this._documents.reviewStatus(documentId);
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
      const status = this._documents.reviewStatus(documentId);
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
    const result = this._documents.readLiveBuffer(documentId);
    if (result === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    const lines = result.content.split("\n");
    const contextSize = searchRequest.context ?? SEARCH_CONTEXT_DEFAULT;
    const maxHits = MAX_SEARCH_HITS;
    let searchRegex: RegExp;
    try {
      searchRegex = makeSearchRegex(searchRequest.literal, "g");
    } catch {
      this.sendError(res, 400, "INVALID_PARAMS", "Invalid search pattern");
      return;
    }
    let collected: { hits: SearchHit[]; truncated: boolean };
    try {
      collected = vm.runInNewContext(
        "collectSearchHits(lines, searchRegex, contextSize, maxHits)",
        { collectSearchHits, lines, searchRegex, contextSize, maxHits },
        { timeout: SEARCH_DEADLINE_MS },
      ) as { hits: SearchHit[]; truncated: boolean };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        throw err;
      }
      this.sendError(
        res,
        422,
        "SEARCH_TIMEOUT",
        `Search did not finish within ${SEARCH_DEADLINE_MS} ms; simplify the pattern`,
      );
      return;
    }
    this.sendJson(res, 200, {
      documentId,
      revision: { sha256: result.sha256 },
      hits: collected.hits,
      truncated: collected.truncated,
    });
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
    if (!(await this.isDocumentOpenableInCurrentWorkspaces(filePath))) {
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

  private async handleListReviews(res: http.ServerResponse): Promise<void> {
    // Open-document reviews, then the sidecar-backed reviews whose files
    // are closed — one list, discriminated by `attached`.
    const reviews: ReviewListEntry[] = [
      ...this._documents.reviewStore.listReviews().flatMap((review) => {
        const status = this._documents.reviewStatus(review.documentId);
        return status === undefined
          ? []
          : [
              {
                ...status,
                documentId: review.documentId,
                documentPath: review.documentPath,
                attached: true,
              },
            ];
      }),
      ...(await this._documents.listDetachedReviews()),
    ];
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
    const failure = await this._documents.reviewLookupFailure(reviewId);
    this.sendError(
      res,
      failure.code === "DOCUMENT_CLOSED" ? 409 : 404,
      failure.code,
      failure.message,
    );
  }

  private async handleGetReview(res: http.ServerResponse, reviewId: string): Promise<void> {
    const documentId = this.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      const detached = await this._documents.findDetachedReview(reviewId);
      if (detached === undefined) {
        this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
        return;
      }
      const unresolvedChunks = sidecarUnresolvedChunks(detached);
      this.sendJson(res, 200, {
        reviewId: detached.reviewId,
        state: classifyReviewState(detached.invalidated, unresolvedChunks),
        generation: detached.generation,
        unresolvedChunks,
        packetCount: detached.packets.length,
        comments: detached.comments,
        attached: false,
      });
      return;
    }
    const status = this._documents.reviewStatus(documentId);
    if (status === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
      return;
    }
    const filePath = this._documents.getDocumentPath(documentId);
    const doc =
      filePath !== undefined
        ? this._documents.loadedDocuments.find((d) => d.filePath === filePath)
        : undefined;
    if (doc === undefined) {
      // A review in the live store whose document is not open is a
      // lifecycle bug — closing a file detaches its review to a sidecar.
      // Inventing a revision here would report a document state nobody has.
      throw new Error(
        `Review ${reviewId} is attached to document ${documentId}, which is not open`,
      );
    }
    // The comments read here include any orphans that chunk-comment
    // reconciliation has surfaced.
    const review = this._documents.reviewStore.getReview(documentId)!;
    this.sendJson(res, 200, {
      ...status,
      comments: review.comments,
      attached: true,
      documentRevision: { sha256: sha256Text(doc.document.toString()) },
    });
  }

  private async handleGetReviewDiff(
    res: http.ServerResponse,
    reviewId: string,
  ): Promise<void> {
    const documentId = this.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      const detached = await this._documents.findDetachedReview(reviewId);
      if (detached === undefined) {
        this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
        return;
      }
      this.sendJson(res, 200, {
        reviewId: detached.reviewId,
        patch: reviewPatch(detached.referenceText, detached.workingText),
        generation: detached.generation,
      });
      return;
    }
    const diff = this._documents.reviewStore.getReviewDiff(
      documentId,
      this._documents.readWorkingText(documentId) ?? "",
    );
    if (diff === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
      return;
    }
    const review = this._documents.reviewStore.getReview(documentId)!;
    this.sendJson(res, 200, {
      reviewId: review.reviewId,
      documentId,
      patch: diff,
      generation: review.generation,
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
    const documentId = this.findDocumentIdByReviewId(reviewId);
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
    const documentId = this.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      const detached = await this._documents.findDetachedReview(reviewId);
      if (detached === undefined) {
        this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
        return;
      }
      this.sendJson(res, 200, {
        reviewId: detached.reviewId,
        generation: detached.generation,
        chunks: sidecarOutstandingChunks(detached),
      });
      return;
    }
    const chunks = this._documents.reviewStore.getOutstandingChunks(
      documentId,
      this._documents.readWorkingText(documentId) ?? "",
    );
    if (chunks === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
      return;
    }
    const review = this._documents.reviewStore.getReview(documentId)!;
    this.sendJson(res, 200, {
      reviewId: review.reviewId,
      documentId,
      generation: review.generation,
      // The precondition a decision on any of these chunks must carry. A
      // detached review has no live buffer and so publishes none: it accepts
      // no decisions until its file is reopened.
      workingSha256: sha256Text(this._documents.readWorkingText(documentId) ?? ""),
      chunks,
    });
  }

  private async handleGetReviewPackets(
    res: http.ServerResponse,
    reviewId: string,
  ): Promise<void> {
    const documentId = this.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      const detached = await this._documents.findDetachedReview(reviewId);
      if (detached === undefined) {
        this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
        return;
      }
      this.sendJson(res, 200, {
        reviewId: detached.reviewId,
        // A stored packet carries its reference spans and no patch format;
        // the wire packet is the ledger entry with the format stamped on.
        packets: detached.packets.map(toWirePacket),
      });
      return;
    }
    const review = this._documents.reviewStore.getReview(documentId);
    if (review === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
      return;
    }
    this.sendJson(res, 200, {
      reviewId: review.reviewId,
      documentId,
      packets: review.packets.map(toWirePacket),
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
  // SSE event streaming
  // ==========================================================================

  private handleSseSubscription(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const afterEventId = this.parseLastEventId(req.headers["last-event-id"]);
    const start = this.eventReplayStartIndex(afterEventId);
    if (start < this._eventReplayBuffer.length) {
      for (const event of this._eventReplayBuffer.slice(start)) {
        this.writeSseEnvelope(res, event);
      }
    } else {
      res.write(": connected\n\n");
    }
    this._sseClients.add(res);

    if (this._sseHeartbeat === undefined) {
      this._sseHeartbeat = setInterval(() => {
        for (const client of this._sseClients) {
          if (!client.writableEnded) {
            client.write(": heartbeat\n\n");
          }
        }
      }, SSE_HEARTBEAT_MS);
    }
    res.on("close", () => {
      this._sseClients.delete(res);
      if (this._sseClients.size === 0 && this._sseHeartbeat !== undefined) {
        clearInterval(this._sseHeartbeat);
        this._sseHeartbeat = undefined;
      }
    });
  }

  private broadcastSseEvent(event: AgentEvent): void {
    const stampedEvent = this.buildSseEvent(event);
    // Add to replay buffer
    this._eventReplayBuffer.push(stampedEvent);
    if (this._eventReplayBuffer.length > SSE_REPLAY_BUFFER_SIZE) {
      this._eventReplayBuffer.shift();
    }
    for (const res of this._sseClients) {
      if (!res.writableEnded) {
        this.writeSseEnvelope(res, stampedEvent);
      }
    }
  }

  private parseLastEventId(header: string | string[] | undefined): number | undefined {
    if (header === undefined) {
      return undefined;
    }
    const candidate = Array.isArray(header) ? header[0] : header;
    const parsed = parseInt(candidate, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  }

  private eventReplayStartIndex(afterEventId: number | undefined): number {
    if (afterEventId === undefined || this._eventReplayBuffer.length === 0) {
      return 0;
    }
    for (let i = 0; i < this._eventReplayBuffer.length; i++) {
      if (parseInt(this._eventReplayBuffer[i].id, 10) > afterEventId) {
        return i;
      }
    }
    return this._eventReplayBuffer.length;
  }

  private writeSseEnvelope(res: http.ServerResponse, event: BufferedAgentEvent): void {
    const data = JSON.stringify(event);
    res.write(`id: ${event.id}\n`);
    if (event.event !== undefined) {
      res.write(`event: ${event.event}\n`);
    }
    res.write(`data: ${data}\n\n`);
  }

  private buildSseEvent(event: AgentEvent): BufferedAgentEvent {
    const id = `${this._eventSequence}`;
    this._eventSequence += 1;
    const enriched: AgentEvent = { ...event };
    if (enriched.documentId !== undefined) {
      const filePath = this._documents.getDocumentPath(enriched.documentId);
      const document =
        filePath === undefined
          ? undefined
          : this._documents.loadedDocuments.find((candidate) => candidate.filePath === filePath);
      if (document !== undefined && enriched.documentRevision === undefined) {
        enriched.documentRevision = { sha256: sha256Text(document.document.toString()) };
      }
      const review = this._documents.reviewStore.getReview(enriched.documentId);
      if (review !== undefined) {
        if (enriched.reviewId === undefined) {
          enriched.reviewId = review.reviewId;
        }
        if (enriched.reviewGeneration === undefined) {
          enriched.reviewGeneration = review.generation;
        }
        if (enriched.unresolvedChunks === undefined) {
          enriched.unresolvedChunks =
            this._documents.reviewStatus(enriched.documentId)?.unresolvedChunks;
        }
      }
    }
    return {
      ...enriched,
      id,
    };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Collects the editor views a document is currently open in, keyed the same
   * way as GET /v1/views.
   */
  private async getViewsForDocument(documentId: string): Promise<EditorViewSummary[]> {
    const focusedView = this._documents.getFocusedView();
    const views: EditorViewSummary[] = [];
    await this._documents.forEachLeaf(async (tabMan, windowId, leafId) => {
      const isOpenHere = tabMan.openFiles.some(
        (openFile) => this._documents.getDocumentId(openFile.path) === documentId,
      );
      if (!isOpenHere) {
        return false;
      }
      const isFocused =
        focusedView !== undefined &&
        focusedView.windowId === windowId &&
        focusedView.leafId === leafId;
      views.push({
        viewId: `view-${windowId}-${leafId}`,
        windowId,
        leafId,
        focused: isFocused,
        active:
          tabMan.activeFile !== null &&
          this._documents.getDocumentId(tabMan.activeFile.path) === documentId,
      });
      return false;
    });
    return views;
  }

  private async getDocumentSummary(documentId: string): Promise<DocumentSummary | undefined> {
    const filePath = this._documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      return undefined;
    }
    const doc = this._documents.loadedDocuments.find((d) => d.filePath === filePath);
    if (doc === undefined) {
      return undefined;
    }
    const content = doc.document.toString();
    const lines = content.split("\n");
    const reviewStatus = this._documents.reviewStatus(documentId);
    return {
      documentId,
      uri: `safe-file://${filePath}`,
      path: filePath,
      name: path.basename(filePath),
      // The wire contract is "markdown" | "code", not the internal enum ordinal.
      type: doc.type === DocumentType.Markdown ? "markdown" : "code",
      dirty: doc.currentVersion !== doc.lastSavedVersion,
      revision: { sha256: sha256Text(content) },
      lineCount: lines.length,
      byteLength: Buffer.byteLength(content, "utf8"),
      views: await this.getViewsForDocument(documentId),
      review: reviewStatus ?? undefined,
    };
  }

  private async isDocumentOpenableInCurrentWorkspaces(filePath: string): Promise<boolean> {
    const workspaces = this._app.config.get().app.openWorkspaces;
    if (workspaces.length === 0) {
      // An empty workspace list is not "every file on disk is in scope". A
      // fresh profile opens no workspace, so answering true here let any
      // loopback client POST an absolute path and then read the file back.
      // What is legitimately in scope with no workspace configured is what the
      // editor already holds — the user opened those documents itself. A path
      // nobody has opened stays out of reach.
      //
      // `getDocumentId` is not that test: `_documentIdByPath` is a permanent
      // assignment cache that closing a document never clears, and listing a
      // workspace assigns an id to every file in it. Asking what is loaded
      // right now is the question this predicate actually has.
      return this._documents.loadedDocuments.some((doc) => doc.filePath === filePath);
    }
    for (const workspacePath of workspaces) {
      if (await this.isDocumentOpenableInWorkspace(filePath, workspacePath)) {
        return true;
      }
    }
    return false;
  }

  private async isDocumentOpenableInWorkspace(
    filePath: string,
    workspacePath: string,
  ): Promise<boolean> {
    // Canonicalize the requested path so a symlink inside a workspace cannot
    // point the containment check at a file outside it. A path realpath cannot
    // resolve — nonexistent, a dangling link, a component that is not a
    // directory, or one this process may not traverse — is a path this
    // predicate cannot prove inside any workspace, and refusal is the only
    // safe answer a containment check can give for it.
    let canonicalFilePath: string;
    try {
      canonicalFilePath = await fs.promises.realpath(filePath);
    } catch {
      return false;
    }

    // A configured workspace can be deleted or unmounted while the editor
    // runs, and realpath then rejects with ENOENT. Letting that escape turned
    // every openability check into a bare 500 whose message named neither the
    // path nor the reason, so the only diagnosis was reading the app log and
    // guessing which of several workspaces was gone. A vanished workspace
    // cannot contain the file, which is the answer this predicate owes its
    // caller; anything else is a real fault and still propagates.
    let canonicalWorkspacePath: string;
    try {
      canonicalWorkspacePath = await fs.promises.realpath(workspacePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      this._log.warning(
        `[AgentHTTPProvider] Configured workspace ${workspacePath} could not be resolved ` +
          `(${code}); treating it as not containing ${filePath}. The workspace is ` +
          "probably deleted or unmounted.",
      );
      return false;
    }
    const relativePath = path.relative(canonicalWorkspacePath, canonicalFilePath);
    return (
      relativePath === "" ||
      (!relativePath.startsWith(`..${path.sep}`) &&
        relativePath !== ".." &&
        !path.isAbsolute(relativePath))
    );
  }

  private findDocumentIdByReviewId(reviewId: string): string | undefined {
    for (const r of this._documents.reviewStore.listReviews()) {
      if (r.reviewId === reviewId) {
        return r.documentId;
      }
    }
    return undefined;
  }

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
