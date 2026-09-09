// Captures the real main-window chrome through the assembled-app harness: the
// Forge app launched against a throwaway config whose one workspace root is
// the Quarto book fixture, attached over CDP, and screenshotted in light and
// dark at two window widths. The scenes are the proof surface for the chrome
// convergence milestones (PLAN-main-window-chrome-convergence, M0): each later
// milestone edits the scene list, never the launch.
//
// Usage: node --import tsx e2e/chrome-capture.ts <output-directory>

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

const output = process.argv[2]
if (output === undefined) {
  throw new Error('Usage: chrome-capture.ts <output-directory>')
}

const LAUNCH_TIMEOUT_MS = 180_000
const HEIGHT = 950
const WIDTHS = [ 1500, 1100 ] as const
const THEMES = [ 'light', 'dark' ] as const

/** One arrangement of the chrome to photograph in every theme and width. */
interface Scene {
  name: string
  arrange: (page: Page) => Promise<void>
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

/** Selects a right-sidebar tab through its config value and waits for the strip to agree. */
async function setSidebarTab (page: Page, tab: 'toc' | 'annotations', target: string): Promise<void> {
  await page.evaluate(value => {
    window.ipc.sendSync('config-provider', {
      command: 'set-config-single',
      payload: { key: 'window.currentSidebarTab', val: value }
    })
  }, tab)
  await page.locator(`#sidebar .system-tab[aria-controls="${target}"][aria-selected="true"]`).waitFor({ timeout: 10_000 })
}

/** Switches the file manager between its Files and Book views by its tab strip. */
async function setFileManagerView (page: Page, view: 'Files' | 'Book'): Promise<void> {
  const tab = page.locator('#file-manager .system-tab', { hasText: view })
  await tab.click()
  await page.locator('#file-manager .system-tab.active', { hasText: view }).waitFor({ timeout: 10_000 })
  const marker = view === 'Book' ? '.quarto-book-outline' : '#file-tree'
  await page.locator(`#file-manager ${marker}`).waitFor({ state: 'visible', timeout: 10_000 })
}

// Every config write (the sidebar tab, the theme) re-derives the file manager's
// Quarto project and resets its view to Book, so the view is chosen last and
// checked right before the shot.
const SCENES: Scene[] = [
  {
    // The Quarto book navigation on the left, the document outline on the right.
    name: 'book-and-outline',
    arrange: async page => {
      await setSidebarTab(page, 'toc', 'sidebar-toc')
      await page.locator('#sidebar .toc-entry-container').first().waitFor({ timeout: 10_000 })
      await setFileManagerView(page, 'Book')
    }
  },
  {
    // The workspace tree on the left, the annotation review panel on the right.
    name: 'tree-and-annotations',
    arrange: async page => {
      await setSidebarTab(page, 'annotations', 'annotations-panel')
      await page.locator('#annotations-panel').waitFor({ state: 'visible', timeout: 10_000 })
      await setFileManagerView(page, 'Files')
    }
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
        sidebarVisible: true,
        currentSidebarTab: 'toc'
      }
    }
  })

  const rendererEvents: string[] = []
  const screenshots = new Map<string, Buffer>()
  const app = await attach(fixture.configDirectory, rendererEvents, LAUNCH_TIMEOUT_MS)

  try {
    const page = await findEditorPage(app.browser, LAUNCH_TIMEOUT_MS)
    await hideDevServerOverlay(page)
    await page.locator('.cm-content').waitFor({ state: 'visible', timeout: LAUNCH_TIMEOUT_MS })
    // The workspace root is the book, so the file manager offers its Book view.
    await page.locator('#file-manager .system-tab', { hasText: 'Book' }).waitFor({ timeout: 60_000 })

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
