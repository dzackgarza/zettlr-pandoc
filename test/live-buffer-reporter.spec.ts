/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Live-buffer reporter specs (issue #1, Phase 8 red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the production live-buffer reporting contract. The
 *                  ReferenceProvider accepts 'report-live-buffer' /
 *                  'drop-live-buffer' (test/reference-provider-shell.spec.ts),
 *                  but no production code sends them: unsaved buffers never
 *                  reach the merged workspace state. These specs lock the
 *                  MainEditor-owned pure reporter
 *                  (source/common/modules/markdown-editor/util/
 *                  live-buffer-reporter.ts): the exact wire invocation built
 *                  from the SHARED extractor, per-document debouncing through
 *                  an INJECTED scheduler (fired manually here — debounce is
 *                  proven headlessly, no wall-clock waits), per-document
 *                  generation monotonicity, and immediate drop on document
 *                  close/switch. The final spec feeds the reporter's
 *                  invocations into the REAL provider ipc handler (headless
 *                  harness, the provider-shell seam) and asserts the merged
 *                  state actually flips to the live overlay — the reporter is
 *                  proven against the boundary it must drive, not against a
 *                  fabricated provider.
 *
 * END HEADER
 */

// The harness must load before any provider module: LogProvider imports
// 'electron' at module scope.
import { ipcMainHandlers } from './headless-electron-harness.cjs'
import { strict as assert } from 'assert'
import EventEmitter from 'events'
import { readFileSync } from 'fs'
import path from 'path'
import ReferenceProvider from 'source/app/service-providers/references'
import LogProvider from 'source/app/service-providers/log'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import {
  createLiveBufferReporter,
  LIVE_BUFFER_DEBOUNCE_MS,
  type LiveBufferScheduledTask,
  type LiveBufferScheduler
} from 'source/common/modules/markdown-editor/util/live-buffer-reporter'
import type FSAL from 'source/app/service-providers/fsal'
import type { WorkspaceReferenceState } from 'source/app/service-providers/references/reference-index'
import type { MDFileDescriptor } from 'source/types/common/fsal'

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')
const THEOREMS_PATH = path.join(FIXTURE_ROOT, 'ProjectA', 'Theorems.md')
const NOTES_PATH = path.join(FIXTURE_ROOT, 'Standalone_Notes.md')

interface RecordedInvocation {
  channel: string
  message: { command: string, payload?: unknown }
}

/**
 * A manually-fired scheduler standing at the injected deferred-execution
 * seam. This is dependency injection of the seam the reporter contract
 * declares, not a mock of provider behavior: the recorded callbacks are the
 * reporter's own deliveries, executed exactly when a spec fires them.
 */
class ManualScheduler implements LiveBufferScheduler {
  public readonly tasks: Array<{ callback: () => void, delayMs: number, cancelled: boolean }> = []

  schedule (callback: () => void, delayMs: number): LiveBufferScheduledTask {
    const task = { callback, delayMs, cancelled: false }
    this.tasks.push(task)
    return { cancel: () => { task.cancelled = true } }
  }

  /** Fires every not-yet-cancelled task once, in schedule order. */
  fireAll (): void {
    for (const task of this.tasks.splice(0)) {
      if (!task.cancelled) {
        task.callback()
      }
    }
  }
}

function recordingSeam (): { invocations: RecordedInvocation[], ipcInvoke: (channel: 'reference-provider', message: { command: string, payload?: unknown }) => Promise<unknown> } {
  const invocations: RecordedInvocation[] = []
  return {
    invocations,
    ipcInvoke: async (channel, message) => {
      invocations.push({ channel, message })
      return undefined
    }
  }
}

describe('Live-buffer reporter (issue #1 Phase 8)', function () {
  it('delivers exactly one report-live-buffer invocation, after the debounce, built from the shared extractor', function () {
    const { invocations, ipcInvoke } = recordingSeam()
    const scheduler = new ManualScheduler()
    const reporter = createLiveBufferReporter(ipcInvoke, scheduler)

    const content = '::: {.lemma #lem:live:only}\nAuthored only in the unsaved buffer.\n:::\n'
    reporter.reportChange(THEOREMS_PATH, content, 3)

    assert.equal(invocations.length, 0, 'nothing may be delivered before the debounce window elapses')
    assert.equal(scheduler.tasks.length, 1, 'one change must schedule exactly one deferred delivery')
    assert.equal(scheduler.tasks[0].delayMs, LIVE_BUFFER_DEBOUNCE_MS, 'the delivery must be deferred by the contract debounce window')

    scheduler.fireAll()
    assert.deepEqual(
      invocations,
      [{
        channel: 'reference-provider',
        message: {
          command: 'report-live-buffer',
          payload: {
            snapshot: extractReferences(THEOREMS_PATH, content),
            generation: 3
          }
        }
      }],
      'the fired delivery must be the exact provider wire message carrying the shared-extractor snapshot'
    )
  })

  it('coalesces a same-document burst into one delivery carrying the latest content and generation', function () {
    const { invocations, ipcInvoke } = recordingSeam()
    const scheduler = new ManualScheduler()
    const reporter = createLiveBufferReporter(ipcInvoke, scheduler)

    reporter.reportChange(THEOREMS_PATH, '# v1\n', 1)
    reporter.reportChange(THEOREMS_PATH, '# v1 v2\n', 2)
    const latest = '# v1 v2 v3 {#sec:latest}\n'
    reporter.reportChange(THEOREMS_PATH, latest, 3)

    scheduler.fireAll()

    assert.equal(
      invocations.length,
      1,
      `a burst of edits inside one debounce window must deliver exactly once, got ${JSON.stringify(invocations.map(i => i.message.command))}`
    )
    const payload = invocations[0].message.payload as { snapshot: unknown, generation: number }
    assert.equal(payload.generation, 3, 'the delivery must carry the LATEST generation of the burst')
    assert.deepEqual(
      payload.snapshot,
      extractReferences(THEOREMS_PATH, latest),
      'the delivery must carry the snapshot of the LATEST content, not an intermediate buffer state'
    )
  })

  it('never delivers a generation at or below the last delivered generation for a document', function () {
    const { invocations, ipcInvoke } = recordingSeam()
    const scheduler = new ManualScheduler()
    const reporter = createLiveBufferReporter(ipcInvoke, scheduler)

    reporter.reportChange(THEOREMS_PATH, '# current\n', 5)
    scheduler.fireAll()
    assert.equal(invocations.length, 1, 'the fresh report must deliver (precondition for the monotonicity claim)')

    // An out-of-order stale report (e.g. a queued update that raced a newer
    // one) must be dropped, not delivered backwards.
    reporter.reportChange(THEOREMS_PATH, '# stale\n', 4)
    scheduler.fireAll()

    const generations = invocations
      .filter(invocation => invocation.message.command === 'report-live-buffer')
      .map(invocation => (invocation.message.payload as { generation: number }).generation)
    assert.deepEqual(generations, [ 5 ], 'the stale generation-4 report must never reach the provider after generation 5 was delivered')
  })

  it('debounces documents independently', function () {
    const { invocations, ipcInvoke } = recordingSeam()
    const scheduler = new ManualScheduler()
    const reporter = createLiveBufferReporter(ipcInvoke, scheduler)

    const theoremsContent = '::: {.theorem #thm:a}\nA\n:::\n'
    const notesContent = 'See @thm:a for the claim.\n'
    reporter.reportChange(THEOREMS_PATH, theoremsContent, 1)
    reporter.reportChange(NOTES_PATH, notesContent, 1)

    scheduler.fireAll()

    const delivered = invocations.map(invocation => {
      const payload = invocation.message.payload as { snapshot: { documentPath: string } }
      return [ invocation.message.command, payload.snapshot.documentPath ]
    })
    assert.deepEqual(
      delivered,
      [
        [ 'report-live-buffer', THEOREMS_PATH ],
        [ 'report-live-buffer', NOTES_PATH ]
      ],
      'each document must deliver its own report; documents never coalesce with or cancel each other'
    )
  })

  it('dropDocument cancels the pending report and immediately delivers drop-live-buffer', function () {
    const { invocations, ipcInvoke } = recordingSeam()
    const scheduler = new ManualScheduler()
    const reporter = createLiveBufferReporter(ipcInvoke, scheduler)

    reporter.reportChange(THEOREMS_PATH, '# about to be closed\n', 9)
    reporter.dropDocument(THEOREMS_PATH)

    assert.deepEqual(
      invocations,
      [{
        channel: 'reference-provider',
        message: { command: 'drop-live-buffer', payload: { documentPath: THEOREMS_PATH } }
      }],
      'closing the document must drop the overlay immediately, without waiting out a debounce window'
    )

    // The pending change report died with the document: firing whatever
    // remains scheduled must not resurrect the closed buffer's overlay.
    scheduler.fireAll()
    assert.equal(
      invocations.filter(invocation => invocation.message.command === 'report-live-buffer').length,
      0,
      'the cancelled pending report must never deliver after the document was dropped'
    )
  })

  describe('against the real reference provider', function () {
    /**
     * The real markdown descriptor FSAL would emit for a fixture file, with
     * its references produced by the same shared extractor FSAL delegates to
     * (the established reference-provider-shell.spec.ts builder).
     */
    function makeDescriptor (documentPath: string): MDFileDescriptor {
      const content = readFileSync(documentPath, 'utf-8')
      return {
        dir: path.dirname(documentPath),
        path: documentPath,
        name: path.basename(documentPath),
        ext: path.extname(documentPath),
        size: content.length,
        id: '',
        tags: [],
        links: [],
        citekeys: [],
        bom: '',
        type: 'file',
        wordCount: 0,
        charCount: 0,
        modtime: 0,
        creationtime: 0,
        linefeed: '\n',
        firstHeading: null,
        yamlTitle: undefined,
        frontmatter: null,
        references: extractReferences(documentPath, content)
      }
    }

    const fsalSeam = new EventEmitter()
    let provider: ReferenceProvider

    before(async function () {
      provider = new ReferenceProvider(new LogProvider(), fsalSeam as unknown as FSAL)
      await provider.boot()
      fsalSeam.emit('fsal-event', { event: 'change', descriptor: makeDescriptor(THEOREMS_PATH) })
    })

    after(async function () {
      await provider.shutdown()
    })

    it('the delivered report is accepted and the merged state flips to the live overlay', async function () {
      const handler = ipcMainHandlers.get('reference-provider')
      assert.ok(handler !== undefined, 'the provider must register the reference-provider handler (provider-shell contract)')

      // The reporter's ipc seam IS the real registered handler: whatever the
      // reporter sends is exactly what the provider receives in production.
      const scheduler = new ManualScheduler()
      const reporter = createLiveBufferReporter(
        async (_channel, message) => await (handler(undefined, message) as Promise<unknown>),
        scheduler
      )

      const liveContent = [
        '::: {.lemma #lem:live:only}',
        'This definition exists only in the unsaved editor buffer.',
        ':::',
        ''
      ].join('\n')
      reporter.reportChange(THEOREMS_PATH, liveContent, 1)
      scheduler.fireAll()

      const overlaid = await (handler(undefined, { command: 'get-snapshot' }) as Promise<WorkspaceReferenceState>)
      const theorems = overlaid.snapshots.filter(snapshot => snapshot.documentPath === THEOREMS_PATH)
      assert.equal(theorems.length, 1, 'exactly one snapshot per document: the reported overlay replaces the saved snapshot')
      assert.equal(
        theorems[0].sourceHash,
        extractReferences(THEOREMS_PATH, liveContent).sourceHash,
        'after the debounce fires, the live buffer must be the authoritative snapshot in the merged state'
      )
      const liveOnly = overlaid.resolutions.get('lem:live:only')
      assert.ok(liveOnly !== undefined, 'a definition authored only in the unsaved buffer must resolve workspace-wide')
      assert.equal(liveOnly.status, 'resolved')

      // Closing the document reverts to the saved FSAL snapshot.
      reporter.dropDocument(THEOREMS_PATH)
      const reverted = await (handler(undefined, { command: 'get-snapshot' }) as Promise<WorkspaceReferenceState>)
      const savedSnapshot = extractReferences(THEOREMS_PATH, readFileSync(THEOREMS_PATH, 'utf-8'))
      const revertedTheorems = reverted.snapshots.find(snapshot => snapshot.documentPath === THEOREMS_PATH)
      assert.ok(revertedTheorems !== undefined, 'the saved snapshot must survive dropping the live overlay')
      assert.equal(revertedTheorems.sourceHash, savedSnapshot.sourceHash, 'dropping must revert the document to its saved snapshot')
      assert.equal(reverted.resolutions.get('lem:live:only'), undefined, 'the buffer-only definition must vanish with its overlay')
    })
  })
})
