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

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { app } from "electron";
import ProviderContract from "@providers/provider-contract";
import DocumentManager from "@providers/documents";
import type LogProvider from "@providers/log";
import type { AppServiceContainer } from "source/app/app-service-container";
import type { AgentApiConfig } from "source/app/service-providers/config/get-config-template";
import makeSearchRegex from "source/common/util/make-search-regex";
import {
  AGENT_API_PROTOCOL_VERSION,
  type AgentEvent,
} from "@dts/common/agent-api";
import { DP_EVENTS } from "@dts/common/documents";
import { sha256Text } from "source/app/util/review-diff";

const SSE_REPLAY_BUFFER_SIZE = 100;
const SSE_HEARTBEAT_MS = 15000;

type BufferedAgentEvent = AgentEvent & { id: string };

// ============================================================================
// AgentHTTPProvider
// ============================================================================

export default class AgentHTTPProvider extends ProviderContract {
  private _server: http.Server | undefined;
  private _instanceId: string;
  private _config: AgentApiConfig;
  private _sseClients: Set<http.ServerResponse> = new Set();
  private _eventReplayBuffer: BufferedAgentEvent[] = [];
  private _eventSequence = 1;
  private _sseHeartbeat: NodeJS.Timeout | undefined;
  private _openApiYaml = "";

  constructor(
    private readonly _log: LogProvider,
    private readonly _documents: DocumentManager,
    private readonly _app: AppServiceContainer,
  ) {
    super();
    this._instanceId = crypto.randomUUID();
    const fullConfig = _app.config.get();
    if (fullConfig.agentApi === undefined) {
      throw new Error("Agent API configuration is required");
    }
    this._config = fullConfig.agentApi;
    // Load the OpenAPI YAML spec (dev: sibling to this file; packaged: assets/openapi.yaml)
    const candidatePaths = [
      path.join(__dirname, "openapi.yaml"),
      path.join(__dirname, "assets", "openapi.yaml"),
    ];
    for (const p of candidatePaths) {
      try {
        this._openApiYaml = fs.readFileSync(p, "utf8");
        break;
      } catch {
        // try next candidate
      }
    }
    if (this._openApiYaml.length === 0) {
      throw new Error("Agent API OpenAPI specification is required");
    }
  }

  async boot(): Promise<void> {
    if (!this._config.enabled) {
      this._log.info("[AgentHTTPProvider] Disabled by config, skipping boot");
      return;
    }

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handleRequest(req, res);
    };

    this._server = http.createServer(handler);

    await new Promise<void>((resolve, reject) => {
      this._server!.listen(this._config.port, "127.0.0.1", () => {
        this._log.info(
          `[AgentHTTPProvider] Listening on http://127.0.0.1:${this._config.port}`,
        );
        resolve();
      });
      this._server!.on("error", reject);
    });

    // Subscribe to review store events
    this._documents.reviewStore.on("*", (event: AgentEvent) => {
      this.broadcastSseEvent(event);
    });

    // Subscribe to document-level events
    this._documents.on(DP_EVENTS.ACTIVE_FILE, (context: unknown) => {
      const ctx = context as { filePath?: string };
      this.broadcastSseEvent({
        event: "focus.changed",
        timestamp: new Date().toISOString(),
        documentId:
          ctx.filePath !== undefined
            ? this._documents.getDocumentId(ctx.filePath)
            : undefined,
      });
    });
    this._documents.on(DP_EVENTS.CHANGE_FILE_STATUS, (context: unknown) => {
      const ctx = context as { filePath?: string };
      this.broadcastSseEvent({
        event: "document.changed",
        timestamp: new Date().toISOString(),
        documentId:
          ctx.filePath !== undefined
            ? this._documents.getDocumentId(ctx.filePath)
            : undefined,
      });
    });
    this._documents.on(DP_EVENTS.CLOSE_FILE, (context: unknown) => {
      const ctx = context as { filePath?: string };
      this.broadcastSseEvent({
        event: "document.closed",
        timestamp: new Date().toISOString(),
        documentId:
          ctx.filePath !== undefined
            ? this._documents.getDocumentId(ctx.filePath)
            : undefined,
      });
    });
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

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // Serve the OpenAPI spec
    if (req.url === "/openapi.yaml" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/yaml" });
      res.end(this._openApiYaml);
      return;
    }

    // Route dispatch
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    this.dispatch(req, res, method, pathname, url).catch((err) => {
      this._log.error(`[AgentHTTPProvider] Unhandled error: ${err}`);
      this.sendError(res, 500, "INTERNAL_ERROR", "Internal server error");
    });
  }

  private async dispatch(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    pathname: string,
    url: URL,
  ): Promise<void> {
    // Health/system routes
    if (pathname === "/health" && method === "GET") {
      return this.sendJson(res, 200, {
        protocolVersion: AGENT_API_PROTOCOL_VERSION,
        instanceId: this._instanceId,
        pid: process.pid,
      });
    }
    if (pathname === "/v1/ping" && method === "GET") {
      return this.sendJson(res, 200, {
        protocolVersion: AGENT_API_PROTOCOL_VERSION,
        instanceId: this._instanceId,
        pid: process.pid,
      });
    }
    if (pathname === "/v1/capabilities" && method === "GET") {
      return this.sendJson(res, 200, {
        protocolVersion: AGENT_API_PROTOCOL_VERSION,
        supportedPatchFormats: ["unified-diff"],
        reviewSupport: true,
        retractionSupport: true,
        maxRequestSize: 25 * 1024 * 1024,
        eventStreamSupport: true,
        eventReplayBufferSize: SSE_REPLAY_BUFFER_SIZE,
        applicationVersion: app.getVersion(),
        instanceId: this._instanceId,
      });
    }
    if (pathname === "/v1/context" && method === "GET") {
      return this.handleGetContext(res);
    }
    if (pathname === "/v1/views" && method === "GET") {
      return this.handleGetViews(res);
    }
    if (pathname === "/v1/workspaces" && method === "GET") {
      return this.handleGetWorkspaces(res);
    }
    if (pathname === "/v1/documents" && method === "GET") {
      return this.handleListDocuments(res, url);
    }
    if (pathname === "/v1/documents" && method === "POST") {
      return this.handleOpenDocument(req, res);
    }
    if (pathname === "/v1/events" && method === "GET") {
      return this.handleSseSubscription(req, res);
    }

    const workspaceOpenMatch = pathname.match(
      /^\/v1\/workspaces\/([^/]+)\/documents\/([^/]+)\/open$/,
    );
    if (workspaceOpenMatch !== null && method === "POST") {
      return this.handleOpenDocumentInWorkspace(
        res,
        decodeURIComponent(workspaceOpenMatch[1]),
        decodeURIComponent(workspaceOpenMatch[2]),
      );
    }
    const workspaceDocumentsMatch = pathname.match(
      /^\/v1\/workspaces\/([^/]+)\/documents(\/.*)?$/,
    );
    if (workspaceDocumentsMatch !== null) {
      const workspaceId = decodeURIComponent(workspaceDocumentsMatch[1]);
      const workspaceSubPath = workspaceDocumentsMatch[2];
      if (
        (workspaceSubPath === undefined || workspaceSubPath === "/") &&
        method === "GET"
      ) {
        return this.handleListWorkspaceDocuments(res, url, workspaceId);
      }
    }

    // Document-scoped routes: /v1/documents/{documentId}...
    const docMatch = pathname.match(/^\/v1\/documents\/([^/]+)(\/.*)?$/);
    if (docMatch !== null) {
      const documentId = decodeURIComponent(docMatch[1]);
      const subPath = docMatch[2];

      if (subPath === undefined && method === "GET") {
        return this.handleGetDocument(res, documentId);
      }
      if (subPath === "/focus" && method === "POST") {
        return this.handleFocusDocument(res, documentId);
      }
      if (subPath === "/content" && method === "GET") {
        return this.handleReadContent(res, documentId, url);
      }
      if (subPath === "/search" && method === "POST") {
        return this.handleSearch(req, res, documentId);
      }
      if (subPath === "/proposals" && method === "POST") {
        return this.handleSubmitProposal(req, res, documentId);
      }
    }

    // Review-scoped routes: /v1/reviews/{reviewId}...
    const reviewMatch = pathname.match(/^\/v1\/reviews\/([^/]+)(\/.*)?$/);
    if (reviewMatch !== null) {
      const reviewId = decodeURIComponent(reviewMatch[1]);
      const subPath = reviewMatch[2];

      if (subPath === undefined && method === "GET") {
        return this.handleGetReview(res, reviewId);
      }
      if (subPath === "/diff" && method === "GET") {
        return this.handleGetReviewDiff(res, reviewId);
      }
      if (subPath === "/chunks" && method === "GET") {
        return this.handleGetReviewChunks(res, reviewId);
      }
      if (subPath === "/packets" && method === "GET") {
        return this.handleGetReviewPackets(res, reviewId);
      }
      if (subPath === "/clear" && method === "POST") {
        return this.handleClearReview(res, reviewId);
      }
      if (subPath === "/events" && method === "GET") {
        return this.handleWaitForReviewEvents(res, reviewId, url);
      }
    }

    if (pathname === "/v1/reviews" && method === "GET") {
      return this.handleListReviews(res);
    }

    // Proposal retraction: /v1/proposals/{packetId}/retract
    const retractMatch = pathname.match(/^\/v1\/proposals\/([^/]+)\/retract$/);
    if (retractMatch !== null && method === "POST") {
      return this.handleRetractProposal(
        res,
        decodeURIComponent(retractMatch[1]),
      );
    }

    this.sendError(res, 404, "NOT_FOUND", `No route for ${method} ${pathname}`);
  }

  // ==========================================================================
  // Route handlers
  // ==========================================================================

  private handleGetContext(res: http.ServerResponse): void {
    const focusedView = this._documents.getFocusedView();
    const focusedDocSummary =
      focusedView?.documentId !== undefined
        ? this.getDocumentSummary(focusedView.documentId)
        : undefined;
    const openDocuments: unknown[] = [];
    for (const doc of this._documents.loadedDocuments) {
      const summary = this.getDocumentSummary(doc.documentId);
      if (summary !== undefined) {
        openDocuments.push(summary);
      }
    }
    this.sendJson(res, 200, {
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
    });
  }

  private handleListDocuments(res: http.ServerResponse, url: URL): void {
    const state = url.searchParams.get("state");
    if (state !== null && state !== "open") {
      this.sendError(res, 400, "INVALID_PARAMS", "Unsupported state filter");
      return;
    }

    const documents: unknown[] = [];
    for (const doc of this._documents.loadedDocuments) {
      const summary = this.getDocumentSummary(doc.documentId);
      if (summary !== undefined) {
        documents.push(summary);
      }
    }
    this.sendJson(res, 200, { documents });
  }

  private async handleGetViews(res: http.ServerResponse): Promise<void> {
    const focusedView = this._documents.getFocusedView();
    const views: unknown[] = [];
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
          activePath !== undefined
            ? this._documents.getDocumentId(activePath)
            : undefined,
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
    const workspaces = this._app.config
      .get()
      .app.openWorkspaces.map((workspacePath) => ({
        workspaceId: workspacePath,
        path: workspacePath,
      }));
    this.sendJson(res, 200, { workspaces });
  }

  private handleListWorkspaceDocuments(
    res: http.ServerResponse,
    url: URL,
    workspaceId: string,
  ): void {
    const workspacePath = decodeURIComponent(workspaceId);
    const knownWorkspaces = this._app.config.get().app.openWorkspaces;
    if (!knownWorkspaces.includes(workspacePath)) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Workspace not found");
      return;
    }

    const query = url.searchParams.get("query");
    const normalizedQuery = query === null ? "" : query.toLowerCase().trim();
    const documents: unknown[] = [];

    this._documents
      .getFilesForWorkspace(workspacePath)
      .then((paths) => {
        for (const documentPath of paths) {
          const documentId = this._documents.getDocumentId(documentPath);
          if (documentId === undefined) {
            continue;
          }
          if (normalizedQuery.length > 0) {
            const haystack = documentPath.toLowerCase();
            if (!haystack.includes(normalizedQuery)) {
              continue;
            }
          }
          const summary = this.getDocumentSummary(documentId);
          if (summary !== undefined) {
            documents.push({
              ...(summary as Record<string, unknown>),
              workspaceId,
            });
          }
        }
        this.sendJson(res, 200, { workspaceId, documents });
      })
      .catch(() => {
        this.sendError(
          res,
          500,
          "INTERNAL_ERROR",
          "Unable to list workspace documents",
        );
      });
  }

  private async handleOpenDocumentInWorkspace(
    res: http.ServerResponse,
    workspaceId: string,
    documentId: string,
  ): Promise<void> {
    const workspacePath = decodeURIComponent(workspaceId);
    const knownWorkspaces = this._app.config.get().app.openWorkspaces;
    if (!knownWorkspaces.includes(workspacePath)) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Workspace not found");
      return;
    }
    const filePath = this._documents.getDocumentPath(documentId);
    if (filePath === undefined || !filePath.startsWith(workspacePath)) {
      this.sendError(
        res,
        404,
        "DOCUMENT_NOT_FOUND",
        "Document is not part of workspace",
      );
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
    let parsed: { uri?: string };
    try {
      parsed = JSON.parse(body) as { uri?: string };
    } catch {
      this.sendError(res, 400, "INVALID_PARAMS", "Invalid JSON body");
      return;
    }
    if (parsed.uri === undefined) {
      this.sendError(res, 400, "INVALID_PARAMS", "uri is required");
      return;
    }
    const resolveOpenPath = (uri: string): string => {
      try {
        const parsedUri = new URL(uri);
        if (
          parsedUri.protocol !== "safe-file:" &&
          parsedUri.protocol !== "file:"
        ) {
          throw new Error("Unsupported protocol");
        }

        let filePath = decodeURIComponent(parsedUri.pathname);
        if (process.platform === "win32" && /^\/[A-Za-z]:/.test(filePath)) {
          filePath = filePath.slice(1);
        }
        return filePath;
      } catch {
        return uri;
      }
    };

    const filePath = resolveOpenPath(parsed.uri);
    try {
      await this._documents.getDocument(filePath);
    } catch {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "File not found");
      return;
    }
    if (!this.isDocumentOpenableInCurrentWorkspaces(filePath)) {
      this.sendError(
        res,
        404,
        "DOCUMENT_NOT_FOUND",
        "Path is outside configured workspace scope",
      );
      return;
    }
    const docId = this._documents.getDocumentId(filePath);
    if (docId === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Could not open document");
      return;
    }
    const summary = this.getDocumentSummary(docId);
    this.sendJson(res, 201, summary);
  }

  private handleGetDocument(
    res: http.ServerResponse,
    documentId: string,
  ): void {
    const summary = this.getDocumentSummary(documentId);
    if (summary === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    this.sendJson(res, 200, summary);
  }

  private async handleFocusDocument(
    res: http.ServerResponse,
    documentId: string,
  ): Promise<void> {
    const filePath = this._documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    if (!this.isDocumentOpenableInCurrentWorkspaces(filePath)) {
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

  private handleReadContent(
    res: http.ServerResponse,
    documentId: string,
    url: URL,
  ): void {
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

    const side = (url.searchParams.get("side") ?? "working") as
      "working" | "reference";
    const startLine = url.searchParams.get("startLine");
    const endLine = url.searchParams.get("endLine");

    const result = this._documents.readLiveBuffer(
      documentId,
      undefined,
      undefined,
    );
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

    let range = applyRange(
      result.content,
      result.lineCount,
      requestedStartLine,
      requestedEndLine,
    );

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
      }
    }

    content = range.content;

    const etag = `"sha256:${result.sha256}"`;
    res.setHeader("ETag", etag);
    this.sendJson(res, 200, {
      documentId,
      side,
      snapshot: result.snapshot,
      revision: { version: result.version, sha256: result.sha256 },
      reviewGeneration,
      range: {
        startLine: range.startLine,
        endLine: range.endLine,
        totalLines: rangeLineCount,
      },
      content,
      truncated: range.truncated,
    });
  }

  private handleWaitForReviewEvents(
    res: http.ServerResponse,
    reviewId: string,
    url: URL,
  ): void {
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
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
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

    let timeout: NodeJS.Timeout;
    const finish = (status: unknown): void => {
      clearTimeout(timeout);
      if ((res as { writableEnded?: boolean }).writableEnded === true) {
        return;
      }
      this.sendJson(res, 200, status);
    };

    const listener = (event: AgentEvent): void => {
      const eventDocumentId = event.documentId;
      if (eventDocumentId !== documentId || event.reviewId !== reviewId) {
        return;
      }
      if (
        event.reviewGeneration !== undefined &&
        event.reviewGeneration > afterGeneration
      ) {
        this._documents.reviewStore.removeListener("*", listener);
        const status = this._documents.reviewStore.getReviewStatus(documentId);
        finish({
          reviewId,
          status,
          events: [event],
        });
      }
    };

    this._documents.reviewStore.on("*", listener);
    timeout = setTimeout(() => {
      this._documents.reviewStore.removeListener("*", listener);
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
    let parsed: { literal?: string; context?: number };
    try {
      parsed = JSON.parse(body) as { literal?: string; context?: number };
    } catch {
      this.sendError(res, 400, "INVALID_PARAMS", "Invalid JSON body");
      return;
    }
    if (parsed.literal === undefined) {
      this.sendError(res, 400, "INVALID_PARAMS", "literal is required");
      return;
    }
    const result = this._documents.readLiveBuffer(documentId);
    if (result === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    const lines = result.content.split("\n");
    const contextSize = parsed.context ?? 3;
    const hits: unknown[] = [];
    let searchRegex: RegExp;
    try {
      searchRegex = makeSearchRegex(parsed.literal, "g");
    } catch {
      this.sendError(res, 400, "INVALID_PARAMS", "Invalid search pattern");
      return;
    }
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
        hits.push({
          line: i + 1,
          column: found + 1,
          length: hitLength,
          contextBefore: lines
            .slice(Math.max(0, i - contextSize), i)
            .join("\n"),
          contextAfter: lines
            .slice(i + 1, Math.min(lines.length, i + 1 + contextSize))
            .join("\n"),
        });
        if (searchRegex.lastIndex >= lines[i].length) {
          break;
        }
      }
    }
    this.sendJson(res, 200, {
      documentId,
      snapshot: result.snapshot,
      revision: { version: result.version, sha256: result.sha256 },
      hits,
      truncated: false,
    });
  }

  private async handleSubmitProposal(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    documentId: string,
  ): Promise<void> {
    // Extract concurrency headers
    const ifMatch = req.headers["if-match"] as string | undefined;
    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

    if (ifMatch === undefined) {
      this.sendError(res, 400, "INVALID_PARAMS", "If-Match header is required");
      return;
    }
    if (idempotencyKey === undefined) {
      this.sendError(
        res,
        400,
        "INVALID_PARAMS",
        "Idempotency-Key header is required",
      );
      return;
    }

    // Verify the ETag format first
    const etagMatch = ifMatch.match(/^"sha256:([a-f0-9]{64})"$/i);
    if (etagMatch === null) {
      this.sendError(
        res,
        400,
        "INVALID_PARAMS",
        "Invalid If-Match ETag format",
      );
      return;
    }

    // Idempotency lookup BEFORE ETag content validation (spec section 6.2).
    // A retry must return the cached result even if the document changed.
    const existingReview = this._documents.reviewStore.getReview(documentId);
    if (existingReview !== undefined) {
      const existingPacket = existingReview.packets.find(
        (p) => p.clientRequestId === idempotencyKey,
      );
      if (existingPacket !== undefined) {
        const status = this._documents.reviewStore.getReviewStatus(documentId)!;
        const filePath = this._documents.getDocumentPath(documentId);
        const doc =
          filePath !== undefined
            ? this._documents.loadedDocuments.find(
                (d) => d.filePath === filePath,
              )
            : undefined;
        const currentContent = doc?.document.toString() ?? "";
        const currentSha = sha256Text(currentContent);
        res.setHeader("ETag", `"sha256:${currentSha}"`);
        this.sendJson(res, 200, {
          packetId: existingPacket.packetId,
          reviewId: existingReview.reviewId,
          documentId,
          documentRevision: {
            version: doc?.currentVersion ?? 0,
            sha256: currentSha,
          },
          reviewGeneration: status.generation,
          unresolvedChunks: status.unresolvedChunks,
          state: status.state,
        });
        return;
      }
    }

    // Read and parse the request body
    const body = await this.readBody(req);
    let parsed: {
      snapshot: string;
      patchFormat: "unified-diff";
      patch: string;
      description?: string;
      expectedReviewGeneration?: number;
    };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      this.sendError(res, 400, "INVALID_PARAMS", "Invalid JSON body");
      return;
    }
    if (typeof parsed.patchFormat !== "string") {
      this.sendError(
        res,
        400,
        "INVALID_PARAMS",
        "patchFormat is required and must be unified-diff",
      );
      return;
    }
    if (parsed.patchFormat !== "unified-diff") {
      this.sendError(res, 400, "INVALID_PARAMS", "Unsupported patch format");
      return;
    }
    if (
      typeof parsed.snapshot !== "string" ||
      typeof parsed.patch !== "string"
    ) {
      this.sendError(
        res,
        400,
        "INVALID_PARAMS",
        "snapshot and patch are required",
      );
      return;
    }
    const parsedSnapshot = DocumentManager.parseSnapshotToken(parsed.snapshot);
    if (parsedSnapshot === undefined) {
      this.sendError(res, 400, "INVALID_PARAMS", "Invalid snapshot token");
      return;
    }
    if (parsedSnapshot.documentId !== documentId) {
      this.sendError(
        res,
        400,
        "INVALID_PARAMS",
        "Snapshot belongs to a different document",
      );
      return;
    }

    const expectedSha = etagMatch[1];

    const filePath = this._documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      this.sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
      return;
    }
    const doc = this._documents.loadedDocuments.find(
      (d) => d.filePath === filePath,
    );
    if (doc === undefined) {
      this.sendError(res, 404, "DOCUMENT_CLOSED", "Document is no longer open");
      return;
    }
    const currentContent = doc.document.toString();
    const currentSha = sha256Text(currentContent);
    if (currentSha !== expectedSha) {
      res.setHeader("ETag", `"sha256:${currentSha}"`);
      this.sendError(
        res,
        412,
        "REVISION_MISMATCH",
        "The document changed after the read. The current ETag is in the response header.",
        {
          expected: { version: doc.currentVersion, sha256: expectedSha },
          actual: { version: doc.currentVersion, sha256: currentSha },
        },
      );
      return;
    }

    if (parsed.expectedReviewGeneration !== undefined) {
      if (
        typeof parsed.expectedReviewGeneration !== "number" ||
        !Number.isInteger(parsed.expectedReviewGeneration)
      ) {
        this.sendError(
          res,
          400,
          "INVALID_PARAMS",
          "expectedReviewGeneration must be an integer",
        );
        return;
      }
      const review = this._documents.reviewStore.getReview(documentId);
      if (
        review === undefined ||
        review.generation !== parsed.expectedReviewGeneration
      ) {
        this.sendError(
          res,
          409,
          "REVIEW_GENERATION_MISMATCH",
          "The review generation no longer matches.",
          {
            expectedReviewGeneration: parsed.expectedReviewGeneration,
            currentReviewGeneration: review?.generation ?? null,
          },
        );
        return;
      }
    }

    // Submit through the same DocumentManager.submitProposal path
    const result = await this._documents.submitProposal(
      parsed.snapshot,
      parsed.patch,
      idempotencyKey,
      parsed.description,
    );

    if (!result.ok) {
      if (result.code === "REVISION_MISMATCH") {
        res.setHeader("ETag", `"sha256:${currentSha}"`);
        this.sendError(res, 412, "REVISION_MISMATCH", result.message);
      } else if (
        result.code === "PATCH_INVALID" ||
        result.code === "PATCH_NOT_APPLICABLE"
      ) {
        this.sendError(res, 400, result.code, result.message);
      } else if (result.code === "REVIEW_INVALIDATED") {
        this.sendError(res, 409, "REVIEW_INVALIDATED", result.message);
      } else {
        this.sendError(res, 500, "INTERNAL_ERROR", result.message);
      }
      return;
    }

    // Set the new ETag on the response
    const newSha = sha256Text(
      this._documents.loadedDocuments
        .find((d) => d.filePath === filePath)
        ?.document.toString() ?? currentContent,
    );
    res.setHeader("ETag", `"sha256:${newSha}"`);
    this.sendJson(res, 200, {
      packetId: result.packetId,
      reviewId: result.reviewId,
      documentId: result.documentId,
      documentRevision: result.documentRevision,
      reviewGeneration: result.reviewGeneration,
      unresolvedChunks: result.unresolvedChunks,
      state: result.state,
    });
  }

  private handleListReviews(res: http.ServerResponse): void {
    const reviews = this._documents.reviewStore.listReviews();
    this.sendJson(res, 200, { reviews });
  }

  private handleGetReview(res: http.ServerResponse, reviewId: string): void {
    const documentId = this.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
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
    this.sendJson(res, 200, {
      ...status,
      documentRevision: doc
        ? {
            version: doc.currentVersion,
            sha256: sha256Text(doc.document.toString()),
          }
        : { version: 0, sha256: "" },
    });
  }

  private handleGetReviewDiff(
    res: http.ServerResponse,
    reviewId: string,
  ): void {
    const documentId = this.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
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

  private handleGetReviewChunks(
    res: http.ServerResponse,
    reviewId: string,
  ): void {
    const documentId = this.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
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

  private handleGetReviewPackets(
    res: http.ServerResponse,
    reviewId: string,
  ): void {
    const documentId = this.findDocumentIdByReviewId(reviewId);
    if (documentId === undefined) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", "Review not found");
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

  private handleClearReview(res: http.ServerResponse, reviewId: string): void {
    const result = this._documents.clearReview(reviewId);
    if (!result.ok) {
      this.sendError(res, 404, "REVIEW_NOT_FOUND", result.message);
      return;
    }
    this.sendJson(res, 200, {
      reviewId: result.reviewId,
      documentId: result.documentId,
      state: result.state,
      documentRevision: result.documentRevision,
    });
  }

  private handleRetractProposal(
    res: http.ServerResponse,
    packetId: string,
  ): void {
    const result = this._documents.retractProposal(packetId);
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
      this.sendError(res, 409, "PACKET_NOT_RETRACTABLE", result.message, {
        reviewId: result.reviewId,
        canClearUnresolved: true,
      });
    }
  }

  // ==========================================================================
  // SSE event streaming
  // ==========================================================================

  private handleSseSubscription(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
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

  private parseLastEventId(
    header: string | string[] | undefined,
  ): number | undefined {
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

  private writeSseEnvelope(
    res: http.ServerResponse,
    event: BufferedAgentEvent,
  ): void {
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
    return {
      ...event,
      id,
    };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private getDocumentSummary(documentId: string): unknown | undefined {
    const filePath = this._documents.getDocumentPath(documentId);
    if (filePath === undefined) {
      return undefined;
    }
    const doc = this._documents.loadedDocuments.find(
      (d) => d.filePath === filePath,
    );
    if (doc === undefined) {
      return undefined;
    }
    const content = doc.document.toString();
    const lines = content.split("\n");
    const reviewStatus =
      this._documents.reviewStore.getReviewStatus(documentId);
    return {
      documentId,
      uri: `safe-file://${filePath}`,
      path: filePath,
      name: path.basename(filePath),
      type: doc.type,
      dirty: doc.currentVersion !== doc.lastSavedVersion,
      revision: {
        version: doc.currentVersion,
        sha256: sha256Text(content),
      },
      lineCount: lines.length,
      byteLength: Buffer.byteLength(content, "utf8"),
      views: [],
      review: reviewStatus ?? undefined,
    };
  }

  private isDocumentOpenableInCurrentWorkspaces(filePath: string): boolean {
    const workspaces = this._app.config.get().app.openWorkspaces;
    if (workspaces.length === 0) {
      return true;
    }
    return workspaces.some((workspacePath) =>
      filePath.startsWith(workspacePath),
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

  private async readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf8");
        if (data.length > 25 * 1024 * 1024) {
          reject(new Error("Request too large"));
          req.destroy();
        }
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
  ): void {
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
    code: string,
    message: string,
    data?: unknown,
  ): void {
    const error: Record<string, unknown> = { code, message };
    if (data !== undefined) {
      error.data = data;
    }
    const json = JSON.stringify({ error });
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json, "utf8"),
    });
    res.end(json);
  }
}
