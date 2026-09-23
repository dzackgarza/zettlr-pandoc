import { strict as assert } from 'assert'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CompletionContext,
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  currentCompletions,
  setSelectedCompletion
} from '@codemirror/autocomplete'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { createPhraseDictionaryWatcher, loadPhraseDictionaries } from 'source/app/util/load-phrase-dictionaries'
import {
  phraseCompletionSource,
  phraseCompletionsField,
  phraseCompletionsUpdate
} from 'source/common/modules/markdown-editor/autocomplete/phrases'
import { parsePhraseDictionary } from 'source/common/util/phrase-dictionary'

interface BrowserPolyfills {
  requestAnimationFrame?: (callback: (time: number) => void) => unknown
  cancelAnimationFrame?: (id: never) => void
  ResizeObserver?: unknown
  Range: { prototype: { getClientRects?: () => unknown, getBoundingClientRect?: () => unknown } }
  window?: BrowserPolyfills
}

function polyfillCodeMirror (): void {
  const target = globalThis as BrowserPolyfills
  if (typeof target.requestAnimationFrame !== 'function') {
    target.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
    target.cancelAnimationFrame = id => clearTimeout(id)
  }
  if (target.window !== undefined && typeof target.window.requestAnimationFrame !== 'function') {
    target.window.requestAnimationFrame = target.requestAnimationFrame
    target.window.cancelAnimationFrame = target.cancelAnimationFrame
  }
  if (typeof target.ResizeObserver !== 'function') {
    target.ResizeObserver = class { observe () {} unobserve () {} disconnect () {} }
    if (target.window !== undefined) {target.window.ResizeObserver = target.ResizeObserver}
  }
  if (typeof target.Range.prototype.getClientRects !== 'function') {
    target.Range.prototype.getClientRects = () => []
    target.Range.prototype.getBoundingClientRect = () => ({
      bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0,
      toJSON: () => ({})
    })
  }
}

describe('phrase completion', function () {
  let directory: string
  let filename: string

  beforeEach(async function () {
    polyfillCodeMirror()
    directory = await mkdtemp(path.join(tmpdir(), 'phrase-dictionary-test-'))
    filename = path.join(directory, 'math.txt')
    await writeFile(filename, [
      '# literal dictionary',
      'Smith-Minkowski-Siegel',
      'minimal model program',
      'Grothendieck-Riemann-Roch',
      'Néron-Severi group',
      ''
    ].join('\r\n'))
  })

  afterEach(async function () {
    await rm(directory, { recursive: true, force: true })
  })

  it('parses literal UTF-8 line dictionaries and rejects malformed lines', async function () {
    const phrases = await loadPhraseDictionaries(directory)
    assert.equal(phrases.length, 4)
    assert.ok(phrases.every(entry => entry.source === filename))
    assert.equal(parsePhraseDictionary('\uFEFF# comment\nNéron\nNe\u0301ron\n\n', 'unicode.txt').length, 1)
    assert.throws(() => parsePhraseDictionary('first\ninvalid\tentry', 'bad.txt'))
  })

  it('offers prose phrases with the correct multiword replacement range', async function () {
    const phrases = await loadPhraseDictionaries(directory)
    const query = (doc: string, pos = doc.length) => phraseCompletionSource(new CompletionContext(
      EditorState.create({
        doc,
        selection: { anchor: pos },
        extensions: [markdown(), phraseCompletionsField.init(() => phrases)]
      }),
      pos,
      true
    ))

    const result = await query('Apply the minimal mo')
    assert.equal(result?.from, 'Apply the '.length)
    assert.ok(result?.options.some(option => option.label === 'minimal model program'))

    for (const text of ['\\Sm', '@Sm', '#Sm', '`Sm`', '```text\nSm\n```', '    Sm']) {
      const pos = text.indexOf('Sm') + 2
      assert.equal(await query(text, pos), null, text)
    }
  })

  it('uses native CodeMirror filtering and literal insertion', async function () {
    const phrases = await loadPhraseDictionaries(directory)
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: '',
        extensions: [
          markdown(),
          phraseCompletionsField,
          autocompletion({
            override: [phraseCompletionSource],
            selectOnOpen: false,
            defaultKeymap: false,
            activateOnTypingDelay: 0,
            interactionDelay: 0
          })
        ]
      })
    })
    view.focus()

    async function waitForCompletion (): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (completionStatus(view.state) === 'active') {return}
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('CodeMirror completion did not become active.')
    }

    async function insertCandidate (typed: string, expected: string): Promise<void> {
      closeCompletion(view)
      view.dispatch({ effects: phraseCompletionsUpdate.of(await loadPhraseDictionaries(directory)) })
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: typed },
        selection: { anchor: typed.length },
        userEvent: 'input.type'
      })
      await waitForCompletion()
      const options = currentCompletions(view.state)
      const index = options.findIndex(option => option.label === expected)
      assert.notEqual(index, -1)
      view.dispatch({ effects: setSelectedCompletion(index) })
      assert.equal(acceptCompletion(view), true)
      assert.equal(view.state.doc.toString(), expected)
    }

    try {
      view.dispatch({ effects: phraseCompletionsUpdate.of(phrases) })
      await insertCandidate('Sm', 'Smith-Minkowski-Siegel')
      await insertCandidate('minimal mo', 'minimal model program')
      await insertCandidate('GRR', 'Grothendieck-Riemann-Roch')

      await writeFile(filename, 'Unbounded derived category\n')
      await insertCandidate('Unb', 'Unbounded derived category')
    } finally {
      view.destroy()
    }
  })

  it('observes text-file rename/deletion and fails loudly on unreadable dictionaries', async function () {
    await rename(filename, path.join(directory, 'renamed.txt'))
    assert.equal((await loadPhraseDictionaries(directory))[0].source, path.join(directory, 'renamed.txt'))
    await rm(path.join(directory, 'renamed.txt'))
    assert.deepEqual(await loadPhraseDictionaries(directory), [])

    await writeFile(filename, Buffer.from([0xc3, 0x28]))
    await assert.rejects(loadPhraseDictionaries(directory))
    await assert.rejects(loadPhraseDictionaries(path.join(directory, 'missing')))
  })

  it('notifies after dictionary creation, editing and deletion under .pandoc', async function () {
    const watchedDirectory = path.join(directory, '.pandoc', 'completions')
    await mkdir(watchedDirectory, { recursive: true })
    const file = path.join(watchedDirectory, 'phrases.txt')
    const watcher = createPhraseDictionaryWatcher()
    const next = (event: string) => once(watcher, event, { signal: AbortSignal.timeout(5000) })
    try {
      const ready = next('ready')
      watcher.add(watchedDirectory)
      await ready

      const added = next('add')
      await writeFile(file, 'Smith normal form\n')
      assert.equal((await added)[0], file)

      const changed = next('change')
      await writeFile(file, 'Smith-Minkowski-Siegel\n')
      assert.equal((await changed)[0], file)
      assert.deepEqual((await loadPhraseDictionaries(watchedDirectory)).map(entry => entry.text), ['Smith-Minkowski-Siegel'])

      const removed = next('unlink')
      await rm(file)
      assert.equal((await removed)[0], file)
      assert.deepEqual(await loadPhraseDictionaries(watchedDirectory), [])
    } finally {
      await watcher.close()
    }
  })
})
