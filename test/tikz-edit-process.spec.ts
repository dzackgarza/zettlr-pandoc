/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ external editor process proofs
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     The app stops each editor that it started, at the end of
 *                  a session and at its own exit. An editor that does not
 *                  end on SIGTERM must not keep the exit of the app waiting:
 *                  after a time limit the app ends the process group of the
 *                  editor (#178).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { TikzEditSessions, VISUAL_TIKZ_EDITOR_COMMAND } from "source/app/util/tikz-edit-session";

// A program that stands for the editor: it ignores SIGTERM, as a process
// whose signal handler does not return does. It writes its process id beside
// the diagram that it was started on, then waits. The `sleep` that it starts
// inherits the ignored signal, so no process of the group ends on SIGTERM.
const EDITOR_THAT_IGNORES_SIGTERM = [
  "#!/bin/sh",
  "trap '' TERM",
  'for diagram in "$@"; do :; done',
  'echo "$$" > "$diagram.pid"',
  "while :; do sleep 1; done",
  "",
].join("\n");

/** More than the time that the app gives an editor to end on SIGTERM. */
const WAIT_MS = 10_000;

describe("TikZ external editor processes", function () {
  this.timeout(30_000);

  let scratch: string;
  let diagram: string;
  let pathBefore: string | undefined;
  let ended: Array<[string, number | null]>;
  let sessions: TikzEditSessions;

  beforeEach(async function () {
    scratch = await mkdtemp(path.join(tmpdir(), "zettlr-tikz-edit-process-"));
    diagram = path.join(scratch, "diagram.tikz");
    await writeFile(diagram, "\\begin{tikzpicture}\n\\draw (0,0) -- (1,0);\n\\end{tikzpicture}\n");
    await writeFile(path.join(scratch, VISUAL_TIKZ_EDITOR_COMMAND), EDITOR_THAT_IGNORES_SIGTERM, {
      mode: 0o755,
    });
    // The app starts the editor by its command name.
    pathBefore = process.env.PATH;
    process.env.PATH = `${scratch}${path.delimiter}${pathBefore ?? ""}`;
    ended = [];
    sessions = new TikzEditSessions({
      source: () => {},
      ended: (id, code) => {
        ended.push([id, code]);
      },
    });
  });

  afterEach(async function () {
    process.env.PATH = pathBefore;
    // The editor leads its process group. An editor that the app left
    // running ends here.
    if (existsSync(`${diagram}.pid`)) {
      spawnSync("kill", ["-KILL", "--", `-${String(await editorProcessId())}`]);
    }
    await rm(scratch, { recursive: true, force: true });
  });

  async function editorProcessId(): Promise<number> {
    const deadline = Date.now() + 10_000;
    while (!existsSync(`${diagram}.pid`) && Date.now() < deadline) {
      await sleep(20);
    }
    return Number((await readFile(`${diagram}.pid`, "utf8")).trim());
  }

  async function startEditor(id: string): Promise<number> {
    const outcome = await sessions.openFile(id, diagram, {
      macrosPath: path.join(scratch, "mathjax-macros.json"),
      resourcesDirectory: "",
    });
    assert.deepEqual(outcome, { outcome: "opened", id });
    return await editorProcessId();
  }

  /** The processes of process group `group`. */
  function processesOfGroup(group: number): string[] {
    const listing = spawnSync("ps", ["-eo", "pgid=,pid=,args="], { encoding: "utf8" });
    return listing.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => Number(line.split(/\s+/u)[0]) === group);
  }

  it("ends an editor that does not end on SIGTERM when the app stops", async function () {
    const editor = await startEditor("square");

    const stopped = await Promise.race([
      sessions.shutdown().then(() => "the editors are gone"),
      sleep(WAIT_MS).then(() => "the app still waits"),
    ]);

    assert.equal(stopped, "the editors are gone");
    assert.deepEqual(processesOfGroup(editor), [], "no process of the editor is left");
  });

  it("ends an editor that does not end on SIGTERM when its session closes", async function () {
    const editor = await startEditor("square");

    sessions.close("square");
    const deadline = Date.now() + WAIT_MS;
    while (ended.length === 0 && Date.now() < deadline) {
      await sleep(50);
    }

    // The exit code of a process that a signal ended is null.
    assert.deepEqual(ended, [["square", null]], "the session ended, and the window was told");
    assert.deepEqual(processesOfGroup(editor), [], "no process of the editor is left");
  });
});
