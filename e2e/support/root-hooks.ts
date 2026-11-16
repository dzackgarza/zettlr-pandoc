/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: the hooks of each spec file of the assembled-app suite
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: The lanes runner loads this file before each spec file
 *              (`--file`, `run-lanes.ts`). Its hooks are hooks of the root
 *              suite, so they hold for each test of the file and need no
 *              line in a spec.
 *
 *              A failed test gets a screenshot of each open window, which
 *              the artifacts of the file keep; a file that keeps no
 *              artifacts itself gets a directory for them. A file fails when a window
 *              of an app that it started reported an error that no test
 *              of the file provokes: a console error, an uncaught
 *              exception or a dialog. A spec of a failure declares what it
 *              provokes with `provokesRendererEvents`.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import {
  captureFailedTest,
  preserveUnwrittenFailures,
  unprovokedRendererEventsOfFile,
} from "./electron-app";

/** The spec file of the tests that ran; mocha gives each test its file. */
let specFile: string | undefined;

afterEach(async function () {
  const test = this.currentTest;
  if (test === undefined) {
    return;
  }
  if (test.file !== undefined) {
    specFile = test.file;
  }
  if (test.state === "failed") {
    await captureFailedTest(test.fullTitle());
  }
});

after(async function () {
  if (specFile !== undefined) {
    await preserveUnwrittenFailures(specFile);
  }
  assert.deepEqual(
    unprovokedRendererEventsOfFile(),
    [],
    "a window of the app reported an error that no test of this file provokes",
  );
});
