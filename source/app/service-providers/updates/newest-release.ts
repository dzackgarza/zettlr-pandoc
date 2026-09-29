/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        newestRelease
 * CVM-Role:        Utility function
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Picks the release the updater offers from the fork's
 *                  GitHub release list (GET /repos/{owner}/{repo}/releases).
 *
 * END HEADER
 */

import semver from 'semver'
import type { ServerAPIResponse } from '.'

/**
 * The highest-versioned release in the list, or undefined when the fork has
 * published none. Prereleases count only when the user accepts betas. A tag
 * that is not a version is an error, not a release to skip.
 */
export function newestRelease (releases: ServerAPIResponse[], acceptBeta: boolean): ServerAPIResponse|undefined {
  const candidates = releases.filter(release => acceptBeta || !release.prerelease)
  let newest: { release: ServerAPIResponse, version: semver.SemVer }|undefined
  for (const release of candidates) {
    const version = semver.parse(release.tag_name)
    if (version === null) {
      throw new Error(`Release tag ${release.tag_name} is not a semantic version`)
    }
    if (newest === undefined || semver.gt(version, newest.version)) {
      newest = { release, version }
    }
  }
  return newest?.release
}
