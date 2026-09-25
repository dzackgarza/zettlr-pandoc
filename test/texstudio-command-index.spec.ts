import { strict as assert } from 'node:assert'
import type { TexstudioCommandIndex } from 'source/common/util/texstudio-command-index'
import { closeTexstudioPackages } from 'source/common/util/texstudio-command-index'
import indexJson from 'source/common/data/texstudio-command-index.json'

const index = indexJson as TexstudioCommandIndex

describe('TeXstudio command index', function () {
  it('is pinned to the surveyed TeXstudio CWL corpus', function () {
    assert.equal(index.source.commit, '263f2615005cdbe5c24d4ee9a7c5746f731e25ac')
    assert.equal(index.source.cwlFiles, 4526)
    assert.deepEqual(index.b, [ 'tex', 'latex-document', 'latex-dev' ])
  })

  it('closes mathtools through amsmath to amsopn', function () {
    const active = closeTexstudioPackages(index, [ 'mathtools' ])
    assert.ok(active.has('mathtools'))
    assert.ok(active.has('amsmath'))
    assert.ok(active.has('amsopn'))
  })
})
