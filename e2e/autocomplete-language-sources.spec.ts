/**
 * Assembled-editor proof for the language-aware completion sources.
 */
import { strict as assert } from 'node:assert'
import { type ChildProcess } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type EditorView } from '@codemirror/view'
import { type Browser, type Page } from 'playwright'
import {
  attach,
  createFixture,
  findEditorPage,
  hideDevServerOverlay,
  shutdown,
} from './support/electron-app'

const DOCUMENT = String.raw`# Completion integration

Prose: on t

Math: $\fr$

Construction: $bma$

Central macro: $\fiberpr$

\begin{tikzpicture}
\dr
\incl
\TEMPLATEPROBE
\end{tikzpicture}

Added phrase: as a r
`

/** The production editor's content element; CodeMirror keeps its view on the element's tile. */
type EditorContentElement = HTMLElement & { cmTile?: { root: { view: EditorView } } }

describe('language-aware completion sources in the assembled editor', function () {
  this.timeout(240_000)

  let appProcess: ChildProcess|undefined
  let browser: Browser|undefined
  let page: Page|undefined
  let fixtureRoot: string|undefined
  let proseFile: string|undefined

  before(async function () {
    const fixture = await createFixture('zettlr-completion-sources-e2e-', {
      documentName: 'completion.md',
      documentContents: DOCUMENT,
    })
    fixtureRoot = fixture.root
    proseFile = path.join(fixture.root, 'portable-prose.txt')
    await writeFile(proseFile, '# fixture-owned portable catalogue\non the other hand\ntherefore\n', 'utf8')
    const configPath = path.join(fixture.configDirectory, 'config.json')
    const config: Record<string, unknown> = JSON.parse(await readFile(configPath, 'utf8'))
    assert.ok(!('editor' in config), `the fixture writes no editor group for this spec to extend: ${JSON.stringify(config)}`)
    config.editor = {
      proseCompletionFile: proseFile,
      proseCompletionExtraFiles: [],
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

    const app = await attach(fixture.configDirectory, [], this.timeout())
    appProcess = app.appProcess
    browser = app.browser
    page = await findEditorPage(browser, this.timeout())
    await hideDevServerOverlay(page)
  })

  after(async function () {
    await shutdown(browser, appProcess)
    if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
  })

  async function replaceFixtureText (needle: string, replacement: string): Promise<void> {
    assert.ok(page !== undefined)
    const replaced = await page.evaluate(({ target, insert }) => {
      const view = document.querySelector<EditorContentElement>('.cm-content')?.cmTile?.root.view
      if (view === undefined) throw new Error('the production editor exposes no CodeMirror view')
      const at = view.state.doc.toString().indexOf(target)
      if (at < 0) return false
      view.dispatch({ changes: { from: at, to: at + target.length, insert } })
      return true
    }, { target: needle, insert: replacement })
    assert.strictEqual(replaced, true, `fixture must contain ${needle}`)
  }

  async function completionLabelsAfter (needle: string): Promise<string[]> {
    assert.ok(page !== undefined)
    await page.keyboard.press('Escape')
    const positioned = await page.evaluate((target) => {
      const view = document.querySelector<EditorContentElement>('.cm-content')?.cmTile?.root.view
      if (view === undefined) throw new Error('the production editor exposes no CodeMirror view')
      const at = view.state.doc.toString().indexOf(target)
      if (at < 0) return false
      view.dispatch({ selection: { anchor: at + target.length } })
      view.focus()
      return true
    }, needle)
    assert.strictEqual(positioned, true, `fixture must contain ${needle}`)
    await page.keyboard.press('Control+Space')
    const popup = page.locator('.cm-tooltip-autocomplete')
    await popup.waitFor({ state: 'visible', timeout: 10_000 })
    return await popup.locator('.cm-completionLabel').allTextContents()
  }

  async function completionInfoAfter (needle: string, expectedLabel: string): Promise<string> {
    assert.ok(page !== undefined)
    const labels = await completionLabelsAfter(needle)
    assert.ok(labels.includes(expectedLabel), `${expectedLabel} missing from ${JSON.stringify(labels)}`)

    const popup = page.locator('.cm-tooltip-autocomplete')
    for (let i = 0; i < labels.length + 2; i++) {
      const selected = await popup.locator('li[aria-selected="true"] .cm-completionLabel').textContent()
      if (selected === expectedLabel) break
      await page.keyboard.press('ArrowDown')
    }
    assert.strictEqual(
      await popup.locator('li[aria-selected="true"] .cm-completionLabel').textContent(),
      expectedLabel,
      `could not select ${expectedLabel}`
    )
    const info = page.locator('.cm-completionInfo .zettlr-completion-info')
    await info.waitFor({ state: 'visible', timeout: 10_000 })
    const text = await info.textContent()
    assert.ok(text !== null, `the completion info for ${expectedLabel} must carry text`)
    return text
  }

  it('offers prose phrases, LaTeX in math, and LaTeX plus TikZ inside TikZ', async function () {
    const prose = await completionLabelsAfter('Prose: on t')
    assert.ok(prose.includes('on the other hand'), `portable phrase missing from ${JSON.stringify(prose)}`)

    const math = await completionLabelsAfter('Math: $\\fr')
    assert.ok(math.includes('\\fracId'), `user-defined fraction macro missing from ${JSON.stringify(math)}`)
    assert.ok(math.includes('\\fractional'), `user-defined fraction-like macro missing from ${JSON.stringify(math)}`)
    assert.ok(math.includes('\\fractionalpart'), `user-defined fraction-like macro missing from ${JSON.stringify(math)}`)
    assert.ok(page !== undefined)
    assert.strictEqual(
      await page.locator('.cm-tooltip-autocomplete li').first().locator('.zettlr-completion-source').textContent(),
      '[Macro]',
      `user macros should outrank stock LaTeX commands for the shared \\fr prefix: ${JSON.stringify(math)}`
    )

    const construction = await completionLabelsAfter('Construction: $bma')
    assert.ok(construction.includes('bmat'), `bmatrix construction missing from ${JSON.stringify(construction)}`)

    const centralMacro = await completionLabelsAfter('Central macro: $\\fiberpr')
    assert.ok(centralMacro.includes('\\fiberprod'), `central ~/.pandoc semantic macro missing from ${JSON.stringify(centralMacro)}`)

    const tikz = await completionLabelsAfter('\\dr')
    assert.ok(tikz.includes('\\draw'), `TikZ command missing from ${JSON.stringify(tikz)}`)

    const latexInTikz = await completionLabelsAfter('\\incl')
    assert.ok(latexInTikz.includes('\\includegraphics'), `ordinary LaTeX command missing inside TikZ: ${JSON.stringify(latexInTikz)}`)

    const templateCompletions = await page.evaluate(async () => await window.ipc.invoke('tikz-completion-commands'))
    const templateCommands = templateCompletions.map(entry => entry.label)
    const mathJaxMacros = await page.evaluate(async () => await window.ipc.invoke('mathjax-macros')) as Record<string, unknown>
    const workshop = JSON.parse(await readFile(path.join(process.cwd(), 'static/autocomplete/latex-workshop-commands.json'), 'utf8')) as Record<string, unknown>
    // Keys such as `(` or `[` name control symbols, not control words; only a
    // control word can collide with a template macro name.
    const standardCommands = new Set(Object.keys(workshop).flatMap(key => {
      const word = /^[A-Za-z@]+/u.exec(key)
      return word === null ? [] : [`\\${word[0]}`]
    }))
    const generatedTikzSource = await readFile(path.join(process.cwd(), 'source/common/modules/markdown-editor/autocomplete/generated-tikz-commands.ts'), 'utf8')
    const generatedTikz = new Set([...generatedTikzSource.matchAll(/"(\\\\[A-Za-z@]+)"/gu)].map(match => JSON.parse(`"${match[1]}"`) as string))
    const mathJaxMacroCommands = new Set(Object.keys(mathJaxMacros).map(name => `\\${name}`))
    const templateOnly = templateCommands.find(command =>
      command.length >= 4 &&
      !standardCommands.has(command) &&
      !generatedTikz.has(command) &&
      !mathJaxMacroCommands.has(command)
    )
    assert.ok(templateOnly !== undefined, 'owned TikZ template must expose at least one local macro beyond standard/MathJax/TikZ catalogues')
    const probe = templateOnly.slice(0, Math.min(templateOnly.length, 4))
    await replaceFixtureText('\\TEMPLATEPROBE', probe)
    const templateMacro = await completionLabelsAfter(probe)
    assert.ok(templateMacro.includes(templateOnly), `template-owned macro ${templateOnly} missing from ${JSON.stringify(templateMacro)}`)
  })

  it('shows rich documentation popouts for constructions and ingested macros', async function () {
    const constructionInfo = await completionInfoAfter('Construction: $bma', 'bmat')
    assert.match(constructionInfo, /square brackets/u)
    assert.match(constructionInfo, /\\begin\{bmatrix\}/u)

    const macroInfo = await completionInfoAfter('Central macro: $\\fiberpr', '\\fiberprod')
    assert.match(macroInfo, /User MathJax macro/u)
    assert.match(macroInfo, /3 arguments/u)
    assert.match(macroInfo, /\\fiberprod\{\$\{1\}\}\{\$\{2\}\}\{\$\{3\}\}/u)
  })

  it('adds a phrase through the real provider to the portable file and completes it without restart', async function () {
    assert.ok(page !== undefined && proseFile !== undefined)
    const result = await page.evaluate(async () => await window.ipc.invoke('dictionary-provider', {
      command: 'add-prose-completion',
      payload: { entry: 'as a result' }
    })) as { added: boolean, filePath: string }
    assert.strictEqual(result.added, true)
    assert.strictEqual(result.filePath, proseFile)
    assert.match(await readFile(proseFile, 'utf8'), /\nas a result\n/u)

    const labels = await completionLabelsAfter('Added phrase: as a r')
    assert.ok(labels.includes('as a result'), `new portable phrase missing from ${JSON.stringify(labels)}`)
  })
})
