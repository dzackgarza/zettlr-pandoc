// The one harness every visual-capture driver uses. Playwright owns the
// Electron lifecycle, the page RPC, the waits and the screenshots, so a
// driver is only its scene: what to render, what to assert, what to shoot.
//
// A driver runs as a plain Node process (`node <driver>.mjs <output-dir>`)
// and Playwright spawns Electron underneath it. Bun cannot drive
// _electron.launch — its CDP attach never completes — so the capture runner
// and the specs invoke drivers with `node`.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { _electron } from 'playwright'

const sceneWindow = path.join(import.meta.dirname, 'scene-window.cjs')

/** The output directory every driver is invoked with as its last argument. */
export const outputDirectory = process.argv[process.argv.length - 1]

/**
 * Launch Electron, attach to its single window, and size it.
 *
 * `args` are extra Electron switches for scenes that need them (the
 * software-rendering scenes pass `--ozone-platform=x11 --disable-gpu`).
 * `userData` redirects the app's userData path for scenes whose components
 * write there.
 */
export async function openScene ({ width, height, userData, args = [] } = {}) {
  const electronApp = await _electron.launch({
    args: ['--no-sandbox', ...args, sceneWindow],
    env: {
      ...process.env,
      VISUAL_SCENE_WIDTH: String(width),
      VISUAL_SCENE_HEIGHT: String(height),
      ...(userData === undefined ? {} : { VISUAL_SCENE_USER_DATA: userData })
    }
  })
  const page = await electronApp.firstWindow()
  const browserWindow = await electronApp.browserWindow(page)
  const scene = {
    electronApp,
    page,
    /** JSHandle for the real BrowserWindow, for the few Electron-only calls. */
    browserWindow,
    /**
     * Resize the real BrowserWindow and wait for the page to have laid out
     * at the new size. An offscreen window carries no frame, so its content
     * box is exactly the size asked for.
     */
    async setSize (nextWidth, nextHeight) {
      await browserWindow.evaluate((window, size) => {
        window.setSize(size[0], size[1])
      }, [nextWidth, nextHeight])
      await page.waitForFunction(
        size => window.innerWidth === size[0] && window.innerHeight === size[1],
        [nextWidth, nextHeight]
      )
    },
    /**
     * Write `html` next to the scene's bundle and navigate to it. The page
     * has to be a real file so its relative <script src> resolves, and
     * leaving it on disk lets a failing capture be reopened by hand.
     */
    async open (filename, html, query = {}) {
      const pagePath = path.join(outputDirectory, filename)
      await writeFile(pagePath, html)
      const url = pathToFileURL(pagePath)
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value)
      }
      await page.goto(url.href)
    },
    /** Screenshot the window into `<output>/<name>.png`. */
    async capture (name) {
      await page.screenshot({ path: path.join(outputDirectory, `${name}.png`) })
    },
    async close () {
      await electronApp.close()
    }
  }
  await scene.setSize(width, height)
  return scene
}
