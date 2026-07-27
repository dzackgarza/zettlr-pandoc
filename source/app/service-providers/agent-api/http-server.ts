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
 *                  for the Zettlr-Pandoc editor agent. Binds to a
 *                  configurable host:port with bearer authentication,
 *                  ETag-based concurrency, SSE event streaming, and CORS.
 *
 *                  All handlers delegate to the existing DocumentManager,
 *                  ReviewDiffStore, and event sources — the same state
 *                  model used by the JSON-RPC provider.
 *
 *                  Defaults: loopback only, TLS off, disabled unless
 *                  explicitly enabled in config.
 *
 * END HEADER
 */

import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import ProviderContract from '@providers/provider-contract'
import type DocumentManager from '@providers/documents'
import type LogProvider from '@providers/log'
import type { AppServiceContainer } from 'source/app/app-service-container'
import type { AgentApiConfig } from 'source/app/service-providers/config/get-config-template'
import {
  AGENT_API_PROTOCOL_VERSION,
  type AgentEvent,
} from '@dts/common/agent-api'
import { DP_EVENTS } from '@dts/common/documents'
import { sha256Text } from 'source/app/util/review-diff'

const SSE_REPLAY_BUFFER_SIZE = 100

// ============================================================================
// AgentHTTPProvider
// ============================================================================

export default class AgentHTTPProvider extends ProviderContract {
  private _server: http.Server | https.Server | undefined
  private _token: string
  private _instanceId: string
  private _config: AgentApiConfig
  private _sseClients: Set<http.ServerResponse> = new Set()
  private _eventReplayBuffer: AgentEvent[] = []
  private _openApiYaml: string

  constructor (
    private readonly _log: LogProvider,
    private readonly _documents: DocumentManager,
    private readonly _app: AppServiceContainer,
  ) {
    super()
    this._token = crypto.randomBytes(32).toString('hex')
    this._instanceId = crypto.randomUUID()
    const fullConfig = _app.config.get()
    this._config = fullConfig.agentApi ?? {
      enabled: false,
      host: '127.0.0.1',
      port: 23119,
      remoteAccess: false,
      tls: { enabled: false },
      cors: { allowedOrigins: [] },
    }
    // Load the OpenAPI YAML spec
    try {
      this._openApiYaml = fs.readFileSync(
        path.join(__dirname, 'openapi.yaml'),
        'utf8',
      )
    } catch {
      this._openApiYaml = ''
    }
  }

  async boot (): Promise<void> {
    if (!this._config.enabled) {
      this._log.info('[AgentHTTPProvider] Disabled by config, skipping boot')
      return
    }

    // Validate remote-access safety constraints
    const isLoopback =
      this._config.host === '127.0.0.1' ||
      this._config.host === '::1' ||
      this._config.host === 'localhost'
    if (this._config.remoteAccess && !isLoopback) {
      if (!this._config.tls.enabled) {
        this._log.error(
          '[AgentHTTPProvider] Refusing to bind non-loopback without TLS. Set agentApi.tls.enabled = true.',
        )
        return
      }
    }

    // Rotate token on every start
    this._token = crypto.randomBytes(32).toString('hex')

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handleRequest(req, res)
    }

    if (this._config.tls.enabled) {
      const tlsCert = this._config.tls.certPath
      const tlsKey = this._config.tls.keyPath
      if (tlsCert === undefined || tlsKey === undefined) {
        this._log.error(
          '[AgentHTTPProvider] TLS enabled but cert/key paths missing',
        )
        return
      }
      this._server = https.createServer(
        {
          cert: fs.readFileSync(tlsCert),
          key: fs.readFileSync(tlsKey),
        },
        handler,
      )
    } else {
      this._server = http.createServer(handler)
    }

    await new Promise<void>((resolve, reject) => {
      this._server!.listen(this._config.port, this._config.host, () => {
        this._log.info(
          `[AgentHTTPProvider] Listening on ${this._config.tls.enabled ? 'https' : 'http'}://${this._config.host}:${this._config.port}`,
        )
        resolve()
      })
      this._server!.on('error', reject)
    })

    // Subscribe to review store events
    this._documents.reviewStore.on('*', (event: AgentEvent) => {
      this.broadcastSseEvent(event)
    })

    // Subscribe to document-level events
    this._documents.on(DP_EVENTS.ACTIVE_FILE, (context: unknown) => {
      const ctx = context as { filePath?: string }
      this.broadcastSseEvent({
        event: 'focus.changed',
        timestamp: new Date().toISOString(),
        documentId:
          ctx.filePath !== undefined
            ? this._documents.getDocumentId(ctx.filePath)
            : undefined,
      })
    })
    this._documents.on(DP_EVENTS.CHANGE_FILE_STATUS, (context: unknown) => {
      const ctx = context as { filePath?: string }
      this.broadcastSseEvent({
        event: 'document.changed',
        timestamp: new Date().toISOString(),
        documentId:
          ctx.filePath !== undefined
            ? this._documents.getDocumentId(ctx.filePath)
            : undefined,
      })
    })
    this._documents.on(DP_EVENTS.CLOSE_FILE, (context: unknown) => {
      const ctx = context as { filePath?: string }
      this.broadcastSseEvent({
        event: 'document.closed',
        timestamp: new Date().toISOString(),
        documentId:
          ctx.filePath !== undefined
            ? this._documents.getDocumentId(ctx.filePath)
            : undefined,
      })
    })
  }

  async shutdown (): Promise<void> {
    // Close all SSE clients
    for (const res of this._sseClients) {
      res.end()
    }
    this._sseClients.clear()

    if (this._server !== undefined) {
      await new Promise<void>((resolve) => {
        this._server?.close(() => resolve())
      })
      this._server = undefined
    }
  }

  // ==========================================================================
  // Request handling
  // ==========================================================================

  private handleRequest (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // CORS headers
    if (this._config.cors.allowedOrigins.length > 0) {
      const origin = req.headers.origin
      if (
        origin !== undefined &&
        this._config.cors.allowedOrigins.includes(origin)
      ) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type, If-Match, Idempotency-Key',
        )
      }
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Serve the OpenAPI spec without authentication
    if (req.url === '/openapi.yaml' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/yaml' })
      res.end(this._openApiYaml)
      return
    }

    // Bearer authentication
    const authHeader = req.headers.authorization
    if (authHeader === undefined || !authHeader.startsWith('Bearer ')) {
      this.sendError(res, 401, 'UNAUTHORIZED', 'Bearer token required')
      return
    }
    const token = authHeader.slice('Bearer '.length).trim()
    if (token !== this._token) {
      this.sendError(res, 401, 'UNAUTHORIZED', 'Invalid token')
      return
    }

    // Route dispatch
    const url = new URL(req.url ?? '/', `http://${this._config.host}`)
    const pathname = url.pathname
    const method = req.method ?? 'GET'

    this.dispatch(req, res, method, pathname, url).catch((err) => {
      this._log.error(`[AgentHTTPProvider] Unhandled error: ${err}`)
      this.sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
    })
  }

  private async dispatch (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    pathname: string,
    url: URL,
  ): Promise<void> {
    // Health/system routes
    if (pathname === '/v1/ping' && method === 'GET') {
      return this.sendJson(res, 200, {
        protocolVersion: AGENT_API_PROTOCOL_VERSION,
        instanceId: this._instanceId,
        pid: process.pid,
      })
    }
    if (pathname === '/v1/capabilities' && method === 'GET') {
      return this.sendJson(res, 200, {
        protocolVersion: AGENT_API_PROTOCOL_VERSION,
        supportedPatchFormats: ['unified-diff'],
        reviewSupport: true,
        retractionSupport: true,
        maxRequestSize: 25 * 1024 * 1024,
        eventStreamSupport: true,
        applicationVersion: app.getVersion(),
        instanceId: this._instanceId,
      })
    }
    if (pathname === '/v1/context' && method === 'GET') {
      return this.handleGetContext(res)
    }
    if (pathname === '/v1/documents' && method === 'GET') {
      return this.handleListDocuments(res)
    }
    if (pathname === '/v1/documents' && method === 'POST') {
      return this.handleOpenDocument(req, res)
    }
    if (pathname === '/v1/events' && method === 'GET') {
      return this.handleSseSubscription(res)
    }

    // Document-scoped routes: /v1/documents/{documentId}...
    const docMatch = pathname.match(/^\/v1\/documents\/([^/]+)(\/.*)?$/)
    if (docMatch !== null) {
      const documentId = decodeURIComponent(docMatch[1])
      const subPath = docMatch[2]

      if (subPath === undefined && method === 'GET') {
        return this.handleGetDocument(res, documentId)
      }
      if (subPath === '/focus' && method === 'POST') {
        return this.handleFocusDocument(res, documentId)
      }
      if (subPath === '/content' && method === 'GET') {
        return this.handleReadContent(res, documentId, url)
      }
      if (subPath === '/search' && method === 'POST') {
        return this.handleSearch(req, res, documentId)
      }
      if (subPath === '/proposals' && method === 'POST') {
        return this.handleSubmitProposal(req, res, documentId)
      }
    }

    // Review-scoped routes: /v1/reviews/{reviewId}...
    const reviewMatch = pathname.match(/^\/v1\/reviews\/([^/]+)(\/.*)?$/)
    if (reviewMatch !== null) {
      const reviewId = decodeURIComponent(reviewMatch[1])
      const subPath = reviewMatch[2]

      if (subPath === undefined && method === 'GET') {
        return this.handleGetReview(res, reviewId)
      }
      if (subPath === '/diff' && method === 'GET') {
        return this.handleGetReviewDiff(res, reviewId)
      }
      if (subPath === '/chunks' && method === 'GET') {
        return this.handleGetReviewChunks(res, reviewId)
      }
      if (subPath === '/packets' && method === 'GET') {
        return this.handleGetReviewPackets(res, reviewId)
      }
      if (subPath === '/clear' && method === 'POST') {
        return this.handleClearReview(res, reviewId)
      }
    }

    if (pathname === '/v1/reviews' && method === 'GET') {
      return this.handleListReviews(res)
    }

    // Proposal retraction: /v1/proposals/{packetId}/retract
    const retractMatch = pathname.match(/^\/v1\/proposals\/([^/]+)\/retract$/)
    if (retractMatch !== null && method === 'POST') {
      return this.handleRetractProposal(
        res,
        decodeURIComponent(retractMatch[1]),
      )
    }

    this.sendError(res, 404, 'NOT_FOUND', `No route for ${method} ${pathname}`)
  }

  // ==========================================================================
  // Route handlers
  // ==========================================================================

  private handleGetContext (res: http.ServerResponse): void {
    const focusedView = this._documents.getFocusedView()
    const focusedDocSummary =
      focusedView?.documentId !== undefined
        ? this.getDocumentSummary(focusedView.documentId)
        : undefined
    const openDocuments: unknown[] = []
    for (const doc of this._documents.loadedDocuments) {
      const summary = this.getDocumentSummary(doc.documentId)
      if (summary !== undefined) {
        openDocuments.push(summary)
      }
    }
    this.sendJson(res, 200, {
      focusedView: focusedView
        ? {
          viewId: focusedView.viewId,
          windowId: focusedView.windowId,
          leafId: focusedView.leafId,
          documentId: focusedView.documentId ?? '',
        }
        : undefined,
      focusedDocument: focusedDocSummary,
      openDocuments,
    })
  }

  private handleListDocuments (res: http.ServerResponse): void {
    const documents: unknown[] = []
    for (const doc of this._documents.loadedDocuments) {
      const summary = this.getDocumentSummary(doc.documentId)
      if (summary !== undefined) {
        documents.push(summary)
      }
    }
    this.sendJson(res, 200, { documents })
  }

  private async handleOpenDocument (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await this.readBody(req)
    let parsed: { uri?: string }
    try {
      parsed = JSON.parse(body) as { uri?: string }
    } catch {
      this.sendError(res, 400, 'INVALID_PARAMS', 'Invalid JSON body')
      return
    }
    if (parsed.uri === undefined) {
      this.sendError(res, 400, 'INVALID_PARAMS', 'uri is required')
      return
    }
    // Convert URI to file path
    let filePath: string
    try {
      const uri = new URL(parsed.uri)
      filePath = uri.pathname
    } catch {
      filePath = parsed.uri
    }
    try {
      await this._documents.getDocument(filePath)
    } catch {
      this.sendError(res, 404, 'DOCUMENT_NOT_FOUND', 'File not found')
      return
    }
    const docId = this._documents.getDocumentId(filePath)
    if (docId === undefined) {
      this.sendError(res, 404, 'DOCUMENT_NOT_FOUND', 'Could not open document')
      return
    }
    const summary = this.getDocumentSummary(docId)
    this.sendJson(res, 201, summary)
  }

  private handleGetDocument (
    res: http.ServerResponse,
    documentId: string,
  ): void {
    const summary = this.getDocumentSummary(documentId)
    if (summary === undefined) {
      this.sendError(res, 404, 'DOCUMENT_NOT_FOUND', 'Document not found')
      return
    }
    this.sendJson(res, 200, summary)
  }

  private async handleFocusDocument (
    res: http.ServerResponse,
    documentId: string,
  ): Promise<void> {
    const filePath = this._documents.getDocumentPath(documentId)
    if (filePath === undefined) {
      this.sendError(res, 404, 'DOCUMENT_NOT_FOUND', 'Document not found')
      return
    }
    // Focus is a renderer-side action; the provider can open the file
    await this._documents.openFile(undefined, undefined, filePath, true)
    this.sendJson(res, 200, { focused: true, documentId })
  }

  private handleReadContent (
    res: http.ServerResponse,
    documentId: string,
    url: URL,
  ): void {
    const side = (url.searchParams.get('side') ?? 'working') as
      | 'working'
      | 'reference'
    const startLine = url.searchParams.get('startLine')
    const endLine = url.searchParams.get('endLine')

    const result = this._documents.readLiveBuffer(
      documentId,
      startLine !== null ? parseInt(startLine, 10) : undefined,
      endLine !== null ? parseInt(endLine, 10) : undefined,
    )
    if (result === undefined) {
      this.sendError(res, 404, 'DOCUMENT_NOT_FOUND', 'Document not found')
      return
    }

    let content = result.content
    let reviewGeneration: number | undefined
    if (side === 'reference') {
      const review = this._documents.reviewStore.getReview(documentId)
      if (review !== undefined) {
        content = review.referenceText
        reviewGeneration = review.generation
      }
    }

    const etag = `"sha256:${result.sha256}"`
    res.setHeader('ETag', etag)
    this.sendJson(res, 200, {
      documentId,
      side,
      snapshot: result.snapshot,
      revision: { version: result.version, sha256: result.sha256 },
      reviewGeneration,
      range: {
        startLine: startLine !== null ? parseInt(startLine, 10) : 1,
        endLine: endLine !== null ? parseInt(endLine, 10) : result.lineCount,
        totalLines: result.lineCount,
      },
      content,
      truncated: result.truncated,
    })
  }

  private async handleSearch (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    documentId: string,
  ): Promise<void> {
    const body = await this.readBody(req)
    let parsed: { literal?: string; context?: number }
    try {
      parsed = JSON.parse(body) as { literal?: string; context?: number }
    } catch {
      this.sendError(res, 400, 'INVALID_PARAMS', 'Invalid JSON body')
      return
    }
    if (parsed.literal === undefined) {
      this.sendError(res, 400, 'INVALID_PARAMS', 'literal is required')
      return
    }
    const result = this._documents.readLiveBuffer(documentId)
    if (result === undefined) {
      this.sendError(res, 404, 'DOCUMENT_NOT_FOUND', 'Document not found')
      return
    }
    const lines = result.content.split('\n')
    const contextSize = parsed.context ?? 3
    const hits: unknown[] = []
    const lowerLiteral = parsed.literal.toLowerCase()
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase()
      let col = 0
      while (col < lower.length) {
        const found = lower.indexOf(lowerLiteral, col)
        if (found < 0) {
          break
        }
        hits.push({
          line: i + 1,
          column: found + 1,
          length: parsed.literal.length,
          contextBefore: lines
            .slice(Math.max(0, i - contextSize), i)
            .join('\n'),
          contextAfter: lines
            .slice(i + 1, Math.min(lines.length, i + 1 + contextSize))
            .join('\n'),
        })
        col = found + parsed.literal.length
      }
    }
    this.sendJson(res, 200, {
      documentId,
      snapshot: result.snapshot,
      revision: { version: result.version, sha256: result.sha256 },
      hits,
      truncated: false,
    })
  }

  private async handleSubmitProposal (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    documentId: string,
  ): Promise<void> {
    // Extract concurrency headers
    const ifMatch = req.headers['if-match'] as string | undefined
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined

    if (ifMatch === undefined) {
      this.sendError(res, 400, 'INVALID_PARAMS', 'If-Match header is required')
      return
    }
    if (idempotencyKey === undefined) {
      this.sendError(
        res,
        400,
        'INVALID_PARAMS',
        'Idempotency-Key header is required',
      )
      return
    }

    // Verify the ETag matches the current document revision
    const etagMatch = ifMatch.match(/^"sha256:([a-f0-9]{64})"$/i)
    if (etagMatch === null) {
      this.sendError(
        res,
        400,
        'INVALID_PARAMS',
        'Invalid If-Match ETag format',
      )
      return
    }
    const expectedSha = etagMatch[1]

    const filePath = this._documents.getDocumentPath(documentId)
    if (filePath === undefined) {
      this.sendError(res, 404, 'DOCUMENT_NOT_FOUND', 'Document not found')
      return
    }
    const doc = this._documents.loadedDocuments.find(
      (d) => d.filePath === filePath,
    )
    if (doc === undefined) {
      this.sendError(res, 404, 'DOCUMENT_CLOSED', 'Document is no longer open')
      return
    }
    const currentContent = doc.document.toString()
    const currentSha = sha256Text(currentContent)
    if (currentSha !== expectedSha) {
      res.setHeader('ETag', `"sha256:${currentSha}"`)
      this.sendError(
        res,
        412,
        'REVISION_MISMATCH',
        'The document changed after the read. The current ETag is in the response header.',
        {
          expected: { version: doc.currentVersion, sha256: expectedSha },
          actual: { version: doc.currentVersion, sha256: currentSha },
        },
      )
      return
    }

    // Read and parse the request body
    const body = await this.readBody(req)
    let parsed: {
      snapshot: string;
      patchFormat: 'unified-diff';
      patch: string;
      description?: string;
      expectedReviewGeneration?: number;
    }
    try {
      parsed = JSON.parse(body) as typeof parsed
    } catch {
      this.sendError(res, 400, 'INVALID_PARAMS', 'Invalid JSON body')
      return
    }

    // Submit through the same DocumentManager.submitProposal path
    const result = await this._documents.submitProposal(
      parsed.snapshot,
      parsed.patch,
      idempotencyKey,
      parsed.description,
    )

    if (!result.ok) {
      if (result.code === 'REVISION_MISMATCH') {
        res.setHeader('ETag', `"sha256:${currentSha}"`)
        this.sendError(res, 412, 'REVISION_MISMATCH', result.message)
      } else if (
        result.code === 'PATCH_INVALID' ||
        result.code === 'PATCH_NOT_APPLICABLE'
      ) {
        this.sendError(res, 400, result.code, result.message)
      } else if (result.code === 'REVIEW_INVALIDATED') {
        this.sendError(res, 409, 'REVIEW_INVALIDATED', result.message)
      } else {
        this.sendError(res, 500, 'INTERNAL_ERROR', result.message)
      }
      return
    }

    // Set the new ETag on the response
    const newSha = sha256Text(
      this._documents.loadedDocuments
        .find((d) => d.filePath === filePath)
        ?.document.toString() ?? currentContent,
    )
    res.setHeader('ETag', `"sha256:${newSha}"`)
    this.sendJson(res, 200, {
      packetId: result.packetId,
      reviewId: result.reviewId,
      documentId: result.documentId,
      documentRevision: result.documentRevision,
      reviewGeneration: result.reviewGeneration,
      unresolvedChunks: result.unresolvedChunks,
      state: result.state,
    })
  }

  private handleListReviews (res: http.ServerResponse): void {
    const reviews = this._documents.reviewStore.listReviews()
    this.sendJson(res, 200, { reviews })
  }

  private handleGetReview (res: http.ServerResponse, reviewId: string): void {
    const documentId = this.findDocumentIdByReviewId(reviewId)
    if (documentId === undefined) {
      this.sendError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found')
      return
    }
    const status = this._documents.reviewStore.getReviewStatus(documentId)
    if (status === undefined) {
      this.sendError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found')
      return
    }
    const filePath = this._documents.getDocumentPath(documentId)
    const doc =
      filePath !== undefined
        ? this._documents.loadedDocuments.find((d) => d.filePath === filePath)
        : undefined
    this.sendJson(res, 200, {
      ...status,
      documentRevision: doc
        ? {
          version: doc.currentVersion,
          sha256: sha256Text(doc.document.toString()),
        }
        : { version: 0, sha256: '' },
    })
  }

  private handleGetReviewDiff (
    res: http.ServerResponse,
    reviewId: string,
  ): void {
    const documentId = this.findDocumentIdByReviewId(reviewId)
    if (documentId === undefined) {
      this.sendError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found')
      return
    }
    const diff = this._documents.reviewStore.getReviewDiff(documentId)
    if (diff === undefined) {
      this.sendError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found')
      return
    }
    const review = this._documents.reviewStore.getReview(documentId)!
    this.sendJson(res, 200, {
      reviewId: review.reviewId,
      documentId,
      patch: diff,
      generation: review.generation,
    })
  }

  private handleGetReviewChunks (
    res: http.ServerResponse,
    reviewId: string,
  ): void {
    const documentId = this.findDocumentIdByReviewId(reviewId)
    if (documentId === undefined) {
      this.sendError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found')
      return
    }
    const chunks = this._documents.reviewStore.getOutstandingChunks(documentId)
    if (chunks === undefined) {
      this.sendError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found')
      return
    }
    const review = this._documents.reviewStore.getReview(documentId)!
    this.sendJson(res, 200, {
      reviewId: review.reviewId,
      documentId,
      generation: review.generation,
      chunks,
    })
  }

  private handleGetReviewPackets (
    res: http.ServerResponse,
    reviewId: string,
  ): void {
    const documentId = this.findDocumentIdByReviewId(reviewId)
    if (documentId === undefined) {
      this.sendError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found')
      return
    }
    const review = this._documents.reviewStore.getReview(documentId)
    if (review === undefined) {
      this.sendError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found')
      return
    }
    this.sendJson(res, 200, {
      reviewId: review.reviewId,
      documentId,
      packets: review.packets,
    })
  }

  private handleClearReview (res: http.ServerResponse, reviewId: string): void {
    const documentId = this.findDocumentIdByReviewId(reviewId)
    if (documentId === undefined) {
      this.sendError(res, 404, 'REVIEW_NOT_FOUND', 'Review not found')
      return
    }
    const result = this._documents.reviewStore.clearUnresolved(documentId)
    if (!result.ok) {
      this.sendError(res, 404, 'REVIEW_NOT_FOUND', result.message)
      return
    }
    const filePath = this._documents.getDocumentPath(documentId)
    const doc =
      filePath !== undefined
        ? this._documents.loadedDocuments.find((d) => d.filePath === filePath)
        : undefined
    this.sendJson(res, 200, {
      reviewId: result.reviewId,
      documentId,
      state: result.state,
      documentRevision: doc
        ? {
          version: doc.currentVersion,
          sha256: sha256Text(doc.document.toString()),
        }
        : { version: 0, sha256: '' },
    })
  }

  private handleRetractProposal (
    res: http.ServerResponse,
    packetId: string,
  ): void {
    const result = this._documents.reviewStore.retractPacket(packetId)
    if (result.ok) {
      this.sendJson(res, 200, {
        retracted: true,
        packetId: result.packetId,
        reviewId: result.reviewId,
        reviewGeneration: result.generation,
        unresolvedChunks: result.unresolvedChunks,
      })
    } else {
      this.sendError(res, 409, 'PACKET_NOT_RETRACTABLE', result.message, {
        reviewId: result.reviewId,
        canClearUnresolved: true,
      })
    }
  }

  // ==========================================================================
  // SSE event streaming
  // ==========================================================================

  private handleSseSubscription (res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    // Send an initial comment to flush the response headers
    res.write(': connected\n\n')
    // Replay buffered events
    for (const event of this._eventReplayBuffer) {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    this._sseClients.add(res)
    res.on('close', () => {
      this._sseClients.delete(res)
    })
  }

  private broadcastSseEvent (event: AgentEvent): void {
    // Add to replay buffer
    this._eventReplayBuffer.push(event)
    if (this._eventReplayBuffer.length > SSE_REPLAY_BUFFER_SIZE) {
      this._eventReplayBuffer.shift()
    }
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const res of this._sseClients) {
      if (!res.writableEnded) {
        res.write(data)
      }
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private getDocumentSummary (documentId: string): unknown | undefined {
    const filePath = this._documents.getDocumentPath(documentId)
    if (filePath === undefined) {
      return undefined
    }
    const doc = this._documents.loadedDocuments.find(
      (d) => d.filePath === filePath,
    )
    if (doc === undefined) {
      return undefined
    }
    const content = doc.document.toString()
    const lines = content.split('\n')
    const reviewStatus =
      this._documents.reviewStore.getReviewStatus(documentId)
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
      byteLength: Buffer.byteLength(content, 'utf8'),
      views: [],
      review: reviewStatus ?? undefined,
    }
  }

  private findDocumentIdByReviewId (reviewId: string): string | undefined {
    for (const r of this._documents.reviewStore.listReviews()) {
      if (r.reviewId === reviewId) {
        return r.documentId
      }
    }
    return undefined
  }

  private async readBody (req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8')
        if (data.length > 25 * 1024 * 1024) {
          reject(new Error('Request too large'))
          req.destroy()
        }
      })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
  }

  private sendJson (
    res: http.ServerResponse,
    status: number,
    body: unknown,
  ): void {
    const json = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json, 'utf8'),
    })
    res.end(json)
  }

  private sendError (
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
    data?: unknown,
  ): void {
    const error: Record<string, unknown> = { code, message }
    if (data !== undefined) {
      error.data = data
    }
    const json = JSON.stringify({ error })
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json, 'utf8'),
    })
    res.end(json)
  }
}
