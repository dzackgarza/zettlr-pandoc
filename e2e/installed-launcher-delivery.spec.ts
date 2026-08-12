// The #52 boundary proof: file arguments must survive the COMPLETE installed
// launcher chain — desktop entry → zettlr-pandoc-dev → kitty splash →
// zettlr-pandoc-boot → packaged Electron binary (cold) or
// zettlr-pandoc-open-in-running (running instance) — and end as a document in
// the real editor. Every earlier test starts somewhere inside that chain, so
// only this spec can catch an argument dropped at an outer link.
//
// The chain is exercised exactly as a desktop session runs it: the launcher is
// installed under an isolated $HOME, and each delivery starts from the
// installed .desktop entry via `gio launch`. Isolation is by $HOME alone —
// window management is real Hyprland, which is global to the session, so this
// spec REQUIRES a live Hyprland compositor and no other running Zettlr-Pandoc.
// Those are asserted up front and failures are loud: a skipped or simulated
// run would be exactly the helper-level proof this spec exists to replace.

import { strict as assert } from 'node:assert'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { agentClient, delay, readAgentApiPort, type AgentClient } from './support/electron-app'

const execFile = promisify(execFileCallback)

const REPO_ROOT = path.resolve(__dirname, '..')
const APP_WINDOW_CLASS = 'zettlr-pandoc'
const SPLASH_WINDOW_CLASS = 'zpandoc-boot'

const COLD_MARKER = 'INSTALLED_LAUNCHER_COLD_DELIVERY_MARKER_7C40D1B2'
const RUNNING_MARKER = 'INSTALLED_LAUNCHER_RUNNING_DELIVERY_MARKER_9A81E6F4'

interface HyprlandClient {
  class: string
  pid: number
}

async function hyprlandClients (): Promise<HyprlandClient[]> {
  const { stdout } = await execFile('hyprctl', ['clients', '-j'])
  const parsed: unknown = JSON.parse(stdout)
  assert.ok(Array.isArray(parsed), 'hyprctl clients -j must return an array')
  return parsed.filter((client): client is HyprlandClient =>
    typeof client === 'object' && client !== null &&
    'class' in client && typeof client.class === 'string' &&
    'pid' in client && typeof client.pid === 'number'
  )
}

async function windowsOfClass (windowClass: string): Promise<HyprlandClient[]> {
  return (await hyprlandClients()).filter(client => client.class === windowClass)
}

/** Thrown only when a poll deadline expires; probe failures propagate as-is. */
class PollTimeoutError extends Error {}

async function pollUntil<T> (
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  description: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe()
    if (result !== undefined) {
      return result
    }
    await delay(500)
  }
  throw new PollTimeoutError(`Timed out after ${timeoutMs}ms waiting for ${description}`)
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Signals the process group. 'gone' is the one legal alternative — ESRCH,
 * the group already exited. Every other failure (EPERM, EINVAL) is a real
 * teardown defect and propagates.
 */
function signalGroup (pid: number, signal: NodeJS.Signals): 'delivered' | 'gone' {
  try {
    process.kill(-pid, signal)
    return 'delivered'
  } catch (error) {
    if (isRecord(error) && error.code === 'ESRCH') {
      return 'gone'
    }
    throw error
  }
}

/** The open-document summaries of GET /v1/context, keyed by absolute path. */
async function openDocumentPaths (api: AgentClient): Promise<string[]> {
  const context = await api.get('/v1/context')
  assert.ok(isRecord(context) && Array.isArray(context.openDocuments))
  return context.openDocuments.map((document: unknown) => {
    assert.ok(isRecord(document) && typeof document.path === 'string')
    return document.path
  })
}

describe('file delivery through the installed desktop launcher (#52)', function () {
  // The cold path may repackage the app when the source fingerprint is stale.
  this.timeout(600_000)

  let testHome: string | undefined
  let appPid: number | undefined

  const environment = (): NodeJS.ProcessEnv => {
    // $HOME isolation: the wrapper, boot script, and Electron all derive
    // their paths from HOME / XDG fallbacks. XDG_RUNTIME_DIR stays — it is
    // session-owned, not home-owned, and Wayland/Hyprland need it.
    const child: NodeJS.ProcessEnv = { ...process.env, HOME: testHome }
    delete child.XDG_CONFIG_HOME
    delete child.XDG_DATA_HOME
    delete child.XDG_CACHE_HOME
    delete child.XDG_STATE_HOME
    return child
  }

  before(async function () {
    // Hard environment preconditions. Failing them fails the suite loudly:
    // this proof cannot degrade to a helper-level launch.
    await execFile('hyprctl', ['clients', '-j']).catch((error: Error) => {
      assert.fail(`A live Hyprland compositor is required for the installed-launcher proof: ${error.message}`)
    })
    for (const requiredCommand of ['kitty', 'gio', 'jq', 'just']) {
      await execFile('sh', ['-c', `command -v ${requiredCommand}`]).catch(() => {
        assert.fail(`Required command is unavailable: ${requiredCommand}`)
      })
    }
    const preexisting = await windowsOfClass(APP_WINDOW_CLASS)
    assert.equal(
      preexisting.length,
      0,
      'Another Zettlr-Pandoc instance is running. The launcher chain is ' +
      'single-instance per desktop, so this proof needs the session to itself: ' +
      'close the running app and re-run.'
    )

    const macroGenerator = path.join(homedir(), '.pandoc', 'bin', 'generate-mathjax-config.py')
    await readFile(macroGenerator).catch((error: NodeJS.ErrnoException) => {
      assert.fail(
        `The boot script requires the workstation MathJax generator at ${macroGenerator}: ${error.message}`
      )
    })

    // An isolated $HOME with the real ~/.pandoc linked in (the boot script's
    // one workstation-owned dependency) and the app profile pre-seeded the
    // same way the other e2e fixtures seed theirs.
    testHome = await mkdtemp(path.join(tmpdir(), 'zettlr-launcher-home-'))
    await symlink(path.join(homedir(), '.pandoc'), path.join(testHome, '.pandoc'))
    const profileDirectory = path.join(testHome, '.config', 'Zettlr-Pandoc')
    const workspaceDirectory = path.join(testHome, 'workspace')
    await mkdir(profileDirectory, { recursive: true })
    await mkdir(workspaceDirectory, { recursive: true })

    const packageMetadata: unknown = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')
    )
    assert.ok(
      isRecord(packageMetadata) && typeof packageMetadata.version === 'string',
      'package.json must declare the application version'
    )
    await writeFile(
      path.join(profileDirectory, 'config.json'),
      `${JSON.stringify({
        version: packageMetadata.version,
        app: { openFiles: [], openWorkspaces: [workspaceDirectory] },
        system: { checkForUpdates: false },
        agentApi: { enabled: true, port: 0 }
      }, null, 2)}\n`,
      'utf8'
    )
    // Pre-seed the window layout the same way createFixture() does, so the
    // launch restores one known editor leaf instead of running first-start
    // logic whose focus would compete with the delivered file.
    const alreadyOpenDocument = path.join(workspaceDirectory, 'already-open.md')
    await writeFile(alreadyOpenDocument, '# Already open\n\nSeed document.\n', 'utf8')
    await writeFile(
      path.join(profileDirectory, 'documents.yaml'),
      [
        '56b44854-b144-4a6f-8061-dcfeb6e512e8:',
        '  type: leaf',
        '  id: 7b4dd4f2-48a2-4279-b6c9-577132e64480',
        '  openFiles:',
        `    - path: ${alreadyOpenDocument}`,
        '      pinned: false',
        `  activeFile:`,
        `    path: ${alreadyOpenDocument}`,
        '    pinned: false',
        ''
      ].join('\n'),
      'utf8'
    )

    const installation = await execFile(
      path.join(REPO_ROOT, 'scripts', 'install-desktop-launcher.sh'),
      [],
      { env: environment() }
    )
    assert.match(installation.stdout, /Installed Zettlr-Pandoc desktop launcher/)
  })

  after(async function () {
    if (appPid !== undefined) {
      // The packaged binary runs setsid in its own process group; terminate
      // the whole group so renderer and GPU children do not outlive the test.
      const windowGone = async (): Promise<true | undefined> =>
        (await windowsOfClass(APP_WINDOW_CLASS)).length === 0 ? true : undefined
      if (signalGroup(appPid, 'SIGTERM') === 'delivered') {
        try {
          await pollUntil(windowGone, 30_000, 'the app group to exit on SIGTERM')
        } catch (error) {
          if (!(error instanceof PollTimeoutError)) {
            throw error
          }
          // Bounded escalation, not tolerance: KILL the group, then require
          // the window to actually vanish or fail the teardown loudly.
          signalGroup(appPid, 'SIGKILL')
          await pollUntil(windowGone, 10_000, 'the app group to exit on SIGKILL')
        }
      }
    }
    if (testHome !== undefined) {
      await rm(testHome, { recursive: true, force: true })
    }
  })

  it('cold start opens the file argument as the focused editor document', async function () {
    assert.ok(testHome !== undefined)
    const profileDirectory = path.join(testHome, '.config', 'Zettlr-Pandoc')
    const coldDocument = path.join(testHome, 'workspace', 'delivered-cold.md')
    await writeFile(coldDocument, `# Cold delivery\n\n${COLD_MARKER}\n`, 'utf8')

    // The exact gesture a desktop session performs: activate the installed
    // desktop entry with a file argument.
    const desktopFile = path.join(
      testHome, '.local', 'share', 'applications', 'zettlr-pandoc.desktop'
    )
    await execFile('gio', ['launch', desktopFile, coldDocument], { env: environment() })

    const appWindow = await pollUntil(
      async () => (await windowsOfClass(APP_WINDOW_CLASS))[0],
      this.timeout() - 60_000,
      `a mapped ${APP_WINDOW_CLASS} window from the cold launch`
    )
    assert.ok(appWindow.pid > 0)

    const port = await readAgentApiPort(profileDirectory, 60_000)
    const api = agentClient(port)
    const ping = await api.get('/v1/ping')
    assert.ok(isRecord(ping) && typeof ping.pid === 'number')
    appPid = ping.pid

    // The delivered file must become the focused document with the authored
    // bytes — "a window appeared" is not delivery.
    const focused = await pollUntil(
      async () => {
        const context = await api.get('/v1/context')
        if (isRecord(context) && isRecord(context.focusedDocument) &&
          context.focusedDocument.path === coldDocument) {
          return context.focusedDocument
        }
        return undefined
      },
      60_000,
      'the cold-delivered file to become the focused document'
    )
    assert.ok(isRecord(focused) && typeof focused.documentId === 'string')
    const content = await api.get(
      `/v1/documents/${encodeURIComponent(focused.documentId)}/content`
    )
    assert.ok(isRecord(content) && typeof content.content === 'string')
    assert.ok(
      content.content.includes(COLD_MARKER),
      'the editor must hold the authored contents of the delivered file'
    )
  })

  it('a second activation delivers its file into the running instance', async function () {
    assert.ok(testHome !== undefined && appPid !== undefined)
    const profileDirectory = path.join(testHome, '.config', 'Zettlr-Pandoc')
    const runningDocument = path.join(testHome, 'workspace', 'delivered-running.md')
    await writeFile(runningDocument, `# Running delivery\n\n${RUNNING_MARKER}\n`, 'utf8')

    const desktopFile = path.join(
      testHome, '.local', 'share', 'applications', 'zettlr-pandoc.desktop'
    )
    await execFile('gio', ['launch', desktopFile, runningDocument], { env: environment() })

    const port = await readAgentApiPort(profileDirectory, 60_000)
    const api = agentClient(port)
    await pollUntil(
      async () =>
        (await openDocumentPaths(api)).includes(runningDocument) ? true : undefined,
      120_000,
      'the running instance to open the delivered file'
    )

    // Same instance, not a second copy: the pid answering the API is the one
    // the cold launch started, and the desktop still shows exactly one app
    // window.
    const ping = await api.get('/v1/ping')
    assert.ok(isRecord(ping) && typeof ping.pid === 'number')
    assert.equal(ping.pid, appPid, 'delivery must reach the original instance')
    assert.equal((await windowsOfClass(APP_WINDOW_CLASS)).length, 1)
    assert.equal(
      (await windowsOfClass(SPLASH_WINDOW_CLASS)).length,
      0,
      'the boot splash must have closed after the handoff'
    )
  })
})
