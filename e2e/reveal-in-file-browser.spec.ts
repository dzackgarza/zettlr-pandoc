/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        "Reveal in File Browser" E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     "Reveal in File Browser" of a file row, of a folder row
 *                  and of a tab, and "Open file browser here", are one
 *                  action (#202): the desktop opens the folder of a file, or
 *                  the folder itself, with the application of its type, and
 *                  a folder that the desktop does not open gives one message
 *                  that names the folder.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const REVEAL = "Reveal in File Browser";

/** The time in which a second message of one click appears. */
const SECOND_MESSAGE_MS = 2_000;

describe("Reveal in File Browser (#202)", function () {
  let browser: Browser | undefined;
  let appProcess: ChildProcess | undefined;
  let getOutput: () => string = () => "";
  let page: Page | undefined;
  let workspace = "";
  let lattices = "";
  let genus = "";
  let opened = "";
  let refuse = "";

  before(async function () {
    const fixture = await createFixture("zettlr-reveal-", {
      documentName: "genus.md",
      documentContents: "# Genus\n\nTwo lattices in one genus.\n",
    });
    genus = fixture.documentPath;
    workspace = path.dirname(genus);
    lattices = path.join(workspace, "lattices");
    await mkdir(lattices);
    await writeFile(path.join(lattices, "form.md"), "# Form\n");

    // The desktop of the run: `xdg-open` writes the path it gets to a file,
    // and stops with an error while the refuse file exists.
    const bin = path.join(fixture.root, "bin");
    await mkdir(bin);
    opened = path.join(fixture.root, "opened.txt");
    refuse = path.join(fixture.root, "refuse");
    const xdgOpen = path.join(bin, "xdg-open");
    await writeFile(
      xdgOpen,
      [
        "#!/bin/sh",
        `if [ -e '${refuse}' ]; then echo "no application opens $1" >&2; exit 4; fi`,
        `printf '%s\\n' "$1" >> '${opened}'`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(xdgOpen, 0o755);
    await writeFile(opened, "");

    ({ browser, appProcess, getOutput } = await attach(fixture.configDirectory, [], {
      environment: { PATH: `${bin}:${process.env.PATH}` },
    }));
    page = await findEditorPage(browser, this.timeout());
  });

  after(async function () {
    await shutdown(browser, appProcess);
    assertCleanExit(getOutput());
  });

  /** The paths that the desktop opened, once it opened `count` paths or after ten seconds. */
  async function openedPaths(count: number): Promise<string[]> {
    const deadline = Date.now() + 10_000;
    let paths = (await readFile(opened, "utf8")).split("\n").filter((line) => line !== "");
    while (paths.length < count && Date.now() < deadline) {
      await delay(100);
      paths = (await readFile(opened, "utf8")).split("\n").filter((line) => line !== "");
    }
    return paths;
  }

  async function revealFromRow(rowPath: string): Promise<void> {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await activePage
      .locator(`#file-tree [data-path=${JSON.stringify(rowPath)}]`)
      .first()
      .click({ button: "right" });
    await activePage.locator(".application-menu .menu-item", { hasText: REVEAL }).click();
  }

  async function revealFromTab(): Promise<void> {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    const tab = activePage.locator(`[role="tab"][data-path=${JSON.stringify(genus)}]`);
    if ((await tab.count()) === 0) {
      await activePage
        .locator(`#file-tree [data-path=${JSON.stringify(genus)}]`)
        .first()
        .click();
    }
    await tab.click({ button: "right" });
    await activePage.locator(".application-menu .menu-item", { hasText: REVEAL }).click();
  }

  it("opens the folder of a file, and a folder itself", async function () {
    await revealFromRow(genus);
    await revealFromRow(lattices);
    await revealFromTab();
    assert.deepEqual(await openedPaths(3), [workspace, lattices, workspace]);
  });

  it("names the folder that the desktop does not open, in one message", async function () {
    const activePage = requireInitialized(page, "The editor page must be initialized");
    await writeFile(refuse, "");
    for (const [reveal, folder] of [
      [() => revealFromRow(lattices), lattices],
      [() => revealFromRow(genus), workspace],
      [revealFromTab, workspace],
    ] as const) {
      await reveal();
      const toast = activePage.locator(ERROR_TOAST);
      const deadline = Date.now() + 10_000;
      while ((await toast.count()) === 0 && Date.now() < deadline) {
        await delay(100);
      }
      await delay(SECOND_MESSAGE_MS);
      assert.equal(await toast.count(), 1, `one message for the refused open of ${folder}`);
      const text = await toast.first().innerText();
      assert.ok(text.includes(folder), `the message names ${folder}:\n${text}`);
      await toast.first().locator('button[aria-label="Dismiss"]').click();
      await toast.first().waitFor({ state: "detached", timeout: 10_000 });
    }
  });
});
