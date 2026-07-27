/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AgentAPIProvider
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     JSON-RPC 2.0 agent API over a local Unix-domain socket
 *                  (or named pipe on Windows). The main process owns all
 *                  agent-visible state; this provider exposes the
 *                  DocumentManager and ReviewDiffStore through a narrow,
 *                  authenticated transport.
 *
 *                  Spec: Zettlr-Pandoc Editor Agent API and CLI Specification
 *
 * END HEADER
 */

import crypto from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import ProviderContract from '@providers/provider-contract'
import type DocumentManager from '@providers/documents'
import type LogProvider from '@providers/log'
import {
  AGENT_API_PROTOCOL_VERSION,
  RPC_ERROR_CODES,
  type AgentErrorCode,
  type AgentEvent,
  type CapabilitiesResponse,
  type ClearReviewRequest,
  type ClearReviewResponse,
  type DiscoveryRecord,
  type DocumentSummary,
  type DocumentType,
  type EditorContext,
  type EditorViewSummary,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PingResponse,
  type ReadDocumentResponse,
  type ReadSide,
  type RetractProposalRequest,
  type RetractProposalResponse,
  type ReviewChunksResponse,
  type ReviewDiffResponse,
  type ReviewListResponse,
  type ReviewPacketsResponse,
  type ReviewStatusResponse,
  type ReviewSummary,
  type SubmitProposalRequest,
  type SubmitProposalResponse,
} from '@dts/common/agent-api'
import { DP_EVENTS } from '@dts/common/documents'
import { sha256Text } from 'source/app/util/review-diff'

const MAX_REQUEST_BYTES = 25 * 1024 * 1024
const PROTOCOL_VERSION = AGENT_API_PROTOCOL_VERSION

// ============================================================================
// Discovery and socket path helpers
// ============================================================================

export function agentApiSocketPath (
  runtimeDir: string = process.env['XDG_RUNTIME_DIR'] ?? os.tmpdir(),
): string {
  if (process.platform === 'win32') {
    const userId = crypto.randomUUID().slice(0, 8)
    return `\\\\.\\pipe\\zettlr-pandoc-agent-v1-${userId}`
  }
  const dir = path.join(runtimeDir, 'zettlr-pandoc')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'agent-v1.sock')
}

export function agentApiTokenFile (
  userDataPath: string = app.getPath('userData'),
): string {
  return path.join(userDataPath, 'agent-token')
}

export function agentApiDiscoveryFile (
  runtimeDir: string = process.env['XDG_RUNTIME_DIR'] ?? os.tmpdir(),
): string {
  if (process.platform === 'win32') {
    return path.join(app.getPath('userData'), 'agent-discovery.json')
  }
  const dir = path.join(runtimeDir, 'zettlr-pandoc')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'agent-discovery.json')
}

// ============================================================================
// AgentAPIProvider
// ============================================================================

export default class AgentAPIProvider extends ProviderContract {
  private _server: net.Server | undefined
  private _socketPath: string
  private _tokenFile: string
  private _discoveryFile: string
  private _token: string
  private _instanceId: string
  private _subscribers: Map<net.Socket, Set<string>> = new Map()

  constructor (
    private readonly _log: LogProvider,
    private readonly _documents: DocumentManager,
    socketPath?: string,
  ) {
    super()
    this._socketPath = socketPath ?? agentApiSocketPath()
    this._tokenFile = agentApiTokenFile()
    this._discoveryFile = agentApiDiscoveryFile()
    this._token = crypto.randomBytes(32).toString('hex')
    this._instanceId = crypto.randomUUID()
  }

  async boot (): Promise<void> {
    // Rotate the token on every start
    this._token = crypto.randomBytes(32).toString('hex')

    // Write the token file (readable only by the current user)
    fs.writeFileSync(this._tokenFile, this._token, {
      mode: 0o600,
      encoding: 'utf8',
    })

    if (process.platform !== 'win32') {
      fs.rmSync(this._socketPath, { force: true })
    }

    this._server = net.createServer((socket) => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      const server = this._server!
      const onError = (err: Error): void => {
        reject(err)
      }
      server.once('error', onError)
      server.listen(this._socketPath, () => {
        server.off('error', onError)
        // Restrict socket permissions to current user only
        if (process.platform !== 'win32') {
          fs.chmodSync(this._socketPath, 0o600)
        }
        this._log.info(`[AgentAPIProvider] Listening on ${this._socketPath}`)
        resolve()
      })
    })

    // Write the discovery record
    const discovery: DiscoveryRecord = {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this._instanceId,
      pid: process.pid,
      endpoint: this._socketPath,
      tokenFile: this._tokenFile,
    }
    fs.writeFileSync(this._discoveryFile, JSON.stringify(discovery, null, 2), {
      mode: 0o600,
      encoding: 'utf8',
    })

    // Subscribe to review store events for event streaming
    this._documents.reviewStore.on('*', (event: AgentEvent) => {
      this.broadcastEvent(event)
    })

    // Subscribe to document-level events (spec section 11)
    this._documents.on(DP_EVENTS.ACTIVE_FILE, (context: unknown) => {
      const ctx = context as {
        filePath?: string;
        windowId?: string;
        leafId?: string;
      }
      this.broadcastEvent({
        event: 'focus.changed',
        timestamp: new Date().toISOString(),
        documentId:
          ctx.filePath !== undefined
            ? this._documents.getDocumentId(ctx.filePath)
            : undefined,
      })
    })
    this._documents.on(DP_EVENTS.CHANGE_FILE_STATUS, (context: unknown) => {
      const ctx = context as { filePath?: string; status?: string }
      this.broadcastEvent({
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
      this.broadcastEvent({
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
    // Emit shutting-down event to all subscribers
    this.broadcastEvent({
      event: 'app.shutting-down',
      timestamp: new Date().toISOString(),
    })

    if (this._server !== undefined) {
      await new Promise<void>((resolve) => {
        this._server?.close(() => {
          resolve()
        })
      })
      this._server = undefined
    }

    // Clean up discovery and token files
    fs.rmSync(this._socketPath, { force: true })
    fs.rmSync(this._discoveryFile, { force: true })
    fs.rmSync(this._tokenFile, { force: true })

    this._subscribers.clear()
  }

  // ==========================================================================
  // Connection handling
  // ==========================================================================

  private handleConnection (socket: net.Socket): void {
    let buffer = ''
    let bytesRead = 0
    let authenticated = false
    let closed = false

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      if (closed) {
        return
      }
      bytesRead += Buffer.byteLength(chunk, 'utf8')
      if (bytesRead > MAX_REQUEST_BYTES) {
        this.writeError(
          socket,
          null,
          RPC_ERROR_CODES.REQUEST_TOO_LARGE,
          'The request is too large.',
          'REQUEST_TOO_LARGE',
        )
        socket.end()
        closed = true
        return
      }

      buffer += chunk

      // Process complete JSON-RPC messages (newline-delimited)
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (line.length === 0) {
          continue
        }

        void this.processLine(socket, line, authenticated).then((nowAuth) => {
          authenticated = nowAuth
        })
      }
    })
    socket.on('error', (err) => {
      this._log.warning(`[AgentAPIProvider] Socket error: ${err.message}`)
    })
    socket.on('close', () => {
      this._subscribers.delete(socket)
    })
  }

  private async processLine (
    socket: net.Socket,
    line: string,
    authenticated: boolean,
  ): Promise<boolean> {
    let request: JsonRpcRequest
    try {
      request = JSON.parse(line) as JsonRpcRequest
    } catch {
      this.writeError(
        socket,
        null,
        RPC_ERROR_CODES.PARSE_ERROR,
        'Parse error: invalid JSON.',
        'PATCH_INVALID',
      )
      return authenticated
    }

    // The first request must be an auth handshake
    if (!authenticated) {
      if (request.method === 'auth') {
        const token = (request.params as { token?: string })?.token
        if (token === this._token) {
          authenticated = true
          this.writeResult(socket, request.id, { authenticated: true })
        } else {
          this.writeError(
            socket,
            request.id,
            RPC_ERROR_CODES.UNAUTHORIZED,
            'Invalid token.',
            'UNAUTHORIZED',
          )
          socket.end()
        }
        return authenticated
      }
      // Not authenticated — reject all requests except auth
      this.writeError(
        socket,
        request.id,
        RPC_ERROR_CODES.UNAUTHORIZED,
        'Authentication required. Send {method: "auth", params: {token: "..."}} first.',
        'UNAUTHORIZED',
      )
      return authenticated
    }

    // Dispatch the authenticated request
    try {
      const result = await this.dispatch(request)
      if (request.method === 'events/subscribe') {
        this._subscribers.set(socket, new Set())
      }
      if (request.method === 'events/unsubscribe') {
        this._subscribers.delete(socket)
      }
      this.writeResult(socket, request.id, result)
    } catch (err: unknown) {
      const agentError = err as {
        code?: AgentErrorCode;
        message?: string;
        data?: unknown;
      }
      this.writeError(
        socket,
        request.id,
        RPC_ERROR_CODES.INTERNAL_ERROR,
        agentError.message ?? 'Internal error',
        agentError.code ?? 'INTERNAL_ERROR',
        agentError.data,
      )
    }
    return authenticated
  }

  // ==========================================================================
  // Method dispatch
  // ==========================================================================

  private async dispatch (request: JsonRpcRequest): Promise<unknown> {
    switch (request.method) {
      // Section 5.1: System
      case 'ping':
        return this.ping()
      case 'capabilities':
        return this.capabilities()

      // Section 5.2: Context
      case 'context':
        return this.getContext()

      // Section 5.3: Documents
      case 'documents/list':
        return this.listDocuments()
      case 'document/read':
        return this.readDocument(
          request.params as {
            documentId?: string;
            focused?: boolean;
            side?: ReadSide;
            startLine?: number;
            endLine?: number;
          },
        )
      case 'document/search':
        return this.searchDocument(
          request.params as {
            documentId?: string;
            focused?: boolean;
            literal?: string;
            context?: number;
          },
        )

      // Section 6: Proposals
      case 'proposal/submit':
        return await this.submitProposal(
          request.params as SubmitProposalRequest,
        )
      case 'proposal/retract':
        return this.retractProposal(request.params as RetractProposalRequest)

      // Section 8: Reviews
      case 'reviews/list':
        return this.listReviews()
      case 'review/status':
        return this.reviewStatus(
          request.params as {
            documentId?: string;
            reviewId?: string;
            focused?: boolean;
          },
        )
      case 'review/diff':
        return this.reviewDiff(
          request.params as {
            documentId?: string;
            reviewId?: string;
            focused?: boolean;
          },
        )
      case 'review/chunks':
        return this.reviewChunks(
          request.params as {
            documentId?: string;
            reviewId?: string;
            focused?: boolean;
          },
        )
      case 'review/packets':
        return this.reviewPackets(
          request.params as {
            documentId?: string;
            reviewId?: string;
            focused?: boolean;
          },
        )

      // Section 9: Clearing
      case 'review/clear':
        return this.clearReview(request.params as ClearReviewRequest)

      // Section 11: Events
      case 'events/subscribe':
        return { subscribed: true }
      case 'events/unsubscribe':
        return { unsubscribed: true }

      default:
        throw {
          code: 'METHOD_NOT_FOUND' as AgentErrorCode,
          message: `Unknown method: ${request.method}`,
        }
    }
  }

  // ==========================================================================
  // Method implementations
  // ==========================================================================

  private ping (): PingResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this._instanceId,
      pid: process.pid,
    }
  }

  private capabilities (): CapabilitiesResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      supportedPatchFormats: ['unified-diff'],
      reviewSupport: true,
      retractionSupport: true,
      maxRequestSize: MAX_REQUEST_BYTES,
      eventStreamSupport: true,
      applicationVersion: app.getVersion(),
      instanceId: this._instanceId,
    }
  }

  private getContext (): EditorContext {
    const focusedView = this._documents.getFocusedView()
    const focusedDocSummary =
      focusedView?.documentId !== undefined
        ? this.getDocumentSummary(focusedView.documentId)
        : undefined

    const openDocuments: DocumentSummary[] = []
    // Enumerate all open documents across all windows/leaves
    for (const doc of this._documents.loadedDocuments) {
      openDocuments.push(this.getDocumentSummary(doc.documentId)!)
    }

    return {
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
    }
  }

  private getDocumentSummary (documentId: string): DocumentSummary | undefined {
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

    const views: EditorViewSummary[] = []
    // Enumerate panes showing this document
    for (const windowId of this._documents.windowKeys()) {
      for (const leafId of this._documents.leafIds(windowId)) {
        const activeFile = this._documents.getActiveFile(leafId)
        if (activeFile === filePath) {
          const focused = this._documents.getFocusedView()?.leafId === leafId
          views.push({
            viewId: `view-${windowId}-${leafId}`,
            windowId,
            leafId,
            focused,
            active: true,
          })
        }
      }
    }

    return {
      documentId,
      uri: `safe-file://${filePath}`,
      path: filePath,
      name: path.basename(filePath),
      type: doc.type as unknown as DocumentType,
      dirty: doc.currentVersion !== doc.lastSavedVersion,
      revision: {
        version: doc.currentVersion,
        sha256: sha256Text(content),
      },
      lineCount: lines.length,
      byteLength: Buffer.byteLength(content, 'utf8'),
      views,
      review: reviewStatus
        ? {
          reviewId: reviewStatus.reviewId,
          state: reviewStatus.state,
          generation: reviewStatus.generation,
          unresolvedChunks: reviewStatus.unresolvedChunks,
          packetCount: reviewStatus.packetCount,
        }
        : undefined,
    }
  }

  private listDocuments (): { documents: DocumentSummary[] } {
    const documents: DocumentSummary[] = []
    for (const doc of this._documents.loadedDocuments) {
      const summary = this.getDocumentSummary(doc.documentId)
      if (summary !== undefined) {
        documents.push(summary)
      }
    }
    return { documents }
  }

  private readDocument (params: {
    documentId?: string;
    focused?: boolean;
    side?: ReadSide;
    startLine?: number;
    endLine?: number;
  }): ReadDocumentResponse {
    let documentId = params.documentId
    if (params.focused === true) {
      const focused = this._documents.getFocusedView()
      documentId = focused?.documentId
    }
    if (documentId === undefined) {
      throw {
        code: 'NO_FOCUSED_DOCUMENT' as AgentErrorCode,
        message: 'No focused document and no documentId provided.',
      }
    }

    const result = this._documents.readLiveBuffer(
      documentId,
      params.startLine,
      params.endLine,
    )
    if (result === undefined) {
      throw {
        code: 'DOCUMENT_NOT_FOUND' as AgentErrorCode,
        message: 'Document not found or not open.',
      }
    }

    // For reference side, return the review's referenceText
    let content = result.content
    let reviewGeneration: number | undefined
    if (params.side === 'reference') {
      const review = this._documents.reviewStore.getReview(documentId)
      if (review !== undefined) {
        content = review.referenceText
        reviewGeneration = review.generation
      }
    }

    return {
      documentId,
      side: params.side ?? 'working',
      snapshot: result.snapshot,
      revision: {
        version: result.version,
        sha256: result.sha256,
      },
      reviewGeneration,
      range: {
        startLine: params.startLine ?? 1,
        endLine: params.endLine ?? result.lineCount,
        totalLines: result.lineCount,
      },
      content,
      truncated: result.truncated,
    }
  }

  private searchDocument (params: {
    documentId?: string;
    focused?: boolean;
    literal?: string;
    context?: number;
  }): {
    documentId: string;
    snapshot: string;
    revision: { version: number; sha256: string };
    hits: {
      line: number;
      column: number;
      length: number;
      contextBefore: string;
      contextAfter: string;
    }[];
    truncated: boolean;
  } {
    let documentId = params.documentId
    if (params.focused === true) {
      const focused = this._documents.getFocusedView()
      documentId = focused?.documentId
    }
    if (documentId === undefined || params.literal === undefined) {
      throw {
        code: 'INVALID_PARAMS' as AgentErrorCode,
        message: 'documentId (or focused) and literal are required.',
      }
    }

    const result = this._documents.readLiveBuffer(documentId)
    if (result === undefined) {
      throw {
        code: 'DOCUMENT_NOT_FOUND' as AgentErrorCode,
        message: 'Document not found.',
      }
    }

    const lines = result.content.split('\n')
    const contextSize = params.context ?? 3
    const hits: {
      line: number;
      column: number;
      length: number;
      contextBefore: string;
      contextAfter: string;
    }[] = []
    const lowerLiteral = params.literal.toLowerCase()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lower = line.toLowerCase()
      let col = 0
      while (col < lower.length) {
        const found = lower.indexOf(lowerLiteral, col)
        if (found < 0) {
          break
        }
        hits.push({
          line: i + 1,
          column: found + 1,
          length: params.literal.length,
          contextBefore: lines
            .slice(Math.max(0, i - contextSize), i)
            .join('\n'),
          contextAfter: lines
            .slice(i + 1, Math.min(lines.length, i + 1 + contextSize))
            .join('\n'),
        })
        col = found + params.literal.length
      }
    }

    return {
      documentId,
      snapshot: result.snapshot,
      revision: { version: result.version, sha256: result.sha256 },
      hits,
      truncated: false,
    }
  }

  private async submitProposal (
    params: SubmitProposalRequest,
  ): Promise<SubmitProposalResponse> {
    const result = await this._documents.submitProposal(
      params.snapshot,
      params.patch,
      params.clientRequestId,
      params.description,
    )
    if (!result.ok) {
      throw {
        code: result.code as AgentErrorCode,
        message: result.message,
      }
    }
    return {
      packetId: result.packetId,
      reviewId: result.reviewId,
      documentId: result.documentId,
      documentRevision: result.documentRevision,
      reviewGeneration: result.reviewGeneration,
      unresolvedChunks: result.unresolvedChunks,
      state: result.state as SubmitProposalResponse['state'],
    }
  }

  private retractProposal (
    params: RetractProposalRequest,
  ): RetractProposalResponse {
    const result = this._documents.reviewStore.retractPacket(params.packetId)
    if (result.ok) {
      return {
        retracted: true,
        packetId: result.packetId,
        reviewId: result.reviewId,
        reviewGeneration: result.generation,
        unresolvedChunks: result.unresolvedChunks,
      }
    }
    return {
      retracted: false,
      code: 'PACKET_NOT_RETRACTABLE',
      message: result.message,
      reviewId: result.reviewId,
      canClearUnresolved: true,
    }
  }

  private listReviews (): ReviewListResponse {
    const reviews = this._documents.reviewStore.listReviews()
    const summaries: ReviewSummary[] = reviews.map((r) => ({
      reviewId: r.reviewId,
      state: r.state,
      generation: r.generation,
      unresolvedChunks: r.unresolvedChunks,
      packetCount: r.packetCount,
    }))
    return { reviews: summaries }
  }

  private resolveDocumentId (params: {
    documentId?: string;
    reviewId?: string;
    focused?: boolean;
  }): string {
    if (params.documentId !== undefined) {
      return params.documentId
    }
    if (params.reviewId !== undefined) {
      // Find the document that owns this review
      for (const r of this._documents.reviewStore.listReviews()) {
        if (r.reviewId === params.reviewId) {
          return r.documentId
        }
      }
      throw {
        code: 'REVIEW_NOT_FOUND' as AgentErrorCode,
        message: `Review ${params.reviewId} not found.`,
      }
    }
    if (params.focused === true) {
      const focused = this._documents.getFocusedView()
      const docId = focused?.documentId
      if (docId !== undefined) {
        return docId
      }
      throw {
        code: 'NO_FOCUSED_DOCUMENT' as AgentErrorCode,
        message: 'No focused document.',
      }
    }
    throw {
      code: 'INVALID_PARAMS' as AgentErrorCode,
      message: 'documentId, reviewId, or focused is required.',
    }
  }

  private reviewStatus (params: {
    documentId?: string;
    reviewId?: string;
    focused?: boolean;
  }): ReviewStatusResponse {
    const documentId = this.resolveDocumentId(params)
    const status = this._documents.reviewStore.getReviewStatus(documentId)
    if (status === undefined) {
      throw {
        code: 'REVIEW_NOT_FOUND' as AgentErrorCode,
        message: 'No active review for this document.',
      }
    }
    const filePath = this._documents.getDocumentPath(documentId)
    const doc =
      filePath !== undefined
        ? this._documents.loadedDocuments.find((d) => d.filePath === filePath)
        : undefined
    return {
      reviewId: status.reviewId,
      documentId,
      state: status.state,
      generation: status.generation,
      unresolvedChunks: status.unresolvedChunks,
      packetCount: status.packetCount,
      documentRevision: doc
        ? {
          version: doc.currentVersion,
          sha256: sha256Text(doc.document.toString()),
        }
        : { version: 0, sha256: '' },
    }
  }

  private reviewDiff (params: {
    documentId?: string;
    reviewId?: string;
    focused?: boolean;
  }): ReviewDiffResponse {
    const documentId = this.resolveDocumentId(params)
    const diff = this._documents.reviewStore.getReviewDiff(documentId)
    if (diff === undefined) {
      throw {
        code: 'REVIEW_NOT_FOUND' as AgentErrorCode,
        message: 'No active review for this document.',
      }
    }
    const review = this._documents.reviewStore.getReview(documentId)!
    return {
      reviewId: review.reviewId,
      documentId,
      patch: diff,
      generation: review.generation,
    }
  }

  private reviewChunks (params: {
    documentId?: string;
    reviewId?: string;
    focused?: boolean;
  }): ReviewChunksResponse {
    const documentId = this.resolveDocumentId(params)
    const chunks = this._documents.reviewStore.getOutstandingChunks(documentId)
    if (chunks === undefined) {
      throw {
        code: 'REVIEW_NOT_FOUND' as AgentErrorCode,
        message: 'No active review for this document.',
      }
    }
    const review = this._documents.reviewStore.getReview(documentId)!
    return {
      reviewId: review.reviewId,
      documentId,
      generation: review.generation,
      chunks,
    }
  }

  private reviewPackets (params: {
    documentId?: string;
    reviewId?: string;
    focused?: boolean;
  }): ReviewPacketsResponse {
    const documentId = this.resolveDocumentId(params)
    const review = this._documents.reviewStore.getReview(documentId)
    if (review === undefined) {
      throw {
        code: 'REVIEW_NOT_FOUND' as AgentErrorCode,
        message: 'No active review for this document.',
      }
    }
    return {
      reviewId: review.reviewId,
      documentId,
      packets: review.packets,
    }
  }

  private clearReview (params: ClearReviewRequest): ClearReviewResponse {
    // Find the documentId from the reviewId
    let documentId: string | undefined
    for (const r of this._documents.reviewStore.listReviews()) {
      if (r.reviewId === params.reviewId) {
        documentId = r.documentId
        break
      }
    }
    if (documentId === undefined) {
      throw {
        code: 'REVIEW_NOT_FOUND' as AgentErrorCode,
        message: `Review ${params.reviewId} not found.`,
      }
    }
    const result = this._documents.reviewStore.clearUnresolved(documentId)
    if (!result.ok) {
      throw {
        code: result.code as AgentErrorCode,
        message: result.message,
      }
    }
    const filePath = this._documents.getDocumentPath(documentId)
    const doc =
      filePath !== undefined
        ? this._documents.loadedDocuments.find((d) => d.filePath === filePath)
        : undefined
    return {
      reviewId: result.reviewId,
      documentId,
      state: result.state,
      documentRevision: doc
        ? {
          version: doc.currentVersion,
          sha256: sha256Text(doc.document.toString()),
        }
        : { version: 0, sha256: '' },
    }
  }

  // ==========================================================================
  // Event broadcasting
  // ==========================================================================

  private broadcastEvent (event: AgentEvent): void {
    const jsonl = JSON.stringify(event) + '\n'
    for (const [socket] of this._subscribers) {
      if (!socket.destroyed) {
        socket.write(jsonl)
      }
    }
  }

  // ==========================================================================
  // Response writing
  // ==========================================================================

  private writeResult (
    socket: net.Socket,
    id: string | number | null,
    result: unknown,
  ): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: id ?? 0,
      result,
    }
    socket.write(JSON.stringify(response) + '\n')
  }

  private writeError (
    socket: net.Socket,
    id: string | number | null,
    rpcCode: number,
    message: string,
    agentCode: AgentErrorCode,
    data?: unknown,
  ): void {
    const error: JsonRpcError = {
      code: rpcCode,
      message,
      data: { code: agentCode, message, ...(data as object) },
    }
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: id ?? 0,
      error,
    }
    socket.write(JSON.stringify(response) + '\n')
  }
}
