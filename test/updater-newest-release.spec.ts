/**
 * The updater offers the newest release from the fork's GitHub release list.
 */

import { strict as assert } from 'assert'
import type { ServerAPIResponse } from 'source/app/service-providers/updates'
import { newestRelease } from 'source/app/service-providers/updates/newest-release'

function release (tag: string, prerelease: boolean): ServerAPIResponse {
  return {
    id: 1,
    tag_name: tag,
    name: tag,
    prerelease,
    html_url: `https://github.com/dzackgarza/zettlr-pandoc/releases/tag/${tag}`,
    body: '',
    published_at: '2026-09-29T00:00:00Z',
    assets: []
  }
}

describe('Updater release choice', function () {
  it('offers nothing while the fork has published no release', function () {
    assert.equal(newestRelease([], true), undefined)
  })

  it('offers the highest version, not the first listed', function () {
    const releases = [ release('v4.7.1', false), release('v4.8.0', false), release('v4.7.2', false) ]
    assert.equal(newestRelease(releases, false)?.tag_name, 'v4.8.0')
  })

  it('offers a prerelease only to a user who accepts betas', function () {
    const releases = [ release('v4.8.0', false), release('v4.9.0-beta.1', true) ]
    assert.equal(newestRelease(releases, false)?.tag_name, 'v4.8.0')
    assert.equal(newestRelease(releases, true)?.tag_name, 'v4.9.0-beta.1')
    assert.equal(newestRelease([ release('v4.9.0-beta.1', true) ], false), undefined)
  })

  it('refuses a tag that is not a version', function () {
    assert.throws(() => newestRelease([ release('milestone-pandoc-export-usable', false) ], false), /not a semantic version/)
  })
})
