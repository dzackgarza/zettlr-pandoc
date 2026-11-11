/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotation button colours E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Opens an annotation thread and its delete confirmation in
 *                  the assembled app in dark mode. Each button with the
 *                  classes of the annotations panel has the background of
 *                  its collaboration token, in the editor pane and in the
 *                  confirmation that is a portal on `body` (#107).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
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

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-annotation-button-colours-e2e-latest");
const DOCUMENT = "# Orbits\n\nThe orbit of a point is the set of its images.\n";

interface ButtonColour {
  label: string;
  classes: string;
  background: string;
  token: string;
  tokenColour: string;
}

/**
 * The background of each visible panel button under `scope`, beside the
 * colour of the token that its classes name. The colour of a token comes
 * from an element that has only that token as its background.
 */
async function buttonColours(page: Page, scope: string): Promise<ButtonColour[]> {
  return page.evaluate((selector) => {
    const colours: ButtonColour[] = [];
    for (const button of document.querySelectorAll<HTMLElement>(
      `${selector} button.annotation-button`,
    )) {
      if (button.offsetParent === null) {
        continue;
      }
      const token = button.classList.contains("annotation-button-danger")
        ? "--annotation-danger"
        : button.classList.contains("annotation-button-primary")
          ? "--annotation-accent"
          : "--annotation-surface";
      const sample = document.createElement("div");
      sample.style.backgroundColor = `var(${token})`;
      document.body.append(sample);
      const tokenColour = getComputedStyle(sample).backgroundColor;
      sample.remove();
      colours.push({
        label: button.innerText.trim(),
        classes: button.className,
        background: getComputedStyle(button).backgroundColor,
        token,
        tokenColour,
      });
    }
    return colours;
  }, scope);
}

describe("assembled app: annotation buttons in dark mode", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let page: Page | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-annotation-button-colours-e2e-", {
      documentName: "orbits.md",
      documentContents: DOCUMENT,
      config: { darkMode: true },
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    const editorPage = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(editorPage);
    await editorPage.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    page = editorPage;
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

  it("paints each button of a thread and of its delete confirmation in the colour of its token", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    assert.equal(
      await shown.evaluate(() => document.body.classList.contains("dark")),
      true,
      "the window is in dark mode",
    );

    const created: unknown = await shown.evaluate(
      async (input) => await window.ipc.invoke("documents:create-annotation", input),
      {
        path: documentPath,
        from: 14,
        to: 19,
        instruction: "Say which group acts.",
        expectedAnnotationGeneration: 0,
      },
    );
    assert.ok(
      typeof created === "object" && created !== null && "annotationId" in created,
      `the annotation was created: ${JSON.stringify(created)}`,
    );

    await shown.locator(".cm-textAnnotation-gutterMarker").first().click();
    const thread = shown.locator(".main-editor-wrapper [data-annotation-detail]");
    await thread.waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("thread.png", await shown.screenshot());
    const inThread = await buttonColours(shown, ".main-editor-wrapper [data-annotation-detail]");
    assert.ok(inThread.length >= 2, `the thread has its actions: ${JSON.stringify(inThread)}`);

    await thread.locator('[data-annotation-action="delete"]').click();
    const confirm = shown.locator('[data-annotation-confirm="delete"]');
    await confirm.waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("delete-confirmation.png", await shown.screenshot());
    const inDialog = await buttonColours(shown, ".annotation-dialog");
    assert.deepEqual(
      inDialog.map((button) => button.token),
      ["--annotation-surface", "--annotation-danger"],
      `the confirmation has Cancel and the destructive action: ${JSON.stringify(inDialog)}`,
    );

    const all = [...inThread, ...inDialog];
    assert.deepEqual(
      all.map((button) => [button.label, button.classes, button.background]),
      all.map((button) => [button.label, button.classes, button.tokenColour]),
      "each button has the background of its token",
    );
    assert.notEqual(
      inDialog[1].tokenColour,
      inDialog[0].tokenColour,
      "the destructive action does not look like Cancel",
    );
  });
});
