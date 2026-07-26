#!/usr/bin/env node
/* eslint-disable @typescript-eslint/strict-boolean-expressions */
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        zettlr-agent CLI entry point
 * CVM-Role:        CLI
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Standalone CLI for the Zettlr-Pandoc agent API. Connects
 *                  to the running app's Unix-domain socket (or named pipe),
 *                  authenticates with the token, and dispatches JSON-RPC 2.0
 *                  requests. Supports SSH traversal (no network listener).
 *
 *                  Usage:
 *                    zettlr-agent ping
 *                    zettlr-agent capabilities --json
 *                    zettlr-agent context [--json]
 *                    zettlr-agent documents list [--json]
 *                    zettlr-agent read --focused [--lines 1:300] [--json]
 *                    zettlr-agent read --document doc-91 [--json]
 *                    zettlr-agent search --focused --literal "text" [--json]
 *                    zettlr-agent propose --snapshot snap_v1_... --patch file.diff
 *                    zettlr-agent propose --snapshot snap_v1_... --patch - < file.diff
 *                    zettlr-agent reviews list [--json]
 *                    zettlr-agent review status [--focused|--review review-12] [--json]
 *                    zettlr-agent review diff [--focused|--review review-12]
 *                    zettlr-agent review chunks [--focused|--review review-12] [--json]
 *                    zettlr-agent review packets [--focused|--review review-12] [--json]
 *                    zettlr-agent review clear review-12 --discard-unresolved
 *                    zettlr-agent proposal retract packet-31
 *                    zettlr-agent watch [--jsonl]
 *                    zettlr-agent watch --review review-12 [--jsonl]
 *                    zettlr-agent bridge --stdio
 *
 * END HEADER
 */

import net from 'net'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  CLI_EXIT_CODES,
  type DiscoveryRecord,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type AgentEvent,
} from '../types/common/agent-api'

// ============================================================================
// Discovery and connection
// ============================================================================

function findDiscoveryFile (): string | undefined {
  const runtimeDir = process.env['XDG_RUNTIME_DIR'] ?? os.tmpdir()
  const discoveryPath = path.join(
    runtimeDir,
    'zettlr-pandoc',
    'agent-discovery.json',
  )
  if (fs.existsSync(discoveryPath)) {
    return discoveryPath
  }
  return undefined
}

function loadDiscovery (): DiscoveryRecord | undefined {
  const discoveryPath = findDiscoveryFile()
  if (discoveryPath === undefined) {
    return undefined
  }
  try {
    const content = fs.readFileSync(discoveryPath, 'utf8')
    return JSON.parse(content) as DiscoveryRecord
  } catch {
    return undefined
  }
}

function loadToken (tokenFile: string): string | undefined {
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim()
  } catch {
    return undefined
  }
}

// ============================================================================
// JSON-RPC client
// ============================================================================

export class AgentClient {
  private socket: net.Socket | undefined
  private buffer = ''
  private pendingRequests: Map<
    string | number,
    {
      resolve: (response: JsonRpcResponse) => void;
      reject: (err: Error) => void;
    }
  > = new Map()
  private nextId = 1
  private eventHandlers: ((event: AgentEvent) => void)[] = []
  private discovery: DiscoveryRecord

  constructor (discovery: DiscoveryRecord) {
    this.discovery = discovery
  }

  async connect (): Promise<void> {
    const token = loadToken(this.discovery.tokenFile)
    if (token === undefined) {
      throw new Error(`Cannot read token file: ${this.discovery.tokenFile}`)
    }

    this.socket = net.createConnection(this.discovery.endpoint)
    this.socket.setEncoding('utf8')

    await new Promise<void>((resolve, reject) => {
      this.socket!.on('connect', () => resolve())
      this.socket!.on('error', reject)
    })

    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk
      let newlineIdx: number
      while ((newlineIdx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newlineIdx)
        this.buffer = this.buffer.slice(newlineIdx + 1)
        if (line.length === 0) {
          continue
        }
        this.handleMessage(line)
      }
    })

    // Authenticate
    const authResponse = await this.request('auth', { token })
    if (authResponse.error !== undefined) {
      throw new Error('Authentication failed')
    }
  }

  private handleMessage (line: string): void {
    let message: JsonRpcResponse | AgentEvent
    try {
      message = JSON.parse(line)
    } catch {
      return
    }

    // Check if it's a JSON-RPC response (has id) or an event (has event field)
    if ('jsonrpc' in message && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id)
      if (pending !== undefined) {
        this.pendingRequests.delete(message.id)
        pending.resolve(message)
      }
    } else if ('event' in message) {
      for (const handler of this.eventHandlers) {
        handler(message as AgentEvent)
      }
    }
  }

  request (method: string, params?: unknown): Promise<JsonRpcResponse> {
    if (this.socket === undefined) {
      return Promise.reject(new Error('Not connected'))
    }
    const id = this.nextId++
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      this.socket!.write(JSON.stringify(request) + '\n')
    })
  }

  onEvent (handler: (event: AgentEvent) => void): void {
    this.eventHandlers.push(handler)
  }

  async close (): Promise<void> {
    if (this.socket !== undefined) {
      this.socket.end()
      this.socket = undefined
    }
  }
}

// ============================================================================
// Output formatting
// ============================================================================

function output (data: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  } else {
    // Human-readable output
    if (typeof data === 'string') {
      process.stdout.write(data + '\n')
    } else {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    }
  }
}

function outputError (message: string, code?: string): void {
  process.stderr.write(`Error: ${message}\n`)
  if (code !== undefined) {
    process.stderr.write(`Code: ${code}\n`)
  }
}

// ============================================================================
// Command handlers
// ============================================================================

async function cmdPing (client: AgentClient, asJson: boolean): Promise<number> {
  const response = await client.request('ping')
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.APP_UNAVAILABLE
  }
  output(response.result, asJson)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdCapabilities (
  client: AgentClient,
  asJson: boolean,
): Promise<number> {
  const response = await client.request('capabilities')
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.APP_UNAVAILABLE
  }
  output(response.result, asJson)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdContext (
  client: AgentClient,
  asJson: boolean,
): Promise<number> {
  const response = await client.request('context')
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.INTERNAL_ERROR
  }
  output(response.result, asJson)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdDocumentsList (
  client: AgentClient,
  asJson: boolean,
): Promise<number> {
  const response = await client.request('documents/list')
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.INTERNAL_ERROR
  }
  output(response.result, asJson)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdRead (
  client: AgentClient,
  args: {
    focused?: boolean;
    document?: string;
    lines?: string;
    side?: string;
    json: boolean;
  },
): Promise<number> {
  const params: {
    focused?: boolean;
    documentId?: string;
    side?: string;
    startLine?: number;
    endLine?: number;
  } = {}
  if (args.focused) {
    params.focused = true
  }
  if (args.document !== undefined) {
    params.documentId = args.document
  }
  if (args.side !== undefined) {
    params.side = args.side
  }
  if (args.lines !== undefined) {
    const parts = args.lines.split(':')
    if (parts.length === 2) {
      params.startLine = parseInt(parts[0], 10)
      params.endLine = parseInt(parts[1], 10)
    }
  }
  const response = await client.request('document/read', params)
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    const code = response.error.data?.code
    if (code === 'NO_FOCUSED_DOCUMENT' || code === 'DOCUMENT_NOT_FOUND') {
      return CLI_EXIT_CODES.APP_UNAVAILABLE
    }
    return CLI_EXIT_CODES.INTERNAL_ERROR
  }
  const result = response.result as { content: string; snapshot: string }
  output({ ...result, content: result.content }, args.json)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdSearch (
  client: AgentClient,
  args: {
    focused?: boolean;
    document?: string;
    literal?: string;
    context?: number;
    json: boolean;
  },
): Promise<number> {
  const params: {
    focused?: boolean;
    documentId?: string;
    literal?: string;
    context?: number;
  } = {}
  if (args.focused) {
    params.focused = true
  }
  if (args.document !== undefined) {
    params.documentId = args.document
  }
  if (args.literal !== undefined) {
    params.literal = args.literal
  }
  if (args.context !== undefined) {
    params.context = args.context
  }
  const response = await client.request('document/search', params)
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.INTERNAL_ERROR
  }
  output(response.result, args.json)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdPropose (
  client: AgentClient,
  args: {
    snapshot: string;
    patch: string;
    description?: string;
    clientRequestId: string;
    json: boolean;
  },
): Promise<number> {
  const params = {
    snapshot: args.snapshot,
    patchFormat: 'unified-diff' as const,
    patch: args.patch,
    description: args.description,
    clientRequestId: args.clientRequestId,
  }
  const response = await client.request('proposal/submit', params)
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    const code = response.error.data?.code
    if (code === 'REVISION_MISMATCH') {
      return CLI_EXIT_CODES.STALE_REVISION
    }
    if (code === 'PATCH_INVALID' || code === 'PATCH_NOT_APPLICABLE') {
      return CLI_EXIT_CODES.MALFORMED_PATCH
    }
    return CLI_EXIT_CODES.INTERNAL_ERROR
  }
  output(response.result, args.json)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdReviewsList (
  client: AgentClient,
  asJson: boolean,
): Promise<number> {
  const response = await client.request('reviews/list')
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.INTERNAL_ERROR
  }
  output(response.result, asJson)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdReviewStatus (
  client: AgentClient,
  args: { focused?: boolean; review?: string; json: boolean },
): Promise<number> {
  const params: { focused?: boolean; reviewId?: string } = {}
  if (args.focused) {
    params.focused = true
  }
  if (args.review !== undefined) {
    params.reviewId = args.review
  }
  const response = await client.request('review/status', params)
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.INTERNAL_ERROR
  }
  output(response.result, args.json)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdReviewDiff (
  client: AgentClient,
  args: { focused?: boolean; review?: string; json: boolean },
): Promise<number> {
  const params: { focused?: boolean; reviewId?: string } = {}
  if (args.focused) {
    params.focused = true
  }
  if (args.review !== undefined) {
    params.reviewId = args.review
  }
  const response = await client.request('review/diff', params)
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.INTERNAL_ERROR
  }
  const result = response.result as { patch: string }
  process.stdout.write(result.patch)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdReviewChunks (
  client: AgentClient,
  args: { focused?: boolean; review?: string; json: boolean },
): Promise<number> {
  const params: { focused?: boolean; reviewId?: string } = {}
  if (args.focused) {
    params.focused = true
  }
  if (args.review !== undefined) {
    params.reviewId = args.review
  }
  const response = await client.request('review/chunks', params)
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.INTERNAL_ERROR
  }
  output(response.result, args.json)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdReviewPackets (
  client: AgentClient,
  args: { focused?: boolean; review?: string; json: boolean },
): Promise<number> {
  const params: { focused?: boolean; reviewId?: string } = {}
  if (args.focused) {
    params.focused = true
  }
  if (args.review !== undefined) {
    params.reviewId = args.review
  }
  const response = await client.request('review/packets', params)
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.INTERNAL_ERROR
  }
  output(response.result, args.json)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdReviewClear (
  client: AgentClient,
  reviewId: string,
): Promise<number> {
  const response = await client.request('review/clear', {
    reviewId,
    discardUnresolved: true,
  })
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.REFUSED_BY_REVIEW
  }
  output(response.result, true)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdProposalRetract (
  client: AgentClient,
  packetId: string,
): Promise<number> {
  const response = await client.request('proposal/retract', { packetId })
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.REFUSED_BY_REVIEW
  }
  output(response.result, true)
  return CLI_EXIT_CODES.SUCCESS
}

async function cmdWatch (
  client: AgentClient,
  _args: { review?: string; document?: string; jsonl: boolean },
): Promise<number> {
  const response = await client.request('events/subscribe')
  if (response.error !== undefined) {
    outputError(response.error.message, response.error.data?.code)
    return CLI_EXIT_CODES.INTERNAL_ERROR
  }
  client.onEvent((event) => {
    process.stdout.write(JSON.stringify(event) + '\n')
  })
  // Keep the process alive
  return new Promise<number>(() => {})
}

async function cmdBridge (_client: AgentClient): Promise<number> {
  // bridge --stdio: forward JSON-RPC over stdin/stdout
  const discovery = loadDiscovery()
  if (discovery === undefined) {
    process.stderr.write('Error: app not running\n')
    return CLI_EXIT_CODES.APP_UNAVAILABLE
  }
  const client = new AgentClient(discovery)
  await client.connect()

  let stdinBuffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    stdinBuffer += chunk
    let newlineIdx: number
    while ((newlineIdx = stdinBuffer.indexOf('\n')) >= 0) {
      const line = stdinBuffer.slice(0, newlineIdx)
      stdinBuffer = stdinBuffer.slice(newlineIdx + 1)
      if (line.length === 0) {
        continue
      }
      try {
        const request = JSON.parse(line) as JsonRpcRequest
        void client.request(request.method, request.params).then((response) => {
          if (response.result !== undefined) {
            process.stdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                result: response.result,
              }) + '\n',
            )
          } else if (response.error !== undefined) {
            process.stdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: response.error,
              }) + '\n',
            )
          }
        })
      } catch {
        // ignore invalid JSON on stdin
      }
    }
  })
  // Keep alive
  return new Promise<number>(() => {})
}

// ============================================================================
// Argument parsing and main
// ============================================================================

function parseArgs (argv: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        result[key] = argv[i + 1]
        i += 2
      } else {
        result[key] = true
        i += 1
      }
    } else {
      result['_positional'] = result['_positional'] ?? [];
      (result['_positional'] as string[]).push(arg)
      i += 1
    }
  }
  return result
}

async function main (): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const command = (args['_positional'] as string[] | undefined)?.[0]
  const asJson = args['json'] === true

  if (command === undefined) {
    process.stderr.write('Usage: zettlr-agent <command> [options]\n')
    return CLI_EXIT_CODES.INVALID_INVOCATION
  }

  // bridge --stdio runs before connecting
  if (command === 'bridge' && args['stdio'] === true) {
    return cmdBridge(undefined as unknown as AgentClient)
  }

  // Connect to the running app
  const discovery = loadDiscovery()
  if (discovery === undefined) {
    outputError('Zettlr-Pandoc is not running (no discovery file found)')
    return CLI_EXIT_CODES.APP_UNAVAILABLE
  }

  const client = new AgentClient(discovery)
  try {
    await client.connect()
  } catch (err) {
    outputError(err instanceof Error ? err.message : 'Cannot connect to app')
    return CLI_EXIT_CODES.APP_UNAVAILABLE
  }

  let exitCode: number
  try {
    switch (command) {
      case 'ping':
        exitCode = await cmdPing(client, asJson)
        break
      case 'capabilities':
        exitCode = await cmdCapabilities(client, asJson)
        break
      case 'context':
        exitCode = await cmdContext(client, asJson)
        break
      case 'documents':
        if ((args['_positional'] as string[])[1] === 'list') {
          exitCode = await cmdDocumentsList(client, asJson)
        } else {
          outputError('Unknown documents subcommand')
          exitCode = CLI_EXIT_CODES.INVALID_INVOCATION
        }
        break
      case 'read':
        exitCode = await cmdRead(client, {
          focused: args['focused'] === true,
          document: args['document'] as string | undefined,
          lines: args['lines'] as string | undefined,
          side: args['side'] as string | undefined,
          json: asJson,
        })
        break
      case 'search':
        exitCode = await cmdSearch(client, {
          focused: args['focused'] === true,
          document: args['document'] as string | undefined,
          literal: args['literal'] as string | undefined,
          context: args['context'] as number | undefined,
          json: asJson,
        })
        break
      case 'propose': {
        const patchFile = args['patch'] as string
        let patch: string
        if (patchFile === '-') {
          // Read from stdin
          patch = await new Promise<string>((resolve) => {
            let data = ''
            process.stdin.setEncoding('utf8')
            process.stdin.on('data', (chunk: string) => {
              data += chunk
            })
            process.stdin.on('end', () => resolve(data))
          })
        } else {
          patch = fs.readFileSync(patchFile, 'utf8')
        }
        exitCode = await cmdPropose(client, {
          snapshot: args['snapshot'] as string,
          patch,
          description: args['description'] as string | undefined,
          clientRequestId:
            (args['client-request-id'] as string) ?? crypto.randomUUID(),
          json: asJson,
        })
        break
      }
      case 'reviews':
        if ((args['_positional'] as string[])[1] === 'list') {
          exitCode = await cmdReviewsList(client, asJson)
        } else {
          outputError('Unknown reviews subcommand')
          exitCode = CLI_EXIT_CODES.INVALID_INVOCATION
        }
        break
      case 'review':
        switch ((args['_positional'] as string[])[1]) {
          case 'status':
            exitCode = await cmdReviewStatus(client, {
              focused: args['focused'] === true,
              review: args['review'] as string | undefined,
              json: asJson,
            })
            break
          case 'diff':
            exitCode = await cmdReviewDiff(client, {
              focused: args['focused'] === true,
              review: args['review'] as string | undefined,
              json: asJson,
            })
            break
          case 'chunks':
            exitCode = await cmdReviewChunks(client, {
              focused: args['focused'] === true,
              review: args['review'] as string | undefined,
              json: asJson,
            })
            break
          case 'packets':
            exitCode = await cmdReviewPackets(client, {
              focused: args['focused'] === true,
              review: args['review'] as string | undefined,
              json: asJson,
            })
            break
          case 'clear': {
            const reviewId = (args['_positional'] as string[])[2]
            if (reviewId === undefined) {
              outputError('review clear requires a review ID')
              exitCode = CLI_EXIT_CODES.INVALID_INVOCATION
            } else {
              exitCode = await cmdReviewClear(client, reviewId)
            }
            break
          }
          default:
            outputError('Unknown review subcommand')
            exitCode = CLI_EXIT_CODES.INVALID_INVOCATION
        }
        break
      case 'proposal':
        if ((args['_positional'] as string[])[1] === 'retract') {
          const packetId = (args['_positional'] as string[])[2]
          if (packetId === undefined) {
            outputError('proposal retract requires a packet ID')
            exitCode = CLI_EXIT_CODES.INVALID_INVOCATION
          } else {
            exitCode = await cmdProposalRetract(client, packetId)
          }
        } else {
          outputError('Unknown proposal subcommand')
          exitCode = CLI_EXIT_CODES.INVALID_INVOCATION
        }
        break
      case 'watch':
        exitCode = await cmdWatch(client, {
          review: args['review'] as string | undefined,
          document: args['document'] as string | undefined,
          jsonl: args['jsonl'] === true,
        })
        break
      case 'bridge':
        if (args['stdio'] === true) {
          exitCode = await cmdBridge(client)
        } else {
          outputError('bridge requires --stdio')
          exitCode = CLI_EXIT_CODES.INVALID_INVOCATION
        }
        break
      default:
        outputError(`Unknown command: ${command}`)
        exitCode = CLI_EXIT_CODES.INVALID_INVOCATION
    }
  } catch (err: unknown) {
    outputError(err instanceof Error ? err.message : 'Unknown error')
    exitCode = CLI_EXIT_CODES.INTERNAL_ERROR
  }

  await client.close()
  return exitCode
}

// Import crypto for UUID generation in the propose command
import crypto from 'crypto'

void main().then((code) => process.exit(code))
