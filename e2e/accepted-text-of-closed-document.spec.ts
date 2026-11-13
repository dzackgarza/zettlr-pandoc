/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Accepted text of a closed document E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An agent proposes a change to a document that no pane
 *                  shows, and the author accepts it in the Annotations view.
 *                  The accepted text is in the review state of the
 *                  document and in no file: the row of the document says so
 *                  and opens the document. Another program then writes the
 *                  file. The document opens with the accepted text, and the
 *                  message of the changed file offers the disk version, the
 *                  review and a copy of the text (#210).
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
  preserveArtifacts,
  readAgentApiPort,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(
  tmpdir(),
  "zettlr-accepted-text-of-closed-document-e2e-latest",
);
const OPEN_DOCUMENT = "# Notes\n\nThe author writes here.\n";
const REVIEWED = "# Genus\n\nTwo lattices in one genus are isometric over each localization.\n";
const ACCEPTED = REVIEWED.replace("localization", "completion");
const OTHER_PROGRAM = `${REVIEWED}\nThe genus of an even unimodular lattice of rank 8 has one class.\n`;
const ANNOTATIONS_VIEW = "#annotations-panel";
const TOAST = "#zettlr-toast-container .zettlr-toast";

/** The paths of the documents that hold text which is not on disk. */
function modifiedDocuments(page: Page): Promise<string[]> {
  return page.evaluate(
    async () =>
      await window.ipc.invoke("documents-provider", { command: "get-file-modification-status" }),
  );
}

describe("assembled app: accepted text of a closed document", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory = "";
  let reviewedPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-accepted-text-of-closed-document-e2e-", {
      documentName: "notes.md",
      documentContents: OPEN_DOCUMENT,
      config: {
        darkMode: false,
        editor: { autoSave: "off" },
        agentApi: { enabled: true, port: 0 },
        window: { sidebarVisible: true },
      },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
    reviewedPath = path.join(path.dirname(fixture.documentPath), "genus.md");
    await writeFile(reviewedPath, REVIEWED, "utf8");
    const app = await attach(configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());

    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    // The author takes the disk version, so the quit asks nothing: the
    // Discard control removes the frozen review, and the editor loads the
    // file.
    const group = page?.locator(
      `${ANNOTATIONS_VIEW} .annotation-document-group[data-document-path="${reviewedPath}"]`,
    );
    if (
      page !== undefined &&
      group !== undefined &&
      (await group.locator(".annotation-frozen-discard").count()) > 0
    ) {
      await group.locator(".annotation-frozen-discard").click();
      await group.waitFor({ state: "detached", timeout: 30_000 });
      await page.evaluate(
        async (pathInPage: string) =>
          await window.ipc.invoke("documents-provider", {
            command: "load-from-disk",
            payload: { path: pathInPage },
          }),
        reviewedPath,
      );
      const deadline = Date.now() + 10_000;
      while ((await modifiedDocuments(page)).length > 0 && Date.now() < deadline) {
        await delay(50);
      }
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

  it("is named in the Annotations view and stays when the file changes", async function () {
    assert.ok(page !== undefined, "The editor window must be open");
    const editorPage = page;
    const api = agentClient(await readAgentApiPort(configDirectory, 60_000));

    await api.post("/v1/review-submissions", {
      document: { uri: reviewedPath },
      baseline: { sha256: sha256Text(REVIEWED) },
      clientRequestId: "accepted-text-of-closed-document",
      claims: [
        {
          description: "Name the completion",
          patch: createPatch(reviewedPath, REVIEWED, ACCEPTED, "", "", { context: 0 }),
        },
      ],
    });
    const group = editorPage.locator(
      `${ANNOTATIONS_VIEW} .annotation-document-group[data-document-path="${reviewedPath}"]`,
    );
    await group.locator(".annotation-document-accept-all").click({ timeout: 30_000 });

    const unsaved = group.locator(".annotation-unsaved-text");
    await unsaved.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("accepted-not-saved.png", await editorPage.screenshot());
    assert.equal(await readFile(reviewedPath, "utf8"), REVIEWED, "the accept writes no file");
    assert.deepEqual(
      await editorPage
        .locator(".cm-content")
        .allInnerTexts()
        .then((texts) => texts.map((text) => text.includes("Genus"))),
      [false],
      "one pane shows the open document, and no pane shows the reviewed document",
    );

    await writeFile(reviewedPath, OTHER_PROGRAM, "utf8");
    await unsaved.locator(".annotation-unsaved-open").click();

    const kept = editorPage.locator(TOAST, { hasText: "genus.md changed on disk" });
    await kept.first().waitFor({ state: "visible", timeout: 30_000 });
    await editorPage
      .locator(".cm-content", { hasText: "completion" })
      .waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("kept-over-disk.png", await editorPage.screenshot());
    assert.deepEqual(
      await kept.first().locator("[data-toast-action]").allInnerTexts(),
      ["Load from disk", "Show the review", "Save a copy…"],
      "the message offers the disk version, the review and a copy of the text",
    );
    assert.deepEqual(
      await modifiedDocuments(editorPage),
      [reviewedPath],
      "the accepted text is unsaved text of the open document",
    );
    assert.equal(
      await readFile(reviewedPath, "utf8"),
      OTHER_PROGRAM,
      "the file keeps the text of the other program",
    );
  });
});
