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

import { strict as assert } from "assert";
import "./headless-electron-harness.cjs";
import { shutdownApplication } from "source/app/lifecycle";

describe("application lifecycle", function () {
  it("allows shutdown before the service container boots", async function () {
    await assert.doesNotReject(shutdownApplication());
  });
});
