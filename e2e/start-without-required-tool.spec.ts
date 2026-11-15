/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: a start of the assembled app without a required tool or file
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: The app does not start without the tools and the files of its
 *              export pipeline (AGENTS.md §5). The spec starts the packaged
 *              app two times: with a PATH that has each required command but
 *              `biber`, and with a home folder whose `.pandoc` has no
 *              justfile. Each start stops at a native error box, names what
 *              is missing in its output, opens no window of the app, and
 *              ends with exit code 1 when the author answers the box (#47).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { REQUIRED_COMMANDS } from "source/app/util/preflight";
import {
  createFixture,
  delay,
  type Fixture,
  launchElectron,
  preserveArtifacts,
  requireInitialized,
  terminateProcess,
} from "./support/electron-app";
import { captureWindow, pressKey, searchWindows } from "./support/native-dialog";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-start-without-required-tool-e2e-latest");
// On Linux, Electron gives the window of each `dialog.showErrorBox` the title
// "Error"; the title argument of the call is the heading inside the box.
const ERROR_BOX_TITLE = "Error";
const ABSENT_COMMAND = "biber";

/** The file of a command on the PATH of this run. */
async function commandOnPath(command: string): Promise<string> {
  const searchPath = process.env.PATH;
  if (searchPath === undefined) {
    throw new Error("The run has no PATH");
  }
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === "") {
      continue;
    }
    const candidate = path.join(directory, command);
    const executable = await access(candidate, constants.X_OK).then(
      () => true,
      () => false,
    );
    if (executable) {
      return candidate;
    }
  }
  throw new Error(`The run has no ${command} on its PATH`);
}

interface Start {
  appProcess: ChildProcess;
  output: () => string;
}

describe("assembled app: a start without a required tool or file (#47)", function () {
  let fixture: Fixture | undefined;
  let appProcess: ChildProcess | undefined;
  /** The output of each start of the spec, for the artifacts. */
  const outputs: string[] = [];
  const screenshots = new Map<string, Buffer>();

  async function start(environment: NodeJS.ProcessEnv): Promise<Start> {
    const created = requireInitialized(fixture, "the fixture exists");
    const started = await launchElectron(created.configDirectory, { environment });
    appProcess = started;
    let output = "";
    const index = outputs.length;
    outputs.push("");
    const appendOutput = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-200_000);
      outputs[index] = output;
    };
    started.stdout?.on("data", appendOutput);
    started.stderr?.on("data", appendOutput);
    return { appProcess: started, output: () => output };
  }

  /**
   * Answers the error box and gives the exit code of the app. A start that
   * ends before it shows a box fails here with its exit code and its output.
   */
  async function answerBoxAndExit(started: Start, screenshot: string): Promise<number | null> {
    let ended: { code: number | null } | undefined;
    const exited = new Promise<number | null>((resolve) => {
      started.appProcess.once("exit", (code) => {
        ended = { code };
        resolve(code);
      });
    });
    const deadline = Date.now() + 60_000;
    let boxes: string[] = [];
    while (boxes.length === 0 && ended === undefined && Date.now() < deadline) {
      boxes = await searchWindows(["--name", `^${ERROR_BOX_TITLE}$`]);
      if (boxes.length === 0) {
        await delay(250);
      }
    }
    const state = ended === undefined ? "the app still runs" : `the app ended with ${ended.code}`;
    assert.equal(
      boxes.length,
      1,
      `the start shows one error box (${state}); its output:\n${started.output()}`,
    );
    const [box] = boxes;
    screenshots.set(screenshot, await captureWindow(box));
    assert.deepEqual(
      await searchWindows(["--name", "Zettlr"]),
      [],
      "no window of the app is on the screen while the box shows",
    );
    await pressKey(box, "Return");
    return await exited;
  }

  beforeEach(async function () {
    fixture = await createFixture("zettlr-start-without-required-tool-e2e-", {
      documentName: "note.md",
      documentContents: "# Note\n",
    });
  });

  afterEach(async function () {
    await terminateProcess(appProcess);
    appProcess = undefined;
    if (fixture !== undefined) {
      await rm(fixture.root, { recursive: true, force: true });
      fixture = undefined;
    }
  });

  after(async function () {
    await preserveArtifacts(
      ARTIFACT_DIRECTORY,
      undefined,
      outputs.map((output, start) => `== start ${start + 1}\n${output}`).join("\n"),
      [],
      screenshots,
    );
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
  });

  it(`names ${ABSENT_COMMAND} and ends with exit code 1 when the PATH has each other required command`, async function () {
    const created = requireInitialized(fixture, "the fixture exists");
    const bin = path.join(created.root, "bin");
    await mkdir(bin);
    for (const { command } of REQUIRED_COMMANDS) {
      if (command !== ABSENT_COMMAND) {
        await symlink(await commandOnPath(command), path.join(bin, command));
      }
    }

    const started = await start({ PATH: bin });
    const code = await answerBoxAndExit(started, "missing-command.png");

    const output = started.output();
    assert.match(output, /Preflight FAILED/);
    const missing = output.split("\n").filter((line) => line.trimStart().startsWith("•"));
    assert.equal(missing.length, 1, `one requirement is missing:\n${output}`);
    assert.ok(
      missing[0].includes(ABSENT_COMMAND) &&
        missing[0].includes("(needed for PDF bibliography generation)"),
      `the missing requirement is ${ABSENT_COMMAND}: ${missing[0]}`,
    );
    assert.equal(code, 1);
  });

  it("names the justfile of ~/.pandoc and ends with exit code 1 when the home folder has none", async function () {
    const created = requireInitialized(fixture, "the fixture exists");
    const home = path.join(created.root, "home");
    const pandocDirectory = path.join(home, ".pandoc");
    await mkdir(pandocDirectory, { recursive: true });
    const installed = path.join(homedir(), ".pandoc");
    for (const entry of await readdir(installed)) {
      if (entry !== "justfile") {
        await symlink(path.join(installed, entry), path.join(pandocDirectory, entry));
      }
    }

    const started = await start({ HOME: home });
    const code = await answerBoxAndExit(started, "missing-justfile.png");

    const output = started.output();
    assert.match(output, /Preflight FAILED/);
    const missing = output.split("\n").filter((line) => line.trimStart().startsWith("•"));
    assert.deepEqual(
      missing.map((line) => line.trim()),
      [`• ${path.join(pandocDirectory, "justfile")} — missing (PDF export)`],
      `one requirement is missing:\n${output}`,
    );
    assert.equal(code, 1);
  });
});
