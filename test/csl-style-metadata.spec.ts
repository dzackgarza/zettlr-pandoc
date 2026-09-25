import { strict as assert } from 'assert'
import { parseCslStyleMetadata, supportsNarrativeComposite } from 'source/app/service-providers/citeproc/util/style-metadata'

describe('CSL style citation-format metadata', function () {
  it('reads label and author-date categories structurally', function () {
    assert.deepEqual(
      parseCslStyleMetadata('<style><info><category field="math"/><category citation-format="label"/></info></style>'),
      { citationFormat: 'label' }
    )
    assert.deepEqual(
      parseCslStyleMetadata('<style><info><category citation-format="author-date"/></info></style>'),
      { citationFormat: 'author-date' }
    )
  })

  it('rejects conflicting and unknown declared formats', function () {
    assert.throws(
      () => parseCslStyleMetadata('<style><info><category citation-format="label"/><category citation-format="numeric"/></info></style>'),
      /conflicting citation-format/
    )
    assert.throws(
      () => parseCslStyleMetadata('<style><info><category citation-format="mystery"/></info></style>'),
      /unsupported citation-format/
    )
  })

  it('only requests author-in-text composite mode for narrative-capable formats', function () {
    assert.equal(supportsNarrativeComposite('author'), true)
    assert.equal(supportsNarrativeComposite('author-date'), true)
    assert.equal(supportsNarrativeComposite('label'), false)
    assert.equal(supportsNarrativeComposite('numeric'), false)
    assert.equal(supportsNarrativeComposite('note'), false)
    assert.equal(supportsNarrativeComposite(undefined), true)
  })
})
