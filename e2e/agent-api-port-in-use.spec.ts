/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Agent API port in use E2E (#215)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Starts the assembled app with an Agent API port that
 *                  another process holds. The Agent API cannot listen, and
 *                  the app shows a native error box and stops. The box
 *                  stops the main process until the author answers it, so
 *                  the log must name the cause before the box shows: while
 *                  the box is on the screen, the app log names EADDRINUSE
 *                  and the port.
 *
 *                  An app in that state does not finish its start. An attach
 *                  to it fails at its time limit and stops each process of
 *                  the app, so a failed start leaves no app behind (#57).
 *
 *                  The box is a native message box, not a page: the spec
 *                  finds and answers it with xdotool on the X display of the
 *                  run.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  attach,
  createFixture,
  type Fixture,
  launchElectron,
  preserveArtifacts,
  readAppLog,
  requireInitialized,
  startDeadline,
  stopProcess,
} from "./support/electron-app";
import { captureWindow, nativeDialog, pressKey } from "./support/native-dialog";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-agent-api-port-in-use-e2e-latest");
// On Linux, Electron gives the window of each `dialog.showErrorBox` the title
// "Error"; the title argument of the call is the heading inside the box.
const ERROR_BOX_TITLE = "Error";

/** The ids of the processes whose command line names `text`. */
async function processesNaming(text: string): Promise<number[]> {
  const pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  const named: number[] = [];
  for (const pid of pids) {
    // A process can end between the listing and the read of its command line.
    const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ESRCH") {
          return "";
        }
        throw error;
      },
    );
    if (commandLine.includes(text)) {
      named.push(Number(pid));
    }
  }
  return named;
}

describe("assembled app: an Agent API port that another process holds (#215)", function () {
  let holder: Server | undefined;
  let fixture: Fixture | undefined;
  let attachFixture: Fixture | undefined;
  let appProcess: ChildProcess | undefined;
  let output = "";
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    holder = createServer();
    holder.listen(0, "127.0.0.1");
    await once(holder, "listening");
  });

  after(async function () {
    await stopProcess(appProcess);
    await preserveArtifacts(ARTIFACT_DIRECTORY, fixture?.root, output, [], screenshots);
    for (const created of [fixture, attachFixture]) {
      if (created !== undefined) {
        await rm(created.root, { recursive: true, force: true });
      }
    }
    if (holder !== undefined) {
      holder.close();
      await once(holder, "close");
    }
  });

  it("names the refused port in the log before the error box shows", async function () {
    const address = requireInitialized(holder, "the holder listens").address();
    assert.ok(address !== null && typeof address === "object", "the holder has a port");
    const port = address.port;

    fixture = await createFixture("zettlr-agent-api-port-in-use-e2e-", {
      documentName: "note.md",
      documentContents: "# Note\n",
      config: { agentApi: { enabled: true, port } },
    });
    appProcess = await launchElectron(fixture.configDirectory);
    const appendOutput = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-200_000);
    };
    appProcess.stdout?.on("data", appendOutput);
    appProcess.stderr?.on("data", appendOutput);

    const box = await nativeDialog(ERROR_BOX_TITLE, 150_000);
    screenshots.set("error-box.png", await captureWindow(box));

    const refusal = (await readAppLog(fixture.root))
      .split("\n")
      .filter((line) => line.includes("EADDRINUSE") && line.includes(`127.0.0.1:${port}`));
    assert.notEqual(
      refusal.length,
      0,
      `while the box shows, the app log names EADDRINUSE and 127.0.0.1:${port}`,
    );

    await pressKey(box, "Return");
  });

  it("stops each process of the app when an attach fails (#57)", async function () {
    // The attach waits its whole time limit for a start that does not end,
    // and then stops the process group of the app.
    this.timeout(startDeadline({}) + 60_000);
    const address = requireInitialized(holder, "the holder listens").address();
    assert.ok(address !== null && typeof address === "object", "the holder has a port");

    attachFixture = await createFixture("zettlr-agent-api-attach-failure-e2e-", {
      documentName: "note.md",
      documentContents: "# Note\n",
      config: { agentApi: { enabled: true, port: address.port } },
    });
    await assert.rejects(attach(attachFixture.configDirectory, []), Error);
    assert.deepEqual(
      await processesNaming(attachFixture.configDirectory),
      [],
      "no process of the app is left after the failed attach",
    );
  });
});
