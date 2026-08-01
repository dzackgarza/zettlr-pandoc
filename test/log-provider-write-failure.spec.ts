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
 *                  entries still reach disk, and shutdown exposes the failed
 *                  flush as a rejected boundary operation.
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

describe('LogProvider (failing file writes)', function () {
  this.timeout(20000)

  const logDir = path.join(app.getPath('userData'), 'logs')
  let provider: IsolatedLogProvider
  let logfile: string

  beforeEach(async function () {
    await mkdir(logDir, { recursive: true })
    provider = new IsolatedLogProvider()
    logfile = path.join(logDir, provider.filename)
  })

  afterEach(async function () {
    await rm(logfile, { recursive: true, force: true })
  })

  it('flushes the newest entry and every arrival queued behind an in-flight append', async function () {
    const entries = Array.from({ length: 64 }, (_, index) => `queued log entry ${index}`)

    // The first call reaches fs.writeFile and yields. The remaining synchronous
    // calls therefore arrive while that append is active; shutdown is the only
    // explicit flush after the burst.
    for (const entry of entries) {
      provider.info(entry)
    }

    await provider.shutdown()

    const written = await readFile(logfile, 'utf8')
    const writtenEntries = written
      .split('\n')
      .filter(line => line.includes('queued log entry '))
      .map(line => line.slice(line.indexOf('queued log entry ')))

    assert.deepEqual(
      writtenEntries,
      entries,
      'one flush must preserve the complete accepted entry sequence, including the newest in-flight arrival'
    )
  })

  it('keeps a failed batch pending, exposes the failure, and accepts a later flush', async function () {
    // Occupy the logfile path with a directory: every append to it rejects.
    await mkdir(logfile, { recursive: true })

    provider.error('entry logged while the logfile could not be written')
    await assert.rejects(
      async () => await provider.shutdown(),
      Error,
      'shutdown must expose a real filesystem append failure'
    )

    // Free the path again; the log must recover on its own.
    await rm(logfile, { recursive: true, force: true })

    provider.error('entry logged after the logfile became writable again')
    await provider.shutdown()

    const written = await readFile(logfile, 'utf8')
    assert.ok(
      written.includes('entry logged while the logfile could not be written'),
      `The entry the failed write dropped was never retried. Logfile:\n${written}`
    )
    assert.ok(
      written.includes('entry logged after the logfile became writable again'),
      `The provider remained disabled after the failed append. Logfile:\n${written}`
    )
  })
})
