// Drives the bearer-token gate through the assembled app rather than a bare
// provider instance: the token arrives via the process environment, and the
// unit tests construct AgentHTTPProvider directly, so nothing there proves the
// value actually survives the launch path into a running editor.
import { strict as assert } from 'node:assert'
import type { ChildProcess } from 'node:child_process'
import type { Browser } from 'playwright'
import {
  attach,
  createFixture,
  E2E_AGENT_API_PORT,
  preserveArtifacts,
  shutdown
} from './support/electron-app'

const ARTIFACTS = '/tmp/zettlr-agent-api-auth-e2e-latest'
const TOKEN = 'e2e-bearer-token-3f9a1c'

interface RunningFixture {
  fixtureRoot: string | undefined
  appProcess: ChildProcess | undefined
  browser: Browser | undefined
  getOutput: () => string
  rendererEvents: string[]
}

describe('agent API bearer token', function () {
  this.timeout(180_000)

  const fixture: RunningFixture = {
    fixtureRoot: undefined,
    appProcess: undefined,
    browser: undefined,
    getOutput: () => '',
    rendererEvents: []
  }
  const port = E2E_AGENT_API_PORT

  async function ping (headers: Record<string, string>): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${port}/v1/ping`, { headers })
    return response.status
  }

  before(async function () {
    const created = await createFixture('zettlr-agent-api-auth-e2e-', {
      documentName: 'guarded.md',
      documentContents: '# Guarded\n\nContents behind a token.\n',
      config: { agentApi: { enabled: true, port } }
    })
    fixture.fixtureRoot = created.root
    // The harness plants the token in the child's environment, which is the
    // same route ~/.envrc takes through `direnv exec` in the desktop launcher.
    const app = await attach(
      created.configDirectory,
      fixture.rendererEvents,
      120_000,
      { agentApiToken: TOKEN }
    )
    fixture.appProcess = app.appProcess
    fixture.browser = app.browser
    fixture.getOutput = app.getOutput

    // The listener comes up after the window; poll until it answers at all.
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        await ping({ authorization: `Bearer ${TOKEN}` })
        break
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error(`Agent API never answered on ${port}: ${String(error)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  })

  after(async function () {
    await preserveArtifacts(
      ARTIFACTS,
      fixture.fixtureRoot,
      fixture.getOutput(),
      fixture.rendererEvents,
      new Map<string, Buffer>()
    )
    await shutdown(fixture.browser, fixture.appProcess)
  })

  it('serves a caller presenting the configured token', async function () {
    assert.equal(await ping({ authorization: `Bearer ${TOKEN}` }), 200)
  })

  it('refuses a caller with no token, a wrong token, or the wrong scheme', async function () {
    assert.equal(await ping({}), 401, 'anonymous must be refused')
    assert.equal(await ping({ authorization: 'Bearer wrong-value' }), 401)
    assert.equal(await ping({ authorization: `Basic ${TOKEN}` }), 401)
    assert.equal(await ping({ authorization: TOKEN }), 401, 'a bare token is not a scheme')
  })

  it('refuses /health too, which reports the instance and process id', async function () {
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(response.status, 401)
  })

  it('serves the specification anonymously so a schema consumer can import it', async function () {
    // The one exemption, and the reason it is safe: the document describes the
    // API, the identical file is in the public repository, and every route it
    // describes still demands the token.
    const response = await fetch(`http://127.0.0.1:${port}/openapi.yaml`)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.ok(body.includes('openapi:'))
    assert.match(body, new RegExp(`servers:\\n {2}- url: http://127\\.0\\.0\\.1:${port}\\n`))
  })

  it('records which auth mode it booted in', async function () {
    // The silent failure this guards against is a tunnel in front of a server
    // that never saw the variable, so the log has to say which mode is live.
    const log = fixture.getOutput()
    assert.ok(
      log.includes('bearer token required'),
      `boot log must record the guarded mode, got:\n${log.split('\n').filter((l) => l.includes('AgentHTTPProvider')).join('\n')}`
    )
  })
})
