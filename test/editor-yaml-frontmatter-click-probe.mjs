import path from 'node:path'
import { openScene, outputDirectory } from './visual/scene.mjs'

const view = await openScene({
  width: 1000,
  height: 720,
  userData: path.join(outputDirectory, 'yaml-click-user-data'),
  args: [ '--ozone-platform=x11', '--disable-gpu' ]
})

await view.open('yaml-frontmatter-click.html', `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; min-height: 100%; background: #fff; color: #222; }
  body { padding: 24px; box-sizing: border-box; }
  #editor { max-width: 820px; margin: 0 auto; }
  .cm-editor { min-height: 0; }
  #editor > .cm-editor { min-height: 580px; }
  #editor > .cm-editor > .cm-scroller { padding: 18px 22px 60px; overflow-x: hidden; }
</style></head><body><main id="editor"></main><script src="./yaml-frontmatter-click-bundle.js"></script></body></html>`)
await view.page.evaluate(() => window.yamlClickReady)

const texts = [ 'Cursor mapping proof', 'compactification', 'A. Author', 'false' ]
const results = []
for (const text of texts) {
  await view.page.evaluate(() => window.yamlClickReset())
  const target = await view.page.evaluate(text => window.yamlClickTarget(text), text)
  await view.page.mouse.click(Math.round(target.x), Math.round(target.y))
  results.push({
    text,
    from: target.from,
    to: target.to,
    state: await view.page.evaluate(() => window.yamlClickState())
  })
}

await view.page.evaluate(() => window.yamlClickReset())
const title = await view.page.evaluate(() => window.yamlClickTarget('Cursor mapping proof'))
await view.page.mouse.click(Math.round(title.x), Math.round(title.y))
await view.page.keyboard.press('End')
await view.page.keyboard.insertText(' updated')
await new Promise(resolve => setTimeout(resolve, 400))
const edited = await view.page.evaluate(() => window.yamlClickState())

await view.page.evaluate(() => window.yamlClickReset())
const clickawayTitle = await view.page.evaluate(() => window.yamlClickTarget('Cursor mapping proof updated'))
await view.page.mouse.click(Math.round(clickawayTitle.x), Math.round(clickawayTitle.y))
await view.page.keyboard.press('End')
await view.page.keyboard.insertText(' clickaway')
const body = await view.page.evaluate(() => window.yamlBodyTarget())
await view.page.mouse.click(Math.round(body.x), Math.round(body.y))
await new Promise(resolve => setTimeout(resolve, 80))

process.stdout.write(`${JSON.stringify({
  initialOuterAnchor: await view.page.evaluate(() => window.yamlOuterInitialAnchor),
  results,
  edited,
  clickaway: await view.page.evaluate(() => window.yamlClickState())
})}\n`)
await view.close()
