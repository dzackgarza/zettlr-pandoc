/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ live-preview controller
 * CVM-Role:        Controller
 * License:         GNU GPL v3
 *
 * Description:     Schedules microlocal TikZ preview renders without coupling
 *                  scheduling to Vue or CodeMirror. Source edits are trailing
 *                  debounced, at most one render is in flight, and while it
 *                  runs only the newest debounced source is retained. A
 *                  successful older render may become the last-good visual
 *                  for the same block, but stale failures are never surfaced
 *                  over newer source.
 *
 * END HEADER
 */

import type { TikzRenderRequest, TikzRenderResult } from 'source/app/util/tikz-render'
import type { TikzSourceBlock } from './tikz-block'

export interface TikzLivePreviewTarget extends TikzSourceBlock {
  docPath: string
}

export type TikzRenderSuccess = Extract<TikzRenderResult, { ok: true }>
export type TikzRenderFailure = Extract<TikzRenderResult, { ok: false }>

export interface TikzLivePreviewState {
  target: TikzLivePreviewTarget|null
  lastGood: { source: string, result: TikzRenderSuccess }|null
  failure: TikzRenderFailure|null
  /** A debounce, queued render, or actual subprocess request is outstanding. */
  pending: boolean
  /** The render service is presently executing one request for this preview. */
  rendering: boolean
  /** The visible last-good figure was compiled from older source. */
  stale: boolean
}

interface RenderJob {
  identity: string
  source: string
  request: TikzRenderRequest
}

export type TikzLiveRender = (request: TikzRenderRequest) => Promise<TikzRenderResult>
export type TikzLivePreviewListener = (state: TikzLivePreviewState) => void

function blockIdentity (target: TikzLivePreviewTarget): string {
  // `from` is stable while editing within a block. `to` is deliberately not
  // part of the identity because inserting source changes it on every edit.
  return `${target.docPath}\0${target.kind}\0${target.language}\0${target.from}`
}

function asRequest (target: TikzLivePreviewTarget, cachePolicy: 'use'|'refresh'): TikzRenderRequest {
  return {
    source: target.source,
    kind: target.kind,
    language: target.language,
    docPath: target.docPath,
    cachePolicy
  }
}

export class TikzLivePreviewController {
  private target: TikzLivePreviewTarget|null = null
  private lastGood: { source: string, result: TikzRenderSuccess }|null = null
  private failure: TikzRenderFailure|null = null
  private debounceTimer: ReturnType<typeof setTimeout>|null = null
  private inFlight = false
  private queued: RenderJob|null = null
  private disposed = false

  constructor (
    private readonly render: TikzLiveRender,
    private readonly listener: TikzLivePreviewListener,
    private readonly debounceMs = 250
  ) {}

  /** Current immutable presentation snapshot. */
  get state (): TikzLivePreviewState {
    return this.snapshot()
  }

  /**
   * Tracks the block under the caret. Moving to another block resets visual
   * history; editing the current block preserves its last successful render.
   */
  setTarget (target: TikzLivePreviewTarget|null): void {
    if (this.disposed) {
      return
    }

    const previous = this.target
    const sameIdentity = previous !== null && target !== null && blockIdentity(previous) === blockIdentity(target)
    const sameSource = sameIdentity && previous?.source === target?.source && previous?.kind === target?.kind

    this.target = target

    if (target === null) {
      this.clearDebounce()
      this.queued = null
      this.lastGood = null
      this.failure = null
      this.publish()
      return
    }

    if (!sameIdentity) {
      this.lastGood = null
      this.failure = null
    }

    if (sameSource) {
      this.publish()
      return
    }

    // A source edit supersedes any not-yet-started request. This is the key
    // latest-wins rule: if A is compiling and B was queued, typing C removes B
    // immediately; only C may be queued after the trailing debounce expires.
    this.queued = null
    this.failure = null
    this.scheduleDebouncedRender()
    this.publish()
  }

  /** Recompile the current bytes while explicitly bypassing the filter cache. */
  forceRender (): void {
    if (this.disposed || this.target === null) {
      return
    }
    this.clearDebounce()
    this.failure = null
    this.queueCurrent('refresh')
    this.publish()
  }

  dispose (): void {
    this.disposed = true
    this.clearDebounce()
    this.queued = null
  }

  private scheduleDebouncedRender (): void {
    this.clearDebounce()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.queueCurrent('use')
      this.publish()
    }, this.debounceMs)
  }

  private clearDebounce (): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private queueCurrent (cachePolicy: 'use'|'refresh'): void {
    const target = this.target
    if (target === null) {
      return
    }

    this.queued = {
      identity: blockIdentity(target),
      source: target.source,
      request: asRequest(target, cachePolicy)
    }

    if (!this.inFlight) {
      this.startNext()
    }
  }

  private startNext (): void {
    const job = this.queued
    if (job === null || this.inFlight || this.disposed) {
      return
    }

    this.queued = null
    this.inFlight = true
    this.publish()

    this.render(job.request)
      .then(
        result => { this.accept(job, result) },
        error => {
          this.accept(job, {
            ok: false,
            kind: 'pandoc-error',
            log: error instanceof Error ? error.message : String(error)
          })
        }
      )
      .finally(() => {
        this.inFlight = false
        if (this.queued !== null) {
          this.startNext()
        }
        this.publish()
      })
  }

  private accept (job: RenderJob, result: TikzRenderResult): void {
    const current = this.target
    if (this.disposed || current === null || blockIdentity(current) !== job.identity) {
      return
    }

    if (result.ok) {
      // A completed successful render remains useful as the visual baseline
      // even if the author typed newer source while it was compiling.
      this.lastGood = { source: job.source, result }
      if (current.source === job.source) {
        this.failure = null
      }
      return
    }

    // A diagnostic for source the author has already changed is stale noise.
    // Keep the last-good picture and wait for the newest queued source.
    if (current.source === job.source) {
      this.failure = result
    }
  }

  private snapshot (): TikzLivePreviewState {
    return {
      target: this.target,
      lastGood: this.lastGood,
      failure: this.failure,
      pending: this.inFlight || this.queued !== null || this.debounceTimer !== null,
      rendering: this.inFlight,
      stale: this.lastGood !== null && this.target !== null && this.lastGood.source !== this.target.source
    }
  }

  private publish (): void {
    if (!this.disposed) {
      this.listener(this.snapshot())
    }
  }
}
