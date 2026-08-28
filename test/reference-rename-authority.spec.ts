/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Workspace rename document-authority boundary specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Proves that workspace reference edits cross the real
 *                  ReferenceProvider -> DocumentManager authority boundary.
 *                  Every open touched document is changed in the central
 *                  authority before commit reports success; immediate undo
 *                  is therefore fenced against acknowledged authority text
 *                  rather than against transactions held by one renderer.
 *
 * END HEADER
 */

// The harness must load before provider modules, which import Electron.
import { userData } from './headless-electron-harness.cjs'
import { strict as assert } from 'assert'
import EventEmitter from 'events'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import DocumentManager from 'source/app/service-providers/documents'
import ReferenceProvider from 'source/app/service-providers/references'
import LogProvider from 'source/app/service-providers/log'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import type { ReferenceRenamePreview } from 'source/common/pandoc-util/compute-reference-edits'
import type { MDFileDescriptor } from 'source/types/common/fsal'

const OLD_KEY = 'thm:authority-owned'
const NEW_KEY = 'thm:authority-acknowledged'
const DEFINITION_SOURCE = [
  '# Authority boundary',
  '',
  '::: {.theorem #thm:authority-owned}',
  'The authority owns this live definition.',
  ':::',
  ''
].join('\n')
const OCCURRENCE_SOURCE = [
  '# Consumer',
  '',
  'The live consumer cites @thm:authority-owned before saving.',
  ''
].join('\n')
const RENAMED_DEFINITION_SOURCE = DEFINITION_SOURCE.replace(OLD_KEY, NEW_KEY)
const RENAMED_OCCURRENCE_SOURCE = OCCURRENCE_SOURCE.replace(OLD_KEY, NEW_KEY)

/** Build the real markdown descriptor consumed by both owned providers. */
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
    frontmatter: null,
    references: extractReferences(filePath, content)
  }
}

interface ScratchBoundary {
  root: string
  definitionPath: string
  occurrencePath: string
  documents: DocumentManager
  references: ReferenceProvider
}

async function createScratchBoundary (): Promise<ScratchBoundary> {
  const root = await mkdtemp(path.join(tmpdir(), 'zettlr-reference-authority-'))
  const definitionPath = path.join(root, 'Definition.md')
  const occurrencePath = path.join(root, 'Occurrence.md')
  writeFileSync(definitionPath, DEFINITION_SOURCE, 'utf-8')
  writeFileSync(occurrencePath, OCCURRENCE_SOURCE, 'utf-8')

  mkdirSync(userData, { recursive: true })
  mkdirSync(path.join(userData, 'logs'), { recursive: true })

  const fsalEvents = new EventEmitter()
  const watcher = {
    on: () => {},
    getWatched: () => ({}),
    watchPath: (_filePath: string) => {},
    unwatchPath: (_filePath: string) => {},
    shutdown: async () => {}
  }
  let references: ReferenceProvider
  const app = {
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
      readDirectoryRecursively: async (_workspacePath: string) => [definitionPath, occurrencePath],
      testAccess: async (_filePath: string) => true,
      writeTextFile: async (filePath: string, content: string) => {
        writeFileSync(filePath, content, 'utf-8')
      }
    },
    citeproc: {
      synchronizeDatabases: async (_libraries: string[]) => {}
    },
    recentDocs: {
      add: (_filePath: string) => {}
    },
    stats: {
      updateCounts: (_words: number, _characters: number) => {}
    },
    windows: {
      askSaveChanges: async (_detail?: string) => ({ response: 0, checkboxChecked: false }),
      getFirstMainWindow: () => undefined,
      getMainWindowKey: (_window: unknown) => ''
    },
    references: {
      reportAuthorityBuffer: (filePath: string, immediate?: boolean) => {
        references.reportAuthorityBuffer(filePath, immediate)
      },
      dropAuthorityBuffer: (filePath: string) => {
        references.dropAuthorityBuffer(filePath)
      }
    }
  }

  const documents = new DocumentManager(app)
  references = new ReferenceProvider(
    app.log,
    fsalEvents,
    documents,
    500,
    userData
  )
  await references.boot()

  fsalEvents.emit('fsal-event', {
    event: 'change',
    descriptor: descriptorFor(definitionPath)
  })
  fsalEvents.emit('fsal-event', {
    event: 'change',
    descriptor: descriptorFor(occurrencePath)
  })
  await documents.getDocument(definitionPath)
  await documents.getDocument(occurrencePath)

  return { root, definitionPath, occurrencePath, documents, references }
}

function acceptedEdit (preview: ReferenceRenamePreview): Extract<ReferenceRenamePreview, { status: 'ok' }>['edit'] {
  assert.equal(preview.status, 'ok')
  if (preview.status !== 'ok') {
    assert.fail('The representative workspace rename was rejected')
  }
  return preview.edit
}

describe('Workspace reference rename authority application', function () {
  let scratch: ScratchBoundary

  beforeEach(async function () {
    scratch = await createScratchBoundary()
  })

  afterEach(async function () {
    await scratch.references.shutdown()
    await scratch.documents.shutdown()
    await rm(scratch.root, { recursive: true, force: true })
  })

  it('applies every open touched document in the central authority before reporting success', async function () {
    const edit = acceptedEdit(scratch.references.previewRename(OLD_KEY, NEW_KEY))

    const outcome = await scratch.references.commitRename(edit)

    assert.equal(outcome.status, 'applied')
    assert.equal(
      scratch.documents.readMarkdownBufferContent(scratch.definitionPath),
      RENAMED_DEFINITION_SOURCE
    )
    assert.equal(
      scratch.documents.readMarkdownBufferContent(scratch.occurrencePath),
      RENAMED_OCCURRENCE_SOURCE
    )
    assert.equal(readFileSync(scratch.definitionPath, 'utf-8'), DEFINITION_SOURCE)
    assert.equal(readFileSync(scratch.occurrencePath, 'utf-8'), OCCURRENCE_SOURCE)
  })

  it('makes immediate undo safe only after the open-buffer application is acknowledged', async function () {
    const edit = acceptedEdit(scratch.references.previewRename(OLD_KEY, NEW_KEY))
    const committed = await scratch.references.commitRename(edit)
    assert.equal(committed.status, 'applied')

    const undone = await scratch.references.undoRename()

    assert.equal(undone.status, 'applied')
    assert.equal(
      scratch.documents.readMarkdownBufferContent(scratch.definitionPath),
      DEFINITION_SOURCE
    )
    assert.equal(
      scratch.documents.readMarkdownBufferContent(scratch.occurrencePath),
      OCCURRENCE_SOURCE
    )
  })
})
