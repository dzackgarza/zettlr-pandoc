/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Pre-boot lifecycle tests
 * CVM-Role:        Test
 * Maintainer:     D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Proves that an early quit does not require a booted service
 *                  container.
 *
 * END HEADER
 */

// biome-ignore-all assist/source/organizeImports: the harness installs the
// electron stand-in at module scope, so it has to load before any module
// that imports electron itself. Sorting these imports breaks the specs.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { shutdownApplication } from "source/app/lifecycle";

describe("application lifecycle", function () {
  it("allows shutdown before the service container boots", async function () {
    await assert.doesNotReject(shutdownApplication());
  });
});
