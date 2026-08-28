/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL saved reference snapshot specs (issue #1, red)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Proves that FSAL's markdown file parser populates the
 *                  descriptor's `references` snapshot from the same content
 *                  it already parses for tags, links, and citekeys, and that
 *                  fsal-file parse() surfaces that snapshot for on-disk
 *                  files. The pinned contract is exact equality with
 *                  extractReferences() over the identical content, which also
 *                  pins "same pass, same result": the descriptor snapshot can
 *                  never diverge from the shared extractor's output.
 *
 * END HEADER
 */

// The harness must load before any FSAL module: file-parser.ts and
// fsal-file.ts transitively import 'electron' through the app service
// container at module scope.
import './headless-electron-harness.cjs'
import assert from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import getMarkdownFileParser from 'source/app/service-providers/fsal/util/file-parser'
import { parse } from 'source/app/service-providers/fsal/fsal-file'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import type { MDFileDescriptor } from 'source/types/common/fsal'

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')

const WORKSPACE_FILES = [
  path.join('ProjectA', 'Halphen_Surfaces.md'),
  path.join('ProjectA', 'Coble_Lattice_Table.md'),
  path.join('ProjectA', 'Theorems.md'),
  path.join('ProjectB', 'Other_Paper.md'),
  'Standalone_Notes.md'
]

// The same ID pattern default the app itself configures for the FSAL parser
const ID_RE_PATTERN = '(\\d{14})'

function fixturePath (relativePath: string): string {
  return path.join(FIXTURE_ROOT, relativePath)
}

/**
 * A bare descriptor as fsal-file's parse() would initialize it, with the
 * skeleton-empty references snapshot the parser must replace.
 */
function makeDescriptor (documentPath: string): MDFileDescriptor {
  return {
    dir: path.dirname(documentPath),
    path: documentPath,
    name: path.basename(documentPath),
    ext: path.extname(documentPath),
    size: 0,
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
    references: { documentPath, sourceHash: '', definitions: [], occurrences: [] }
  }
}

describe('FSAL saved reference snapshots', function () {
  const parser = getMarkdownFileParser(ID_RE_PATTERN)

  for (const relativePath of WORKSPACE_FILES) {
    it(`parseMarkdownFile extracts the exact reference snapshot of ${relativePath}`, function () {
      const documentPath = fixturePath(relativePath)
      const content = readFileSync(documentPath, 'utf-8')
      const expected = extractReferences(documentPath, content)
      // Fixture sanity: every workspace file carries a reference surface, so
      // the equality below can never pass vacuously on empty-vs-empty.
      assert.ok(
        expected.definitions.length + expected.occurrences.length > 0,
        `${relativePath} must contain definitions or occurrences`
      )

      const descriptor = makeDescriptor(documentPath)
      parser(descriptor, content)

      assert.deepStrictEqual(descriptor.references, expected)
    })
  }

  it('keeps bibliography citekeys from the shared pass untouched', function () {
    const documentPath = fixturePath(path.join('ProjectA', 'Halphen_Surfaces.md'))
    const content = readFileSync(documentPath, 'utf-8')
    const descriptor = makeDescriptor(documentPath)
    parser(descriptor, content)

    // The existing citation surface must not change when reference
    // extraction joins the same parse: @Ols04 stays a citekey and never
    // becomes a reference occurrence.
    assert.ok(descriptor.citekeys.includes('Ols04'), 'bibliography citekey @Ols04 must survive')
    assert.deepStrictEqual(
      descriptor.references.occurrences.filter(occurrence => occurrence.key === 'Ols04'),
      []
    )
  })

  it('parse() surfaces the reference snapshot of an on-disk file', async function () {
    const documentPath = fixturePath(path.join('ProjectA', 'Coble_Lattice_Table.md'))
    const content = readFileSync(documentPath, 'utf-8')

    const descriptor = await parse(documentPath, null, parser)

    assert.deepStrictEqual(descriptor.references, extractReferences(documentPath, content))
  })
})
