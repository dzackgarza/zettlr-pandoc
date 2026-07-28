import { strict as assert } from 'node:assert'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { stringify } from 'yaml'

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

async function findEditorPage(
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
    `No editor window appeared within ${timeoutMs}ms. Open pages: ${JSON.stringify(openPages)}`
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
  rendererEvents: string[],
  screenshots: ReadonlyMap<string, Buffer>
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
  for (const [filename, screenshot] of screenshots) {
    await writeFile(path.join(ARTIFACT_DIRECTORY, filename), screenshot)
  }

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

async function waitForAppDiagnostic(
  fixtureRoot: string,
  documentPath: string,
  timeoutMs: number
): Promise<void> {
  const logDirectory = path.join(fixtureRoot, 'config', 'logs')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const diagnostic = (
      await Promise.all(
        (await readdir(logDirectory))
          .filter(filename => filename.endsWith('.log'))
          .map(async filename =>
            await readFile(path.join(logDirectory, filename), 'utf8')
          )
      )
    ).join('\n')
    if (diagnostic.includes(documentPath) && diagnostic.includes('EACCES')) {
      return
    }
    await delay(100)
  }

  throw new Error(
    `No app diagnostic identified ${documentPath} and EACCES within ${timeoutMs}ms.`
  )
}

describe('opening a Markdown document', function () {
  let appProcess: ChildProcess | undefined
  let browser: Browser | undefined
  let fixtureRoot: string | undefined
  let documentPath: string | undefined
  let processOutput = ''
  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()

  before(async function () {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'zettlr-document-open-e2e-'))
    const configDirectory = path.join(fixtureRoot, 'config')
    const workspaceDirectory = path.join(fixtureRoot, 'workspace')
    documentPath = path.join(workspaceDirectory, 'opened-document.md')

    await mkdir(configDirectory)
    await mkdir(workspaceDirectory)
    await writeFile(
      documentPath,
      `# Opened document\n\n${MARKER}\n`,
      'utf8'
    )

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
    const configPath = path.join(configDirectory, 'config.json')
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: packageMetadata.version,
          app: {
            openFiles: [],
            openWorkspaces: [workspaceDirectory]
          },
          system: { checkForUpdates: false }
        },
        null,
        2
      )}\n`,
      'utf8'
    )

    const documentsPath = path.join(configDirectory, 'documents.yaml')
    const documents = {
      '56b44854-b144-4a6f-8061-dcfeb6e512e8': {
        type: 'leaf',
        id: '7b4dd4f2-48a2-4279-b6c9-577132e64480',
        openFiles: [{ path: documentPath, pinned: false }],
        activeFile: { path: documentPath, pinned: false }
      }
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

    const devToolsUrl = await waitForDevTools(
      appProcess,
      () => processOutput,
      this.timeout()
    )
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
    if (documentPath !== undefined) {
      await chmod(documentPath, 0o600)
    }
    await preserveArtifacts(
      fixtureRoot,
      processOutput,
      rendererEvents,
      screenshots
    )
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
    const page = await findEditorPage(browser, this.timeout())
    const editor = page.locator('.cm-content')
    await editor.waitFor({
      state: 'visible',
      timeout: this.timeout(),
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
    screenshots.set('visible-document.png', await page.screenshot())
  })

  it('attributes a remote reload failure to the active document', async function () {
    assert.ok(browser, 'The application must be running')
    assert.ok(fixtureRoot, 'The fixture root must be initialized')
    assert.ok(documentPath, 'The document path must be initialized')
    const activeDocumentPath = documentPath
    const page = await findEditorPage(browser, this.timeout())

    await chmod(activeDocumentPath, 0o000)
    const changedAt = new Date(Date.now() + 60_000)
    await utimes(activeDocumentPath, changedAt, changedAt)

    const toast = page.locator('#zettlr-toast-container .zettlr-toast.error')
    await toast.waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(
      await toast.count(),
      1,
      'The remote reload failure must produce exactly one in-app error toast.'
    )
    assert.equal(
      await toast.getAttribute('role'),
      'status',
      'The reload failure must use the app toast status surface.'
    )
    const toastText = await toast.innerText()
    assert.ok(
      toastText.includes(path.basename(activeDocumentPath)) &&
        toastText.includes('EACCES'),
      `The error toast did not attribute the reload failure to the active document.\n` +
        `Toast text: ${JSON.stringify(toastText)}`
    )
    screenshots.set('document-reload-error-toast.png', await page.screenshot())

    const matchingDiagnostics = rendererEvents.filter(
      event =>
        event.includes(activeDocumentPath) && event.includes('EACCES')
    )
    assert.equal(
      matchingDiagnostics.length,
      1,
      `Renderer diagnostics did not identify the failed document.\n` +
        rendererEvents.join('\n')
    )
    await waitForAppDiagnostic(fixtureRoot, activeDocumentPath, 20_000)
  })
})
