/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a move whose review state cannot follow
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Each of three documents carries an annotation, and a
 *                  fourth document links to all three. The directory of the
 *                  sidecars then takes no new file, so the state of a
 *                  document cannot go to the key of a new path. A rename, a
 *                  move and a rename of a folder each reach the disk. The
 *                  links to the document follow it, and the author gets the
 *                  cause one time.
 *
 *                  The link prompt of a rename and the error of a folder
 *                  rename are native message boxes: the spec finds and
 *                  answers them on the X display of the run
 *                  (`support/native-dialog.ts`).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import type { DocumentCollaborationSession } from "../source/types/common/document-collaboration";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { captureWindow, nativeDialog, pressKey } from "./support/native-dialog";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-move-unwritable-review-e2e-latest");
const NOTE = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const GENUS = "# Genus\n\nA genus holds finitely many isometry classes.\n";
const RANK = "# Rank\n\nThe Leech lattice has rank 24.\n";
const INDEX = "# Index\n\nSee [[note]], [[drafts/genus]] and [[notes/rank]].\n";
const INSTRUCTION = "State the signature condition.";
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const LINK_PROMPT_TITLE = "Confirm";
const FOLDER_ERROR_TITLE = "Rename directory";

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

/** Opens a document in a tab and gives it one annotation. */
async function openAndAnnotate(page: Page, documentPath: string, quote: string): Promise<void> {
  await page.evaluate(
    async (pathInPage) =>
      await window.ipc.invoke("documents-provider", {
        command: "open-file",
        payload: { path: pathInPage, newTab: true },
      }),
    documentPath,
  );
  await page
    .locator(`[role="tab"][data-path="${documentPath}"].active`)
    .waitFor({ state: "visible", timeout: 30_000 });
  const session: DocumentCollaborationSession | undefined = await page.evaluate(
    async (pathInPage) =>
      await window.ipc.invoke("documents-provider", {
        command: "get-collaboration-session",
        payload: { path: pathInPage },
      }),
    documentPath,
  );
  assert.ok(session !== undefined, `the provider holds a session for ${documentPath}`);
  const from = session.workingText.indexOf(quote);
  assert.ok(from >= 0, `${documentPath} holds the text to annotate`);
  const created: unknown = await page.evaluate(
    async (input) => await window.ipc.invoke("documents:create-annotation", input),
    {
      path: documentPath,
      from,
      to: from + quote.length,
      instruction: INSTRUCTION,
      expectedAnnotationGeneration: session.annotations.generation,
    },
  );
  assert.ok(
    typeof created === "object" && created !== null && "annotationId" in created,
    `the annotation was created: ${JSON.stringify(created)}`,
  );
}

/** The text of a file when it has the expected text before the time limit; else its last text. */
async function textOnDisk(filePath: string, expected: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await readFile(filePath, "utf8");
    if (text === expected || Date.now() > deadline) {
      return text;
    }
    await delay(250);
  }
}

describe("a move whose review state cannot follow the document", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let sidecarDirectory = "";
  let workspace = "";
  let notePath = "";
  let indexPath = "";
  let genusPath = "";
  let rankPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-move-unwritable-review-e2e-", {
      documentName: "note.md",
      documentContents: NOTE,
      config: { darkMode: false, editor: { autoSave: "off" } },
    });
    fixtureRoot = fixture.root;
    sidecarDirectory = path.join(fixture.configDirectory, "review-sidecars");
    notePath = fixture.documentPath;
    workspace = path.dirname(notePath);
    indexPath = path.join(workspace, "index.md");
    genusPath = path.join(workspace, "drafts", "genus.md");
    rankPath = path.join(workspace, "notes", "rank.md");
    await mkdir(path.join(workspace, "drafts"));
    await mkdir(path.join(workspace, "notes"));
    await mkdir(path.join(workspace, "archive"));
    await writeFile(indexPath, INDEX, "utf8");
    await writeFile(genusPath, GENUS, "utf8");
    await writeFile(rankPath, RANK, "utf8");
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });

    await openAndAnnotate(page, notePath, "even unimodular");
    await openAndAnnotate(page, genusPath, "finitely many");
    await openAndAnnotate(page, rankPath, "rank 24");
    // From here the directory of the sidecars takes no new file.
    await chmod(sidecarDirectory, 0o500);
  });

  after(async function () {
    if (sidecarDirectory !== "") {
      await chmod(sidecarDirectory, 0o700);
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

  it("offers the link update of a rename, and shows the cause one time", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    assert.deepEqual(await errorMessages(editorPage), [], "no error is shown before the rename");

    const refused = renameIsRefused(editorPage, notePath, "lattices.md");
    const prompt = await nativeDialog(LINK_PROMPT_TITLE, 30_000);
    screenshots.set("link-prompt.png", await captureWindow(prompt));
    // The default button is "No". Tab moves the focus to "Yes".
    await pressKey(prompt, "Tab");
    await pressKey(prompt, "space");

    assert.equal(await refused, true, "the rename reports the state that did not move");
    assert.equal(
      await textOnDisk(indexPath, INDEX.replace("[[note]]", "[[lattices]]"), 20_000),
      INDEX.replace("[[note]]", "[[lattices]]"),
      "the link names the document at its new name",
    );
    await editorPage.locator(ERROR_TOAST).first().waitFor({ state: "visible", timeout: 20_000 });
    const messages = await errorMessages(editorPage);
    assert.equal(messages.length, 1, `one error is shown: ${JSON.stringify(messages)}`);
    screenshots.set("rename.png", await editorPage.screenshot());
    await dismissErrors(editorPage);
  });

  it("updates the links of a move, and shows the cause one time", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const expected = INDEX.replace("[[note]]", "[[lattices]]").replace(
      "[[drafts/genus]]",
      "[[genus]]",
    );

    const refused = await moveIsRefused(editorPage, genusPath, path.join(workspace, "archive"));

    assert.equal(refused, true, "the move reports the state that did not move");
    assert.equal(
      await textOnDisk(indexPath, expected, 20_000),
      expected,
      "the link names the document at its new place",
    );
    await editorPage.locator(ERROR_TOAST).first().waitFor({ state: "visible", timeout: 20_000 });
    const messages = await errorMessages(editorPage);
    assert.equal(messages.length, 1, `one error is shown: ${JSON.stringify(messages)}`);
    screenshots.set("move.png", await editorPage.screenshot());
    await dismissErrors(editorPage);
  });

  it("updates the links of a renamed folder, and shows the cause one time", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const expected = INDEX.replace("[[note]]", "[[lattices]]")
      .replace("[[drafts/genus]]", "[[genus]]")
      .replace("[[notes/rank]]", "[[rank]]");

    const renamed: Promise<unknown> = editorPage.evaluate(
      async (payload) => await window.ipc.invoke("application", { command: "dir-rename", payload }),
      { path: path.join(workspace, "notes"), name: "results" },
    );
    const box = await nativeDialog(FOLDER_ERROR_TITLE, 30_000);
    screenshots.set("folder-error.png", await captureWindow(box));
    await pressKey(box, "Return");

    assert.equal(await renamed, false, "the folder rename reports the state that did not move");
    assert.equal(
      await textOnDisk(indexPath, expected, 20_000),
      expected,
      "the link names the document in the renamed folder",
    );
    assert.deepEqual(
      await errorMessages(editorPage),
      [],
      "the message box is the one message of a folder rename",
    );

    // The file manager shows each document where it is.
    const row = (target: string): string => `.tree-item[data-path=${JSON.stringify(target)}]`;
    await editorPage
      .locator(row(path.join(workspace, "lattices.md")))
      .waitFor({ state: "attached", timeout: 20_000 });
    await editorPage
      .locator(row(path.join(workspace, "results")))
      .waitFor({ state: "attached", timeout: 20_000 });
    for (const former of [notePath, genusPath, path.join(workspace, "notes")]) {
      await editorPage.locator(row(former)).waitFor({ state: "detached", timeout: 20_000 });
    }
    screenshots.set("after-the-moves.png", await editorPage.screenshot());
  });
});
