/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Close of a main window E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The app has two main windows, and the author closes the
 *                  second one. A window with unsaved text asks first: the
 *                  answer Cancel leaves the window and its text, and the
 *                  answer No closes the window and writes nothing. A window
 *                  whose document has a review that cannot be written stays
 *                  open with the cause and the action "Close anyway"; the
 *                  other window shows no message. That action closes the
 *                  window: the file keeps its text, no
 *                  prompt offers to save the proposal, and the review
 *                  returns with the next open of the document (#210).
 *
 *                  The spec answers native message boxes, so it runs on the
 *                  display of the run only.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPatch } from "diff";
import { type Browser, type Page } from "playwright";
import { sha256Text } from "../source/common/util/sha256";
import {
  agentClient,
  assertCleanExit,
  attach,
  clickBeforeClose,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  readAgentApiPort,
  requestWindowClose,
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { captureWindow, nativeDialog, nativeDialogs, pressKey } from "./support/native-dialog";
import { leafIds, openInLeaf } from "./support/panes";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-window-close-e2e-latest");
const PROMPT_TITLE = "Unsaved changes";
const FIRST = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const DRAFT = "# Draft\n\nA first sentence.\n";
const SENTENCE = "A sentence that the author did not save.";
const REVIEWED = "# Genus\n\nTwo lattices in one genus are isometric over each localization.\n";
const PROPOSED = REVIEWED.replace("localization", "completion");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const NOTE = "input.suggestion-chunk-comment";

/** The paths of the documents that hold text which is not on disk. */
function modifiedDocuments(page: Page): Promise<string[]> {
  return page.evaluate(
    async () =>
      await window.ipc.invoke("documents-provider", { command: "get-file-modification-status" }),
  );
}

/** Resolves true when the window of the page went away inside the time limit. */
async function windowWentAway(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!page.isClosed() && Date.now() < deadline) {
    await delay(100);
  }
  return page.isClosed();
}

describe("assembled app: the close of a main window", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let firstWindow: Page | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory = "";
  let firstPath = "";
  let draftPath = "";
  let reviewedPath = "";
  let sidecarDirectory = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /** File → New Window, and one document in the pane of the new window. */
  async function secondWindowWith(documentPath: string): Promise<Page> {
    const origin = requireInitialized(firstWindow, "the first window must be open");
    const opened = origin.context().waitForEvent("page", { timeout: 30_000 });
    await origin.evaluate(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.new_window" });
    });
    const page = await opened;
    await page.waitForFunction(
      () => new URLSearchParams(location.search).get("window_id") !== null,
      undefined,
      { timeout: 30_000 },
    );
    await page.locator("#window-content").waitFor({ state: "visible", timeout: 60_000 });
    await page.setViewportSize({ width: 1400, height: 900 });

    const [leaf] = await leafIds(page);
    await openInLeaf(page, leaf, documentPath);
    await page
      .locator(`[role="tab"][data-path="${documentPath}"].active`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(".cm-content:visible").waitFor({ state: "visible", timeout: 30_000 });
    return page;
  }

  before(async function () {
    const fixture = await createFixture("zettlr-window-close-e2e-", {
      documentName: "lattices.md",
      documentContents: FIRST,
      config: {
        darkMode: false,
        editor: { autoSave: "off" },
        agentApi: { enabled: true, port: 0 },
      },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
    firstPath = fixture.documentPath;
    draftPath = path.join(path.dirname(firstPath), "draft.md");
    reviewedPath = path.join(path.dirname(firstPath), "genus.md");
    sidecarDirectory = path.join(configDirectory, "review-sidecars");
    await writeFile(draftPath, DRAFT, "utf8");
    await writeFile(reviewedPath, REVIEWED, "utf8");
    const app = await attach(configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    firstWindow = await findEditorPage(app.browser, this.timeout());

    await firstWindow.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    await mkdir(sidecarDirectory, { recursive: true });
    await chmod(sidecarDirectory, 0o700);
    screenshots.set("display-at-end.png", await captureWindow("root"));
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

  it("asks about unsaved text, and each answer does what it says", async function () {
    const first = requireInitialized(firstWindow, "the first window must be open");
    const second = await secondWindowWith(draftPath);
    await second.locator(".cm-content:visible").click();
    await second.keyboard.press("ControlOrMeta+End");
    await second.keyboard.type(SENTENCE);
    const modifiedTab = second.locator(`[role="tab"][data-path="${draftPath}"].modified`);
    await modifiedTab.waitFor({ state: "visible", timeout: 30_000 });

    // Cancel: the window and its text stay.
    await requestWindowClose(second);
    const cancelled = await nativeDialog(PROMPT_TITLE, 30_000);
    screenshots.set("unsaved-prompt.png", await captureWindow(cancelled));
    await pressKey(cancelled, "Escape");
    assert.equal(await windowWentAway(second, 3_000), false, "Cancel leaves the window");
    assert.equal(await modifiedTab.count(), 1, "Cancel leaves the unsaved text");
    assert.ok(
      (await second.locator(".cm-content:visible").innerText()).includes(SENTENCE),
      "the editor has the sentence of the author",
    );

    // No: the window closes, and the file keeps its text.
    await requestWindowClose(second);
    const discarded = await nativeDialog(PROMPT_TITLE, 30_000);
    await pressKey(discarded, "Tab");
    await pressKey(discarded, "space");
    assert.equal(await windowWentAway(second, 30_000), true, "the answer No closes the window");
    assert.equal(await readFile(draftPath, "utf8"), DRAFT, "the answer No writes nothing");
    assert.deepEqual(await modifiedDocuments(first), [], "no document holds the discarded text");
    assert.deepEqual(await nativeDialogs(PROMPT_TITLE, 2_000), [], "one close asks one time");
    await first.locator(".cm-content:visible").click();
    screenshots.set("first-window-after-close.png", await first.screenshot());
  });

  it("keeps a window whose review cannot be written, and closes it on the action", async function () {
    const first = requireInitialized(firstWindow, "the first window must be open");
    const api = agentClient(await readAgentApiPort(configDirectory, 60_000));
    const second = await secondWindowWith(reviewedPath);

    await api.post("/v1/review-submissions", {
      document: { uri: reviewedPath },
      baseline: { sha256: sha256Text(REVIEWED) },
      clientRequestId: "window-close",
      claims: [
        {
          description: "Name the completion",
          patch: createPatch(reviewedPath, REVIEWED, PROPOSED, "", "", { context: 0 }),
        },
      ],
    });
    await second.locator(NOTE).waitFor({ state: "visible", timeout: 30_000 });

    // The sidecar directory loses write permission: the real error of a
    // disk that is read-only or full.
    await chmod(sidecarDirectory, 0o500);
    await requestWindowClose(second);
    const toast = second.locator(ERROR_TOAST);
    await toast.first().waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("close-refused.png", await second.screenshot());
    assert.equal(second.isClosed(), false, "the window stays");
    assert.equal(await toast.count(), 1, "the window that the author closes shows one message");
    assert.deepEqual(await toast.first().locator("[data-toast-action]").allInnerTexts(), [
      "Close anyway",
    ]);
    assert.equal(await second.locator(NOTE).count(), 1, "the review stays in the window");
    screenshots.set("first-window-at-refusal.png", await first.screenshot());
    assert.equal(
      await first.locator(ERROR_TOAST).count(),
      0,
      "the window that the author did not close shows no message",
    );

    await clickBeforeClose(toast.first().locator("[data-toast-action]"));
    const prompts = await nativeDialogs(PROMPT_TITLE, 5_000);
    if (prompts.length > 0) {
      screenshots.set("prompt-after-close-anyway.png", await captureWindow(prompts[0]));
      await pressKey(prompts[0], "Escape");
    }
    assert.deepEqual(prompts, [], "no prompt offers to save the text of the proposal");
    assert.equal(await windowWentAway(second, 30_000), true, "the action closes the window");
    assert.equal(
      await readFile(reviewedPath, "utf8"),
      REVIEWED,
      "the file has no text of the proposal",
    );
    assert.deepEqual(await modifiedDocuments(first), [], "no loaded document holds the proposal");

    // The sidecar is as the last write left it: the next open has the review.
    // The quit of the run does not ask about a document with an undecided
    // proposal, and writes its review to the sidecar.
    await chmod(sidecarDirectory, 0o700);
    const [leaf] = await leafIds(first);
    await openInLeaf(first, leaf, reviewedPath);
    await first.locator(NOTE).waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("review-returned.png", await first.screenshot());
  });
});
