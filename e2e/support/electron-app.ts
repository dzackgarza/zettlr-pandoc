// Shared assembled-app harness. Both E2E specs launch the real Forge app
// against a throwaway data directory and attach over CDP; keeping that in one
// module is what stops the second spec from copying the first one's 300 lines.
import { strict as assert } from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { stringify } from 'yaml'

export const REPO_ROOT = path.resolve(process.cwd())

export function delay (milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function requireInitialized<T> (
  value: T | undefined,
  message: string
): T {
  if (value === undefined) {
    throw new Error(message)
  }
  return value
}

export function outputTail (output: string): string {
  return output.split('\n').slice(-100).join('\n')
}

/**
 * Observe a currently available loopback port.
 *
 * This does not reserve the port: closing the probe releases ownership. The
 * assembled-app harness serializes complete Forge lifetimes below, so another
 * repository E2E run cannot race an Agent API or Forge bind. A collision with
 * an unrelated process remains a loud bind failure owned by the server.
 */
export async function findAvailablePort (): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not observe an available loopback port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

export async function waitForDevTools (
  appProcess: ChildProcess,
  getOutput: () => string,
  timeoutMs: number
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Electron did not expose DevTools within ${timeoutMs}ms.\n${outputTail(getOutput())}`
        )
      )
    }, timeoutMs)

    const inspectOutput = (): void => {
      const match = getOutput().match(/DevTools listening on (ws:\/\/\S+)/)
      if (match !== null) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    }

    appProcess.stdout?.on('data', inspectOutput)
    appProcess.stderr?.on('data', inspectOutput)
    appProcess.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    appProcess.once('exit', (code, signal) => {
      clearTimeout(timeout)
      reject(
        new Error(
          `Electron exited before exposing DevTools (code=${String(code)}, signal=${String(signal)}).\n${outputTail(getOutput())}`
        )
      )
    })
  })
}

export async function findEditorPage (
  browser: Browser,
  timeoutMs: number
): Promise<Page> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          if ((await page.locator('.cm-content').count()) > 0) {
            return page
          }
        } catch (error) {
          if (page.isClosed()) {
            continue
          }
          throw new Error(`Could not inspect editor page ${page.url()}`, {
            cause: error
          })
        }
      }
    }

    await delay(250)
  }

  const openPages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .map((page) => page.url())
  throw new Error(
    `No editor window appeared within ${timeoutMs}ms. Open pages: ${JSON.stringify(openPages)}`
  )
}

function processGroupIsAlive (pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ESRCH'
    ) {
      return false
    }
    throw error
  }
}

async function waitForProcessGroupExit (
  pid: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processGroupIsAlive(pid)) {
      return true
    }
    await delay(100)
  }
  return !processGroupIsAlive(pid)
}

export async function stopProcess (
  appProcess: ChildProcess | undefined
): Promise<void> {
  if (appProcess?.pid === undefined) {
    return
  }

  if (await waitForProcessGroupExit(appProcess.pid, 10_000)) {
    return
  }

  process.kill(-appProcess.pid, 'SIGTERM')
  if (!(await waitForProcessGroupExit(appProcess.pid, 5_000))) {
    process.kill(-appProcess.pid, 'SIGKILL')
    await waitForProcessGroupExit(appProcess.pid, 5_000)
  }
}

export async function readAppLog (fixtureRoot: string): Promise<string> {
  const logDirectory = path.join(fixtureRoot, 'config', 'logs')
  const filenames = await readdir(logDirectory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return [] as string[]
      }
      throw error
    }
  )
  return (
    await Promise.all(
      filenames
        .filter(filename => filename.endsWith('.log'))
        .map(async filename =>
          await readFile(path.join(logDirectory, filename), 'utf8')
        )
    )
  ).join('\n')
}

export async function preserveArtifacts (
  artifactDirectory: string,
  fixtureRoot: string | undefined,
  processOutput: string,
  rendererEvents: string[],
  screenshots: ReadonlyMap<string, Buffer>
): Promise<void> {
  await rm(artifactDirectory, { recursive: true, force: true })
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(
    path.join(artifactDirectory, 'process.log'),
    processOutput,
    'utf8'
  )
  await writeFile(
    path.join(artifactDirectory, 'renderer-events.log'),
    `${rendererEvents.join('\n')}\n`,
    'utf8'
  )
  for (const [filename, screenshot] of screenshots) {
    await writeFile(path.join(artifactDirectory, filename), screenshot)
  }

  if (fixtureRoot !== undefined) {
    const appLogs = path.join(fixtureRoot, 'config', 'logs')
    await cp(appLogs, path.join(artifactDirectory, 'app-logs'), {
      recursive: true
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error
      }
    })
  }
}

export interface Fixture {
  root: string
  configDirectory: string
  documentPath: string
}

export interface FixtureOptions {
  /** Basename of the single document opened in the active leaf. */
  documentName: string
  /** Exact bytes written to that document. */
  documentContents: string
  /**
   * Extra config.json keys merged over the defaults — the Agent API spec uses
   * this to pin `agentApi.port` to a port it owns for the run.
   */
  config?: Record<string, unknown>
}

export async function createFixture (
  prefix: string,
  options: FixtureOptions
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  const configDirectory = path.join(root, 'config')
  const workspaceDirectory = path.join(root, 'workspace')
  const documentPath = path.join(workspaceDirectory, options.documentName)

  await mkdir(configDirectory)
  await mkdir(workspaceDirectory)
  await writeFile(documentPath, options.documentContents, 'utf8')

  const packageMetadata: unknown = JSON.parse(
    await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')
  )
  assert.ok(
    packageMetadata !== null &&
      typeof packageMetadata === 'object' &&
      'version' in packageMetadata &&
      typeof packageMetadata.version === 'string',
    'package.json must declare the application version'
  )
  await writeFile(
    path.join(configDirectory, 'config.json'),
    `${JSON.stringify(
      {
        version: packageMetadata.version,
        app: {
          openFiles: [],
          openWorkspaces: [workspaceDirectory]
        },
        system: { checkForUpdates: false },
        ...options.config
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  const documents = {
    '56b44854-b144-4a6f-8061-dcfeb6e512e8': {
      type: 'leaf',
      id: '7b4dd4f2-48a2-4279-b6c9-577132e64480',
      openFiles: [{ path: documentPath, pinned: false }],
      activeFile: { path: documentPath, pinned: false }
    }
  }
  await writeFile(
    path.join(configDirectory, 'documents.yaml'),
    stringify(documents),
    'utf8'
  )

  return { root, configDirectory, documentPath }
}

export interface LaunchOptions {
  /**
   * Bearer token the launched app must demand. Absent means it boots unguarded.
   * There is no third state: an inherited token is always discarded, so the
   * caller's choice here is the only thing that decides the app's auth mode.
   */
  agentApiToken?: string
}

export async function launchElectron (
  configDirectory: string,
  options: LaunchOptions = {}
): Promise<ChildProcess> {
  const forgeExecutable = path.join(
    REPO_ROOT,
    'node_modules',
    '.bin',
    'electron-forge'
  )
  const forgeArguments = [
    'start',
    '--',
    `--data-dir=${configDirectory}`,
    '--remote-debugging-port=0',
    '--disable-hardware-acceleration',
    // Kept for one property only: whether a test passes must not depend on
    // which window happens to be on top. Chromium does throttle renderers it
    // considers occluded, which would stall the style recalculation a :hover
    // assertion waits on.
    //
    // These flags are NOT known to have fixed anything. They were added after
    // a suite failure that occlusion would explain, but the green run cited as
    // evidence changed two things at once -- the flags went in and the other
    // agents sharing this checkout stopped -- so it discriminates nothing.
    // Competing candidates for that failure remain open: concurrent runs
    // corrupting each other through the repo-wide .webpack build directory,
    // and a boot/shutdown-shaped failure seen with neither signature. Do not
    // cite these flags as the fix for suite instability.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding'
  ]
  const needsVirtualDisplay =
    process.platform === 'linux' &&
    process.env.DISPLAY === undefined &&
    process.env.WAYLAND_DISPLAY === undefined
  const executable = needsVirtualDisplay ? 'xvfb-run' : forgeExecutable
  const args = needsVirtualDisplay
    ? ['--auto-servernum', forgeExecutable, ...forgeArguments]
    : forgeArguments

  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'develop',
    ZETTLR_FORGE_RENDERER_PORT: '3100',
    ZETTLR_FORGE_LOGGER_PORT: '9001'
  }
  // An inherited token would boot the app in bearer-token mode and silently
  // change what every unauthenticated spec is testing, so the developer's
  // shell does not get a vote: only an explicit request supplies one.
  delete childEnvironment.ZETTLR_AGENT_API_TOKEN
  if (options.agentApiToken !== undefined) {
    childEnvironment.ZETTLR_AGENT_API_TOKEN = options.agentApiToken
  }

  // Forge owns two fixed TCP ports and writes the repository-wide .webpack
  // tree. The lock spans the complete child lifetime, so a second repository
  // E2E launch is refused before either shared resource can be touched. flock
  // holds the descriptor through the wrapped command and the kernel releases
  // it if that process dies; there is no check-then-release ownership gap.
  const launchLock = path.join(tmpdir(), 'zettlr-pandoc-electron-e2e.lock')
  return spawn('flock', [
    '--exclusive',
    '--nonblock',
    '--verbose',
    launchLock,
    executable,
    ...args
  ], {
    cwd: REPO_ROOT,
    detached: true,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

export function observeRenderer (page: Page, rendererEvents: string[]): void {
  page.on('console', message => {
    if (message.type() === 'error') {
      rendererEvents.push(`console.error: ${message.text()}`)
    }
  })
  page.on('pageerror', error => {
    rendererEvents.push(`pageerror: ${error.stack ?? error.message}`)
  })
  page.on('dialog', dialog => {
    rendererEvents.push(`dialog.${dialog.type()}: ${dialog.message()}`)
    void dialog.dismiss().catch(error => {
      rendererEvents.push(`dialog-dismiss-error: ${String(error)}`)
    })
  })
}

/**
 * A launched app plus the CDP connection to it. `attach` performs the whole
 * before-hook sequence so specs do not each re-derive the ordering.
 */
export interface RunningApp {
  appProcess: ChildProcess
  browser: Browser
  getOutput: () => string
}

export async function attach (
  configDirectory: string,
  rendererEvents: string[],
  timeoutMs: number,
  options: LaunchOptions = {}
): Promise<RunningApp> {
  const appProcess = await launchElectron(configDirectory, options)
  let processOutput = ''
  const appendOutput = (chunk: Buffer): void => {
    processOutput = `${processOutput}${chunk.toString()}`.slice(-200_000)
  }
  appProcess.stdout?.on('data', appendOutput)
  appProcess.stderr?.on('data', appendOutput)

  const devToolsUrl = await waitForDevTools(
    appProcess,
    () => processOutput,
    timeoutMs
  )
  const browser = await chromium.connectOverCDP(devToolsUrl)
  for (const context of browser.contexts()) {
    context.pages().forEach(page => observeRenderer(page, rendererEvents))
    context.on('page', page => observeRenderer(page, rendererEvents))
  }

  return { appProcess, browser, getOutput: () => processOutput }
}

export async function shutdown (
  browser: Browser | undefined,
  appProcess: ChildProcess | undefined
): Promise<void> {
  const mainWindow = browser
    ?.contexts()
    .flatMap(context => context.pages())
    .find(page => page.url().includes('/main_window/'))
  await mainWindow?.close({ runBeforeUnload: true })
  await stopProcess(appProcess)
  await browser?.close()
}

export function assertCleanExit (processOutput: string): void {
  assert.doesNotMatch(
    processOutput,
    /(?:^|\n).*FATAL:|Uncaught exception/,
    `The application terminated with a fatal runtime error.\n${outputTail(processOutput)}`
  )
  if (processOutput.includes('DevTools listening on')) {
    assert.match(
      processOutput,
      /Shutting down at/,
      `The application did not complete a graceful shutdown.\n${outputTail(processOutput)}`
    )
  }
}
