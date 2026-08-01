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

import {
  AGENT_API_PROTOCOL_VERSION,
  type AgentEvent,
  type AgentEventType,
  type DocumentSummary,
  type EditorContext,
  type EditorViewSummary,
  type AddReviewCommentRequest,
  type AgentApiResponseBody,
  type AgentError,
  type AgentErrorCode,
  type AgentErrorResponse,
  type ChunkDecision,
  type HoldChunkRequest,
  type ProposalClaim,
  type ReadDocumentResponse,
  type SubmitProposalRequest,
  type ReadSide,
  type ReviewEventsResponse,
  type ReviewListEntry,
  type OpenDocumentRequest,
  type PingResponse,
  type SearchHit,
  type WorkspaceDocumentEntry,
  type WorkspaceFileEntry,
  type ViewSummary,
} from "@dts/common/agent-api";
import { DocumentType, DP_EVENTS } from "@dts/common/documents";
import DocumentManager from "@providers/documents";
import type LogProvider from "@providers/log";
import ProviderContract from "@providers/provider-contract";
import crypto from "crypto";
import { app } from "electron";
import fs from "fs";
import http from "http";
import path from "path";
import vm from "vm";
import { parseDocument, type Document } from "yaml";
import {
  classifyReviewState,
  reviewPatch,
  sha256Text,
  sidecarOutstandingChunks,
} from "@providers/documents/review-diff-store";
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
 * Request decoding happens exactly once, here, at the owned HTTP boundary.
 * Handlers downstream receive declared types and never inspect raw JSON, so a
 * missing or wrong-typed field is a 400 at the edge rather than an `unknown`
 * threaded through the request path.
 */
type Decoded<T> = { ok: true; value: T } | { ok: false; message: string };

function decodeJsonObject(body: string): Decoded<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, message: "Invalid JSON body" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "Invalid JSON body" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * The hold body is optional in its entirety — a hold without text is legal,
 * and a schema-driven client may POST no body at all. A present body must
 * still parse: swallowing a malformed one would silently drop the comment
 * the caller thought it attached.
 */
function decodeHoldChunkRequest(body: string): Decoded<HoldChunkRequest> {
  if (body.trim().length === 0) {
    return { ok: true, value: {} };
  }
  const raw = decodeJsonObject(body);
  if (!raw.ok) {
    return raw;
  }
  const { comment } = raw.value;
  if (comment === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof comment !== "string" || comment.length === 0) {
    return { ok: false, message: "comment must be a non-empty string when present" };
  }
  return { ok: true, value: { comment } };
}

function decodeAddReviewCommentRequest(
  body: string,
): Decoded<AddReviewCommentRequest> {
  const raw = decodeJsonObject(body);
  if (!raw.ok) {
    return raw;
  }
  const { text } = raw.value;
  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, message: "text is required and must be a non-empty string" };
  }
  return { ok: true, value: { text } };
}

function decodeOpenDocumentRequest(body: string): Decoded<OpenDocumentRequest> {
  const raw = decodeJsonObject(body);
  if (!raw.ok) {
    return raw;
  }
  const { uri } = raw.value;
  if (typeof uri !== "string") {
    return { ok: false, message: "uri is required and must be a string" };
  }
  return { ok: true, value: { uri } };
}

/**
 * Decodes the `side` query parameter into a total ReadSide. The spec declares it
 * optional with `default: working`, so an absent parameter is the contract's
 * value rather than a runtime guess, and an unrecognized one is refused here
 * instead of being silently read as `working`.
 */
function decodeReadSide(raw: string | null): Decoded<ReadSide> {
  if (raw === null) {
    return { ok: true, value: "working" };
  }
  if (raw !== "working" && raw !== "reference") {
    return { ok: false, message: "side must be working or reference" };
  }
  return { ok: true, value: raw };
}

/**
 * The spec declares `context` optional with `default: 3`. That default is part
 * of the published contract, so it is applied here, once, at the boundary that
 * owns request decoding — and the decoded type carries a total `context`, so no
 * handler downstream can substitute a different value for a missing one.
 */
export interface DecodedSearchDocumentRequest {
  literal: string;
  context: number;
}

const SEARCH_CONTEXT_DEFAULT = 3;

/**
 * Bounds on user-provided search patterns. The search endpoint accepts raw
 * regular expressions, and this server runs on the Electron main process: a
 * catastrophic pattern left unbounded does not slow one request down, it
 * freezes the editor. The length cap refuses absurd patterns at the decode
 * boundary; the deadline bounds evaluation.
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
export const MAX_SEARCH_PATTERN_LENGTH = 512;
const SEARCH_DEADLINE_MS = 1000;

/**
 * `context` is the third cost dimension of this endpoint, and the only one that
 * scales the response rather than the search: every hit copies up to `context`
 * lines on each side into its own `contextBefore`/`contextAfter`, so the bytes
 * this request allocates in the main process are hits x 2 x context lines. Left
 * open-ended, a single request naming a context larger than the document makes
 * each of its hits carry a full copy of that document. The cap is enforced at
 * the decode boundary and declared in openapi.yaml, so a caller learns the
 * ceiling from the published contract instead of from a hung editor.
 */
export const MAX_SEARCH_CONTEXT = 100;

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

function decodeSearchDocumentRequest(
  body: string,
): Decoded<DecodedSearchDocumentRequest> {
  const raw = decodeJsonObject(body);
  if (!raw.ok) {
    return raw;
  }
  const { literal, context } = raw.value;
  if (typeof literal !== "string") {
    return { ok: false, message: "literal is required and must be a string" };
  }
  if (literal.length > MAX_SEARCH_PATTERN_LENGTH) {
    return {
      ok: false,
      message: `literal must be at most ${MAX_SEARCH_PATTERN_LENGTH} characters`,
    };
  }
  if (context === undefined) {
    return { ok: true, value: { literal, context: SEARCH_CONTEXT_DEFAULT } };
  }
  if (
    typeof context !== "number" ||
    !Number.isInteger(context) ||
    context < 0 ||
    context > MAX_SEARCH_CONTEXT
  ) {
    return {
      ok: false,
      message: `context must be an integer between 0 and ${MAX_SEARCH_CONTEXT}`,
    };
  }
  return { ok: true, value: { literal, context } };
}

/**
 * Field predicates written as type guards, so a decoder narrows its own values
 * instead of asserting them afterwards: `snapshot as string` would compile even
 * if the check above it were deleted.
 */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isInteger(value));
}

function decodeSubmitProposalRequest(body: string): Decoded<SubmitProposalRequest> {
  const raw = decodeJsonObject(body);
  if (!raw.ok) {
    return raw;
  }
  const {
    snapshot,
    patchFormat,
    patch,
    description,
    claims,
    clientRequestId,
    expectedReviewGeneration,
  } = raw.value;
  if (patchFormat !== "unified-diff") {
    return {
      ok: false,
      message: isString(patchFormat)
        ? "Unsupported patch format"
        : "patchFormat is required and must be unified-diff",
    };
  }
  if (!isString(snapshot)) {
    return { ok: false, message: "snapshot is required and must be a string" };
  }
  if (!isString(clientRequestId) || clientRequestId.length === 0) {
    return { ok: false, message: "clientRequestId is required and must be a non-empty string" };
  }
  if (!isOptionalInteger(expectedReviewGeneration)) {
    return { ok: false, message: "expectedReviewGeneration must be an integer" };
  }

  // Exactly one of the two shapes: a claims sequence, or a single patch.
  if (claims !== undefined) {
    if (patch !== undefined || description !== undefined) {
      return {
        ok: false,
        message: "claims replaces patch and description; send one shape or the other",
      };
    }
    if (!Array.isArray(claims) || claims.length === 0) {
      return { ok: false, message: "claims must be a non-empty array" };
    }
    const decodedClaims: ProposalClaim[] = [];
    for (let i = 0; i < claims.length; i++) {
      const claim: unknown = claims[i];
      if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
        return { ok: false, message: `claims[${i}] must be an object` };
      }
      const { description: claimDescription, patch: claimPatch } = claim as Record<
        string,
        unknown
      >;
      if (!isString(claimDescription) || claimDescription.length === 0) {
        return {
          ok: false,
          message: `claims[${i}].description is required and must be a non-empty string`,
        };
      }
      if (!isString(claimPatch)) {
        return { ok: false, message: `claims[${i}].patch is required and must be a string` };
      }
      decodedClaims.push({ description: claimDescription, patch: claimPatch });
    }
    return {
      ok: true,
      value: {
        snapshot,
        patchFormat,
        claims: decodedClaims,
        clientRequestId,
        expectedReviewGeneration,
      },
    };
  }

  if (!isString(patch)) {
    return { ok: false, message: "patch is required and must be a string" };
  }
  if (!isOptionalString(description)) {
    return { ok: false, message: "description must be a string" };
  }
  return {
    ok: true,
    value: { snapshot, patchFormat, patch, description, clientRequestId, expectedReviewGeneration },
  };
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
      agentApi?: {
        enabled: boolean;
        port: number;
        tokenEnvironmentVariable: string;
      };
      app: { openWorkspaces: string[] };
    };
  };
}

/** What a route handler is given: the exchange, plus its decoded path parameters. */
interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
}

/**
 * One route this server answers.
 *
 * `path` is the OpenAPI path template, spelled exactly as openapi.yaml spells
 * it, and the matcher is compiled from that same string. The published
 * document and the dispatcher therefore cannot disagree about what a route is
 * called: there is one spelling, and `AgentHTTPProvider.routes` hands the list
 * back so a caller — the conformance test among them — can ask the running
 * server what it serves instead of guessing from the source text.
 */
interface AgentApiRoute {
  method: string;
  path: string;
  /** Answered before the token check. Only the specification document is. */
  anonymous?: boolean;
  handle: (ctx: RouteContext) => void | Promise<void>;
}

interface CompiledRoute extends AgentApiRoute {
  pattern: RegExp;
  paramNames: string[];
}

/**
 * `/v1/documents/{documentId}/content` becomes `^/v1/documents/([^/]+)/content$`
 * with `documentId` named. A parameter spans exactly one segment, which is what
 * keeps `/v1/documents/{documentId}` from swallowing its own sub-paths.
 */
function compileRoute(route: AgentApiRoute): CompiledRoute {
  const paramNames: string[] = [];
  const pattern = route.path
    .split("/")
    .map((segment) => {
      const parameter = segment.match(/^\{(\w+)\}$/);
      if (parameter === null) {
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      paramNames.push(parameter[1]);
      return "([^/]+)";
    })
    .join("/");
  return { ...route, pattern: new RegExp(`^${pattern}$`), paramNames };
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
  private readonly _requiredToken: string | undefined;
  private readonly _tokenEnvironmentVariable: string;
  /** The one route table. Dispatch matches against these entries and nothing else. */
  private readonly _routes: CompiledRoute[];

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
    // Read once, at construction: a token that appears or changes mid-run would
    // mean the same server answered two different security postures.
    const agentApiConfig = this._app.config.get().agentApi;
    if (agentApiConfig === undefined) {
      throw new Error("Agent API configuration is required");
    }
    this._tokenEnvironmentVariable = agentApiConfig.tokenEnvironmentVariable;
    const configuredToken = process.env[this._tokenEnvironmentVariable];
    this._requiredToken =
      configuredToken === undefined || configuredToken.length === 0
        ? undefined
        : configuredToken;
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
    this._routes = this.buildRoutes().map(compileRoute);
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
        this._log.info(
          `[AgentHTTPProvider] Listening on http://127.0.0.1:${config.port} ` +
            (this._requiredToken === undefined
              ? `(no ${this._tokenEnvironmentVariable} set: any loopback caller is served without a token. ` +
                "Do not expose this port through a tunnel or proxy in this mode.)"
              : "(bearer token required)"),
        );
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

    // Subscribe to review store events
    this._documents.reviewStore.on("*", (event: AgentEvent) => {
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

  /**
   * The (method, path template) pairs this server dispatches on — its own
   * account of what it serves, read off the table dispatch matches against.
   */
  public get routes(): ReadonlyArray<{ method: string; path: string }> {
    return this._routes.map(({ method, path }) => ({ method, path }));
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
   * The specification with `servers` rewritten to the origin the request
   * arrived on.
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
  private specificationForRequest(req: http.IncomingMessage, asJson: boolean): string {
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
    return asJson
      ? JSON.stringify(specification.toJSON(), null, 2)
      : specification.toString();
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
    try {
      this.routeRequest(req, res, method, requestUrl);
    } catch (error) {
      this._log.error(
        `[AgentHTTPProvider] ${method} ${requestUrl} threw out of the request ` +
          `handler: ${String(error)}`,
        error,
      );
      this.sendError(res, 500, "INTERNAL_ERROR", "Internal server error");
    }
  }

  private routeRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    requestUrl: string,
  ): void {
    const url = new URL(requestUrl, "http://127.0.0.1");
    const pathname = url.pathname;
    const matched = this.matchRoute(method, pathname);

    // The specification is deliberately the one anonymous route. It describes
    // the API rather than exposing it — the same document sits in the public
    // repository — and a client that reads it still cannot call anything
    // without the token. Serving it openly is what lets a schema consumer, the
    // Custom GPT builder among them, import by URL instead of being handed a
    // pasted copy that then drifts.
    //
    // This is a deliberate exemption for a static document, not a general
    // pattern: /health next door stays behind the token because it reports the
    // instance id and process id of a running editor.
    //
    // The check runs before an unmatched path is refused, so an anonymous
    // caller learns nothing about which routes exist: everything that is not
    // the specification answers 401 first, routed or not.
    if (matched?.route.anonymous !== true && !this.isAuthorized(req)) {
      // The body says nothing an anonymous caller did not already know. It
      // named the environment variable carrying the secret, which told whoever
      // reached the tunnel how this server is configured and what to probe for.
      // The operator needs that sentence; a stranger does not, so it goes to
      // the log the operator can read and nowhere else.
      this._log.warning(
        `[AgentHTTPProvider] Refused an unauthenticated ${method} ${requestUrl}. ` +
          `Callers must send "Authorization: Bearer <token>" carrying the value of ` +
          `${this._tokenEnvironmentVariable} that this editor was started with.`,
      );
      this.sendError(res, 401, "UNAUTHORIZED", "Authentication required.");
      return;
    }

    if (matched === undefined) {
      this.sendError(res, 404, "METHOD_NOT_FOUND", `No route for ${method} ${pathname}`);
      return;
    }

    // Decoded after the token check: a malformed escape is a caller's error to
    // be told about, not something an anonymous caller gets to provoke.
    const params: Record<string, string> = {};
    matched.route.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(matched.captures[index]);
    });

    // The async wrapper is what makes a handler that throws synchronously
    // arrive in the same catch as one that rejects.
    void (async () => await matched.route.handle({ req, res, url, params }))().catch((err) => {
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
   * True when the request may proceed: either no token is configured, or the
   * request carries exactly it.
   *
   * The comparison is constant-time. A `===` on the secret leaks its prefix
   * through response timing, which matters precisely in the case this check
   * exists for — a caller that reached the port from somewhere other than the
   * author's own machine and can retry as often as it likes.
   */
  private isAuthorized(req: http.IncomingMessage): boolean {
    if (this._requiredToken === undefined) {
      return true;
    }
    const header = req.headers.authorization;
    if (header === undefined) {
      return false;
    }
    const match = header.match(/^Bearer (.+)$/);
    if (match === null) {
      return false;
    }
    const presented = Buffer.from(match[1], "utf8");
    const expected = Buffer.from(this._requiredToken, "utf8");
    // timingSafeEqual throws on a length mismatch, which would itself disclose
    // the secret's length — so the lengths are compared first and the result is
    // folded in, never short-circuited.
    const sameLength = presented.length === expected.length;
    return (
      crypto.timingSafeEqual(sameLength ? presented : expected, expected) &&
      sameLength
    );
  }

  /**
   * The first route whose method and compiled pattern accept this request.
   *
   * Every template is anchored and a parameter never crosses a `/`, so no two
   * entries can accept the same path and the order of the table is not part of
   * its meaning.
   */
  private matchRoute(
    method: string,
    pathname: string,
  ): { route: CompiledRoute; captures: string[] } | undefined {
    for (const route of this._routes) {
      if (route.method !== method) {
        continue;
      }
      const match = pathname.match(route.pattern);
      if (match !== null) {
        return { route, captures: match.slice(1) };
      }
    }
    return undefined;
  }

  /**
   * Everything this server serves, in one list.
   *
   * This is the route table, not a description of one: dispatch answers from
   * exactly these entries, so a route that is not here is not served, and
   * `routes` can hand the same list to a caller asking what this server
   * publishes. The path strings are the ones openapi.yaml declares.
   */
  private buildRoutes(): AgentApiRoute[] {
    const instanceIdentity = (): PingResponse => ({
      protocolVersion: AGENT_API_PROTOCOL_VERSION,
      instanceId: this._instanceId,
      pid: process.pid,
    });

    // The same document in two encodings, because importers are not uniformly
    // willing to read YAML: the Custom GPT builder fetched the YAML URL and
    // silently did nothing, while it accepted an otherwise equivalent JSON
    // document served as application/json. YAML remains the committed source —
    // both encodings are written from the one parsed document, so the two
    // cannot disagree.
    const serveSpecification =
      (asJson: boolean) =>
      ({ req, res }: RouteContext): void => {
        // Built before anything is committed to the wire: a body that failed
        // half-written would leave a 200 already sent and nothing to correct
        // it with.
        const specification = this.specificationForRequest(req, asJson);
        res.writeHead(200, {
          "Content-Type": asJson ? "application/json" : "application/yaml",
        });
        res.end(specification);
      };

    return [
      { method: "GET", path: "/openapi.yaml", anonymous: true, handle: serveSpecification(false) },
      { method: "GET", path: "/openapi.json", anonymous: true, handle: serveSpecification(true) },

      // Health/system routes
      { method: "GET", path: "/health", handle: ({ res }) => this.sendJson(res, 200, instanceIdentity()) },
      { method: "GET", path: "/v1/ping", handle: ({ res }) => this.sendJson(res, 200, instanceIdentity()) },
      {
        method: "GET",
        path: "/v1/capabilities",
        handle: ({ res }) =>
          this.sendJson(res, 200, {
            protocolVersion: AGENT_API_PROTOCOL_VERSION,
            supportedPatchFormats: ["unified-diff"],
            reviewSupport: true,
            retractionSupport: true,
            maxRequestSize: 25 * 1024 * 1024,
            eventStreamSupport: true,
            eventReplayBufferSize: SSE_REPLAY_BUFFER_SIZE,
            applicationVersion: app.getVersion(),
            instanceId: this._instanceId,
          }),
      },
      { method: "GET", path: "/v1/context", handle: async ({ res }) => await this.handleGetContext(res) },
      { method: "GET", path: "/v1/views", handle: async ({ res }) => await this.handleGetViews(res) },
      { method: "GET", path: "/v1/events", handle: ({ req, res }) => this.handleSseSubscription(req, res) },

      // Workspaces
      { method: "GET", path: "/v1/workspaces", handle: ({ res }) => this.handleGetWorkspaces(res) },
      {
        method: "GET",
        path: "/v1/workspace/files",
        handle: async ({ res }) => await this.handleListWorkspaceFiles(res),
      },
      {
        method: "GET",
        path: "/v1/workspaces/{workspaceId}/documents",
        handle: ({ res, url, params }) =>
          this.handleListWorkspaceDocuments(res, url, params.workspaceId),
      },
      {
        method: "POST",
        path: "/v1/workspaces/{workspaceId}/documents/{documentId}/open",
        handle: async ({ res, params }) =>
          await this.handleOpenDocumentInWorkspace(res, params.workspaceId, params.documentId),
      },

      // Documents
      {
        method: "GET",
        path: "/v1/documents",
        handle: async ({ res, url }) => await this.handleListDocuments(res, url),
      },
      {
        method: "POST",
        path: "/v1/documents",
        handle: async ({ req, res }) => await this.handleOpenDocument(req, res),
      },
      {
        method: "GET",
        path: "/v1/documents/{documentId}",
        handle: async ({ res, params }) => await this.handleGetDocument(res, params.documentId),
      },
      {
        method: "POST",
        path: "/v1/documents/{documentId}/focus",
        handle: async ({ res, params }) => await this.handleFocusDocument(res, params.documentId),
      },
      {
        method: "GET",
        path: "/v1/documents/{documentId}/content",
        handle: ({ res, url, params }) => this.handleReadContent(res, params.documentId, url),
      },
      {
        method: "POST",
        path: "/v1/documents/{documentId}/search",
        handle: async ({ req, res, params }) => await this.handleSearch(req, res, params.documentId),
      },
      {
        method: "POST",
        path: "/v1/documents/{documentId}/proposals",
        handle: async ({ req, res, params }) =>
          await this.handleSubmitProposal(req, res, params.documentId),
      },

      // Reviews
      {
        method: "GET",
        path: "/v1/reviews",
        handle: async ({ res }) => await this.handleListReviews(res),
      },
      {
        method: "GET",
        path: "/v1/reviews/{reviewId}",
        handle: async ({ res, params }) => await this.handleGetReview(res, params.reviewId),
      },
      {
        method: "GET",
        path: "/v1/reviews/{reviewId}/diff",
        handle: async ({ res, params }) => await this.handleGetReviewDiff(res, params.reviewId),
      },
      {
        method: "GET",
        path: "/v1/reviews/{reviewId}/chunks",
        handle: async ({ res, params }) => await this.handleGetReviewChunks(res, params.reviewId),
      },
      ...(["accept", "reject", "hold"] as ChunkDecision[]).map((decision) => ({
        method: "POST",
        path: `/v1/reviews/{reviewId}/chunks/{chunkId}/${decision}`,
        handle: async ({ req, res, params }: RouteContext) =>
          await this.handleDecideChunk(req, res, params.reviewId, params.chunkId, decision),
      })),
      {
        method: "POST",
        path: "/v1/reviews/{reviewId}/comments",
        handle: async ({ req, res, params }) =>
          await this.handleAddReviewComment(req, res, params.reviewId),
      },
      {
        method: "GET",
        path: "/v1/reviews/{reviewId}/packets",
        handle: async ({ res, params }) => await this.handleGetReviewPackets(res, params.reviewId),
      },
      {
        method: "POST",
        path: "/v1/reviews/{reviewId}/accept-all",
        handle: async ({ res, params }) => await this.handleAcceptAllChunks(res, params.reviewId),
      },
      {
        method: "POST",
        path: "/v1/reviews/{reviewId}/clear",
        handle: async ({ res, params }) => await this.handleClearReview(res, params.reviewId),
      },
      {
        method: "GET",
        path: "/v1/reviews/{reviewId}/events",
        handle: async ({ res, url, params }) =>
          await this.handleWaitForReviewEvents(res, params.reviewId, url),
      },

      // Proposals
      {
        method: "POST",
        path: "/v1/proposals/{packetId}/retract",
        handle: async ({ res, params }) =>
          await this.handleRetractProposal(res, params.packetId),
      },
    ];
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

  private async handleListDocuments(res: http.ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get("state");
    if (state !== null && state !== "open") {
      this.sendError(res, 400, "INVALID_PARAMS", "Unsupported state filter");
      return;
    }

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
    url: URL,
    workspaceId: string,
  ): void {
    const workspacePath = workspaceId;
    const knownWorkspaces = this._app.config.get().app.openWorkspaces;
    if (!knownWorkspaces.includes(workspacePath)) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Workspace not found");
      return;
    }

    const query = url.searchParams.get("query");
    const normalizedQuery = query === null ? "" : query.toLowerCase().trim();
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

  private async handleOpenDocumentInWorkspace(
    res: http.ServerResponse,
    workspaceId: string,
    documentId: string,
  ): Promise<void> {
    const workspacePath = workspaceId;
    const knownWorkspaces = this._app.config.get().app.openWorkspaces;
    if (!knownWorkspaces.includes(workspacePath)) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Workspace not found");
      return;
    }
    const filePath = this._documents.getDocumentPath(documentId);
    if (filePath === undefined || !(await this.isDocumentOpenableInWorkspace(filePath, workspacePath))) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document is not part of workspace");
      return;
    }
    await this._documents.openFile(undefined, undefined, filePath, true);
    this.sendJson(res, 200, { focused: true, documentId });
  }

  private async handleOpenDocument(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req);
    const decoded = decodeOpenDocumentRequest(body);
    if (!decoded.ok) {
      this.sendError(res, 400, "INVALID_PARAMS", decoded.message);
      return;
    }
    const request = decoded.value;
    const resolveOpenPath = (uri: string): string | undefined => {
      try {
        const parsedUri = new URL(uri);
        if (parsedUri.protocol !== "safe-file:" && parsedUri.protocol !== "file:") {
          throw new Error("Unsupported protocol");
        }

        let filePath = decodeURIComponent(parsedUri.pathname);
        if (process.platform === "win32" && /^\/[A-Za-z]:/.test(filePath)) {
          filePath = filePath.slice(1);
        }
        return path.resolve(filePath);
      } catch {
        return path.isAbsolute(uri) ? path.resolve(uri) : undefined;
      }
    };

    const filePath = resolveOpenPath(request.uri);
    if (filePath === undefined || !(await this.isDocumentOpenableInCurrentWorkspaces(filePath))) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Path is outside configured workspace scope");
      return;
    }
    try {
      await this._documents.getDocument(filePath);
    } catch {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "File not found");
      return;
    }
    const docId = this._documents.getDocumentId(filePath);
    if (docId === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Could not open document");
      return;
    }
    const summary = await this.getDocumentSummary(docId);
    if (summary === undefined) {
      this.sendError(res, 500, "INTERNAL_ERROR", "Document opened but could not be summarized");
      return;
    }
    this.sendJson(res, 201, summary);
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

  private handleReadContent(res: http.ServerResponse, documentId: string, url: URL): void {
    const parseLine = (input: string | null): number | undefined => {
      if (input === null) {
        return undefined;
      }
      const parsed = parseInt(input, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return undefined;
      }
      return parsed;
    };

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

    const decodedSide = decodeReadSide(url.searchParams.get("side"));
    if (!decodedSide.ok) {
      this.sendError(res, 400, "INVALID_PARAMS", decodedSide.message);
      return;
    }
    const side = decodedSide.value;
    const startLine = url.searchParams.get("startLine");
    const endLine = url.searchParams.get("endLine");

    const result = this._documents.readLiveBuffer(documentId, undefined, undefined);
    if (result === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }

    const requestedStartLine = parseLine(startLine) ?? 1;
    const requestedEndLine = parseLine(endLine) ?? result.lineCount;

    let content = result.content;
    let rangeLineCount = result.lineCount;
    let reviewGeneration: number | undefined;
    const review = this._documents.reviewStore.getReview(documentId);
    if (review !== undefined) {
      reviewGeneration = review.generation;
    }

    let range = applyRange(result.content, result.lineCount, requestedStartLine, requestedEndLine);
    let revision = { version: result.version, sha256: result.sha256 };

    if (side === "reference") {
      if (review !== undefined) {
        const referenceLines = review.referenceText.split("\n");
        rangeLineCount = referenceLines.length;
        const referenceRangeEnd = Math.min(requestedEndLine, rangeLineCount);
        range = applyRange(
          review.referenceText,
          rangeLineCount,
          requestedStartLine,
          referenceRangeEnd,
        );
        reviewGeneration = review.generation;
        revision = { version: review.generation, sha256: sha256Text(review.referenceText) };
      }
    }

    content = range.content;

    const response: ReadDocumentResponse = {
      documentId,
      side,
      revision,
      reviewGeneration,
      range: {
        startLine: range.startLine,
        endLine: range.endLine,
        totalLines: rangeLineCount,
      },
      content,
      truncated: range.truncated,
    };
    if (side === "working") {
      res.setHeader("ETag", `"sha256:${result.sha256}"`);
      this.sendJson(res, 200, { ...response, snapshot: result.snapshot });
      return;
    }
    this.sendJson(res, 200, response);
  }

  private async handleWaitForReviewEvents(
    res: http.ServerResponse,
    reviewId: string,
    url: URL,
  ): Promise<void> {
    const parseNumber = (
      value: string | null,
      fallback: number,
      min: number,
      max: number,
    ): number => {
      if (value === null) {
        return fallback;
      }
      const parsed = parseInt(value, 10);
      if (!Number.isInteger(parsed)) {
        return fallback;
      }
      return Math.max(min, Math.min(max, parsed));
    };

    const waitSeconds = parseNumber(
      url.searchParams.get("waitSeconds") ?? url.searchParams.get("wait"),
      30,
      0,
      120,
    );
    const afterGeneration = Math.max(
      0,
      parseNumber(url.searchParams.get("afterGeneration"), 0, 0, 2 ** 31),
    );

    const documentId = this.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      // A detached review's generation cannot advance — nothing can decide
      // its chunks while its file is closed — so waiting on it would be
      // waiting forever. The refusal names the file to open instead.
      await this.sendReviewLookupFailure(res, reviewId);
      return;
    }

    const current = this._documents.reviewStore.getReviewStatus(documentId);
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
      this._documents.reviewStore.removeListener("*", listener);
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
        const status = this._documents.reviewStore.getReviewStatus(documentId);
        finish({
          reviewId,
          status,
          events: [event],
        });
      }
    };

    this._documents.reviewStore.on("*", listener);
    res.on("close", cleanup);
    timeout = setTimeout(() => {
      const status = this._documents.reviewStore.getReviewStatus(documentId);
      finish({
        reviewId,
        status,
        timedOut: true,
      });
    }, waitSeconds * 1000);
  }

  private async handleSearch(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    documentId: string,
  ): Promise<void> {
    const body = await this.readBody(req);
    const decodedSearch = decodeSearchDocumentRequest(body);
    if (!decodedSearch.ok) {
      this.sendError(res, 400, "INVALID_PARAMS", decodedSearch.message);
      return;
    }
    const searchRequest = decodedSearch.value;
    const result = this._documents.readLiveBuffer(documentId);
    if (result === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    const lines = result.content.split("\n");
    const contextSize = searchRequest.context;
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
      snapshot: result.snapshot,
      revision: { version: result.version, sha256: result.sha256 },
      hits: collected.hits,
      truncated: collected.truncated,
    });
  }

  private async handleSubmitProposal(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    documentId: string,
  ): Promise<void> {
    // No request headers are read here. Concurrency rides in the body, because
    // an OpenAPI consumer that generates calls from the published document
    // drops header parameters and could never satisfy a header requirement.

    // Read and parse the request body
    const body = await this.readBody(req);
    const decodedProposal = decodeSubmitProposalRequest(body);
    if (!decodedProposal.ok) {
      this.sendError(res, 400, "INVALID_PARAMS", decodedProposal.message);
      return;
    }
    const proposal: SubmitProposalRequest = decodedProposal.value;
    const parsedSnapshot = DocumentManager.parseSnapshotToken(proposal.snapshot);
    if (parsedSnapshot === undefined) {
      this.sendError(res, 400, "INVALID_PARAMS", "Invalid snapshot token");
      return;
    }
    if (parsedSnapshot.documentId !== documentId) {
      this.sendError(res, 400, "INVALID_PARAMS", "Snapshot belongs to a different document");
      return;
    }

    const filePath = this._documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    const doc = this._documents.loadedDocuments.find((d) => d.filePath === filePath);
    if (doc === undefined) {
      this.sendError(res, 404, "DOCUMENT_CLOSED", "Document is no longer open");
      return;
    }
    // Submit through the same DocumentManager claim-sequence path the
    // single-patch shape travels — one application path, two wire shapes.
    let result;
    if (proposal.claims !== undefined) {
      result = await this._documents.submitProposalClaims(
        proposal.snapshot,
        proposal.claims,
        proposal.clientRequestId,
        proposal.expectedReviewGeneration,
      );
    } else if (proposal.patch !== undefined) {
      result = await this._documents.submitProposal(
        proposal.snapshot,
        proposal.patch,
        proposal.clientRequestId,
        proposal.description,
        proposal.expectedReviewGeneration,
      );
    } else {
      // The decoder admits exactly the two shapes above.
      this.sendError(res, 400, "INVALID_PARAMS", "patch or claims is required");
      return;
    }

    if (!result.ok) {
      if (result.code === "REVISION_MISMATCH") {
        res.setHeader("ETag", `"sha256:${sha256Text(doc.document.toString())}"`);
        this.sendError(res, 412, "REVISION_MISMATCH", result.message);
      } else if (result.code === "PATCH_INVALID" || result.code === "PATCH_NOT_APPLICABLE") {
        this.sendError(res, 400, result.code, result.message);
      } else if (result.code === "REVIEW_INVALIDATED") {
        this.sendError(res, 409, "REVIEW_INVALIDATED", result.message);
      } else if (result.code === "IDEMPOTENCY_CONFLICT" || result.code === "REVIEW_GENERATION_MISMATCH") {
        this.sendError(res, 409, result.code, result.message);
      } else {
        this.sendError(res, 500, "INTERNAL_ERROR", result.message);
      }
      return;
    }

    // Set the new ETag on the response
    const newSha = sha256Text(
      this._documents.loadedDocuments.find((d) => d.filePath === filePath)?.document.toString() ??
        doc.document.toString(),
    );
    res.setHeader("ETag", `"sha256:${newSha}"`);
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
      ...this._documents.reviewStore.listReviews().map((review) => ({
        ...review,
        attached: true,
      })),
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
      this.sendJson(res, 200, {
        reviewId: detached.reviewId,
        state: classifyReviewState(detached.invalidated, detached.unresolvedChunks),
        generation: detached.generation,
        unresolvedChunks: detached.unresolvedChunks,
        heldChunks: detached.heldChunks,
        packetCount: detached.packets.length,
        comments: detached.comments,
        attached: false,
      });
      return;
    }
    const status = this._documents.reviewStore.getReviewStatus(documentId);
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
    // getReviewStatus just reconciled the holds, so the comments read here
    // already include any orphans that reconciliation surfaced.
    const review = this._documents.reviewStore.getReview(documentId)!;
    this.sendJson(res, 200, {
      ...status,
      comments: review.comments,
      attached: true,
      documentRevision: {
        version: doc.currentVersion,
        sha256: sha256Text(doc.document.toString()),
      },
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
    const diff = this._documents.reviewStore.getReviewDiff(documentId);
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
   * POST /v1/reviews/{reviewId}/chunks/{chunkId}/accept | /reject | /hold
   *
   * The same decision path the editor's buttons use — DocumentManager's
   * decideChunk — so an agent and a human clicking are indistinguishable to
   * the review state machine. The chunkId is content-addressed: if the region
   * changed since the caller listed chunks, the decision fails with
   * CHUNK_NOT_FOUND instead of landing somewhere unintended. Hold alone
   * carries a body — the optional comment attached without adjudicating.
   */
  private async handleDecideChunk(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    reviewId: string,
    chunkId: string,
    decision: ChunkDecision,
  ): Promise<void> {
    let comment: string | undefined;
    if (decision === "hold") {
      const decoded = decodeHoldChunkRequest(await this.readBody(req));
      if (!decoded.ok) {
        this.sendError(res, 400, "INVALID_PARAMS", decoded.message);
        return;
      }
      comment = decoded.value.comment;
    }
    let result = await this._documents.decideChunkAsync(reviewId, chunkId, decision, comment);
    if (!result.ok && result.code === "REVIEW_NOT_FOUND") {
      result = await this._documents.reviewLookupFailure(reviewId);
    }
    if (!result.ok) {
      const status =
        result.code === "REVIEW_NOT_FOUND" || result.code === "CHUNK_NOT_FOUND"
          ? 404
          : result.code === "DOCUMENT_CLOSED" || result.code === "REVIEW_INVALIDATED"
            ? 409
            : 400;
      this.sendError(res, status, result.code, result.message);
      return;
    }
    this.sendJson(res, 200, result);
  }

  /**
   * POST /v1/reviews/{reviewId}/comments — attach a review-level comment.
   * No document text moves, so this goes straight to the store; the
   * generation advance is what wakes the agent's long-poll.
   */
  private async handleAddReviewComment(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    reviewId: string,
  ): Promise<void> {
    const decoded = decodeAddReviewCommentRequest(await this.readBody(req));
    if (!decoded.ok) {
      this.sendError(res, 400, "INVALID_PARAMS", decoded.message);
      return;
    }
    const documentId = this.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      await this.sendReviewLookupFailure(res, reviewId);
      return;
    }
    const result = this._documents.addReviewComment(reviewId, decoded.value.text);
    if (!result.ok) {
      this.sendError(res, 404, result.code, result.message);
      return;
    }
    this.sendJson(res, 200, {
      reviewId: result.reviewId,
      documentId: result.documentId,
      reviewGeneration: result.generation,
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
    const chunks = this._documents.reviewStore.getOutstandingChunks(documentId);
    if (chunks === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
      return;
    }
    const review = this._documents.reviewStore.getReview(documentId)!;
    this.sendJson(res, 200, {
      reviewId: review.reviewId,
      documentId,
      generation: review.generation,
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
        // The sidecar keeps each packet's reference spans alongside the
        // ledger entry; the wire packet is the ledger entry alone.
        packets: detached.packets.map(({ refSpans: _refSpans, ...packet }) => packet),
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
      packets: review.packets,
    });
  }

  /**
   * POST /v1/reviews/{reviewId}/accept-all — accept every chunk of the
   * current partition in one sweep, the mirror of /clear (mass reject).
   * Same decision authority as the editor's Accept-all control.
   */
  private async handleAcceptAllChunks(
    res: http.ServerResponse,
    reviewId: string,
  ): Promise<void> {
    let result = await this._documents.acceptAllChunksAsync(reviewId);
    if (!result.ok && result.code === "REVIEW_NOT_FOUND") {
      result = await this._documents.reviewLookupFailure(reviewId);
    }
    if (!result.ok) {
      const status =
        result.code === "REVIEW_NOT_FOUND"
          ? 404
          : result.code === "DOCUMENT_CLOSED" || result.code === "REVIEW_INVALIDATED"
            ? 409
            : 400;
      this.sendError(res, status, result.code, result.message);
      return;
    }
    this.sendJson(res, 200, result);
  }

  private async handleClearReview(res: http.ServerResponse, reviewId: string): Promise<void> {
    let result = await this._documents.clearReviewAsync(reviewId);
    if (!result.ok && result.code === "REVIEW_NOT_FOUND") {
      result = await this._documents.reviewLookupFailure(reviewId);
    }
    if (!result.ok) {
      this.sendError(
        res,
        result.code === "DOCUMENT_CLOSED" || result.code === "REVIEW_INVALIDATED" ? 409 : 404,
        result.code,
        result.message,
      );
      return;
    }
    this.sendJson(res, 200, {
      reviewId: result.reviewId,
      documentId: result.documentId,
      state: result.state,
      documentRevision: result.documentRevision,
    });
  }

  private async handleRetractProposal(
    res: http.ServerResponse,
    packetId: string,
  ): Promise<void> {
    const result = await this._documents.retractProposal(packetId);
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
      // longer the retractable one, or its file is closed. Restating the
      // first code over the second would tell an agent to clear a review it
      // cannot reach.
      this.sendError(res, 409, result.code, result.message, {
        reviewId: result.reviewId,
        canClearUnresolved: result.canClearUnresolved,
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
        enriched.documentRevision = {
          version: document.currentVersion,
          sha256: sha256Text(document.document.toString()),
        };
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
          enriched.unresolvedChunks = this._documents.reviewStore.countUnresolved(
            enriched.documentId,
          );
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
    const reviewStatus = this._documents.reviewStore.getReviewStatus(documentId);
    return {
      documentId,
      uri: `safe-file://${filePath}`,
      path: filePath,
      name: path.basename(filePath),
      // The wire contract is "markdown" | "code", not the internal enum ordinal.
      type: doc.type === DocumentType.Markdown ? "markdown" : "code",
      dirty: doc.currentVersion !== doc.lastSavedVersion,
      revision: {
        version: doc.currentVersion,
        sha256: sha256Text(content),
      },
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
