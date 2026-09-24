/**
 * @ignore
 * Contains: E2E reference proof for Quarto theorem cross-references
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'
import { extractReferences } from 'source/common/pandoc-util/extract-references'
import { resolveWorkspace } from 'source/common/pandoc-util/resolve-references'

describe('Quarto theorem cross-reference E2E reference proof', function () {
  // Repo-owned fixtures (never the user's private research documents): a
  // classless Quarto ::: {#def-core} div whose title comes from its child
  // heading, and a separate document that cites @def-core.
  const FIXTURE_ROOT = path.resolve('test', 'fixtures', 'quarto-reference-e2e')
  const DEF_PATH = path.join(FIXTURE_ROOT, 'Definitions.md')
  const OCC_PATH = path.join(FIXTURE_ROOT, 'Consumers.md')

  let defText: string
  let occText: string

  before(function () {
    defText = readFileSync(DEF_PATH, 'utf8')
    occText = readFileSync(OCC_PATH, 'utf8')
  })

  it('extracts classless Quarto ::: {#def-core} as a theorem definition with child heading title', function () {
    const defSnap = extractReferences(DEF_PATH, defText)
    const defCore = defSnap.definitions.find(d => d.key === 'def-core')

    assert.ok(defCore !== undefined, 'def-core definition must be extracted')
    assert.strictEqual(defCore.key, 'def-core')
    assert.strictEqual(defCore.family, 'def')
    assert.strictEqual(defCore.sourceKind, 'theorem-div')
    assert.strictEqual(defCore.title, 'Underlying homotopy type and core')
  })

  it('extracts @def-core occurrence from consuming document', function () {
    const occSnap = extractReferences(OCC_PATH, occText)
    const occCore = occSnap.occurrences.filter(o => o.key === 'def-core')

    assert.ok(occCore.length > 0, '@def-core occurrence must be extracted')
    assert.strictEqual(occCore[0].key, 'def-core')
    assert.strictEqual(occCore[0].family, 'def')
  })

  it('resolves def-core end-to-end across workspace snapshots', function () {
    const defSnap = extractReferences(DEF_PATH, defText)
    const occSnap = extractReferences(OCC_PATH, occText)
    const resolutions = resolveWorkspace([defSnap, occSnap])

    const resolution = resolutions.get('def-core')
    assert.ok(resolution !== undefined, 'Resolution must exist for def-core')
    assert.strictEqual(resolution.status, 'resolved')
    if (resolution.status === 'resolved') {
      assert.strictEqual(resolution.definition.documentPath, DEF_PATH)
      assert.strictEqual(resolution.definition.title, 'Underlying homotopy type and core')
    }
  })


})
