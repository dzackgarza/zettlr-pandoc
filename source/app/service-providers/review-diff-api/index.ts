/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ReviewDiffAPIProvider
 * CVM-Role:        Controller
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Local request/response socket for external review-diff tools:
 *                  read the authoritative open document buffer and submit a
 *                  version-fenced review proposition.
 *
 * END HEADER
 */

import fs from 'fs'
import net from 'net'
import path from 'path'
import { createHash } from 'crypto'
import { app } from 'electron'
import ProviderContract from '@providers/provider-contract'
import type DocumentManager from '@providers/documents'
import type LogProvider from '@providers/log'
import type {
  ReviewDiffApiRequest,
  ReviewDiffApiResponse
} from '@dts/common/review-diff'

const MAX_REQUEST_BYTES = 25 * 1024 * 1024

export function reviewDiffApiSocketPath (userDataPath: string = app.getPath('userData')): string {
  if (process.platform === 'win32') {
    const key = createHash('sha256').update(userDataPath, 'utf8').digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\zettlr-pandoc-review-diff-${key}`
  }

  return path.join(userDataPath, 'review-diff-api.sock')
}

export async function sendReviewDiffApiRequest (socketPath: string, request: ReviewDiffApiRequest): Promise<ReviewDiffApiResponse> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let responseText = ''

    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
    socket.on('data', chunk => {
      responseText += chunk
    })
    socket.on('error', reject)
    socket.on('end', () => {
      try {
        resolve(JSON.parse(responseText) as ReviewDiffApiResponse)
      } catch (err: unknown) {
        reject(err)
      }
    })
  })
}

export default class ReviewDiffAPIProvider extends ProviderContract {
  private _server: net.Server|undefined

  constructor (
    private readonly _log: LogProvider,
    private readonly _documents: DocumentManager,
    private readonly _socketPath = reviewDiffApiSocketPath()
  ) {
    super()
  }

  async boot (): Promise<void> {
    if (process.platform !== 'win32') {
      fs.rmSync(this._socketPath, { force: true })
    }

    this._server = net.createServer(socket => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      const server = this._server!
      const onError = (err: Error): void => { reject(err) }
      server.once('error', onError)
      server.listen(this._socketPath, () => {
        server.off('error', onError)
        this._log.info(`[ReviewDiffAPIProvider] Listening on ${this._socketPath}`)
        resolve()
      })
    })
  }

  async shutdown (): Promise<void> {
    if (this._server === undefined) {
      return
    }

    await new Promise<void>(resolve => {
      this._server?.close(() => { resolve() })
    })
    this._server = undefined

    if (process.platform !== 'win32') {
      fs.rmSync(this._socketPath, { force: true })
    }
  }

  private handleConnection (socket: net.Socket): void {
    let requestText = ''
    let requestBytes = 0
    let refused = false
    let complete = false

    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      if (complete) {
        return
      }

      requestBytes += Buffer.byteLength(chunk, 'utf8')
      if (requestBytes > MAX_REQUEST_BYTES) {
        refused = true
        complete = true
        this.writeResponse(socket, {
          ok: false,
          error: {
            code: 'request-too-large',
            message: 'The review-diff API request is too large.'
          }
        })
        return
      }

      requestText += chunk
      if (requestText.endsWith('\n')) {
        complete = true
        this.respondToRequestText(socket, requestText.trimEnd())
      }
    })
    socket.on('end', () => {
      if (refused || complete) {
        return
      }

      complete = true
      this.respondToRequestText(socket, requestText)
    })
    socket.on('error', err => {
      this._log.warning(`[ReviewDiffAPIProvider] Socket error: ${err.message}`)
    })
  }

  private respondToRequestText (socket: net.Socket, requestText: string): void {
    this.handleRequestText(requestText)
      .then(response => { this.writeResponse(socket, response) })
      .catch(err => {
        this.writeResponse(socket, {
          ok: false,
          error: {
            code: 'internal-error',
            message: err instanceof Error ? err.message : 'The review-diff API request failed.'
          }
        })
      })
  }

  private async handleRequestText (requestText: string): Promise<ReviewDiffApiResponse> {
    let request: ReviewDiffApiRequest
    try {
      request = JSON.parse(requestText) as ReviewDiffApiRequest
    } catch (_err: unknown) {
      return {
        ok: false,
        error: {
          code: 'invalid-json',
          message: 'The review-diff API request was not valid JSON.'
        }
      }
    }

    return await this.handleRequest(request)
  }

  private async handleRequest (request: ReviewDiffApiRequest): Promise<ReviewDiffApiResponse> {
    if (request.method === 'readDocument') {
      return {
        id: request.id,
        ok: true,
        result: await this._documents.readReviewDiffDocumentSnapshot(request.params.path)
      }
    }

    if (request.method === 'openReview') {
      return {
        id: request.id,
        ok: true,
        result: await this._documents.openReviewDiffFromSnapshot(request.params)
      }
    }

    return {
      id: (request as { id?: string|number }).id,
      ok: false,
      error: {
        code: 'unsupported-method',
        message: 'The review-diff API method is not supported.'
      }
    }
  }

  private writeResponse (socket: net.Socket, response: ReviewDiffApiResponse): void {
    socket.end(`${JSON.stringify(response)}\n`)
  }
}
