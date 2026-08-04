/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Renderer-reachable rename-undo route specs (issue #1, review A5/B7)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the production rename command over the real
 *                  ReferenceProvider and a scratch workspace on disk. Commit
 *                  rewrites every affected file, undo restores the original
 *                  bytes, and the one-shot undo record is consumed.
 *
 * END HEADER
 */

// The harness must load before any provider module: LogProvider imports
// 'electron' at module scope.
import './headless-electron-harness.cjs'
import { strict as assert } from 'assert'
import EventEmitter from 'events'
import { readFileSync } from 'fs'
import { cp, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import ReferenceProvider from 'source/app/service-providers/references'
import RenameReference from 'source/app/service-providers/commands/rename-reference'
import LogProvider from 'source/app/service-providers/log'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import type { AppServiceContainer } from 'source/app/app-service-container'
import type {
  CommitRenameOutcome,
  ReferenceRenamePreview,
  UndoRenameOutcome
} from '@common/pandoc-util/compute-reference-edits'
import type { MDFileDescriptor } from 'source/types/common/fsal'
import type { WorkspaceTextEdit } from '@dts/common/references'

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')
const WORKSPACE_FILES = [
  path.join('ProjectA', 'Theorems.md'),
  path.join('ProjectA', 'Halphen_Surfaces.md'),
  path.join('ProjectB', 'Other_Paper.md'),
  'Standalone_Notes.md'
]

const OLD_KEY = 'thm:torelli'
const NEW_KEY = 'thm:torelli-headline'

/** The real markdown descriptor FSAL would emit for a scratch file. */
function makeDescriptor (documentPath: string): MDFileDescriptor {
  const content = readFileSync(documentPath, 'utf-8')
  return {
    dir: path.dirname(documentPath),
    path: documentPath,
    name: path.basename(documentPath),
    ext: path.extname(documentPath),
    size: content.length,
    id: '',
    tags: [],
    links: [],
    citekeys: [],
    bom: '',
    type: 'file',
    wordCount: 0,
    charCount: 0,
    modtime: 0,
    creationtime: 0,
    linefeed: '\n',
    firstHeading: null,
    yamlTitle: undefined,
    frontmatter: null,
    references: extractReferences(documentPath, content)
  }
}

describe('Renderer-reachable rename-undo command route (review A5)', function () {
  const fsalSeam = new EventEmitter()
  let scratchRoot: string
  let provider: ReferenceProvider
  let command: RenameReference
  /** Original scratch bytes per absolute path, captured before the commit */
  const originals = new Map<string, string>()

  before(async function () {
    scratchRoot = await mkdtemp(path.join(tmpdir(), 'zettlr-rename-undo-route-'))
    await cp(FIXTURE_ROOT, scratchRoot, { recursive: true })

    provider = new ReferenceProvider(
      new LogProvider(),
      fsalSeam,
      {
        readMarkdownBufferContent: (_filePath: string) => undefined,
        applyWorkspaceTextEdits: async (_edits: WorkspaceTextEdit[]) => []
      },
      500
    )
    await provider.boot()

    for (const relative of WORKSPACE_FILES) {
      const absolute = path.join(scratchRoot, relative)
      originals.set(absolute, readFileSync(absolute, 'utf-8'))
      fsalSeam.emit('fsal-event', { event: 'change', descriptor: makeDescriptor(absolute) })
    }

    command = new RenameReference({ references: provider } as unknown as AppServiceContainer)
  })

  after(async function () {
    await provider.shutdown()
    await rm(scratchRoot, { recursive: true, force: true })
  })

  it('commits a rename through the command chain, rewriting every citing document on disk', async function () {
    const preview = await command.run('preview-reference-rename', { oldKey: OLD_KEY, newKey: NEW_KEY }) as ReferenceRenamePreview
    assert.strictEqual(preview.status, 'ok', 'the duplicate-defined fixture key must preview cleanly')
    if (preview.status !== 'ok') {
      return
    }

    assert.strictEqual(Object.keys(preview.edit.expectedSourceHashes).length, 4)

    const outcome = await command.run('commit-reference-rename', { edit: preview.edit }) as CommitRenameOutcome
    assert.strictEqual(outcome.status, 'applied')

    for (const [ absolute, original ] of originals) {
      const current = readFileSync(absolute, 'utf-8')
      assert.ok(current.includes(NEW_KEY), `${absolute} must carry the new key after the commit`)
      assert.strictEqual(
        current.includes(`${OLD_KEY} `) || current.includes(`${OLD_KEY}]`) || current.includes(`#${OLD_KEY}}`),
        false,
        `${absolute} must not keep a stale authored token of the old key`
      )
      assert.notStrictEqual(current, original, `${absolute} must actually change`)
    }
  })

  it('undo-reference-rename through the same chain restores every document byte-identically', async function () {
    const outcome = await command.run('undo-reference-rename', undefined) as UndoRenameOutcome
    assert.strictEqual(outcome.status, 'applied', 'the pending undo must apply over the untouched post-commit state')

    for (const [ absolute, original ] of originals) {
      assert.strictEqual(
        readFileSync(absolute, 'utf-8'),
        original,
        `${absolute} must be restored byte-identically`
      )
    }
  })

  it('the applied undo consumes the one-shot record', async function () {
    const outcome = await command.run('undo-reference-rename', undefined) as UndoRenameOutcome
    assert.strictEqual(outcome.status, 'no-pending-undo')
  })
})