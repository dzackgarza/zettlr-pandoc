// Captures the real main-window chrome through the assembled-app harness: the
// Forge app launched against a throwaway config whose one workspace root is
// the Quarto book fixture, with the sidebar and the annotation review panel
// visible, attached over CDP, and screenshotted in light and dark at two
// window widths. The scenes are the proof surface for the chrome
// convergence milestones (PLAN-main-window-chrome-convergence, M0): each later
// milestone edits the scene list, never the launch.
//
// Usage: node --import tsx e2e/chrome-capture.ts <output-directory> <launch-timeout-ms>

import { strict as assert } from 'node:assert'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import type { Page } from 'playwright'
import {
  assertCleanExit,
  attach,
  createWorkspaceFixture,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  REPO_ROOT,
  shutdown
} from './support/electron-app'

const [ output, launchTimeoutArgument ] = process.argv.slice(2)
if (output === undefined || launchTimeoutArgument === undefined) {
  throw new Error('Usage: chrome-capture.ts <output-directory> <launch-timeout-ms>')
}
// How long the app may take to boot and show its editor; the recipe passes it.
const launchTimeoutMs = Number.parseInt(launchTimeoutArgument, 10)
assert.ok(
  Number.isInteger(launchTimeoutMs) && launchTimeoutMs > 0,
  `The launch timeout must be a positive number of milliseconds, got ${launchTimeoutArgument}`
)

const HEIGHT = 950
const WIDTHS = [ 1500, 1100 ] as const
const THEMES = [ 'light', 'dark' ] as const

/** One arrangement of the chrome to photograph in every theme and width. */
interface Scene {
  name: string
  arrange: (page: Page) => Promise<void>
  /** Undoes what `arrange` did when a later scene must not inherit it. */
  restore?: (page: Page) => Promise<void>
}

const PROJECT_MODULE = '#navigation-sidebar [data-module="project"]'
const PROJECT_HEADER = `${PROJECT_MODULE} .chrome-section-trigger`
const LAST_HEADER = '#navigation-sidebar [data-module="otherFiles"] .chrome-section-trigger'

async function waitForModuleState (page: Page, state: 'open' | 'closed'): Promise<void> {
  await page.locator(`${PROJECT_MODULE}[data-state="${state}"]`).waitFor({ timeout: 10_000 })
}

/**
 * The section header's keyboard contract, driven through the real window
 * with no owned key handler behind it: Space and Enter toggle, End and Home
 * move the focus to the last and the first header, Escape changes nothing.
 */
async function proveSectionHeaderKeyboard (page: Page): Promise<void> {
  const header = page.locator(PROJECT_HEADER)
  const lastHeader = page.locator(LAST_HEADER)
  await header.focus()
  await page.keyboard.press('Space')
  await waitForModuleState(page, 'closed')
  await page.keyboard.press('Enter')
  await waitForModuleState(page, 'open')
  await page.keyboard.press('End')
  const endFocusedLast = await lastHeader.evaluate(element => element === document.activeElement)
  assert.ok(endFocusedLast, 'End must move the focus to the last section header')
  await page.keyboard.press('Home')
  const homeFocusedFirst = await header.evaluate(element => element === document.activeElement)
  assert.ok(homeFocusedFirst, 'Home must move the focus to the first section header')
  await page.keyboard.press('Escape')
  await waitForModuleState(page, 'open')
  await page.keyboard.press('Tab')
  const focusLeftHeader = await header.evaluate(element => element !== document.activeElement)
  assert.ok(focusLeftHeader, 'Tab must move the focus off the section header')
}

const LAUNCHER = '[data-command-launcher]'
const LAUNCHER_INPUT = `${LAUNCHER} [data-command-launcher-input]`

/** Opens the launcher through its View menu item, the path the accelerator takes. */
async function openLauncher (page: Page): Promise<void> {
  await page.evaluate(() => {
    window.ipc.send('menu-provider', { command: 'click-menu-item', payload: 'menu.command_launcher' })
  })
  await page.locator(LAUNCHER_INPUT).waitFor({ state: 'visible', timeout: 10_000 })
}

async function closeLauncher (page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.locator(LAUNCHER).waitFor({ state: 'detached', timeout: 10_000 })
}

async function typeAndWaitForHighlight (page: Page, query: string, label: string): Promise<void> {
  await page.locator(LAUNCHER_INPUT).fill(query)
  await page.locator(`${LAUNCHER} [data-launcher-row][data-highlighted]`, { hasText: label }).waitFor({ timeout: 10_000 })
}

/** Flips the app's own dark-mode setting and waits for the body class. */
async function setDarkMode (page: Page, dark: boolean): Promise<void> {
  await page.evaluate(value => {
    window.ipc.sendSync('config-provider', {
      command: 'set-config-single',
      payload: { key: 'darkMode', val: value }
    })
  }, dark)
  await page.waitForFunction(
    value => document.body.classList.contains('dark') === value,
    dark,
    { timeout: 10_000 }
  )
}

const FILE_LIST = '#file-manager #file-list'

/** Switches the Project module's tree mode through its config value. */
async function setFileManagerMode (page: Page, mode: 'thin' | 'combined' | 'expanded'): Promise<void> {
  await page.evaluate(value => {
    window.ipc.sendSync('config-provider', {
      command: 'set-config-single',
      payload: { key: 'fileManagerMode', val: value }
    })
  }, mode)
}

const MODULE_HEADER = (id: string): string => `#navigation-sidebar [data-module="${id}"] .chrome-section-trigger`

async function setModuleState (page: Page, id: string, state: 'open' | 'closed'): Promise<void> {
  await page.locator(MODULE_HEADER(id)).click()
  await page.locator(`#navigation-sidebar [data-module="${id}"][data-state="${state}"]`).waitFor({ timeout: 10_000 })
}

const SCENES: Scene[] = [
  {
    // The seven modules on the left (the reference modules collapsed, their
    // default), the annotation review panel on the right.
    name: 'modules-and-panel',
    arrange: async page => {
      await page.locator('#navigation-sidebar [data-module="book"] .quarto-book-outline button.chapter').first().waitFor({ timeout: 10_000 })
      await page.locator('#navigation-sidebar [data-module="outline"] .toc-entry-container').first().waitFor({ timeout: 10_000 })
      await page.locator('#navigation-sidebar [data-module="otherFiles"][data-state="closed"]').waitFor({ timeout: 10_000 })
      await page.locator('#annotations-panel').waitFor({ state: 'visible', timeout: 10_000 })
    }
  },
  {
    // The reference modules open and Project, Search and Book collapsed, so
    // the reference modules take the room.
    name: 'reference-modules',
    arrange: async page => {
      for (const id of [ 'project', 'search', 'book' ]) {
        await setModuleState(page, id, 'closed')
      }
      for (const id of [ 'references', 'relatedFiles', 'otherFiles' ]) {
        await setModuleState(page, id, 'open')
      }
      await page.locator('#navigation-sidebar [data-module="references"] #references-list').waitFor({ timeout: 10_000 })
      await page.locator('#navigation-sidebar [data-module="otherFiles"] .other-files-panel').waitFor({ timeout: 10_000 })
    },
    restore: async page => {
      for (const id of [ 'references', 'relatedFiles', 'otherFiles' ]) {
        await setModuleState(page, id, 'closed')
      }
      for (const id of [ 'project', 'search', 'book' ]) {
        await setModuleState(page, id, 'open')
      }
    }
  },
  {
    // Both panes hidden through the tab row's toggles: the editor alone.
    name: 'panes-hidden',
    arrange: async page => {
      await page.locator('.document-tablist-wrapper [data-pane-toggle="navigation-sidebar"]').click()
      await page.locator('#navigation-sidebar').waitFor({ state: 'detached', timeout: 10_000 })
      await page.locator('.document-tablist-wrapper [data-pane-toggle="annotation-panel"]').click()
      await page.locator('#annotations-panel').waitFor({ state: 'detached', timeout: 10_000 })
    },
    restore: async page => {
      await page.locator('.document-tablist-wrapper [data-pane-toggle="navigation-sidebar"]').click()
      await page.locator('#navigation-sidebar [data-module="project"]').waitFor({ timeout: 10_000 })
      await page.locator('.document-tablist-wrapper [data-pane-toggle="annotation-panel"]').click()
      await page.locator('#annotations-panel').waitFor({ state: 'attached', timeout: 10_000 })
    }
  },
  {
    // The Project module collapsed to its header alone.
    name: 'project-collapsed',
    arrange: async page => {
      await page.locator(PROJECT_HEADER).click()
      await waitForModuleState(page, 'closed')
    },
    restore: async page => {
      await page.locator(PROJECT_HEADER).click()
      await waitForModuleState(page, 'open')
    }
  },
  {
    // The Project module in thin mode, a directory clicked so its file list slid in.
    name: 'project-thin',
    arrange: async page => {
      await setFileManagerMode(page, 'thin')
      await page.locator(FILE_LIST).waitFor({ state: 'hidden', timeout: 10_000 })
      await page.locator('#file-manager .tree-item.directory[data-path$="/foundations"]').click()
      await page.locator(`${FILE_LIST}:not(.hidden)`).waitFor({ state: 'visible', timeout: 10_000 })
      // The list slides in over the tree; photograph it once it has arrived.
      await page.waitForFunction(() => {
        const manager = document.querySelector('#file-manager')
        const list = document.querySelector('#file-list')
        return manager !== null && list !== null &&
          list.getBoundingClientRect().left === manager.getBoundingClientRect().left
      }, undefined, { timeout: 10_000 })
    },
    restore: async page => {
      await setFileManagerMode(page, 'combined')
      await page.locator(FILE_LIST).waitFor({ state: 'hidden', timeout: 10_000 })
    }
  },
  {
    // The Project module in expanded mode: the tree and the file list side by side.
    name: 'project-expanded',
    arrange: async page => {
      await setFileManagerMode(page, 'expanded')
      await page.locator('#file-manager.expanded #file-list:not(.hidden)').waitFor({ state: 'visible', timeout: 10_000 })
    },
    restore: async page => {
      await setFileManagerMode(page, 'combined')
      await page.locator(FILE_LIST).waitFor({ state: 'hidden', timeout: 10_000 })
    }
  },
  {
    // The command launcher at its root: the menu groups and the dynamic groups.
    name: 'launcher-root',
    arrange: async page => { await openLauncher(page) },
    restore: closeLauncher
  },
  {
    // The launcher inside the Insert submenu, a query narrowing its rows.
    name: 'launcher-insert',
    arrange: async page => {
      await openLauncher(page)
      await typeAndWaitForHighlight(page, 'insert', 'Insert')
      await page.keyboard.press('Enter')
      await typeAndWaitForHighlight(page, 'foot', 'Footnote')
    },
    restore: closeLauncher
  },
  {
    // The launcher in its references view, ranking the workspace definitions.
    name: 'launcher-references',
    arrange: async page => {
      await openLauncher(page)
      await typeAndWaitForHighlight(page, 'references', 'Search references')
      await page.keyboard.press('Enter')
      await page.locator(`${LAUNCHER} [data-search-mode="definitions"]`).waitFor({ timeout: 10_000 })
      await page.locator(LAUNCHER_INPUT).fill('sec')
      await page.locator(`${LAUNCHER} [data-launcher-row][data-highlighted][data-reference-key]`).waitFor({ timeout: 10_000 })
    },
    restore: closeLauncher
  }
]

async function main (): Promise<void> {
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })

  const fixture = await createWorkspaceFixture('zettlr-chrome-capture-', {
    workspaceSource: path.join(REPO_ROOT, 'test', 'fixtures', 'quarto-book'),
    activeDocument: path.join('foundations', 'forms.md'),
    config: {
      darkMode: false,
      window: {
        fileManagerVisible: true,
        sidebarVisible: true
      }
    }
  })

  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()
  const app = await attach(fixture.configDirectory, rendererEvents, launchTimeoutMs)

  try {
    const page = await findEditorPage(app.browser, launchTimeoutMs)
    await hideDevServerOverlay(page)
    await page.locator('.cm-content').waitFor({ state: 'visible', timeout: launchTimeoutMs })
    // The workspace root is the book, so the sidebar offers its Book module.
    await page.locator('#navigation-sidebar [data-module="book"]').waitFor({ timeout: 60_000 })
    await waitForModuleState(page, 'open')
    await proveSectionHeaderKeyboard(page)

    for (const theme of THEMES) {
      await setDarkMode(page, theme === 'dark')
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: HEIGHT })
        await page.waitForFunction(expected => window.innerWidth === expected, width, { timeout: 10_000 })
        for (const scene of SCENES) {
          await scene.arrange(page)
          const filename = `${scene.name}-${theme}-${width}.png`
          const image = await page.screenshot()
          screenshots.set(filename, image)
          console.error(`chrome-capture: ${filename}`)
          await scene.restore?.(page)
        }
      }
    }
  } finally {
    await shutdown(app.browser, app.appProcess)
    await preserveArtifacts(output, fixture.root, app.getOutput(), rendererEvents, screenshots)
    await rm(fixture.root, { recursive: true, force: true })
  }

  assertCleanExit(app.getOutput())
  assert.equal(screenshots.size, THEMES.length * WIDTHS.length * SCENES.length)
  console.log(`chrome-capture: ${screenshots.size} captures in ${output}`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
