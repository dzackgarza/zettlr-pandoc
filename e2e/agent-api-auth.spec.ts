// Drives the bearer-token gate through the assembled app rather than a bare
// provider instance: the token arrives via the process environment, and the
// unit tests construct AgentHTTPProvider directly, so nothing there proves the
// value actually survives the launch path into a running editor.
import { strict as assert } from 'node:assert'
import type { ChildProcess } from 'node:child_process'
import type { Browser } from 'playwright'
import { createServer } from 'node:net'
import {
  attach,
  createFixture,
  preserveArtifacts,
  shutdown
} from './support/electron-app'

/** Bind port 0, read what the kernel gave, release it, hand it to the app. */
async function reserveFreePort (): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not reserve a loopback port for the Agent API'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

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
  let port: number
  let previousToken: string | undefined

  async function ping (headers: Record<string, string>): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${port}/v1/ping`, { headers })
    return response.status
  }

  before(async function () {
    port = await reserveFreePort()
    previousToken = process.env.ZETTLR_AGENT_API_TOKEN
    // launchElectron spreads process.env into the child, so this is the same
    // route ~/.envrc takes through `direnv exec` in the desktop launcher.
    process.env.ZETTLR_AGENT_API_TOKEN = TOKEN

    const created = await createFixture('zettlr-agent-api-auth-e2e-', {
      documentName: 'guarded.md',
      documentContents: '# Guarded\n\nContents behind a token.\n',
      config: { agentApi: { enabled: true, port } }
    })
    fixture.fixtureRoot = created.root
    const app = await attach(created.configDirectory, fixture.rendererEvents, 120_000)
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
    if (previousToken === undefined) {
      delete process.env.ZETTLR_AGENT_API_TOKEN
    } else {
      process.env.ZETTLR_AGENT_API_TOKEN = previousToken
    }
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

  it('refuses the spec and health routes too, not just the data routes', async function () {
    // These short-circuit ahead of the router; a tunnel must not leak the API's
    // shape, instance id or pid to an anonymous caller.
    for (const route of ['/health', '/openapi.yaml']) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`)
      assert.equal(response.status, 401, `${route} must refuse an anonymous caller`)
    }
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
