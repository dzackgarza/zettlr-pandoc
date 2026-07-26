/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ provenance pin proof
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks the CI pandoc-config checkout to the same upstream
 *                  commit named by the bundled TikZ fallback provenance, so CI
 *                  provisioning and the app-owned fallback cannot drift apart
 *                  silently.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'

function extractSingleQuotedReadonly (source: string, name: string): string {
  const match = source.match(new RegExp(`^readonly ${name}='([^']+)'$`, 'm'))
  assert.ok(match, `missing readonly ${name} pin`)
  return match[1]
}

function extractTomlString (source: string, name: string): string {
  const match = source.match(new RegExp(`^${name} = "([^"]+)"$`, 'm'))
  assert.ok(match, `missing TOML ${name} pin`)
  return match[1]
}

describe('TikZ fallback provenance', function () {
  it('keeps CI pandoc-config provisioning pinned to the bundled fallback source commit', function () {
    const setupScript = readFileSync(path.join(process.cwd(), 'scripts/setup-ci-toolchain.sh'), 'utf8')
    const provenance = readFileSync(path.join(process.cwd(), 'static/tikz/PROVENANCE.toml'), 'utf8')

    const ciPandocConfigCommit = extractSingleQuotedReadonly(setupScript, 'pandoc_config_commit')
    const bundledFallbackCommit = extractTomlString(provenance, 'source_commit')

    assert.strictEqual(
      ciPandocConfigCommit,
      bundledFallbackCommit,
      'scripts/setup-ci-toolchain.sh and static/tikz/PROVENANCE.toml must name the same pandoc-config commit'
    )
  })
})
