// Replays the scripted README demo scenes (readme-demo-entry.ts), writing
// one PNG frame per step plus an ffconcat timing file per scene.
// scripts/build-readme-demos.sh assembles the GIFs.

import { cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { openScene, outputDirectory } from './visual/scene.mjs'

const scenes = [
  { name: 'math-typing', scene: 'math', width: 920, height: 600 },
  { name: 'amsthm-typing', scene: 'amsthm', width: 920, height: 640 },
  { name: 'review-flow', scene: 'review', width: 980, height: 640 },
  // A single-frame still: the theorem-environment sampler for the README
  // gallery. build-readme-demos.sh leaves it out of the GIF loop.
  { name: 'env-gallery', scene: 'gallery', width: 920, height: 700 }
]

async function capture (view, spec) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: #ffffff; color: #222222; }
    body { padding: 22px; box-sizing: border-box; }
    #editor { max-width: 860px; margin: 0 auto; }
    .cm-editor { min-height: ${spec.height - 60}px; font-size: 16px; line-height: 1.5; }
    .cm-scroller { padding: 16px 20px 40px; overflow-x: hidden; }
    .cm-content { overflow-wrap: anywhere; }
  </style></head><body data-scene="${spec.scene}">
    <main id="editor"></main><script src="../readme-demo-bundle.js"></script>
  </body></html>`
  // Pages live one level below the output directory: the production MathJax
  // setup resolves its webfonts at ../mathjax relative to the page (the
  // webpack build copies them there), so the driver mirrors that layout.
  await mkdir(path.join(outputDirectory, 'pages'), { recursive: true })
  const framesDirectory = path.join(outputDirectory, spec.name)
  await mkdir(framesDirectory, { recursive: true })

  await view.setSize(spec.width, spec.height)
  await view.open(path.join('pages', `${spec.name}.html`), html)
  await view.page.evaluate(() => window.captureReady)
  const stepCount = await view.page.evaluate(() => window.demoStepCount)
  if (stepCount === 0) {
    throw new Error(`${spec.name} scripted zero steps`)
  }

  const concat = ['ffconcat version 1.0']
  const writeFrame = async (index, hold) => {
    // Two animation frames, then a short settle: MathJax typesets
    // asynchronously and exposes no completion signal the page could be
    // waited on, so the hold is the only available synchronization.
    await view.page.evaluate(
      () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    await view.page.waitForTimeout(30)
    const name = `frame-${String(index).padStart(4, '0')}.png`
    await view.page.screenshot({ path: path.join(framesDirectory, name) })
    concat.push(`file '${spec.name}/${name}'`, `duration ${hold}`)
    return name
  }

  await writeFrame(0, 0.8)
  let lastFrame = null
  for (let step = 0; step < stepCount; step++) {
    const hold = await view.page.evaluate(step => window.runDemoStep(step), step)
    lastFrame = await writeFrame(step + 1, hold)
  }
  // The concat demuxer ignores the final duration unless the last file is
  // listed a second time.
  concat.push(`file '${spec.name}/${lastFrame}'`)
  await writeFile(path.join(outputDirectory, `${spec.name}.ffconcat`), concat.join('\n') + '\n')
  console.log(`${spec.name}: ${stepCount + 1} frames`)
}

const fontsDirectory = path.join(outputDirectory, 'mathjax')
for (const fontPackage of ['mathjax-newcm-font', 'mathjax-mhchem-font-extension']) {
  await cp(
    path.join(import.meta.dirname, '..', 'node_modules', '@mathjax', fontPackage, 'chtml', 'woff2'),
    fontsDirectory,
    { recursive: true }
  )
}

const view = await openScene({ width: 980, height: 640, args: ['--ozone-platform=x11', '--disable-gpu'] })
for (const spec of scenes) {
  await capture(view, spec)
}
await view.close()
