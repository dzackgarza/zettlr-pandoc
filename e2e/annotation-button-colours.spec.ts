/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotation button colours E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Opens each collaboration surface of the assembled app: an
 *                  annotation thread, its delete confirmation (a portal on
 *                  `body`), the Annotations view, the review bar, a review
 *                  chunk and the dialog that creates an annotation. In dark
 *                  and in light mode each button with the classes of the
 *                  annotations panel has the background of its collaboration
 *                  token, and no control of a surface changes when the
 *                  platform class leaves `body` (#107).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
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
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  readAgentApiPort,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-annotation-button-colours-e2e-latest");
const DOCUMENT =
  "# Orbits\n\nThe orbit of a point is the set of its images.\n\nThe stabilizer of a point is a subgroup.\n";
const PROPOSED = DOCUMENT.replace("a subgroup", "a closed subgroup");
const ANNOTATED = { from: 14, to: 19 };

const THREAD = ".main-editor-wrapper [data-annotation-detail]";
const CONFIRMATION = ".annotation-dialog";
const PANEL = "#annotations-panel";
const REVIEW_BAR = ".suggestion-review-bar";
const REVIEW_CHUNK = ".suggestion-chunk";
const CREATE_DIALOG = ".annotation-create-dialog";

interface ButtonColour {
  label: string;
  classes: string;
  background: string;
  token: string;
  tokenColour: string;
}

interface ControlPainting {
  control: string;
  withPlatform: string;
  withoutPlatform: string;
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
          : button.classList.contains("accept")
            ? "--annotation-resolved"
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

/**
 * The painting of each visible control under `scope`: as the window shows
 * it, and with the platform class taken from `body`. Without that class no
 * platform rule of the window selects a control, so the second reading is
 * what the rules of the surface give on their own.
 */
async function controlPainting(page: Page, scope: string): Promise<ControlPainting[]> {
  return page.evaluate((selector) => {
    const properties = [
      "background-color",
      "color",
      "border-top-width",
      "border-top-style",
      "border-top-color",
      "border-bottom-width",
      "border-bottom-style",
      "border-bottom-color",
      "border-left-width",
      "border-right-width",
      "border-top-left-radius",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "min-width",
      "font-family",
      "font-size",
    ];
    const controls = [
      ...document.querySelectorAll<HTMLElement>(`${selector} :is(input, select, textarea, button)`),
    ].filter((control) => control.offsetParent !== null);
    const still = document.createElement("style");
    still.textContent = "* { transition: none !important; }";
    document.head.append(still);
    const platform = ["linux", "darwin", "win32"].filter((name) =>
      document.body.classList.contains(name),
    );
    // The first reading has the platform class, the second has not.
    const readings: string[][] = [];
    for (const withClass of [true, false]) {
      if (!withClass) {
        document.body.classList.remove(...platform);
      }
      readings.push(
        controls.map((control) => {
          const style = getComputedStyle(control);
          return properties.map((name) => `${name}: ${style.getPropertyValue(name)}`).join("; ");
        }),
      );
    }
    document.body.classList.add(...platform);
    still.remove();
    const [withPlatform, withoutPlatform] = readings;
    return controls.map((control, index) => ({
      control: `${control.tagName.toLowerCase()}.${control.className}`,
      withPlatform: withPlatform[index],
      withoutPlatform: withoutPlatform[index],
    }));
  }, scope);
}

describe("assembled app: controls of the collaboration surfaces", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory = "";
  let documentPath = "";
  let page: Page | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-annotation-button-colours-e2e-", {
      documentName: "orbits.md",
      documentContents: DOCUMENT,
      config: { darkMode: true, agentApi: { enabled: true, port: 0 } },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
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

  /**
   * Reads the buttons and the controls of every surface that is on the
   * screen in this colour mode. The two dialogs are modal, so each is opened,
   * read and closed in turn.
   */
  async function readSurfaces(
    shown: Page,
    mode: string,
  ): Promise<{ colours: ButtonColour[]; painting: ControlPainting[]; surfaces: string[] }> {
    const colours: ButtonColour[] = [];
    const painting: ControlPainting[] = [];
    const surfaces: string[] = [];
    const read = async (surface: string): Promise<void> => {
      const controls = await controlPainting(shown, surface);
      if (controls.length > 0) {
        surfaces.push(surface);
      }
      painting.push(...controls);
      colours.push(...(await buttonColours(shown, surface)));
    };

    for (const surface of [THREAD, PANEL, REVIEW_BAR, REVIEW_CHUNK]) {
      await read(surface);
    }
    screenshots.set(`${mode}-surfaces.png`, await shown.screenshot());

    await shown.locator(`${THREAD} [data-annotation-action="delete"]`).click();
    await shown
      .locator('[data-annotation-confirm="delete"]')
      .waitFor({ state: "visible", timeout: 10_000 });
    await read(CONFIRMATION);
    screenshots.set(`${mode}-delete-confirmation.png`, await shown.screenshot());
    await shown.locator(`${CONFIRMATION} button`, { hasText: "Cancel" }).click();
    await shown.locator(CONFIRMATION).waitFor({ state: "detached", timeout: 10_000 });

    // The event that the command "Annotate for AI…" sends for a selection.
    await shown.evaluate((range) => {
      const editor = document.querySelector(".main-editor-wrapper .cm-editor");
      if (editor === null) {
        throw new Error("The window shows no editor");
      }
      editor.dispatchEvent(
        new CustomEvent("zettlr-annotate-selection", { bubbles: true, detail: range }),
      );
    }, ANNOTATED);
    await shown.locator(CREATE_DIALOG).waitFor({ state: "visible", timeout: 10_000 });
    await read(CREATE_DIALOG);
    screenshots.set(`${mode}-create-dialog.png`, await shown.screenshot());
    await shown.locator(`${CREATE_DIALOG} [data-cancel]`).click();
    await shown.locator(CREATE_DIALOG).waitFor({ state: "detached", timeout: 10_000 });

    return { colours, painting, surfaces };
  }

  function assertOwnPainting(
    read: { colours: ButtonColour[]; painting: ControlPainting[]; surfaces: string[] },
    mode: string,
  ): void {
    assert.deepEqual(
      read.surfaces,
      [THREAD, PANEL, REVIEW_BAR, REVIEW_CHUNK, CONFIRMATION, CREATE_DIALOG],
      `${mode}: each surface shows controls`,
    );
    assert.deepEqual(
      read.colours.map((button) => [button.label, button.classes, button.background]),
      read.colours.map((button) => [button.label, button.classes, button.tokenColour]),
      `${mode}: each button has the background of its token`,
    );
    const tokens = new Set(read.colours.map((button) => button.token));
    assert.deepEqual(
      [...tokens].sort(),
      [
        "--annotation-accent",
        "--annotation-danger",
        "--annotation-resolved",
        "--annotation-surface",
      ],
      `${mode}: the surfaces show a button of each kind`,
    );
    const danger = read.colours.find((button) => button.token === "--annotation-danger");
    const cancel = read.colours.find((button) => button.label === "Cancel");
    assert.ok(danger !== undefined && cancel !== undefined, `${mode}: the confirmation was read`);
    assert.notEqual(
      danger.background,
      cancel.background,
      `${mode}: the destructive action does not look like Cancel`,
    );
    assert.deepEqual(
      read.painting.map((control) => [control.control, control.withPlatform]),
      read.painting.map((control) => [control.control, control.withoutPlatform]),
      `${mode}: no platform rule paints a control of a collaboration surface`,
    );
  }

  it("paints each control of each collaboration surface by the rules of the surface, in dark and in light mode", async function () {
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
        ...ANNOTATED,
        instruction: "Say which group acts.",
        expectedAnnotationGeneration: 0,
      },
    );
    assert.ok(
      typeof created === "object" && created !== null && "annotationId" in created,
      `the annotation was created: ${JSON.stringify(created)}`,
    );

    const api = agentClient(await readAgentApiPort(configDirectory, 60_000));
    await api.post("/v1/review-submissions", {
      document: { uri: documentPath },
      baseline: { sha256: sha256Text(DOCUMENT) },
      clientRequestId: "annotation-button-colours",
      claims: [
        {
          description: "Name the topology",
          patch: createPatch(documentPath, DOCUMENT, PROPOSED, "", "", { context: 0 }),
        },
      ],
    });
    await shown.locator(REVIEW_CHUNK).first().waitFor({ state: "visible", timeout: 30_000 });
    await shown.locator(REVIEW_BAR).waitFor({ state: "visible", timeout: 30_000 });

    await shown.locator('[data-activity="annotations"]').click();
    await shown.locator(PANEL).waitFor({ state: "visible", timeout: 10_000 });
    await shown.locator(".cm-textAnnotation-gutterMarker").first().click();
    await shown.locator(THREAD).waitFor({ state: "visible", timeout: 10_000 });

    assertOwnPainting(await readSurfaces(shown, "dark"), "dark mode");

    await shown.evaluate(() => {
      window.config.set("darkMode", false);
    });
    await shown.waitForFunction(() => !document.body.classList.contains("dark"), undefined, {
      timeout: 10_000,
    });
    await shown.locator(THREAD).waitFor({ state: "visible", timeout: 10_000 });

    assertOwnPainting(await readSurfaces(shown, "light"), "light mode");
  });
});
