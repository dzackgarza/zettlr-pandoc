// Proof that a global search which never starts says so in the pane the user
// started it from.
//
// Starting a search puts the pane into its running presentation — progress bar
// up, Search disabled, previous results cleared — and then dispatches over IPC.
// Only the search provider ends that state, by broadcasting 'search-end'. So a
// dispatch that rejects ends nothing: the pane keeps showing a run that is not
// happening, and a failure handler that writes to the developer console leaves
// the user no reachable signal at all.
//
// The failure here is a real one, not an injected one. A workspace that goes
// away while the app is running stays in `app.openWorkspaces`: the dead-path
// sweep runs once, when the config is read at boot, and FSAL deliberately keeps
// such roots afterwards ("Workspaces can be marked as 'dead' so that users
// don't lose them"). The search provider consults neither — its very first act
// is to read every open workspace recursively, which throws on the vanished one
// and rejects the renderer's invoke. A user whose workspace lives on a drive
// that unmounts, or a synced folder that disappears, hits exactly this.
import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Browser, type Locator, type Page } from 'playwright'
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  requireInitialized,
  shutdown
} from './support/electron-app'

const ARTIFACT_DIRECTORY = path.join(
  tmpdir(),
  'zettlr-global-search-dispatch-failure-e2e-latest'
)

/** The pane, and the parts of it this spec reads. */
const PANE = '#global-search-pane'
const QUERY_INPUT = `${PANE} input#field-inputquery-input`
const RUNNING_INDICATOR = `${PANE} progress`
const ERROR_MESSAGE = `${PANE} p.search-error`
const REPLACEMENT_RESULT = `${PANE} .single-search-result .filename`

const PROJECT_SETTINGS = {
  sorting: 'name-up',
  project: {
    title: 'Initial project',
    profiles: [],
    files: [],
    cslStyle: '',
    templates: { tex: '', html: '' }
  },
  icon: null,
  color: null
}

const SEARCH_CORPUS_FILES = 128
const SEARCHABLE_PADDING = 'ordinary words '.repeat(120)

/** The pane's Search button — 'Cancel' and 'Clear search' sit beside it. */
function searchButton (page: Page): Locator {
  return page.locator(PANE).getByRole('button', { name: 'Search', exact: true })
}

interface RunningFixture {
  appProcess: ChildProcess | undefined
  browser: Browser | undefined
  fixtureRoot: string | undefined
  workspace: string | undefined
  projectSettingsFile: string | undefined
  vanishingWorkspace: string | undefined
  getOutput: () => string
  rendererEvents: string[]
  screenshots: Map<string, Buffer>
}

/**
 * Boots the app with two workspaces open: the fixture's own, and a second one
 * this spec later deletes out from under the running app. Both must exist at
 * boot, because the config drops workspaces that are already missing when it is
 * read. createFixture writes the config before it knows the second path, so
 * that path is merged into the file it produced rather than by widening the
 * shared harness.
 */
async function boot (fixture: RunningFixture, timeoutMs: number): Promise<void> {
  const created = await createFixture('zettlr-global-search-dispatch-failure-e2e-', {
    documentName: 'searched-document.md',
    documentContents: '# Searchable\n\nThe word haystack appears here.\n'
  })
  fixture.fixtureRoot = created.root
  const workspace = path.dirname(created.documentPath)
  fixture.workspace = workspace
  const projectSettingsFile = path.join(workspace, '.ztr-directory')
  fixture.projectSettingsFile = projectSettingsFile
  await writeFile(projectSettingsFile, JSON.stringify(PROJECT_SETTINGS), 'utf8')

  for (let index = 0; index < SEARCH_CORPUS_FILES; index += 1) {
    await writeFile(
      path.join(workspace, `search-corpus-${String(index).padStart(3, '0')}.md`),
      `# Corpus ${index}\n\n${SEARCHABLE_PADDING}\n`,
      'utf8'
    )
  }
  await writeFile(
    path.join(workspace, 'replacement-hit.md'),
    '# Replacement\n\nreplacementtoken appears here.\n',
    'utf8'
  )

  const vanishingWorkspace = path.join(created.root, 'workspace-on-a-removable-drive')
  await mkdir(vanishingWorkspace)
  await writeFile(
    path.join(vanishingWorkspace, 'note-on-the-drive.md'),
    '# On the drive\n\nAnother haystack lives here.\n',
    'utf8'
  )
  fixture.vanishingWorkspace = vanishingWorkspace

  const configPath = path.join(created.configDirectory, 'config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    app: { openWorkspaces: string[] }
  }
  config.app.openWorkspaces = [...config.app.openWorkspaces, vanishingWorkspace]
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const app = await attach(created.configDirectory, fixture.rendererEvents, timeoutMs)
  fixture.appProcess = app.appProcess
  fixture.browser = app.browser
  fixture.getOutput = app.getOutput
}

async function teardown (fixture: RunningFixture): Promise<void> {
  await shutdown(fixture.browser, fixture.appProcess)
  await preserveArtifacts(
    ARTIFACT_DIRECTORY,
    fixture.fixtureRoot,
    fixture.getOutput(),
    fixture.rendererEvents,
    fixture.screenshots
  )
  if (fixture.fixtureRoot !== undefined) {
    await rm(fixture.fixtureRoot, { recursive: true, force: true })
  }
  console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`)
  assertCleanExit(fixture.getOutput())
}

/** Opens the global search pane the way a user does: the toolbar toggle. */
async function openSearchPane (page: Page, timeoutMs: number): Promise<void> {
  const queryInput = page.locator(QUERY_INPUT)
  if (!(await queryInput.isVisible())) {
    await page
      .locator('#toolbar-toggle-file-manager button[title="Search across all files"]')
      .click()
    await queryInput.waitFor({ state: 'visible', timeout: timeoutMs })
  }
}

async function findProjectPropertiesPage (
  browser: Browser,
  timeoutMs: number
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if ((await page.locator('#formats-panel').count()) > 0) {
          return page
        }
      }
    }
    await delay(100)
  }
  throw new Error(`No project-properties window appeared within ${timeoutMs}ms`)
}

async function waitForProjectState (
  page: Page,
  workspace: string,
  shouldBeProject: boolean
): Promise<void> {
  await page.waitForFunction(
    async ({ directoryPath, enabled }) => {
      const descriptor = await window.ipc.invoke('fsal', {
        command: 'get-descriptor',
        payload: directoryPath
      })
      return descriptor !== undefined &&
        !Array.isArray(descriptor) &&
        descriptor.type === 'directory' &&
        (descriptor.settings.project !== null) === enabled
    },
    { directoryPath: workspace, enabled: shouldBeProject },
    { timeout: 30_000 }
  )
}

async function waitForRendererEvent (
  events: string[],
  fragment: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (events.some(event => event.includes(fragment))) {
      return
    }
    await delay(100)
  }
  assert.fail(`Renderer never reported ${JSON.stringify(fragment)}`)
}

async function waitForProjectTitle (
  settingsFile: string,
  expectedTitle: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let settings: unknown
    try {
      settings = JSON.parse(await readFile(settingsFile, 'utf8'))
    } catch (error) {
      if (error instanceof SyntaxError) {
        await delay(100)
        continue
      }
      throw error
    }
    if (
      settings !== null &&
      typeof settings === 'object' &&
      'project' in settings &&
      settings.project !== null &&
      typeof settings.project === 'object' &&
      'title' in settings.project &&
      settings.project.title === expectedTitle
    ) {
      return
    }
    await delay(100)
  }
  assert.fail(`Project settings never persisted title ${JSON.stringify(expectedTitle)}`)
}

describe('global-search and project-properties failure recovery', function () {
  this.timeout(300_000)

  const running: RunningFixture = {
    appProcess: undefined,
    browser: undefined,
    fixtureRoot: undefined,
    workspace: undefined,
    projectSettingsFile: undefined,
    vanishingWorkspace: undefined,
    getOutput: () => '',
    rendererEvents: [],
    screenshots: new Map<string, Buffer>()
  }
  const { screenshots } = running

  before(async function () {
    await boot(running, this.timeout())
  })

  after(async function () {
    await teardown(running)
  })

  it('starts the edited query after cancelling the active search', async function () {
    assert.ok(running.browser, 'The application must be running')
    const page = await findEditorPage(running.browser, this.timeout())
    await openSearchPane(page, 30_000)

    const queryInput = page.locator(QUERY_INPUT)
    await queryInput.fill('notpresentinthecorpus')
    await searchButton(page).click()
    // Replace the query immediately after starting it. The running indicator
    // can appear and disappear between two CDP polls on a fast machine; the
    // user gesture under test is Enter while the dispatched search is active,
    // not observation of that transient paint.
    await queryInput.fill('replacementtoken')
    await queryInput.press('Enter')
    await page.locator(REPLACEMENT_RESULT).filter({
      hasText: 'replacement-hit.md'
    }).waitFor({ state: 'visible', timeout: 60_000 })
  })

  it('retries a project edit after descriptor validation recovers', async function () {
    const workspace = requireInitialized(
      running.workspace,
      'The fixture workspace must be initialized'
    )
    const projectSettingsFile = requireInitialized(
      running.projectSettingsFile,
      'The project settings path must be initialized'
    )
    assert.ok(running.browser, 'The application must be running')
    const mainPage = await findEditorPage(running.browser, this.timeout())

    // The visible Project Settings button dispatches this exact production
    // application command from PopoverDirProps. Its containing directory
    // popover is reached from an Electron native context menu, which CDP
    // cannot select; enter at the command boundary, then drive the real
    // project-properties window and controls.
    await mainPage.evaluate(
      async ([directoryPath]) =>
        await window.ipc.invoke('application', {
          command: 'open-project-preferences',
          payload: directoryPath
        }),
      [workspace]
    )

    const propertiesPage = await findProjectPropertiesPage(
      running.browser,
      30_000
    )
    try {
      const titleInput = propertiesPage.getByLabel('Project Title')
      await titleInput.waitFor({ state: 'visible', timeout: 30_000 })
      assert.equal(await titleInput.inputValue(), 'Initial project')

      await rm(projectSettingsFile)
      await waitForProjectState(mainPage, workspace, false)
      await titleInput.fill('First edit cannot persist')
      await waitForRendererEvent(
        running.rendererEvents,
        'Project was null',
        30_000
      )

      await writeFile(projectSettingsFile, JSON.stringify(PROJECT_SETTINGS), 'utf8')
      await waitForProjectState(mainPage, workspace, true)
      await titleInput.fill('Recovered project title')
      await waitForProjectTitle(
        projectSettingsFile,
        'Recovered project title',
        10_000
      )
    } finally {
      if (!propertiesPage.isClosed()) {
        await propertiesPage.evaluate(() => {
          window.ipc.send('window-controls', { command: 'win-close' })
        })
        await propertiesPage.waitForEvent('close', { timeout: 10_000 })
      }
    }
  })

  it('names the failure in the pane and stops showing the search as running', async function () {
    const vanishingWorkspace = requireInitialized(
      running.vanishingWorkspace,
      'The vanishing workspace path must be initialized'
    )
    assert.ok(running.browser, 'The application must be running')
    const page = await findEditorPage(running.browser, this.timeout())
    await openSearchPane(page, 30_000)

    // The drive goes away with the app already up, so the vanished root is
    // still an open workspace when the search provider reads it.
    await rm(vanishingWorkspace, { recursive: true, force: true })

    await page.locator(QUERY_INPUT).fill('haystack')
    await searchButton(page).click()

    // The pane owns the running presentation, so the pane is where the failure
    // has to land. Waiting on it is the whole test: before this fix nothing
    // ever appeared here and the wait ran out with the progress bar still up.
    const errorMessage = page.locator(ERROR_MESSAGE)
    await errorMessage.waitFor({ state: 'visible', timeout: 30_000 })
    screenshots.set('search-dispatch-failed.png', await page.screenshot())

    const reported = await errorMessage.innerText()
    assert.match(
      reported,
      /^Search failed: /,
      `The pane must name the operation that failed. It read: ${JSON.stringify(reported)}`
    )
    assert.ok(
      reported.includes(vanishingWorkspace),
      'The pane must carry the provider\'s own reason, not a generic failure. ' +
        `It read: ${JSON.stringify(reported)}`
    )

    // A search that never started must not go on looking like one that is
    // merely slow, and the user must be able to try again.
    assert.equal(
      await page.locator(RUNNING_INDICATOR).count(),
      0,
      'The pane still shows a progress bar for a search that never started.'
    )
    assert.equal(
      await searchButton(page).isDisabled(),
      false,
      'The Search button stayed disabled, so the failed search cannot be retried.'
    )

    // Editing the query is the user saying "next attempt", so the report of the
    // last one must go. Asserted here, after the message has been seen, so that
    // its disappearance cannot be satisfied by never having appeared.
    await page.locator(QUERY_INPUT).fill('needle')
    await errorMessage.waitFor({ state: 'detached', timeout: 10_000 })
  })
})
