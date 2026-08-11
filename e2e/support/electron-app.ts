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

/** Bind port 0, read what the kernel gave, release it, and hand it to the caller. */
export async function reserveFreePort (): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not reserve a loopback port'))
        return
      }
      const { port } = address
      server.close(error => {
        if (error !== undefined) {
          reject(error)
          return
        }
        resolve(port)
      })
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

export async function waitForApplicationBoot (
  appProcess: ChildProcess,
  getOutput: () => string,
  timeoutMs: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `The application did not complete boot within ${timeoutMs}ms.\n${outputTail(getOutput())}`
        )
      )
    }, timeoutMs)

    const inspectOutput = (): void => {
      if (getOutput().includes('[AppServiceContainer] Boot successful!')) {
        clearTimeout(timeout)
        resolve()
      }
    }

    inspectOutput()
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
          `Electron exited before completing boot (code=${String(code)}, signal=${String(signal)}).\n${outputTail(getOutput())}`
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

/**
 * Takes the dev server's error overlay out of the way. `forge start` injects a
 * full-window iframe that intercepts pointer events, so a Playwright click on
 * a real control is refused for a reason that belongs to the harness rather
 * than to the application.
 */
export async function hideDevServerOverlay (page: Page): Promise<void> {
  await page.addStyleTag({
    content: '#webpack-dev-server-client-overlay { display: none !important; }'
  })
}

/** The Agent API, as the specs drive it: JSON in, parsed JSON out. */
export interface AgentClient {
  get: (route: string) => Promise<unknown>
  post: (route: string, body: unknown) => Promise<unknown>
  /** Like `post`, but hands back the status and raw body of a refusal. */
  postExpectingFailure: (
    route: string,
    body: unknown
  ) => Promise<{ status: number, body: unknown }>
}

export function agentClient (port: number): AgentClient {
  const base = `http://127.0.0.1:${port}`
  const post = async (route: string, body: unknown): Promise<Response> =>
    await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  const parse = async (response: Response): Promise<unknown> => {
    const text = await response.text()
    return text === '' ? undefined : JSON.parse(text)
  }
  const require = async (response: Response): Promise<unknown> => {
    const parsed = await parse(response)
    if (!response.ok) {
      throw new Error(
        `Agent API ${response.status} for ${response.url}: ${JSON.stringify(parsed)}`
      )
    }
    return parsed
  }
  return {
    get: async route => await require(await fetch(`${base}${route}`)),
    post: async (route, body) => await require(await post(route, body)),
    postExpectingFailure: async (route, body) => {
      const response = await post(route, body)
      return { status: response.status, body: await parse(response) }
    }
  }
}

/** Resolves once the Agent API answers `/v1/ping`; throws when it never does. */
export async function waitForAgentApi (
  port: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/ping`).catch(
      () => undefined
    )
    if (response?.ok === true) {
      return
    }
    await delay(250)
  }
  throw new Error(`The Agent API on port ${port} never answered /v1/ping`)
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
  /** Files delivered as literal application arguments on a cold start. */
  files?: string[]
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
    '--disable-hardware-acceleration'
  ]
  if (options.files !== undefined) {
    forgeArguments.push(...options.files)
  }
  const needsVirtualDisplay =
    process.platform === 'linux' &&
    process.env.DISPLAY === undefined &&
    process.env.WAYLAND_DISPLAY === undefined
  const executable = needsVirtualDisplay ? 'xvfb-run' : forgeExecutable
  const args = needsVirtualDisplay
    ? ['--auto-servernum', forgeExecutable, ...forgeArguments]
    : forgeArguments

  // Forge's dev server and logger need separate ports. Choose fresh loopback
  // ports for this launch; the application owns the subsequent bind and will
  // report an unrelated collision rather than silently changing ports.
  const rendererPort = await reserveFreePort()
  const loggerPort = await reserveFreePort()

  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'develop',
    ZETTLR_FORGE_RENDERER_PORT: String(rendererPort),
    ZETTLR_FORGE_LOGGER_PORT: String(loggerPort)
  }

  return spawn(executable, args, {
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
  await waitForApplicationBoot(appProcess, () => processOutput, timeoutMs)
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
