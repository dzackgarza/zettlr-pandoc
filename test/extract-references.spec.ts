import assert from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { extractReferences, hashDocumentSource } from 'source/common/pandoc-util/extract-references'
import { theoremDivClass } from 'source/common/util/pandoc-quick-reference'
import { referenceFamilyOf, THEOREM_FAMILIES, type ReferenceDefinition, type ReferenceFamily, type ReferenceOccurrence, type SourceRange, type TheoremFamily } from 'source/types/common/references'

const FIXTURE_ROOT = path.join('test', 'fixtures', 'reference-workspace')

interface Fixture { documentPath: string, content: string }

function loadFixture (relativePath: string): Fixture {
  const documentPath = path.join(FIXTURE_ROOT, relativePath)
  return { documentPath, content: readFileSync(documentPath, 'utf-8') }
}

/**
 * Returns the exact range of a token that must occur exactly once in the
 * fixture, so hardcoded expectations stay robust against fixture edits.
 */
function tokenRange (content: string, token: string): SourceRange {
  const from = content.indexOf(token)
  assert.notStrictEqual(from, -1, `fixture must contain the token ${token}`)
  assert.strictEqual(content.indexOf(token, from + 1), -1, `fixture token must be unique: ${token}`)
  return { from, to: from + token.length }
}

/** The complete authored line containing the (unique) token. */
function lineAt (content: string, token: string): string {
  const { from } = tokenRange(content, token)
  const start = content.lastIndexOf('\n', from) + 1
  const end = content.indexOf('\n', from)
  return content.slice(start, end === -1 ? content.length : end)
}

/** The complete fenced div block whose opening line contains the id token. */
function divBlockAt (content: string, idToken: string): string {
  const { from } = tokenRange(content, idToken)
  const start = content.lastIndexOf('\n', from) + 1
  const close = content.indexOf('\n:::', from)
  assert.notStrictEqual(close, -1, `fenced div for ${idToken} must close`)
  return content.slice(start, close + '\n:::'.length)
}

/** The complete fenced code block whose opening fence contains the id token. */
function fenceBlockAt (content: string, idToken: string): string {
  const { from } = tokenRange(content, idToken)
  const start = content.lastIndexOf('\n', from) + 1
  const close = content.indexOf('\n```', from)
  assert.notStrictEqual(close, -1, `fenced code block for ${idToken} must close`)
  return content.slice(start, close + '\n```'.length)
}

function familyOf (key: string): ReferenceFamily {
  const family = referenceFamilyOf(key)
  assert.ok(family !== undefined, `fixture key must carry a supported reference family: ${key}`)
  return family
}

function definition (
  fixture: Fixture,
  key: string,
  sourceKind: ReferenceDefinition['sourceKind'],
  classes: string[],
  title: string | undefined,
  previewSource: string,
  enclosingSection: string | undefined
): ReferenceDefinition {
  return {
    key,
    family: familyOf(key),
    sourceKind,
    documentPath: fixture.documentPath,
    range: tokenRange(fixture.content, '#' + key),
    classes,
    title,
    previewSource,
    enclosingSection,
    sourceHash: hashDocumentSource(fixture.content)
  }
}

function occurrence (
  fixture: Fixture,
  key: string,
  syntaxKind: ReferenceOccurrence['syntaxKind'],
  clusterRaw: string
): ReferenceOccurrence {
  return {
    key,
    family: familyOf(key),
    range: tokenRange(fixture.content, '@' + key),
    syntaxKind,
    clusterRaw,
    documentPath: fixture.documentPath,
    sourceHash: hashDocumentSource(fixture.content)
  }
}

// Every one of the fifteen theorem prefixes is defined once in Theorems.md.
const THEOREM_FIXTURE_DEFINITIONS: Array<{ key: string, family: TheoremFamily, title: string | undefined }> = [
  { key: 'thm:torelli', family: 'thm', title: 'Torelli for Enriques' },
  { key: 'lem:kodaira:embedding', family: 'lem', title: undefined },
  { key: 'prop:fibration-count', family: 'prop', title: undefined },
  { key: 'cor:automorphism-index', family: 'cor', title: undefined },
  { key: 'def:halphen-pencil', family: 'def', title: undefined },
  { key: 'rmk:characteristic-two', family: 'rmk', title: undefined },
  { key: 'ex:coble-surface', family: 'ex', title: undefined },
  { key: 'conj:borcherds-form', family: 'conj', title: 'Modularity of the Borcherds form' },
  { key: 'clm:isotropic-vector', family: 'clm', title: undefined },
  { key: 'obs:root-invariant', family: 'obs', title: undefined },
  { key: 'qst:moduli-compactification', family: 'qst', title: undefined },
  { key: 'prob:classify-actions', family: 'prob', title: undefined },
  { key: 'ass:very-general', family: 'ass', title: undefined },
  { key: 'warn:signature-convention', family: 'warn', title: undefined },
  { key: 'exr:compute-discriminant', family: 'exr', title: undefined }
]

describe('extractReferences()', function () {
  it('fixture covers every supported theorem prefix exactly once', function () {
    const covered = THEOREM_FIXTURE_DEFINITIONS.map(entry => entry.family).sort()
    assert.deepStrictEqual(covered, [ ...THEOREM_FAMILIES ].sort())
  })

  it('extracts every crossref-attr definition with exact ranges, captions, and sections', function () {
    const fixture = loadFixture(path.join('ProjectA', 'Coble_Lattice_Table.md'))
    const snapshot = extractReferences(fixture.documentPath, fixture.content)

    assert.deepStrictEqual(snapshot.definitions, [
      definition(
        fixture, 'sec:moduli', 'crossref-attr', [],
        'Moduli of marked surfaces',
        lineAt(fixture.content, '#sec:moduli'),
        'Coble lattices and rational surfaces'
      ),
      definition(
        fixture, 'tbl:coble-lattices', 'crossref-attr', [],
        'Coble lattices of Halphen type',
        lineAt(fixture.content, '#tbl:coble-lattices'),
        'Moduli of marked surfaces'
      ),
      definition(
        fixture, 'eq:intersection-form', 'crossref-attr', [],
        undefined,
        lineAt(fixture.content, '#eq:intersection-form'),
        'Moduli of marked surfaces'
      ),
      definition(
        fixture, 'fig:root-diagram', 'crossref-attr', [],
        'Root diagram',
        lineAt(fixture.content, '#fig:root-diagram'),
        'Moduli of marked surfaces'
      ),
      definition(
        fixture, 'lst:sage-run', 'crossref-attr', [ 'python' ],
        'Sage session',
        fenceBlockAt(fixture.content, '#lst:sage-run'),
        'Moduli of marked surfaces'
      )
    ])
  })

  it('extracts a theorem-div definition for every supported prefix with exact ranges', function () {
    const fixture = loadFixture(path.join('ProjectA', 'Theorems.md'))
    const snapshot = extractReferences(fixture.documentPath, fixture.content)

    assert.deepStrictEqual(snapshot.definitions, THEOREM_FIXTURE_DEFINITIONS.map(entry =>
      definition(
        fixture, entry.key, 'theorem-div', [ theoremDivClass(entry.family) ], entry.title,
        divBlockAt(fixture.content, '#' + entry.key),
        'Main results'
      )
    ))
  })

  it('preserves colon-bearing keys in full with the family taken from the first segment', function () {
    const fixture = loadFixture(path.join('ProjectA', 'Theorems.md'))
    const snapshot = extractReferences(fixture.documentPath, fixture.content)

    const lemma = snapshot.definitions.find(def => def.family === 'lem')
    assert.deepStrictEqual(lemma, definition(
      fixture, 'lem:kodaira:embedding', 'theorem-div', [ 'lemma' ], undefined,
      divBlockAt(fixture.content, '#lem:kodaira:embedding'),
      'Main results'
    ))
  })

  it('excludes proof divs, empty keys, and unsupported families from definitions', function () {
    const fixture = loadFixture(path.join('ProjectA', 'Theorems.md'))
    const keys = extractReferences(fixture.documentPath, fixture.content).definitions.map(def => def.key)

    // Positive control first: an empty extraction must not pass this test.
    assert.ok(keys.includes('thm:torelli'), 'the theorem div must be indexed')
    assert.ok(!keys.includes('thm:should-not-index'), 'proof divs are unreferenceable')
    assert.ok(!keys.includes('thm:'), 'an empty key is not a definition')
    assert.ok(!keys.includes('table:wrong-prefix'), 'table: is not a supported family')
  })

  it('extracts bare and bracketed occurrences with exact ranges and cluster text', function () {
    const fixture = loadFixture(path.join('ProjectA', 'Halphen_Surfaces.md'))
    const snapshot = extractReferences(fixture.documentPath, fixture.content)
    const cluster = '[@thm:torelli; @lem:embedding]'
    assert.strictEqual(fixture.content.includes(cluster), true, 'fixture must contain the authored cluster')

    assert.deepStrictEqual(snapshot.occurrences, [
      occurrence(fixture, 'tbl:coble-lattices', 'bare', '@tbl:coble-lattices'),
      occurrence(fixture, 'thm:torelli', 'bracketed', cluster),
      occurrence(fixture, 'lem:embedding', 'bracketed', cluster),
      occurrence(fixture, 'eq:intersection-form', 'bare', '@eq:intersection-form'),
      occurrence(fixture, 'fig:nonexistent-diagram', 'bare', '@fig:nonexistent-diagram'),
      occurrence(fixture, 'sec:moduli', 'bare', '@sec:moduli')
    ])
  })

  it('extracts bracketed reference clusters but never bibliography citations', function () {
    const fixture = loadFixture(path.join('ProjectA', 'Halphen_Surfaces.md'))
    const occurrences = extractReferences(fixture.documentPath, fixture.content).occurrences

    assert.strictEqual(fixture.content.includes('[@Ols04, Lem. 7.1]'), true, 'fixture must contain the citation')
    // Positive control: the reference cluster in the same document is extracted …
    assert.ok(
      occurrences.some(occ => occ.key === 'thm:torelli' && occ.syntaxKind === 'bracketed'),
      'bracketed reference clusters must be extracted'
    )
    // … while the bibliography citation contributes no occurrence at all.
    assert.deepStrictEqual(occurrences.filter(occ => occ.key === 'Ols04'), [])
    assert.deepStrictEqual(occurrences.filter(occ => occ.clusterRaw.includes('@Ols04')), [])
  })

  it('extracts duplicate definitions from every defining file', function () {
    const theorems = loadFixture(path.join('ProjectA', 'Theorems.md'))
    const otherPaper = loadFixture(path.join('ProjectB', 'Other_Paper.md'))

    const inTheorems = extractReferences(theorems.documentPath, theorems.content)
      .definitions.filter(def => def.key === 'thm:torelli')
    const inOtherPaper = extractReferences(otherPaper.documentPath, otherPaper.content)
      .definitions.filter(def => def.key === 'thm:torelli')

    assert.deepStrictEqual(inTheorems.map(def => def.documentPath), [theorems.documentPath])
    assert.deepStrictEqual(inOtherPaper, [
      definition(
        otherPaper, 'thm:torelli', 'theorem-div', [ 'theorem' ],
        'Torelli for rational elliptic surfaces',
        divBlockAt(otherPaper.content, '#thm:torelli'),
        'Lattice preliminaries'
      )
    ])
  })

  it('extracts the another-project definitions with exact ranges', function () {
    const fixture = loadFixture(path.join('ProjectB', 'Other_Paper.md'))
    const snapshot = extractReferences(fixture.documentPath, fixture.content)

    assert.deepStrictEqual(snapshot.definitions, [
      definition(
        fixture, 'def:lattice', 'theorem-div', [ 'definition' ], undefined,
        divBlockAt(fixture.content, '#def:lattice'),
        'Lattice preliminaries'
      ),
      definition(
        fixture, 'thm:torelli', 'theorem-div', [ 'theorem' ],
        'Torelli for rational elliptic surfaces',
        divBlockAt(fixture.content, '#thm:torelli'),
        'Lattice preliminaries'
      )
    ])
  })

  it('extracts the standalone document snapshot completely', function () {
    const fixture = loadFixture('Standalone_Notes.md')
    const snapshot = extractReferences(fixture.documentPath, fixture.content)

    assert.deepStrictEqual(snapshot.definitions, [
      definition(
        fixture, 'rmk:standalone-note', 'theorem-div', [ 'remark' ], undefined,
        divBlockAt(fixture.content, '#rmk:standalone-note'),
        'Reading notes'
      )
    ])
    assert.deepStrictEqual(snapshot.occurrences, [
      occurrence(fixture, 'thm:torelli', 'bare', '@thm:torelli')
    ])
  })

  it('preserves escaped quotes inside authored title attributes (review C8)', function () {
    // Pandoc's attribute syntax backslash-escapes quotes inside quoted
    // values; the extracted title must carry the literal quotes, not a
    // value truncated at the first escape.
    const doc = '::: {.theorem #thm:quoted title="He said \\"stop\\" twice"}\nBody.\n:::\n'
    const snapshot = extractReferences('crafted-escapes.md', doc)

    assert.strictEqual(snapshot.definitions.length, 1, 'the escaped-quote div must still define its target')
    assert.strictEqual(snapshot.definitions[0].key, 'thm:quoted')
    assert.strictEqual(
      snapshot.definitions[0].title,
      'He said "stop" twice',
      'the authored escaped quotes must survive as literal quotes in the title'
    )
  })

  it('never fabricates definitions from unclosed attribute-block near-misses (review C8)', function () {
    // A heading whose attribute block never closes is structurally not a
    // labeled definition; the citing occurrence still extracts and simply
    // stays unresolved.
    const headingDoc = '## Broken heading {#sec:broken\n\nSee @sec:broken.\n'
    const headingSnapshot = extractReferences('crafted-unclosed-heading.md', headingDoc)
    assert.deepStrictEqual(headingSnapshot.definitions, [], 'an unclosed heading attribute block defines nothing')
    assert.strictEqual(headingSnapshot.occurrences.length, 1, 'the citing occurrence itself must still extract')
    assert.strictEqual(headingSnapshot.occurrences[0].key, 'sec:broken')

    // Same for a fenced div whose opening line never closes its brace.
    const divDoc = '::: {.theorem #thm:unclosed\nBody.\n:::\n'
    const divSnapshot = extractReferences('crafted-unclosed-div.md', divDoc)
    assert.deepStrictEqual(divSnapshot.definitions, [], 'an unclosed div attribute block defines nothing')
  })

  it('computes a deterministic source hash that distinguishes different content', function () {
    const halphen = loadFixture(path.join('ProjectA', 'Halphen_Surfaces.md'))
    const coble = loadFixture(path.join('ProjectA', 'Coble_Lattice_Table.md'))

    const first = extractReferences(halphen.documentPath, halphen.content)
    const second = extractReferences(halphen.documentPath, halphen.content)
    assert.strictEqual(first.sourceHash, second.sourceHash)
    assert.strictEqual(first.sourceHash, hashDocumentSource(halphen.content))
    assert.strictEqual(first.documentPath, halphen.documentPath)

    const other = extractReferences(coble.documentPath, coble.content)
    assert.notStrictEqual(first.sourceHash, other.sourceHash)
  })
})
