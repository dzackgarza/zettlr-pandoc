/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        LogProvider write-failure specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Locks the behaviour of the app log when its own file write
 *                  fails. The log is the surface every other failure in the app
 *                  is reported on -- and the one an operator reads after a
 *                  crash -- so it must survive a write it cannot complete: the
 *                  entries it could not write are kept and retried, later
 *                  entries still reach disk, and the failure itself is reported
 *                  on a channel that is not the one that just failed.
 *
 *                  The failure is real, not simulated: the logfile path is
 *                  occupied by a directory, so the real fs.writeFile against it
 *                  rejects with EISDIR. Nothing about the provider is stubbed.
 *
 * END HEADER
 */

// The harness must load before any provider module: LogProvider imports
// 'electron' at module scope.
import './headless-electron-harness.cjs'
import { strict as assert } from 'assert'
import { app } from 'electron'
import { mkdir, readFile, rm } from 'fs/promises'
import path from 'path'
import LogProvider from 'source/app/service-providers/log'

/**
 * The real provider, writing to the real log directory, but under a filename of
 * its own so that the other specs constructing a LogProvider (which all share
 * today's logfile) cannot contribute lines to what this spec reads back.
 */
class IsolatedLogProvider extends LogProvider {
  public readonly filename = `log-write-failure-${process.pid}-${Date.now()}.log`

  _getLogfileName (): string {
    return this.filename
  }
}

/**
 * log() fires its append without awaiting it, so the spec has to wait on the
 * observable outcome rather than on a promise it can reach. Throws on timeout
 * instead of letting an unmet condition pass as success.
 *
 * @param   {() => Promise<boolean>}  condition    What is being waited for
 * @param   {string}                  description  Named in the timeout message
 */
async function waitFor (condition: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after 5s waiting for ${description}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('LogProvider (failing file writes)', function () {
  // Above waitFor's own deadline, so that a stuck log fails with the diagnostic
  // naming what it was waiting for rather than with mocha's generic timeout.
  this.timeout(20000)

  const logDir = path.join(app.getPath('userData'), 'logs')
  let provider: IsolatedLogProvider
  let logfile: string
  let stderr: string[]
  const realConsoleError = console.error

  beforeEach(async function () {
    await mkdir(logDir, { recursive: true })
    provider = new IsolatedLogProvider()
    logfile = path.join(logDir, provider.filename)
    stderr = []
    console.error = function (...args: unknown[]) {
      stderr.push(args.map((arg) => (arg instanceof Error) ? arg.message : String(arg)).join(' '))
    }
  })

  afterEach(async function () {
    console.error = realConsoleError
    await rm(logfile, { recursive: true, force: true })
  })

  it('retries the entries a failed write dropped, and keeps logging afterwards', async function () {
    // Occupy the logfile path with a directory: every append to it rejects.
    await mkdir(logfile, { recursive: true })

    provider.error('entry logged while the logfile could not be written')
    await waitFor(
      async () => stderr.some((line) => line.includes('EISDIR')),
      'the failed log write to be reported on stderr'
    )

    // Free the path again; the log must recover on its own.
    await rm(logfile, { recursive: true, force: true })

    provider.error('entry logged after the logfile became writable again')
    await waitFor(
      async () => (await readFile(logfile, 'utf8').catch(() => '')).includes('became writable again'),
      'the log to resume writing to disk'
    )

    const written = await readFile(logfile, 'utf8')
    assert.ok(
      written.includes('entry logged while the logfile could not be written'),
      `The entry the failed write dropped was never retried. Logfile:\n${written}`
    )
    assert.ok(
      written.includes('EISDIR'),
      `The write failure left no trace in the log itself. Logfile:\n${written}`
    )
  })

  it('propagates a failed final flush out of shutdown()', async function () {
    await mkdir(logfile, { recursive: true })

    provider.info('entry that shutdown has to flush')
    // Let that first write fail and release the lock, so the flush below is the
    // one attempting the write rather than one deferring to a write in flight.
    await waitFor(
      async () => stderr.some((line) => line.includes('EISDIR')),
      'the first failed log write to settle'
    )

    await assert.rejects(
      async () => await provider.shutdown(),
      /EISDIR/,
      'shutdown() reported a clean flush of a log it could not write'
    )
  })
})
