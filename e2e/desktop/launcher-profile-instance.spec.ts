/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The boot script decides by the profile of the start (#57)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     zettlr-pandoc-boot skips the MathJax macro refresh, the
 *                  rebuild and the debug port when the app of its start
 *                  already runs: the start then only delivers its arguments.
 *                  The app of a start is the one of its profile (the userData
 *                  folder, or --data-dir). An app of another profile has the
 *                  same window class, and a start of the default profile is
 *                  not delivered to it. The spec starts the packaged app on a
 *                  profile of its own on the live Hyprland session and runs
 *                  the boot script in a $HOME without the MathJax generator
 *                  and without ~/.envrc: a start that refreshes stops at the
 *                  generator, a start that delivers stops at ~/.envrc. Both
 *                  stops come before a launch.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_API_ENVIRONMENT,
  createFixture,
  currentPackagedBinary,
  delay,
  REPO_ROOT,
  startDeadline,
  stopProcess,
} from "../support/electron-app";

const BOOT_SCRIPT = path.join(REPO_ROOT, "scripts", "desktop", "zettlr-pandoc-boot");
const GENERATOR_ABSENT = "MathJax macro generator is unavailable";
const ENVIRONMENT_ABSENT = "The environment file is unavailable";

/** The pids of the windows of the app class on the live Hyprland session. */
function zettlrWindowPids(): number[] {
  const clients: unknown = JSON.parse(
    execFileSync("hyprctl", ["clients", "-j"], { encoding: "utf8" }),
  );
  assert.ok(Array.isArray(clients), "hyprctl clients -j gives an array");
  return clients.flatMap((client: { class: string; pid: number }) =>
    client.class === "zettlr-pandoc" ? [client.pid] : [],
  );
}

describe("the boot script decides by the profile of the start (#57)", function () {
  this.timeout(startDeadline({}) + 60_000);
  let testHome = "";
  let fixtureRoot = "";
  let profile = "";
  let app: ChildProcess | undefined;

  /**
   * Runs the boot script in the test $HOME, and answers what it wrote: the
   * reason of a stop goes to the terminal, the steps go to its log.
   */
  async function boot(args: string[]): Promise<string> {
    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: testHome };
    delete environment.XDG_CONFIG_HOME;
    delete environment.XDG_CACHE_HOME;
    const run = spawnSync(BOOT_SCRIPT, args, {
      env: environment,
      input: "",
      encoding: "utf8",
      timeout: 60_000,
    });
    const log = await readFile(path.join(testHome, ".cache", "zettlr-pandoc-dev.log"), "utf8");
    const written = `${run.stdout}${run.stderr}\n${log}`;
    assert.equal(run.status, 1, `the boot script stops before a launch:\n${written}`);
    return written;
  }

  before(async function () {
    zettlrWindowPids();
    const binary = currentPackagedBinary();
    testHome = await mkdtemp(path.join(tmpdir(), "zettlr-boot-profile-home-"));
    const fixture = await createFixture("zettlr-boot-profile-", {
      documentName: "profile.md",
      documentContents: "# Profile\n",
    });
    fixtureRoot = fixture.root;
    profile = fixture.configDirectory;
    app = spawn(
      binary,
      [`--data-dir=${profile}`, "--ozone-platform=wayland", "--disable-hardware-acceleration"],
      {
        detached: true,
        env: { ...process.env, ...AGENT_API_ENVIRONMENT },
        stdio: "ignore",
      },
    );
    const pid = app.pid;
    assert.ok(pid !== undefined, "the app of the other profile started");
    const deadline = Date.now() + startDeadline({});
    while (!zettlrWindowPids().includes(pid)) {
      assert.ok(Date.now() < deadline, "the app of the other profile shows its window");
      await delay(250);
    }
  });

  after(async function () {
    await stopProcess(app);
    await rm(testHome, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("refreshes the macros while only an app of another profile runs", async function () {
    const output = await boot([]);
    assert.ok(
      output.includes(GENERATOR_ABSENT),
      `the start of the default profile refreshes:\n${output}`,
    );
  });

  it("delivers while the app of the profile of the start runs", async function () {
    const output = await boot([`--data-dir=${profile}`]);
    assert.ok(!output.includes(GENERATOR_ABSENT), `a delivery does not refresh:\n${output}`);
    assert.ok(output.includes(ENVIRONMENT_ABSENT), `the start goes on to the delivery:\n${output}`);
  });
});
