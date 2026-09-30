/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Ownership of the editor configuration
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     The window gives the editor a configuration that the window
 *                  made from its reactive configuration store. The editor
 *                  keeps its own copy in the order it needs. The configuration
 *                  of the window stays as the window made it, so the window
 *                  sees no change that it must send to the editor again.
 *
 * END HEADER
 */

import './provision-renderer-window-seams'
import { strict as assert } from 'assert'
import { reactive, watchEffect } from 'vue'
import type { DocumentAuthorityAPI } from 'source/common/modules/markdown-editor'
import { configField, type EditorConfigOptions } from 'source/common/modules/markdown-editor/util/configuration'
import { DocumentType } from '@dts/common/documents'

function polyfillJsdomForCodeMirror (): void {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = callback => Number(setTimeout(() => callback(Date.now()), 0))
    globalThis.cancelAnimationFrame = handle => clearTimeout(handle)
  }
  if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = globalThis.requestAnimationFrame
    window.cancelAnimationFrame = globalThis.cancelAnimationFrame
  }
  if (typeof globalThis.ResizeObserver !== 'function') {
    globalThis.ResizeObserver = class {
      observe (): void {}
      unobserve (): void {}
      disconnect (): void {}
    }
    window.ResizeObserver = globalThis.ResizeObserver
  }
}

describe('MarkdownEditor configuration ownership', function () {
  let MarkdownEditor: typeof import('source/common/modules/markdown-editor').default
  let previousCssLoader: ((module: NodeModule, filename: string) => void)|undefined

  before(async function () {
    polyfillJsdomForCodeMirror()
    const cjsRequire = require as NodeRequire & { extensions: Record<string, (module: NodeModule, filename: string) => void> }
    previousCssLoader = cjsRequire.extensions['.css']
    cjsRequire.extensions['.css'] = () => {}
    MarkdownEditor = (await import('source/common/modules/markdown-editor')).default
  })

  after(function () {
    const cjsRequire = require as NodeRequire & { extensions: Record<string, (module: NodeModule, filename: string) => void> }
    if (previousCssLoader === undefined) {
      delete cjsRequire.extensions['.css']
    } else {
      cjsRequire.extensions['.css'] = previousCssLoader
    }
  })

  const never = new Promise<never>(() => {})
  const authority: DocumentAuthorityAPI = {
    fetchDoc: async () => ({ content: 'The lattice has a root.\n', type: DocumentType.Markdown, startVersion: 0 }),
    pullUpdates: async () => await never,
    pushUpdates: async () => true
  }
  const WINDOW_ORDER = [ '->', '<-->', '-->' ]
  const LONGEST_KEY_FIRST = [ '<-->', '-->', '->' ]

  /** A configuration as the window makes it from its reactive store, and the count of changes to its list. */
  function windowConfiguration (): { configuration: EditorConfigOptions, listChanges: () => number, keys: () => string[] } {
    const configuration = reactive({
      autocorrect: {
        active: true,
        matchWholeWords: false,
        magicQuotes: { primary: '“…”', secondary: '‘…’' },
        replacements: [
          { key: '->', value: '→' },
          { key: '<-->', value: '↔' },
          { key: '-->', value: '⟶' }
        ]
      }
    })
    const keys = (): string[] => configuration.autocorrect.replacements.map(item => item.key)
    // The reader runs one time now, and one more time for each change of the list.
    let changes = -1
    watchEffect(() => {
      assert.equal(keys().length, WINDOW_ORDER.length)
      changes++
    }, { flush: 'sync' })
    return { configuration, listChanges: () => changes, keys }
  }

  it('sorts its own copy of the replacements it starts with and leaves the list of the window in its order', async function () {
    const fromWindow = windowConfiguration()
    const editor = new MarkdownEditor('leaf', 'window', '/tmp/configuration-ownership.md', authority, fromWindow.configuration)
    await editor.ready

    assert.deepEqual(
      editor.instance.state.field(configField).autocorrect.replacements.map(item => item.key),
      LONGEST_KEY_FIRST
    )
    assert.deepEqual(fromWindow.keys(), WINDOW_ORDER)
    assert.equal(fromWindow.listChanges(), 0)
    editor.unmount()
  })

  it('sorts its own copy of the replacements of an update and leaves the list of the window in its order', async function () {
    const editor = new MarkdownEditor('leaf', 'window', '/tmp/configuration-ownership.md', authority)
    await editor.ready
    assert.deepEqual(editor.instance.state.field(configField).autocorrect.replacements, [])

    const fromWindow = windowConfiguration()
    editor.setOptions(fromWindow.configuration)

    assert.deepEqual(
      editor.instance.state.field(configField).autocorrect.replacements.map(item => item.key),
      LONGEST_KEY_FIRST
    )
    assert.deepEqual(fromWindow.keys(), WINDOW_ORDER)
    assert.equal(fromWindow.listChanges(), 0)
    editor.unmount()
  })
})
