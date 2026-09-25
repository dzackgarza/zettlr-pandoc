import { strict as assert } from 'assert'
import { readFileSync, statSync } from 'fs'
import path from 'path'
import { STACKS_TIKZ_REFERENCES } from './tikz-stacks-reference'

interface GoldenComparison {
  id: string
  normalizedRatio: number
}

interface GoldenPage {
  tag: string
  comparisons: GoldenComparison[]
}

const FIXTURE_DIR = path.join(process.cwd(), 'test/fixtures/tikz-stacks-reference')

describe('TikZ exact Stacks visual-reference corpus', function () {
  it('pins several real Stacks pages and every recorded diagram to literal xymatrix source', function () {
    assert.deepStrictEqual(STACKS_TIKZ_REFERENCES.map(reference => reference.tag), [ '01JO', '07JW', '067L' ])
    assert.strictEqual(
      STACKS_TIKZ_REFERENCES.reduce((total, reference) => total + reference.diagrams.length, 0),
      5
    )
    for (const reference of STACKS_TIKZ_REFERENCES) {
      assert.match(reference.url, new RegExp(`/tag/${reference.tag}$`))
      for (const diagram of reference.diagrams) {
        assert.ok(diagram.xymatrix.startsWith('\\xymatrix{'))
        assert.match(diagram.tikz, /^\\begin\{tikzcd\}/)
        assert.match(diagram.tikz, /\\end\{tikzcd\}$/)
      }
    }
  })

  it('keeps durable original-page and side-by-side screenshots for every reference', function () {
    for (const reference of STACKS_TIKZ_REFERENCES) {
      const page = path.join(FIXTURE_DIR, `stacks-${reference.tag}-original-page.png`)
      assert.ok(statSync(page).size > 10_000, `${reference.tag} page screenshot is present and nontrivial`)
      for (const diagram of reference.diagrams) {
        const comparison = path.join(FIXTURE_DIR, `compare-stacks-${reference.tag}-${diagram.id}.png`)
        assert.ok(statSync(comparison).size > 10_000, `${reference.tag}/${diagram.id} comparison screenshot is present`)
      }
    }
  })

  it('records Stacks-normalized widths within the accepted visual equivalence band', function () {
    const golden = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'measurements.json'), 'utf8')) as GoldenPage[]
    assert.deepStrictEqual(golden.map(page => page.tag), STACKS_TIKZ_REFERENCES.map(reference => reference.tag))

    for (const reference of STACKS_TIKZ_REFERENCES) {
      const page = golden.find(candidate => candidate.tag === reference.tag)
      assert.ok(page !== undefined, `golden measurements include ${reference.tag}`)
      assert.deepStrictEqual(page.comparisons.map(comparison => comparison.id), reference.diagrams.map(diagram => diagram.id))
      for (const comparison of page.comparisons) {
        assert.ok(
          comparison.normalizedRatio >= 0.92 && comparison.normalizedRatio <= 1.10,
          `${reference.tag}/${comparison.id} stays within 8–10% of the Stacks width/body-em ratio; got ${comparison.normalizedRatio}`
        )
      }
    }
  })
})

