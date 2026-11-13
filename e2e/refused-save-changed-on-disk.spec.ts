/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Refused save of a reviewed document that changed on disk E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An agent proposal opens a review of the open document, and
 *                  another program then writes the file. The save of the
 *                  author is refused: the file keeps the text of the other
 *                  program. The message of the refusal names two ways on,
 *                  the disk version and the review, and it has an action for
 *                  each, on the toast and in the notification center. The
 *                  action for the review opens the Annotations view, which
 *                  has the controls that reapply or discard the review
 *                  (#210).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPatch } from "diff";
import { type Browser, type Page } from "playwright";
import { sha256Text } from "../source/common/util/sha256";
import {
  agentClient,
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  readAgentApiPort,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-refused-save-changed-on-disk-e2e-latest");
const REVIEWED = "# Genus\n\nTwo lattices in one genus are isometric over each localization.\n";
const PROPOSED = REVIEWED.replace("localization", "completion");
const OTHER_PROGRAM = `${REVIEWED}\nThe genus of an even unimodular lattice of rank 8 has one class.\n`;
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
const ANNOTATIONS_VIEW = "#annotations-panel";

/** File → Save: the menu item that Ctrl+S runs. */
async function save(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.save" });
  });
}

/** The paths of the documents that hold text which is not on disk. */
function modifiedDocuments(page: Page): Promise<string[]> {
  return page.evaluate(
    async () =>
      await window.ipc.invoke("documents-provider", { command: "get-file-modification-status" }),
  );
}

/**
 * The author takes the disk version: the Discard control of the Annotations
 * view removes the review, and the editor loads the text of the file.
 */
async function takeDiskVersion(page: Page, documentPath: string): Promise<void> {
  const group = page.locator(
    `${ANNOTATIONS_VIEW} .annotation-document-group[data-document-path="${documentPath}"]`,
  );
  await group.locator(".annotation-frozen-discard").click();
  await group.waitFor({ state: "detached", timeout: 30_000 });
  await page.evaluate(
    async (pathInPage: string) =>
      await window.ipc.invoke("documents-provider", {
        command: "load-from-disk",
        payload: { path: pathInPage },
      }),
    documentPath,
  );
  const deadline = Date.now() + 10_000;
  while ((await modifiedDocuments(page)).length > 0 && Date.now() < deadline) {
    await delay(50);
  }
}

describe("assembled app: a save of a reviewed document that changed on disk", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory = "";
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-refused-save-changed-on-disk-e2e-", {
      documentName: "genus.md",
      documentContents: REVIEWED,
      config: {
        darkMode: false,
        editor: { autoSave: "off" },
        agentApi: { enabled: true, port: 0 },
        window: { sidebarVisible: false },
      },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
    documentPath = fixture.documentPath;
    const app = await attach(configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    // A case that stopped early leaves text that is not on disk, and a quit
    // would then ask about it.
    if (page !== undefined && (await modifiedDocuments(page)).length > 0) {
      await page.evaluate(() => {
        window.config.set("window.sidebarVisible", true);
      });
      await takeDiskVersion(page, documentPath);
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

  it("offers the disk version and the review, and the review has its controls", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const editorPage = page;
    const api = agentClient(await readAgentApiPort(configDirectory, 60_000));

    await api.post("/v1/review-submissions", {
      document: { uri: documentPath },
      baseline: { sha256: sha256Text(REVIEWED) },
      clientRequestId: "refused-save-changed-on-disk",
      claims: [
        {
          description: "Name the completion",
          patch: createPatch(documentPath, REVIEWED, PROPOSED, "", "", { context: 0 }),
        },
      ],
    });
    await editorPage
      .locator("input.suggestion-chunk-comment")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await editorPage.locator(ANNOTATIONS_VIEW).isVisible(),
      false,
      "the Annotations view is closed before the save",
    );

    await writeFile(documentPath, OTHER_PROGRAM, "utf8");
    await save(editorPage);

    const toast = editorPage.locator(ERROR_TOAST);
    await toast.first().waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("save-refused.png", await editorPage.screenshot());
    assert.equal(await toast.count(), 1, "one refused save shows one message");
    assert.equal(
      await readFile(documentPath, "utf8"),
      OTHER_PROGRAM,
      "the file keeps the text of the other program",
    );
    assert.deepEqual(
      await toast.first().locator("[data-toast-action]").allInnerTexts(),
      ["Load from disk", "Show the review"],
      "the message has an action for each way on that it names",
    );

    // The notification center shows the same message with the same actions.
    const bell = editorPage.locator('[data-statusbar-item="notifications"]');
    await bell.click();
    const logged = editorPage.locator("#notification-center .notification-entry.error");
    await logged.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("notification-center.png", await editorPage.screenshot());
    assert.deepEqual(
      await logged.locator("[data-notification-action]").allInnerTexts(),
      ["Load from disk", "Show the review"],
      "the notification center has both actions of the message",
    );
    await logged.locator("[data-notification-action]", { hasText: "Show the review" }).click();
    await bell.click();

    const group = editorPage.locator(
      `${ANNOTATIONS_VIEW} .annotation-document-group[data-document-path="${documentPath}"]`,
    );
    await group
      .locator(".annotation-frozen-reapply")
      .waitFor({ state: "visible", timeout: 30_000 });
    await group
      .locator(".annotation-frozen-discard")
      .waitFor({ state: "visible", timeout: 30_000 });
    // The view opens with a transition. A trial click waits until its
    // target does not move, so the capture shows the open view.
    await group.locator(".annotation-frozen-discard").click({ trial: true });
    screenshots.set("review-shown.png", await editorPage.screenshot());
    assert.equal(await logged.count(), 0, "the action takes the message away");

    await takeDiskVersion(editorPage, documentPath);
    assert.deepEqual(await modifiedDocuments(editorPage), [], "the editor has the disk version");
    assert.equal(await readFile(documentPath, "utf8"), OTHER_PROGRAM);
  });
});
