/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        A start in the notification area (e2e)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     `--launch-minimized` starts the session in the
 *                  notification area: no main window opens. The option is
 *                  a choice for one start; the saved setting
 *                  `system.leaveAppRunning` is the choice of the author and
 *                  stays as the author set it (#204). A second start shows
 *                  the window of the session, and the spec quits through
 *                  the menu: a close of the window leaves the session in
 *                  the notification area.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  AGENT_API_ENVIRONMENT,
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  REPO_ROOT,
  type RunningApp,
  requestQuit,
  requireInitialized,
  stopProcess,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-launch-minimized-e2e-latest");
const ELECTRON = path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron");

/**
 * Starts the application a second time on the same profile. The start gives
 * its request to the running session (`acquireLaunch`) and exits.
 */
async function startAgain(configDirectory: string): Promise<string> {
  const { stdout } = await promisify(execFile)(
    ELECTRON,
    [
      REPO_ROOT,
      `--data-dir=${configDirectory}`,
      "--open-in-running-instance",
      "--disable-hardware-acceleration",
      "--ozone-platform=x11",
    ],
    { env: { ...process.env, NODE_ENV: "develop", ZETTLR_E2E: "1", ...AGENT_API_ENVIRONMENT } },
  );
  return stdout;
}

describe("assembled app: a start in the notification area", function () {
  let app: RunningApp | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory: string | undefined;
  let output = "";
  const rendererEvents: string[] = [];

  before(async function () {
    const fixture = await createFixture("zettlr-launch-minimized-e2e-", {
      documentName: "lattices.md",
      documentContents: "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n",
      config: { system: { checkForUpdates: false, leaveAppRunning: false } },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
  });

  after(async function () {
    // A case that failed leaves the session running; stop it. A first case
    // that did not attach has no session and no output.
    if (app !== undefined) {
      await stopProcess(app.appProcess);
      await app.browser.close();
      output = app.getOutput();
    }
    await preserveArtifacts(ARTIFACT_DIRECTORY, fixtureRoot, output, rendererEvents, new Map());
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(output);
  });

  it("starts without a window", async function () {
    app = await attach(
      requireInitialized(configDirectory, "config directory"),
      rendererEvents,
      this.timeout(),
      { flags: ["--launch-minimized"] },
    );
    const mainWindows = app.browser
      .contexts()
      .flatMap((context) => context.pages())
      .filter((page) => page.url().includes("/main_window/"));
    assert.deepEqual(
      mainWindows.map((page) => page.url()),
      [],
      "the session starts in the notification area",
    );
  });

  it("shows the window of the session at a second start", async function () {
    const running = requireInitialized(app, "the session of the first case");
    assert.match(
      await startAgain(requireInitialized(configDirectory, "config directory")),
      /\[Application\] Launch complete\./,
    );
    const page = await findEditorPage(running.browser, 30_000);
    await requestQuit(page);
    await stopProcess(running.appProcess);
  });

  it("leaves the saved setting as the author set it", async function () {
    // The session has quit, or the case before it failed and the session
    // still runs; the setting on disk is the same in both states.
    const saved = JSON.parse(
      await readFile(
        path.join(requireInitialized(configDirectory, "config directory"), "config.json"),
        "utf8",
      ),
    ) as { system: { leaveAppRunning: boolean } };
    assert.equal(
      saved.system.leaveAppRunning,
      false,
      "the option of one start does not change the saved setting",
    );
  });
});
