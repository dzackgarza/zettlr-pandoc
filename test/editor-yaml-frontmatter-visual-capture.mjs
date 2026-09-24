import { openScene } from './visual/scene.mjs'

const scenes = [
  { name: 'yaml-frontmatter-light-wide', dark: false, width: 1200, height: 800 },
  { name: 'yaml-frontmatter-dark-wide', dark: true, width: 1200, height: 800 },
  { name: 'yaml-frontmatter-light-narrow', dark: false, width: 480, height: 900 },
  { name: 'yaml-frontmatter-dark-narrow', dark: true, width: 480, height: 900 }
]

const view = await openScene({ width: 1200, height: 800 })
for (const scene of scenes) {
  const background = scene.dark ? '#2b2b2c' : '#ffffff'
  const foreground = scene.dark ? '#e5e7eb' : '#222222'
  await view.setSize(scene.width, scene.height)
  await view.open(`${scene.name}.html`, `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; min-height: 100%; background: ${background}; color: ${foreground}; }
    body { padding: 28px; box-sizing: border-box; }
    #editor { max-width: 920px; margin: 0 auto; }
    #editor > .cm-editor { min-height: 620px; }
    #editor > .cm-editor > .cm-scroller { padding: 18px 22px 60px; overflow-x: hidden; }
  </style></head><body data-dark="${scene.dark}"><main id="editor"></main><script src="./yaml-frontmatter-visual-bundle.js"></script></body></html>`)
  await view.page.evaluate(() => window.captureReady)
  const dimensions = await view.page.evaluate(() => {
    const content = document.querySelector('.cm-content')
    const card = document.querySelector('.yaml-frontmatter-card')
    return {
      contentClientWidth: content?.clientWidth ?? 0,
      contentScrollWidth: content?.scrollWidth ?? 0,
      cardHeight: card?.getBoundingClientRect().height ?? 0
    }
  })
  if (dimensions.contentScrollWidth > dimensions.contentClientWidth + 1) {
    throw new Error(`${scene.name} has horizontal editor overflow`)
  }
  if (dimensions.cardHeight <= 0) {
    throw new Error(`${scene.name} did not render the properties block`)
  }
  await view.capture(scene.name)
}
await view.close()
