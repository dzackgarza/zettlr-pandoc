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

const FILES_SECTION = '#navigation-sidebar [data-section="files"]'
const FILES_HEADER = `${FILES_SECTION} .chrome-section-trigger`
const LAST_HEADER = '#navigation-sidebar [data-section="book"] .chrome-section-trigger'
const ACTIVITY = (view: string): string => `#activity-bar [data-activity="${view}"]`
const PANEL_ACTIVITY = '#panel-activity-bar [data-activity="annotations"]'

/**
 * A pane slides shut, and its content stops being visible as soon as the
 * pane has no width for it — before the slide has finished. Captures wait
 * for the pane itself to reach the width it is heading for, or the shot
 * catches it halfway.
 */
async function waitForPaneWidth (page: Page, pane: 'navigation-sidebar' | 'annotation-panel', width: 'zero' | 'some'): Promise<void> {
  await page.waitForFunction(([ selector, expected ]) => {
    const measured = document.querySelector(selector)?.getBoundingClientRect().width ?? 0
    return expected === 'zero' ? measured === 0 : measured > 0
  }, [ `[data-pane="${pane}"]`, width ] as const, { timeout: 10_000 })
}

async function waitForFilesState (page: Page, state: 'open' | 'closed'): Promise<void> {
  await page.locator(`${FILES_SECTION}[data-state="${state}"]`).waitFor({ timeout: 10_000 })
}

/**
 * The section header's keyboard contract, driven through the real window
 * with no owned key handler behind it: Space and Enter toggle, End and Home
 * move the focus to the last and the first header, Escape changes nothing.
 */
async function proveSectionHeaderKeyboard (page: Page): Promise<void> {
  const header = page.locator(FILES_HEADER)
  const lastHeader = page.locator(LAST_HEADER)
  await header.focus()
  await page.keyboard.press('Space')
  await waitForFilesState(page, 'closed')
  await page.keyboard.press('Enter')
  await waitForFilesState(page, 'open')
  await page.keyboard.press('End')
  const endFocusedLast = await lastHeader.evaluate(element => element === document.activeElement)
  assert.ok(endFocusedLast, 'End must move the focus to the last section header')
  await page.keyboard.press('Home')
  const homeFocusedFirst = await header.evaluate(element => element === document.activeElement)
  assert.ok(homeFocusedFirst, 'Home must move the focus to the first section header')
  await page.keyboard.press('Escape')
  await waitForFilesState(page, 'open')
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

const SECTION_HEADER = (id: string): string => `#navigation-sidebar [data-section="${id}"] .chrome-section-trigger`

async function setSectionState (page: Page, id: string, state: 'open' | 'closed'): Promise<void> {
  await page.locator(SECTION_HEADER(id)).click()
  await page.locator(`#navigation-sidebar [data-section="${id}"][data-state="${state}"]`).waitFor({ timeout: 10_000 })
}

const SCENES: Scene[] = [
  {
    // The activity bar with the Explorer pressed: the tree, Outline and
    // Book collapsed below it (their default), the annotation review panel
    // on the right.
    name: 'explorer',
    arrange: async page => {
      await page.locator(`${ACTIVITY('explorer')}[aria-pressed="true"]`).waitFor({ timeout: 10_000 })
      await page.locator('#navigation-sidebar [data-section="outline"][data-state="closed"]').waitFor({ timeout: 10_000 })
      await page.locator('#navigation-sidebar [data-section="book"][data-state="closed"]').waitFor({ timeout: 10_000 })
      await page.locator('#annotations-panel').waitFor({ state: 'visible', timeout: 10_000 })
    }
  },
  {
    // The Explorer with Outline and Book expanded under the tree.
    name: 'explorer-sections',
    arrange: async page => {
      await setSectionState(page, 'outline', 'open')
      await setSectionState(page, 'book', 'open')
      await page.locator('#navigation-sidebar [data-section="book"] .quarto-book-outline button.chapter').first().waitFor({ timeout: 10_000 })
      await page.locator('#navigation-sidebar [data-section="outline"] .toc-entry-container').first().waitFor({ timeout: 10_000 })
    },
    restore: async page => {
      await setSectionState(page, 'outline', 'closed')
      await setSectionState(page, 'book', 'closed')
    }
  },
  {
    // The Search view from its icon, a search run and a replacement typed:
    // the results with their replace controls.
    name: 'search-view',
    arrange: async page => {
      await page.locator(ACTIVITY('search')).click()
      await page.locator('#navigation-sidebar[data-view="search"] #search-view').waitFor({ timeout: 10_000 })
      const query = page.locator('#navigation-sidebar[data-view="search"] input[name="search-input"]')
      await query.fill('subgroupoid')
      await query.press('Enter')
      await page.locator('#navigation-sidebar[data-view="search"] .file-match').first().waitFor({ timeout: 20_000 })
      // The replace field lives behind the widget's chevron, as it does in
      // the reference implementation.
      await page.locator('#navigation-sidebar[data-view="search"] [data-search-action="toggle-replace"]').click()
      await page.locator('#navigation-sidebar[data-view="search"] input[name="replace-input"]').fill('subcategory')
      await page.locator('#navigation-sidebar[data-view="search"] .match-replace').first().waitFor({ timeout: 10_000 })
    },
    restore: async page => {
      await page.locator('#navigation-sidebar[data-view="search"] [data-search-action="toggle-replace"]').click()
      await page.locator(ACTIVITY('explorer')).click()
      await page.locator('#navigation-sidebar[data-view="explorer"]').waitFor({ timeout: 10_000 })
    }
  },
  {
    // The References view from its icon: the active file's citations, with
    // its related files expanded below them.
    name: 'references-view',
    arrange: async page => {
      await page.locator(ACTIVITY('references')).click()
      await page.locator('#navigation-sidebar[data-view="references"]').waitFor({ timeout: 10_000 })
      await setSectionState(page, 'relatedFiles', 'open')
      await page.locator('#navigation-sidebar [data-section="citations"] #references-list').waitFor({ timeout: 10_000 })
    },
    restore: async page => {
      await setSectionState(page, 'relatedFiles', 'closed')
      await page.locator(ACTIVITY('explorer')).click()
      await page.locator('#navigation-sidebar[data-view="explorer"]').waitFor({ timeout: 10_000 })
    }
  },
  {
    // Two editor panes side by side, the second one focused: one status bar
    // follows the focused pane.
    name: 'two-panes',
    arrange: async page => {
      // Splits, then opens the book's index in the new pane through the
      // provider, so the pane holds a document to focus.
      await page.evaluate(async () => {
        const windowId = new URLSearchParams(location.search).get('window_id')
        if (windowId === null) {
          throw new Error('The main window carries no window_id')
        }
        const activePath = document.querySelector('.editor-pane [role="tab"].active')?.getAttribute('data-path')
        if (activePath === null || activePath === undefined) {
          throw new Error('The capture expects an active document tab')
        }
        const indexPath = [ ...activePath.split('/').slice(0, -2), 'index.md' ].join('/')
        const tree: unknown = await window.ipc.invoke('documents-provider', { command: 'retrieve-tab-config', payload: { windowId } })
        const leaf = tree as { type: string, id: string }
        if (leaf.type !== 'leaf') {
          throw new Error('The capture expects a single pane before the split')
        }
        // 'horizontal' is the document manager's side-by-side direction.
        await window.ipc.invoke('documents-provider', {
          command: 'split-leaf',
          payload: { originWindow: windowId, originLeaf: leaf.id, direction: 'horizontal', insertion: 'after' }
        })
        const split: unknown = await window.ipc.invoke('documents-provider', { command: 'retrieve-tab-config', payload: { windowId } })
        const branch = split as { type: string, nodes: Array<{ type: string, id: string }> }
        const created = branch.nodes.find(node => node.type === 'leaf' && node.id !== leaf.id)
        if (branch.type !== 'branch' || created === undefined) {
          throw new Error('The split produced no new pane')
        }
        await window.ipc.invoke('documents-provider', {
          command: 'open-file',
          payload: { windowId, leafId: created.id, path: indexPath, newTab: true }
        })
      })
      const secondPane = page.locator('.editor-pane').nth(1)
      await secondPane.locator('.cm-content').waitFor({ state: 'visible', timeout: 10_000 })
      await secondPane.locator('.cm-content').click()
      await page.locator('#main-statusbar [data-statusbar-item="words"]', { hasText: /^(?!1 words)/ }).waitFor({ timeout: 10_000 })
    },
    restore: async page => {
      await page.evaluate(async () => {
        const windowId = new URLSearchParams(location.search).get('window_id')
        if (windowId === null) {
          throw new Error('The main window carries no window_id')
        }
        const tree: unknown = await window.ipc.invoke('documents-provider', { command: 'retrieve-tab-config', payload: { windowId } })
        const branch = tree as { type: string, nodes: Array<{ type: string, id: string }> }
        const second = branch.nodes[1]
        if (branch.type !== 'branch' || second === undefined) {
          throw new Error('The capture expects two panes to restore from')
        }
        await window.ipc.invoke('documents-provider', { command: 'close-leaf', payload: { windowId, leafId: second.id } })
      })
      await page.locator('.editor-pane').nth(1).waitFor({ state: 'detached', timeout: 10_000 })
      await page.locator('.editor-pane .cm-content').click()
    }
  },
  {
    // Both panes hidden through the tab row's toggles: the editor alone.
    name: 'panes-hidden',
    arrange: async page => {
      await page.locator(ACTIVITY('explorer')).click()
      await waitForPaneWidth(page, 'navigation-sidebar', 'zero')
      await page.locator(PANEL_ACTIVITY).click()
      await waitForPaneWidth(page, 'annotation-panel', 'zero')
    },
    restore: async page => {
      await page.locator(ACTIVITY('explorer')).click()
      await page.locator('#navigation-sidebar [data-section="files"]').waitFor({ timeout: 10_000 })
      await waitForPaneWidth(page, 'navigation-sidebar', 'some')
      await page.locator(PANEL_ACTIVITY).click()
      await page.locator('#annotations-panel').waitFor({ state: 'visible', timeout: 10_000 })
      await waitForPaneWidth(page, 'annotation-panel', 'some')
    }
  },
  {
    // The Files section collapsed to its header alone.
    name: 'files-collapsed',
    arrange: async page => {
      await page.locator(FILES_HEADER).click()
      await waitForFilesState(page, 'closed')
    },
    restore: async page => {
      await page.locator(FILES_HEADER).click()
      await waitForFilesState(page, 'open')
    }
  },
  {
    // The Files section in thin mode, a directory clicked so its file list slid in.
    name: 'project-thin',
    arrange: async page => {
      await setFileManagerMode(page, 'thin')
      // Thin mode displays the list (combined mode does not) but keeps it slid
      // out until a directory is chosen; wait for that state before choosing.
      await page.waitForFunction(() => {
        const list = document.querySelector('#file-manager #file-list')
        return list !== null && list.classList.contains('hidden') && getComputedStyle(list).display !== 'none'
      }, undefined, { timeout: 10_000 })
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
    // The Files section in expanded mode: the tree and the file list side by side.
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
    await page.locator('#navigation-sidebar [data-section="book"]').waitFor({ timeout: 60_000 })
    await waitForFilesState(page, 'open')
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
