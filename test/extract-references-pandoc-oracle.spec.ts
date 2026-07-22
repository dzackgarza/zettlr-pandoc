// Differential oracle: the real Pandoc markdown reader is the authority on
// which authored attribute identifiers exist. extractReferences() must agree
// with the Pandoc AST on referenceable identity (range-independent), without
// Pandoc ever becoming an authoring-time subprocess.

import assert from 'assert'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import path from 'path'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { REFERENCE_FAMILIES } from 'source/types/common/references'

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')

// A supported identifier is a supported family prefix, a colon, and a
// non-empty key ('thm:' is a near-miss, 'table:wrong-prefix' an unsupported
// family).
const SUPPORTED_IDENTIFIER = new RegExp('^(?:' + REFERENCE_FAMILIES.join('|') + '):.+$')

interface PandocElement { t: string, c?: unknown }

function isElement (value: unknown): value is PandocElement {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    typeof (value as PandocElement).t === 'string'
}

/** Pandoc Attr is [identifier, classes, key-value pairs]. */
function attrIdentifier (attr: unknown): string {
  assert.ok(Array.isArray(attr) && typeof attr[0] === 'string', 'pandoc Attr must start with an identifier')
  return attr[0] as string
}

function attrClasses (attr: unknown): string[] {
  assert.ok(Array.isArray(attr) && Array.isArray(attr[1]), 'pandoc Attr must carry a class list')
  return attr[1] as string[]
}

/**
 * Plain Pandoc leaves the pandoc-crossref equation attribute as a literal
 * `{#eq:key}` Str following the DisplayMath inline; collect those ids from
 * the JSON structure.
 */
function collectDisplayMathAttrIdentifiers (inlines: unknown[], into: string[]): void {
  for (let i = 0; i < inlines.length; i++) {
    const element = inlines[i]
    if (!isElement(element) || element.t !== 'Math' || !Array.isArray(element.c)) {
      continue
    }
    const mathKind: unknown = element.c[0]
    if (!isElement(mathKind) || mathKind.t !== 'DisplayMath') {
      continue
    }
    let j = i + 1
    while (j < inlines.length) {
      const next = inlines[j]
      if (isElement(next) && next.t === 'Space') {
        j++
      } else {
        break
      }
    }
    const follower = inlines[j]
    if (isElement(follower) && follower.t === 'Str' && typeof follower.c === 'string') {
      const match = /^\{#([^\s}]+)\}$/.exec(follower.c)
      if (match !== null) {
        into.push(match[1])
      }
    }
  }
}

/**
 * Collects every identifier of a referenceable node in the Pandoc AST:
 * Header, Div (except proof divs, which are unreferenceable), CodeBlock,
 * Table, Figure, and Image Attrs, plus display-math attribute ids.
 */
function collectReferenceableIdentifiers (node: unknown, into: string[]): void {
  if (Array.isArray(node)) {
    collectDisplayMathAttrIdentifiers(node, into)
    for (const child of node) {
      collectReferenceableIdentifiers(child, into)
    }
    return
  }
  if (!isElement(node)) {
    return
  }
  const content: unknown = node.c
  if (node.t === 'Header' && Array.isArray(content)) {
    into.push(attrIdentifier(content[1]))
  } else if (node.t === 'Div' && Array.isArray(content)) {
    if (!attrClasses(content[0]).includes('proof')) {
      into.push(attrIdentifier(content[0]))
    }
  } else if ([ 'CodeBlock', 'Table', 'Figure', 'Image' ].includes(node.t) && Array.isArray(content)) {
    into.push(attrIdentifier(content[0]))
  }
  collectReferenceableIdentifiers(content, into)
}

function pandocIdentifiers (documentPath: string): string[] {
  const json = execFileSync('pandoc', [ '-f', 'markdown', '-t', 'json', documentPath ], { encoding: 'utf-8' })
  const ast = JSON.parse(json) as { blocks: unknown }
  const identifiers: string[] = []
  collectReferenceableIdentifiers(ast.blocks, identifiers)
  return identifiers
}

describe('extractReferences() against the real Pandoc AST oracle', function () {
  it('has a working system pandoc (hard requirement, never skipped)', function () {
    // If pandoc is absent this fails loudly; there is deliberately no skip.
    const version = execFileSync('pandoc', ['--version'], { encoding: 'utf-8' })
    assert.match(version, /^pandoc \d/)
  })

  // EVERY fixture file participates in the oracle (issue #5, C9): the five
  // workspace documents plus the adjacent subfigure gallery. Files without
  // authored definitions (Halphen_Surfaces.md carries only references) pin a
  // supported count of 0 — the differential there proves the extractor
  // invents no definitions from mere usages, and the nonzero counts of the
  // other files keep the collector itself honest.
  const ORACLE_FILES: Array<{ relativePath: string, supportedIdentifierCount: number }> = [
    { relativePath: path.join('ProjectA', 'Coble_Lattice_Table.md'), supportedIdentifierCount: 5 },
    { relativePath: path.join('ProjectA', 'Theorems.md'), supportedIdentifierCount: 15 },
    { relativePath: path.join('ProjectA', 'Halphen_Surfaces.md'), supportedIdentifierCount: 0 },
    { relativePath: path.join('ProjectB', 'Other_Paper.md'), supportedIdentifierCount: 2 },
    { relativePath: 'Standalone_Notes.md', supportedIdentifierCount: 1 },
    // Wrapping/subfigure forms (review A1): pandoc carries the wrapping div
    // ids (#fig:coble-panels, #lst:lattice-scan) as Div Attr identifiers
    // beside the nested Figure ids and the explicit section id. The gallery
    // lives beside the workspace (the atomicity spec pins the workspace
    // directory's exact listing).
    { relativePath: path.join('..', 'subfigure-gallery', 'Subfigure_Gallery.md'), supportedIdentifierCount: 5 }
  ]

  for (const { relativePath, supportedIdentifierCount } of ORACLE_FILES) {
    it(`agrees with the Pandoc AST on referenceable identity for ${relativePath}`, function () {
      const documentPath = path.join(FIXTURE_ROOT, relativePath)
      const content = readFileSync(documentPath, 'utf-8')

      const extracted = extractReferences(documentPath, content)
        .definitions.map(definition => definition.key).sort()
      const supported = pandocIdentifiers(documentPath)
        .filter(identifier => SUPPORTED_IDENTIFIER.test(identifier)).sort()

      // Guard the oracle itself: a collector regression that observes nothing
      // must never let the agreement pass vacuously.
      assert.strictEqual(
        supported.length, supportedIdentifierCount,
        `pandoc must observe ${supportedIdentifierCount} supported identifiers in ${relativePath}`
      )

      // Exact set agreement: every extracted definition key exists as a
      // pandoc identifier, and every supported pandoc identifier is extracted.
      assert.deepStrictEqual(extracted, supported)
    })
  }
})
