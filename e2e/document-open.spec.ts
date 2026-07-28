import { strict as assert } from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { parse, stringify } from 'yaml'

const APP_START_TIMEOUT_MS = 120_000
const DOCUMENT_RENDER_TIMEOUT_MS = 30_000
const MARKER = 'ZETTLR_E2E_VISIBLE_DOCUMENT_MARKER_4E8C8D8A'
const REPO_ROOT = path.resolve(process.cwd())
const ARTIFACT_DIRECTORY = path.join(
  tmpdir(),
  'zettlr-document-open-e2e-latest'
)

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function outputTail(output: string): string {
  return output.split('\n').slice(-100).join('\n')
}

async function waitForDevTools(
  appProcess: ChildProcess,
  getOutput: () => string
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Electron did not expose DevTools within ${APP_START_TIMEOUT_MS}ms.\n${outputTail(getOutput())}`
        )
      )
    }, APP_START_TIMEOUT_MS)

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

async function findEditorPage(browser: Browser): Promise<Page> {
  const deadline = Date.now() + DOCUMENT_RENDER_TIMEOUT_MS

  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          if ((await page.locator('.cm-content').count()) > 0) {
            return page
          }
        } catch {
          // The window can be replaced while the application is starting.
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
    `No editor window appeared within ${DOCUMENT_RENDER_TIMEOUT_MS}ms. Open pages: ${JSON.stringify(openPages)}`
  )
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessGroupExit(
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

async function stopProcess(
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

async function preserveArtifacts(
  fixtureRoot: string | undefined,
  processOutput: string,
  rendererEvents: string[]
): Promise<void> {
  await rm(ARTIFACT_DIRECTORY, { recursive: true, force: true })
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true })
  await writeFile(
    path.join(ARTIFACT_DIRECTORY, 'process.log'),
    processOutput,
    'utf8'
  )
  await writeFile(
    path.join(ARTIFACT_DIRECTORY, 'renderer-events.log'),
    `${rendererEvents.join('\n')}\n`,
    'utf8'
  )

  if (fixtureRoot !== undefined) {
    const appLogs = path.join(fixtureRoot, 'config', 'logs')
    await cp(appLogs, path.join(ARTIFACT_DIRECTORY, 'app-logs'), {
      recursive: true
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error
      }
    })
  }
}

describe('opening a Markdown document', function () {
  this.timeout(APP_START_TIMEOUT_MS + DOCUMENT_RENDER_TIMEOUT_MS + 30_000)

  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let processOutput = ''
  const rendererEvents: string[] = []

  before(async function () {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'zettlr-document-open-e2e-'))
    const configDirectory = path.join(fixtureRoot, 'config')
    const workspaceDirectory = path.join(fixtureRoot, 'workspace')
    const documentPath = path.join(workspaceDirectory, 'opened-document.md')

    await cp(path.join(REPO_ROOT, 'resources', 'test-cfg'), configDirectory, {
      recursive: true,
    })
    await rm(path.join(configDirectory, 'logs'), {
      recursive: true,
      force: true
    })
    await mkdir(workspaceDirectory)
    await writeFile(
      documentPath,
      `# Opened document\n\n${MARKER}\n`,
      'utf8'
    )

    const configPath = path.join(configDirectory, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8'))
    config.app.openFiles = []
    config.app.openWorkspaces = [workspaceDirectory]
    config.system.checkForUpdates = false
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

    const documentsPath = path.join(configDirectory, 'documents.yaml')
    const documents = parse(await readFile(documentsPath, 'utf8'))
    const windowId = Object.keys(documents)[0]
    assert.ok(windowId, 'The test configuration must contain a main window')
    documents[windowId] = {
      type: 'leaf',
      id: '7b4dd4f2-48a2-4279-b6c9-577132e64480',
      openFiles: [{ path: documentPath, pinned: false }],
      activeFile: { path: documentPath, pinned: false },
    }
    await writeFile(documentsPath, stringify(documents), 'utf8')

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
    const needsVirtualDisplay =
      process.platform === 'linux' &&
      process.env.DISPLAY === undefined &&
      process.env.WAYLAND_DISPLAY === undefined
    const executable = needsVirtualDisplay ? 'xvfb-run' : forgeExecutable
    const args = needsVirtualDisplay
      ? ['--auto-servernum', forgeExecutable, ...forgeArguments]
      : forgeArguments

    appProcess = spawn(executable, args, {
      cwd: REPO_ROOT,
      detached: true,
      env: { ...process.env, NODE_ENV: 'develop' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const appendOutput = (chunk: Buffer): void => {
      processOutput = `${processOutput}${chunk.toString()}`.slice(-200_000)
    }
    appProcess.stdout?.on('data', appendOutput)
    appProcess.stderr?.on('data', appendOutput)

    const devToolsUrl = await waitForDevTools(appProcess, () => processOutput)
    browser = await chromium.connectOverCDP(devToolsUrl)
    const observePage = (page: Page): void => {
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
        dialog.dismiss().catch(() => undefined)
      })
    }
    for (const context of browser.contexts()) {
      context.pages().forEach(observePage)
      context.on('page', observePage)
    }
  })

  after(async function () {
    const mainWindow = browser
      ?.contexts()
      .flatMap(context => context.pages())
      .find(page => page.url().includes('/main_window/'))
    await mainWindow?.close({ runBeforeUnload: true }).catch(() => undefined)
    await stopProcess(appProcess)
    await browser?.close().catch(() => undefined)
    await preserveArtifacts(fixtureRoot, processOutput, rendererEvents)
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`)
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
  })

  it('renders the contents of the active nonempty document', async function () {
    assert.ok(browser, 'The application must be running')
    const page = await findEditorPage(browser)
    const editor = page.locator('.cm-content')
    await editor.waitFor({
      state: 'visible',
      timeout: DOCUMENT_RENDER_TIMEOUT_MS,
    })
    const renderedText = await editor.innerText()

    assert.ok(
      renderedText.includes(MARKER),
      `The opened nonempty document rendered as an empty or incorrect buffer.\n` +
        `Rendered editor text: ${JSON.stringify(renderedText)}\n` +
        `Page URL: ${page.url()}\n` +
        `Application output:\n${outputTail(processOutput)}`
    )
    assert.deepEqual(
      rendererEvents,
      [],
      `The renderer reported unexpected errors or dialogs:\n${rendererEvents.join('\n')}`
    )
  })
})
