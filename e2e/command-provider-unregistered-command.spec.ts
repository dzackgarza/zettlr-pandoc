import { strict as assert } from 'node:assert'
import { rm } from 'node:fs/promises'
import { type Browser } from 'playwright'
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  shutdown
} from './support/electron-app'
import { type ChildProcess } from 'node:child_process'

describe('the application command channel', function () {
  let appProcess: ChildProcess|undefined
  let browser: Browser|undefined
  let fixtureRoot: string|undefined
  let getOutput = (): string => ''

  before(async function () {
    const fixture = await createFixture('zettlr-command-provider-e2e-', {
      documentName: 'command-channel.md',
      documentContents: '# Command channel\n'
    })
    fixtureRoot = fixture.root
    const running = await attach(fixture.configDirectory, [], this.timeout())
    appProcess = running.appProcess
    browser = running.browser
    getOutput = running.getOutput
  })

  after(async function () {
    await shutdown(browser, appProcess)
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
    assertCleanExit(getOutput())
  })

  it('rejects names with no implementation and still dispatches a registered command', async function () {
    assert.ok(browser !== undefined, 'the application must be running')
    const page = await findEditorPage(browser, this.timeout())

    const result: unknown = await page.evaluate(`(async () => {
      const rejected = []
      for (const command of [
        'next-file',
        'previous-file',
        'a-command-nothing-registers'
      ]) {
        try {
          await window.ipc.invoke('application', { command })
          rejected.push(false)
        } catch {
          rejected.push(true)
        }
      }
      const registeredResult = await window.ipc.invoke('application', {
        command: 'copy-img-to-clipboard',
        payload: 42
      })
      return { rejected, registeredResult }
    })()`)

    assert.deepEqual(result, {
      rejected: [true, true, true],
      registeredResult: false
    })
  })
})
