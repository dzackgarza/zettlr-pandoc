/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Update check against a server that does not answer
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An update check whose server does not answer within the
 *                  time limit is a timed-out check: the provider reports
 *                  `ETIMEDOUT`, and the HTTP client leaves no rejection and
 *                  no exception that no code handles. The check runs under
 *                  the Node of Electron, whose TLS sockets end a request
 *                  that is destroyed with an error of their own.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { electronBinary } from "../e2e/support/electron-app";
import type { CheckTimeoutReport } from "./updater-check-timeout-entry";

describe("An update check whose server does not answer", function () {
  // The check has a time limit of 5 s for each of its requests.
  this.timeout(90_000);

  it("is a timed-out check and leaves no unhandled failure", async function () {
    const { stdout } = await promisify(execFile)(
      electronBinary(),
      ["--import", "tsx", "--import", "./test/setup.js", "test/updater-check-timeout-entry.ts"],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    );
    const lastLine = stdout.trimEnd().split("\n").at(-1);
    assert.ok(lastLine !== undefined, "the program prints its report");
    const report: CheckTimeoutReport = JSON.parse(lastLine);

    assert.deepEqual(report, {
      lastErrorCode: "ETIMEDOUT",
      lastErrorMessage: "Could not check for updates: The connection attempt timed out.",
      unhandledRejections: [],
      uncaughtExceptions: [],
    });
  });
});
