/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ shared-config authority proof
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Locks CI provisioning to the shared pandoc-config source of
 *                  truth instead of a per-project commit pin. The app has no
 *                  production TikZ-filter fallback, so CI must exercise the
 *                  same floating shared configuration users run.
 *
 * END HEADER
 */

import { strict as assert } from 'assert'
import { readFileSync } from 'fs'
import path from 'path'

describe('TikZ shared Pandoc-config authority', function () {
  it('provisions current pandoc-config in CI without a per-project commit pin', function () {
    const setupScript = readFileSync(path.join(process.cwd(), 'scripts/setup-ci-toolchain.sh'), 'utf8')
    assert.match(
      setupScript,
      /git clone --depth 1 https:\/\/github\.com\/dzackgarza\/pandoc-config\.git "\$\{pandoc_config_dir\}"/,
      'CI must fetch the shared pandoc-config source directly'
    )
    assert.doesNotMatch(setupScript, /pandoc_config_commit|checkout --detach/,
      'CI must not recreate a stale project-specific filter pin')
  })
})
