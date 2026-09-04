// Renders an exported HTML file in the shipping Chromium and captures both
// the post-MathJax DOM and a screenshot.
//
// Usage: node test/pandoc-math-html-probe.mjs <html-file> <screenshot.png> <result.html>

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { openScene } from './visual/scene.mjs'

const [inputFile, screenshotFile, resultFile] = process.argv.slice(-3)

const view = await openScene({
  width: 800,
  height: 600,
  userData: path.join(path.dirname(screenshotFile), 'user-data')
})

await view.page.goto(pathToFileURL(inputFile).href)
await view.page.waitForFunction(
  () => document.querySelectorAll('mjx-container').length === 2,
  undefined,
  { timeout: 15000 }
)

const html = await view.page.evaluate(() => document.documentElement.outerHTML)
await view.page.screenshot({ path: screenshotFile })
await writeFile(resultFile, html)
await view.close()
