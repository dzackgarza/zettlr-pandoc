/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tests of the Project export
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A Project export runs each profile of the Project. The
 *                  author gets the success message only when each profile
 *                  exported, and one message that names each profile that
 *                  did not. These tests run the real export over the real
 *                  FSAL, with export commands that are real processes.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import AssetsProvider from "source/app/service-providers/assets";
import {
  exportProject,
  type ProjectExportServices,
} from "source/app/service-providers/commands/dir-project-export";
import ConfigProvider from "source/app/service-providers/config";
import type FSAL from "source/app/service-providers/fsal";
import LogProvider from "source/app/service-providers/log";
import LongRunningTaskProvider from "source/app/service-providers/long-running-tasks";
import { WikilinkIndex } from "source/common/util/wikilink-resolution";
import { bootFsal } from "./fsal-seam";
import { notifications, userData } from "./headless-electron-harness.cjs";

const CHAPTER = "# Genus\n\nTwo forms of one genus.\n";

/** What the first failing command writes to its error output. */
const NO_ENGINE = "the engine of the first command is absent";

/** What the second failing command writes to its error output. */
const NO_TEMPLATE = "the template of the second command is absent";

/** An error window that the command opened. */
interface ErrorWindow {
  title: string;
  message: string;
  contents: string | undefined;
}

describe("Project export", function () {
  let root: string;
  let scripts: string;
  let fsal: FSAL;
  let assets: AssetsProvider;
  let services: ProjectExportServices;
  const errorWindows: ErrorWindow[] = [];

  /** An export command of the configuration: a script of this spec. */
  async function exportCommand(name: string, body: string): Promise<string> {
    const script = path.join(scripts, name);
    await writeFile(script, `#!/bin/sh\n${body}\n`);
    await chmod(script, 0o755);
    return script;
  }

  /** A Project folder with one chapter and the given export commands. */
  async function project(name: string, profiles: string[]): Promise<string> {
    const directory = path.join(root, name);
    await mkdir(directory);
    await writeFile(path.join(directory, "chapter.md"), CHAPTER);
    await writeFile(
      path.join(directory, ".ztr-directory"),
      JSON.stringify({
        sorting: "name-up",
        project: {
          title: name,
          profiles,
          files: ["chapter.md"],
          cslStyle: "",
          templates: { tex: "", html: "" },
        },
        icon: null,
        color: null,
      }),
    );
    return directory;
  }

  let oneFailed: string;
  let twoFailed: string;
  let allExported: string;

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-project-export-"));
    scripts = await mkdtemp(path.join(tmpdir(), "zettlr-project-export-commands-"));

    const noEngine = await exportCommand("no-engine.sh", `echo "${NO_ENGINE}" >&2\nexit 3`);
    const noTemplate = await exportCommand("no-template.sh", `echo "${NO_TEMPLATE}" >&2\nexit 4`);
    // The command gets the Project folder as its argument.
    const listing = await exportCommand("listing.sh", 'ls "$1" > "$1/listing.txt"');

    oneFailed = await project("one-failed", [noEngine, listing]);
    twoFailed = await project("two-failed", [noEngine, noTemplate]);
    allExported = await project("all-exported", [listing]);

    // The export profiles of the author: this Project uses commands only.
    await mkdir(path.join(userData, "defaults"), { recursive: true });

    const log = new LogProvider();
    const config = new ConfigProvider(log, [path.resolve("static", "lang")]);
    config.set("export.customCommands", [
      { displayName: "First command", command: noEngine },
      { displayName: "Second command", command: noTemplate },
      { displayName: "Listing", command: listing },
    ]);
    assets = new AssetsProvider(log, config);
    fsal = await bootFsal(root);

    services = {
      fsal,
      assets,
      config,
      log,
      lrt: new LongRunningTaskProvider(log),
      // No document of these Projects has a wikilink.
      links: { index: new WikilinkIndex([]) },
      windows: {
        showErrorMessage: (title: string, message: string, contents?: string) => {
          errorWindows.push({ title, message, contents });
        },
      },
    };
  });

  beforeEach(function () {
    errorWindows.length = 0;
    notifications.shown.length = 0;
  });

  after(async function () {
    await fsal.shutdown();
    await assets.shutdown();
    await rm(root, { recursive: true });
    await rm(scripts, { recursive: true });
  });

  it("shows the success message when each profile exported", async function () {
    const exported = await exportProject(services, allExported);

    assert.equal(exported, true);
    assert.equal(notifications.shown.length, 1);
    assert.deepEqual(errorWindows, []);
  });

  it("shows no success message when a profile did not export", async function () {
    const exported = await exportProject(services, oneFailed);

    assert.deepEqual(notifications.shown, []);
    assert.equal(exported, false);
  });

  it("runs the other profiles of a Project with a profile that did not export", async function () {
    await exportProject(services, oneFailed);

    assert.match(await readFile(path.join(oneFailed, "listing.txt"), "utf8"), /^chapter\.md$/m);
  });

  it("names each profile that did not export in one message", async function () {
    await exportProject(services, twoFailed);

    assert.equal(errorWindows.length, 1, "one failure of an export opens one error window");
    const [shown] = errorWindows;
    for (const part of ["First command", "Second command", NO_ENGINE, NO_TEMPLATE]) {
      assert.ok(
        `${shown.message}\n${shown.contents}`.includes(part),
        `the message has no "${part}"`,
      );
    }
  });
});
