/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Quit with an open review E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Quits the assembled app while a pane shows a document
 *                  with an agent proposal that the author did not decide on,
 *                  and another document has unsaved text of the author. The
 *                  spec answers the native quit prompt with its default
 *                  button, Save changes. The file of the reviewed document
 *                  has no text of the proposal, the edit of the author is
 *                  saved, and the next start of the app has the review
 *                  (#146).
 *
 *                  The prompt is a native message box, not a page: the spec
 *                  finds and answers it with xdotool and captures it with
 *                  ImageMagick on the X display of the run.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPatch } from "diff";
import { type Browser, type Page } from "playwright";
import { sha256Text } from "../source/common/util/sha256";
import type { DocumentCollaborationSession } from "../source/types/common/document-collaboration";
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
  requestQuit,
  requireInitialized,
  shutdown,
} from "./support/electron-app";
import { captureWindow, nativeDialog, pressKey } from "./support/native-dialog";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-quit-with-review-e2e-latest");
const REVIEWED = "# Genus\n\nTwo lattices in one genus are isometric over each localization.\n";
const PROPOSED = REVIEWED.replace("localization", "completion");
// The two words end with "tion": the proposal replaces what is before it.
const REPLACED = "localiza";
const DRAFT = "# Draft\n\n";
const SENTENCE = "The Leech lattice has rank 24.";
const QUIT_PROMPT_TITLE = "Unsaved changes";

function collaborationSession(
  page: Page,
  documentPath: string,
): Promise<DocumentCollaborationSession | undefined> {
  return page.evaluate(
    async (pathInPage) =>
      await window.ipc.invoke("documents-provider", {
        command: "get-collaboration-session",
        payload: { path: pathInPage },
      }),
    documentPath,
  );
}

describe("assembled app: a quit with an open review in a pane", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory = "";
  let reviewedPath = "";
  let draftPath = "";
  let reviewId = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  async function start(timeoutMs: number): Promise<Page> {
    const app = await attach(configDirectory, rendererEvents, timeoutMs);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    const page = await findEditorPage(app.browser, timeoutMs);
    await hideDevServerOverlay(page);
    await page.locator(".cm-content:visible").waitFor({ state: "visible", timeout: timeoutMs });
    return page;
  }

  before(async function () {
    const fixture = await createFixture("zettlr-quit-with-review-e2e-", {
      documentName: "genus.md",
      documentContents: REVIEWED,
      config: {
        darkMode: false,
        editor: { autoSave: "off" },
        agentApi: { enabled: true, port: 0 },
      },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
    reviewedPath = fixture.documentPath;
    draftPath = path.join(path.dirname(reviewedPath), "draft.md");
    await writeFile(draftPath, DRAFT, "utf8");
  });

  after(async function () {
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

  it("saves the edit of the author and keeps the proposal out of the reviewed file", async function () {
    const page = await start(this.timeout());
    const running = requireInitialized(appProcess, "The app process must be running");
    const api = agentClient(await readAgentApiPort(configDirectory, 60_000));

    const submitted = await api.post("/v1/review-submissions", {
      document: { uri: reviewedPath },
      baseline: { sha256: sha256Text(REVIEWED) },
      clientRequestId: "quit-with-open-review",
      claims: [
        {
          description: "Name the completion",
          patch: createPatch(reviewedPath, REVIEWED, PROPOSED, "", "", { context: 0 }),
        },
      ],
    });
    assert.ok(
      typeof submitted === "object" &&
        submitted !== null &&
        "reviewId" in submitted &&
        typeof submitted.reviewId === "string",
      `the proposal opened a review: ${JSON.stringify(submitted)}`,
    );
    reviewId = submitted.reviewId;
    await page
      .locator("input.suggestion-chunk-comment")
      .waitFor({ state: "visible", timeout: 30_000 });

    // The reviewed document stays in its tab; the author types in another.
    await page.evaluate(
      async (pathInPage: string) =>
        await window.ipc.invoke("documents-provider", {
          command: "open-file",
          payload: { path: pathInPage, newTab: true },
        }),
      draftPath,
    );
    await page
      .locator(`[role="tab"][data-path="${draftPath}"].active`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(".cm-content:visible").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(SENTENCE);
    await page
      .locator(`[role="tab"][data-path="${draftPath}"].modified`)
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await page.locator(`[role="tab"][data-path="${reviewedPath}"]`).count(),
      1,
      "a pane shows the reviewed document",
    );
    screenshots.set("before-quit.png", await page.screenshot());

    const exited = once(running, "exit");
    await requestQuit(page);
    const prompt = await nativeDialog(QUIT_PROMPT_TITLE, 30_000);
    screenshots.set("quit-prompt.png", await captureWindow(prompt));
    await pressKey(prompt, "Return");

    const outcome = await Promise.race([exited, delay(30_000).then(() => "still running")]);
    assert.deepEqual(outcome, [0, null], "the answer Save changes ends the app");
    assertCleanExit(getOutput());

    assert.equal(
      await readFile(reviewedPath, "utf8"),
      REVIEWED,
      "the file of the reviewed document has no text of the proposal",
    );
    assert.equal(
      await readFile(draftPath, "utf8"),
      `${DRAFT}${SENTENCE}`,
      "the edit of the author is saved",
    );
  });

  it("has the review at the next start", async function () {
    const page = await start(this.timeout());

    await page.locator(`[role="tab"][data-path="${reviewedPath}"]`).click();
    await page
      .locator(`[role="tab"][data-path="${reviewedPath}"].active`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await page
      .locator("input.suggestion-chunk-comment")
      .waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("next-start.png", await page.screenshot());

    const session = await collaborationSession(page, reviewedPath);
    assert.deepEqual(
      [
        session?.review?.id,
        session?.review?.suggestions.map((suggestion) => suggestion.removedText),
        session?.workingText,
      ],
      [reviewId, [REPLACED], PROPOSED],
      "the review of the last session is open, with its proposal undecided",
    );
    assert.equal(
      await readFile(reviewedPath, "utf8"),
      REVIEWED,
      "the load of the review writes no file",
    );
  });
});
