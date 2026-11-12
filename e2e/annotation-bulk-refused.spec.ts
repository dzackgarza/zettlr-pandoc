/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Refused bulk action of the Annotations view E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The Annotations view lists a closed document with an open
 *                  annotation. Its sidecar then becomes a file that the
 *                  application cannot read. "Resolve all" of the document is
 *                  refused, and the window shows the author the cause of the
 *                  refusal (#210).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { chmod, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-annotation-bulk-refused-e2e-latest");
const DOCUMENT =
  "# Orbits\n\nThe orbit of a point is the set of its images.\n\nThe stabilizer of a point is a subgroup.\n";
const ANNOTATED = { from: 14, to: 19 };

/** Closes the document in the one pane of the window, as a click on its tab does. */
async function closeFileInPane(page: Page, filePath: string): Promise<void> {
  await page.evaluate(async (pathInPage: string) => {
    const windowId = new URLSearchParams(location.search).get("window_id");
    if (windowId === null) {
      throw new Error("The main window carries no window_id");
    }
    const tree = await window.ipc.invoke("documents-provider", {
      command: "retrieve-tab-config",
      payload: { windowId },
    });
    if (tree.type !== "leaf") {
      throw new Error(`Expected a single leaf, got ${tree.type}`);
    }
    await window.ipc.invoke("documents-provider", {
      command: "close-file",
      payload: { windowId, leafId: tree.id, path: pathInPage },
    });
  }, filePath);
}

/** The text of each error message on screen. */
function errorToasts(page: Page): Promise<string[]> {
  return page
    .locator("#zettlr-toast-container .zettlr-toast.error span:first-child")
    .allInnerTexts();
}

describe("assembled app: a refused bulk action of the Annotations view", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let sidecarDirectory = "";
  let refusedSidecars: string[] = [];
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-annotation-bulk-refused-e2e-", {
      documentName: "orbits.md",
      documentContents: DOCUMENT,
      config: { window: { sidebarVisible: true } },
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    sidecarDirectory = path.join(fixture.configDirectory, "review-sidecars");
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
  });

  after(async function () {
    for (const sidecar of refusedSidecars) {
      await chmod(sidecar, 0o600);
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

  it("shows the cause when Resolve all of a document is refused", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    const created: unknown = await shown.evaluate(
      async (input) => await window.ipc.invoke("documents:create-annotation", input),
      {
        path: documentPath,
        ...ANNOTATED,
        instruction: "Say which group acts.",
        expectedAnnotationGeneration: 0,
      },
    );
    assert.ok(
      typeof created === "object" && created !== null && "annotationId" in created,
      `the annotation was created: ${JSON.stringify(created)}`,
    );
    await closeFileInPane(shown, documentPath);
    await shown
      .locator(`[role="tab"][data-path=${JSON.stringify(documentPath)}]`)
      .waitFor({ state: "detached", timeout: 30_000 });

    // The configuration opens the Annotations view beside the editor.
    const resolveAll = shown.locator(
      `.annotation-document-group[data-document-path=${JSON.stringify(documentPath)}] .annotation-document-resolve-acted`,
    );
    await resolveAll.waitFor({ state: "visible", timeout: 30_000 });

    refusedSidecars = (await readdir(sidecarDirectory)).map((name) =>
      path.join(sidecarDirectory, name),
    );
    assert.equal(refusedSidecars.length, 1, "the closed document has one sidecar");
    await chmod(refusedSidecars[0], 0o000);

    assert.deepEqual(await errorToasts(shown), [], "no message is on screen before the click");
    await resolveAll.click();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await errorToasts(shown)).length === 0) {
      await delay(120);
    }
    screenshots.set("refused-resolve-all.png", await shown.screenshot());
    const messages = await errorToasts(shown);
    assert.equal(messages.length, 1, "the window shows the refusal one time");
    assert.ok(
      messages[0].includes(refusedSidecars[0]),
      `the message names the file that cannot be read: ${messages[0]}`,
    );
  });
});
