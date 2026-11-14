/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Rename of a document with collaboration state E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Moves two documents in the assembled app. A pane shows
 *                  the first, which carries an annotation; the file is
 *                  renamed. No pane shows the second, which carries the
 *                  review of an agent proposal; its folder is renamed, the
 *                  one move that the app permits for a document with unsaved
 *                  working text. The first keeps its annotation under the new
 *                  name and takes an edit and a save. The quit request then
 *                  ends the app, with each state in the sidecar of the new
 *                  path (#178).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPatch } from "diff";
import { type Browser, type Page } from "playwright";
import { sha256Text } from "../source/common/util/sha256";
import type { DocumentCollaborationSession } from "../source/types/common/document-collaboration";
import {
  type AgentClient,
  agentClient,
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  readAgentApiPort,
  requestQuit,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-rename-annotated-e2e-latest");
const CONTENTS = "# Lattices\n\nAn even unimodular lattice has a rank that 8 divides.\n";
const INSTRUCTION = "State the signature condition for the indefinite case.";
const PARKED_CONTENTS =
  "# Genus\n\nTwo lattices in one genus are isometric over each localization.\n";
const PARKED_REVISED = PARKED_CONTENTS.replace("localization", "completion");

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

/** What each sidecar of the profile holds: the annotation ids and the review id, by document path. */
async function sidecarStates(
  configDirectory: string,
): Promise<Map<string, { annotations: string[]; review: string | null }>> {
  const directory = path.join(configDirectory, "review-sidecars");
  const states = new Map<string, { annotations: string[]; review: string | null }>();
  for (const name of await readdir(directory)) {
    const sidecar = JSON.parse(await readFile(path.join(directory, name), "utf8")) as {
      documentPath: string;
      review: { reviewId: string } | null;
      annotations: { items: Array<{ annotationId: string }> };
    };
    states.set(sidecar.documentPath, {
      annotations: sidecar.annotations.items.map((item) => item.annotationId),
      review: sidecar.review === null ? null : sidecar.review.reviewId,
    });
  }
  return states;
}

function rename(
  page: Page,
  command: "file-rename" | "dir-rename",
  target: string,
  name: string,
): Promise<unknown> {
  return page.evaluate(
    async (input) =>
      await window.ipc.invoke("application", { command: input.command, payload: input.payload }),
    { command, payload: { path: target, name } },
  );
}

describe("a document that carries collaboration state, after a rename", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let api: AgentClient | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory = "";
  let originalPath = "";
  let renamedPath = "";
  let parkedDirectory = "";
  let movedParkedDirectory = "";
  let parkedPath = "";
  let movedParkedPath = "";
  let annotationId = "";
  let reviewId = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-rename-annotated-e2e-", {
      documentName: "note.md",
      documentContents: CONTENTS,
      config: {
        darkMode: false,
        window: { sidebarVisible: true },
        agentApi: { enabled: true, port: 0 },
      },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
    originalPath = fixture.documentPath;
    renamedPath = path.join(path.dirname(originalPath), "lattices.md");
    parkedDirectory = path.join(path.dirname(originalPath), "drafts");
    movedParkedDirectory = path.join(path.dirname(originalPath), "papers");
    parkedPath = path.join(parkedDirectory, "genus.md");
    movedParkedPath = path.join(movedParkedDirectory, "genus.md");
    await mkdir(parkedDirectory);
    await writeFile(parkedPath, PARKED_CONTENTS, "utf8");
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    api = agentClient(await readAgentApiPort(fixture.configDirectory, 60_000));
    page = await findEditorPage(app.browser, this.timeout());

    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
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

  it("keeps the annotation under the new name", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const before = await collaborationSession(editorPage, originalPath);
    assert.ok(before !== undefined, "the provider holds a session for the open document");
    const from = CONTENTS.indexOf("even unimodular");
    const created: unknown = await editorPage.evaluate(
      async (input) => await window.ipc.invoke("documents:create-annotation", input),
      {
        path: originalPath,
        from,
        to: from + "even unimodular".length,
        instruction: INSTRUCTION,
        expectedAnnotationGeneration: before.annotations.generation,
      },
    );
    assert.ok(
      typeof created === "object" &&
        created !== null &&
        "annotationId" in created &&
        typeof created.annotationId === "string",
      `the annotation was created: ${JSON.stringify(created)}`,
    );
    annotationId = created.annotationId;

    await rename(editorPage, "file-rename", originalPath, path.basename(renamedPath));
    await editorPage
      .locator(`[role="tab"][data-path="${renamedPath}"]`)
      .waitFor({ state: "visible", timeout: 20_000 });

    const after = await collaborationSession(editorPage, renamedPath);
    assert.deepEqual(
      after?.annotations.items.map((item) => item.annotationId),
      [annotationId],
      "the session of the new path holds the annotation of the document",
    );
    assert.equal(
      await collaborationSession(editorPage, originalPath),
      undefined,
      "no document is at the old path",
    );
    await editorPage
      .locator("#annotations-panel")
      .getByText(INSTRUCTION, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("after-rename.png", await editorPage.screenshot());
  });

  it("takes an edit and saves it to the new path", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const sentence = "The signature of an indefinite one is 0 mod 8.";
    await editorPage.locator(".cm-content").click();
    await editorPage.keyboard.press("ControlOrMeta+End");
    await editorPage.keyboard.type(sentence);
    await editorPage.evaluate(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.save" });
    });

    const deadline = Date.now() + 10_000;
    let written = await readFile(renamedPath, "utf8");
    while (written === CONTENTS && Date.now() < deadline) {
      await delay(50);
      written = await readFile(renamedPath, "utf8");
    }
    assert.equal(written, `${CONTENTS}${sentence}`);
    const session = await collaborationSession(editorPage, renamedPath);
    const from = CONTENTS.indexOf("even unimodular");
    assert.deepEqual(
      session?.annotations.items.map((item) => [item.annotationId, item.anchor]),
      [
        [
          annotationId,
          {
            state: "range",
            from,
            to: from + "even unimodular".length,
            quotedText: "even unimodular",
          },
        ],
      ],
      "the edit after the annotated text leaves the annotation on its text",
    );
  });

  it("quits with a reviewed document that no pane shows, in a renamed folder, in the sidecar of its new path", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const running = requireInitialized(appProcess, "The app process must be running");
    const activeApi = requireInitialized(api, "The Agent API client must be initialized");

    const submitted = await activeApi.post("/v1/review-submissions", {
      document: { uri: parkedPath },
      baseline: { sha256: sha256Text(PARKED_CONTENTS) },
      clientRequestId: "rename-parked-review",
      claims: [
        {
          description: "Name the completion",
          patch: createPatch(parkedPath, PARKED_CONTENTS, PARKED_REVISED, "", "", { context: 0 }),
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
    assert.equal(
      await editorPage.locator(`[role="tab"][data-path="${parkedPath}"]`).count(),
      0,
      "the proposal opens no tab: no pane shows the reviewed document",
    );

    assert.equal(
      await rename(editorPage, "dir-rename", parkedDirectory, path.basename(movedParkedDirectory)),
      true,
      "the folder of the reviewed document was renamed",
    );
    assert.equal(
      await readFile(movedParkedPath, "utf8"),
      PARKED_CONTENTS,
      "the proposal is working text: the file on disk is as it was",
    );

    const exited = once(running, "exit");
    await requestQuit(editorPage);
    const outcome = await Promise.race([exited, delay(30_000).then(() => "still running")]);
    if (outcome === "still running") {
      screenshots.set("quit-refused.png", await editorPage.screenshot());
    }
    assert.deepEqual(outcome, [0, null], "the quit request ends the app");

    assert.deepEqual(
      await sidecarStates(configDirectory),
      new Map([
        [renamedPath, { annotations: [annotationId], review: null }],
        [movedParkedPath, { annotations: [], review: reviewId }],
      ]),
      "each document has its state in the sidecar of its new path",
    );
  });
});
