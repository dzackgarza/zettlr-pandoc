import { openScene } from './visual/scene.mjs'
import path from 'node:path'

const WIDE = { width: 1200, height: 800 }

const scene = await openScene({
  ...WIDE,
  args: ['--ozone-platform=x11', '--disable-gpu']
})
const { page } = scene

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #1e1e1e; color: #fff; }
  #app { width: 100%; height: 100%; }
</style></head><body class="dark">
  <div id="app"></div>
  <script src="./annotations-panel-animation-bundle.js"></script>
</body></html>`

await scene.open('benchmark.html', html)
await page.evaluate(() => window.benchmarkReady)

const steps = [320, 260, 200, 140, 80, 20, 0]

// 1. Unoptimized baseline
await page.evaluate(() => window.setUnoptimizedMode(true))
const unoptimizedLayout = await page.evaluate((s) => window.measureStepLayouts(s), steps)
const unoptimizedClose = await page.evaluate(() => window.measureToggleAnimation('close'))
await new Promise(r => setTimeout(r, 150))
const unoptimizedOpen = await page.evaluate(() => window.measureToggleAnimation('open'))

// 2. Optimized state
await page.evaluate(() => window.setUnoptimizedMode(false))
const optimizedLayout = await page.evaluate((s) => window.measureStepLayouts(s), steps)
const optimizedClose = await page.evaluate(() => window.measureToggleAnimation('close'))
await new Promise(r => setTimeout(r, 150))
const optimizedOpen = await page.evaluate(() => window.measureToggleAnimation('open'))

// 3. Inspect CSS rule for content-visibility
const hasContentVisibility = await page.evaluate(() => {
  const item = document.querySelector('.annotation-list-item')
  if (!item) return false
  const style = window.getComputedStyle(item)
  return style.contentVisibility === 'auto'
})

await scene.close()

const report = {
  unoptimized: {
    layout: unoptimizedLayout,
    close: unoptimizedClose,
    open: unoptimizedOpen
  },
  optimized: {
    layout: optimizedLayout,
    close: optimizedClose,
    open: optimizedOpen
  },
  hasContentVisibility
}

console.log(JSON.stringify(report))
