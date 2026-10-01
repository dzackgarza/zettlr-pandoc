/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Documents-provider quit prompt specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the REAL DocumentManager's before-quit listener.
 *                  An agent proposal loads its document into the authority
 *                  without a pane; the unsaved changes the quit prompt asks
 *                  about are the ones a pane shows, named one per line, and
 *                  a review nobody is looking at goes to its sidecar.
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import { appListeners, appQuitRequests, messageBoxes, userData } from './headless-electron-harness.cjs'
import { strict as assert } from 'assert'
import { createPatch } from 'diff'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import DocumentManager from 'source/app/service-providers/documents'
import LogProvider from 'source/app/service-providers/log'
import { sha256Text } from 'source/common/util/sha256'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import type { AppServiceContainer } from 'source/app/app-service-container'
import type { MDFileDescriptor } from 'source/types/common/fsal'

const SHOWN_SOURCE = 'The author is typing here.\n'
const PROPOSED_SOURCE = 'alpha\nbeta\n'
const PROPOSED_TARGET = 'alpha\nBETA\n'
// The quit dialog's buttons: Save, Discard, Cancel.
const DISCARD = 1
const CANCEL = 2

function descriptorFor (filePath: string): MDFileDescriptor {
  const content = readFileSync(filePath, 'utf-8')
  const stat = statSync(filePath)
  return {
    dir: path.dirname(filePath),
    path: filePath,
    name: path.basename(filePath),
    ext: path.extname(filePath),
    size: stat.size,
    id: '',
    tags: [],
    links: [],
    citekeys: [],
    bom: '',
    type: 'file',
    wordCount: 0,
    charCount: content.length,
    modtime: stat.mtimeMs,
    creationtime: stat.birthtimeMs,
    linefeed: '\n',
    firstHeading: null,
    yamlTitle: undefined,
    aliases: [],
    frontmatter: null,
    references: extractReferences(filePath, content)
  }
}

interface QuitEvent {
  prevented: boolean
  preventDefault: () => void
}

describe('Documents-provider quit prompt', function () {
  let root: string
  let shownPath: string
  let proposedPath: string
  let provider: DocumentManager
  let windowId: string
  let leafId: string

  /**
   * Fire the registered before-quit listener and wait for its outcome: a
   * quit request, a cancelled dialog, or an unprevented event. The sidecar
   * write before the dialog and the save or discard after it are real file
   * I/O, so this waits on the outcome and not on a tick count; a dialog
   * answered with Save or Discard is not yet an outcome.
   */
  async function requestQuit (): Promise<QuitEvent> {
    const listeners = appListeners.get('before-quit') ?? []
    assert.equal(listeners.length, 1, 'the documents provider registers the one before-quit listener')
    const quitsBefore = appQuitRequests.length
    const dialogsBefore = messageBoxes.shown.length
    const event: QuitEvent = { prevented: false, preventDefault () { this.prevented = true } }
    listeners[0](event)
    const deadline = Date.now() + 5000
    while (
      event.prevented &&
      appQuitRequests.length === quitsBefore &&
      (messageBoxes.shown.length === dialogsBefore || messageBoxes.answer !== CANCEL) &&
      Date.now() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    for (let settle = 0; settle < 10; settle++) {
      await new Promise(resolve => setImmediate(resolve))
    }
    return event
  }

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), 'zettlr-quit-prompt-'))
    shownPath = path.join(root, 'Shown.md')
    proposedPath = path.join(root, 'Proposed.md')
    writeFileSync(shownPath, SHOWN_SOURCE, 'utf-8')
    writeFileSync(proposedPath, PROPOSED_SOURCE, 'utf-8')
    mkdirSync(path.join(userData, 'logs'), { recursive: true })
    await rm(path.join(userData, 'documents.yaml'), { force: true })
    appListeners.delete('before-quit')
    appQuitRequests.length = 0
    messageBoxes.shown.length = 0
    messageBoxes.answer = undefined

    const watcher = {
      on: () => {},
      getWatched: () => ({}),
      watchPath: (_filePath: string) => {},
      unwatchPath: (_filePath: string) => {},
      shutdown: async () => {}
    }
    const appSeam = {
      log: new LogProvider(),
      config: {
        get: () => ({
          app: { openFiles: [], openWorkspaces: [root] },
          editor: { autoSave: 'off' as const },
          system: { avoidNewTabs: false },
          appLang: 'en-US',
          files: {
            images: { openWith: 'zettlr' as const },
            pdf: { openWith: 'zettlr' as const }
          },
          alwaysReloadFiles: false
        }),
        addPath: (_filePath: string) => false,
        set: (_key: string, _value: unknown) => {}
      },
      fsal: {
        getWatchdog: () => watcher,
        getDescriptorForAnySupportedFile: async (filePath: string) => descriptorFor(filePath),
        loadAnySupportedFile: async (filePath: string) => readFileSync(filePath, 'utf-8'),
        getDescriptorFor: async (filePath: string) => descriptorFor(filePath),
        getFilesystemMetadata: async (filePath: string) => ({ modtime: statSync(filePath).mtimeMs }),
        testAccess: async (_filePath: string) => true,
        writeTextFile: async (filePath: string, content: string) => {
          writeFileSync(filePath, content, 'utf-8')
        }
      },
      citeproc: {
        synchronizeDatabases: async (_libraries: string[]) => {}
      },
      recentDocs: {
        add: (_filePath: string) => {},
        markEdited: (_filePath: string) => {}
      },
      stats: {
        updateCounts: (_words: number, _characters: number) => {}
      },
      references: {
        reportAuthorityBuffer: (_filePath: string) => {},
        dropAuthorityBuffer: (_filePath: string) => {}
      }
    }

    provider = new DocumentManager(appSeam as unknown as AppServiceContainer)
    await provider.boot()
    windowId = provider.windowKeys()[0]
    leafId = provider.leafIds(windowId)[0]
  })

  afterEach(async function () {
    await provider.shutdown()
    await rm(root, { recursive: true, force: true })
  })

  /** An agent proposes a change to a file no pane shows. */
  async function proposeWithoutPane (): Promise<string> {
    const documentId = provider.ensureDocumentId(proposedPath)
    const submitted = await provider.submitProposal(
      documentId,
      sha256Text(PROPOSED_SOURCE),
      [{
        description: 'capitalize beta',
        patch: createPatch('document', PROPOSED_SOURCE, PROPOSED_TARGET, '', '', { context: 0 })
      }],
      'quit-prompt-proposal',
      0
    )
    if (!submitted.ok) {
      assert.fail(`The review proposal was refused: ${submitted.code}`)
    }
    assert.equal(provider.isModified(proposedPath), true)
    assert.equal(provider.getActiveFile(leafId), null)
    return documentId
  }

  it('quits without a prompt when the only changed document is a review no pane shows', async function () {
    const documentId = await proposeWithoutPane()

    const event = await requestQuit()

    assert.deepEqual(messageBoxes.shown, [])
    assert.equal(event.prevented, true, 'the review is written through before the process may exit')
    assert.equal(appQuitRequests.length, 1)
    assert.equal(readFileSync(proposedPath, 'utf-8'), PROPOSED_SOURCE)
    assert.deepEqual(provider.loadedDocuments.map(document => document.filePath), [])

    await provider.getDocument(proposedPath)
    assert.equal(provider.reviewStatus(documentId)?.unresolvedChunks, 1)
    assert.equal(provider.readMarkdownBufferContent(proposedPath), PROPOSED_TARGET)
  })

  it('names the documents in panes that it asks about, and asks about nothing else', async function () {
    await proposeWithoutPane()
    await provider.getDocument(shownPath)
    assert.equal(await provider.openFile(windowId, leafId, shownPath), true)
    await provider.applyWorkspaceTextEdits([
      { documentPath: shownPath, range: { from: 0, to: 0 }, insert: 'Draft: ' }
    ])

    messageBoxes.answer = CANCEL
    const cancelled = await requestQuit()
    assert.equal(cancelled.prevented, true)
    assert.equal(messageBoxes.shown.length, 1)
    assert.equal(messageBoxes.shown[0].detail, shownPath)
    assert.equal(appQuitRequests.length, 0)
    assert.equal(provider.isModified(shownPath), true)

    messageBoxes.answer = DISCARD
    await requestQuit()
    assert.equal(appQuitRequests.length, 1)
    assert.equal(readFileSync(shownPath, 'utf-8'), SHOWN_SOURCE)
    assert.equal(readFileSync(proposedPath, 'utf-8'), PROPOSED_SOURCE)
  })
})
