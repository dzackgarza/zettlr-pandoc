/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains: refused application commands, end to end
 * CVM-Role: Test
 * Maintainer: D. Zack Garza
 * License: GNU GPL v3
 *
 * Description: A command of the application that cannot do its work tells the
 *              author so in the window. The spec sends two commands as the
 *              file manager sends them: a rename in a directory that lost its
 *              write permission, and a move of a document with unsaved
 *              changes. Each is refused, each leaves the file where it was,
 *              and each shows one error in the window that names the file
 *              (#178).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { access, chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-command-refusal-e2e-latest");
const CONTENTS = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const HELD_CONTENTS = "# Genus\n\nA genus holds finitely many isometry classes.\n";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";

/** Sends a rename as the file manager does. Answers whether the command was refused. */
function renameIsRefused(page: Page, target: string, name: string): Promise<boolean> {
  return page.evaluate(
    async (payload) =>
      await window.ipc.invoke("application", { command: "file-rename", payload }).then(
        () => false,
        () => true,
      ),
    { path: target, name },
  );
}

/** Sends a move as the file manager does. Answers whether the command was refused. */
function moveIsRefused(page: Page, from: string, to: string): Promise<boolean> {
  return page.evaluate(
    async (payload) =>
      await window.ipc.invoke("application", { command: "request-move", payload }).then(
        () => false,
        () => true,
      ),
    { from, to },
  );
}

/** The message of each error that the window shows. */
function errorMessages(page: Page): Promise<string[]> {
  return page.locator(`${ERROR_TOAST} span:first-child`).allInnerTexts();
}

async function dismissErrors(page: Page): Promise<void> {
  const dismiss = page.locator(`${ERROR_TOAST} button[aria-label="Dismiss"]`);
  while ((await dismiss.count()) > 0) {
    await dismiss.first().click();
  }
}

describe("an application command that cannot do its work", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let notePath = "";
  let archiveDirectory = "";
  let lockedDirectory = "";
  let heldPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-command-refusal-e2e-", {
      documentName: "note.md",
      documentContents: CONTENTS,
      config: { darkMode: false, editor: { autoSave: "off" } },
    });
    fixtureRoot = fixture.root;
    notePath = fixture.documentPath;
    archiveDirectory = path.join(path.dirname(notePath), "archive");
    lockedDirectory = path.join(path.dirname(notePath), "locked");
    heldPath = path.join(lockedDirectory, "held.md");
    await mkdir(archiveDirectory);
    await mkdir(lockedDirectory);
    await writeFile(heldPath, HELD_CONTENTS, "utf8");
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    await chmod(lockedDirectory, 0o700);
    // A document with unsaved changes stops the shutdown at a native prompt.
    // The save is the IPC call that the save-file shortcut makes: CDP key
    // events do not run the main-process menu accelerators.
    if (page !== undefined) {
      assert.deepEqual(
        await page.evaluate(
          async (pathInPage) =>
            await window.ipc.invoke("documents:save-file", { path: pathInPage }),
          notePath,
        ),
        { ok: true },
      );
      await page
        .locator(`[role="tab"][data-path="${notePath}"]:not(.modified)`)
        .waitFor({ state: "visible", timeout: 20_000 });
    }
    await shutdown(browser, appProcess);
    await preserveArtifacts(
      ARTIFACT_DIRECTORY,
      fixtureRoot,
      getOutput(),
      rendererEvents,
      screenshots,
    );
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    console.log(`E2E artifacts: ${ARTIFACT_DIRECTORY}`);
    assertCleanExit(getOutput());
  });

  it("shows why a file in a read-only directory was not renamed", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await chmod(lockedDirectory, 0o500);
    assert.deepEqual(await errorMessages(editorPage), [], "no error is shown before the rename");

    const refused = await renameIsRefused(editorPage, heldPath, "genus.md");

    assert.equal(refused, true, "the rename reports that it did not happen");
    await editorPage.locator(ERROR_TOAST).first().waitFor({ state: "visible", timeout: 20_000 });
    const messages = await errorMessages(editorPage);
    assert.equal(messages.length, 1, `one error is shown: ${JSON.stringify(messages)}`);
    assert.equal(
      messages[0],
      "Could not rename held.md: permission denied.",
      "the error names the file and the cause, without the call and the paths of the system error",
    );
    assert.deepEqual(
      await readdir(lockedDirectory),
      ["held.md"],
      "the file keeps its name on disk",
    );
    screenshots.set("rename-refused.png", await editorPage.screenshot());

    await chmod(lockedDirectory, 0o700);
    await dismissErrors(editorPage);
  });

  it("shows why a document with unsaved changes was not moved", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    await editorPage.locator(".cm-content").click();
    await editorPage.keyboard.press("Control+End");
    await editorPage.keyboard.type("The rank of the Leech lattice is 24.");
    await editorPage
      .locator(`[role="tab"][data-path="${notePath}"].modified`)
      .waitFor({ state: "visible", timeout: 20_000 });
    assert.deepEqual(await errorMessages(editorPage), [], "no error is shown before the move");

    const refused = await moveIsRefused(editorPage, notePath, archiveDirectory);

    assert.equal(refused, true, "the move reports that it did not happen");
    await editorPage.locator(ERROR_TOAST).first().waitFor({ state: "visible", timeout: 20_000 });
    const messages = await errorMessages(editorPage);
    assert.equal(messages.length, 1, `one error is shown: ${JSON.stringify(messages)}`);
    assert.ok(messages[0].includes("note.md"), `the error names the document: ${messages[0]}`);
    await access(notePath);
    assert.deepEqual(await readdir(archiveDirectory), [], "the target directory stays empty");
    screenshots.set("move-refused.png", await editorPage.screenshot());
  });
});
