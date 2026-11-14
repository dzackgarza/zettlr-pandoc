/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        File tree event subscription E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A workspace with more rows than the listener limit of the
 *                  renderer IPC: 150 notes and 30 folders. The rows of the
 *                  file tree add no IPC listener: the window has as many
 *                  listeners with the rows shown as with the workspace
 *                  collapsed. The tree follows a file that appears on disk,
 *                  and "New directory…" makes one folder, in the selected
 *                  folder.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type CDPSession, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-file-tree-listeners-e2e-latest");
const NOTE_COUNT = 150;
const FOLDER_COUNT = 30;

/**
 * Counts the IPC listeners of the window by channel. The preload of the
 * window puts each listener of `window.ipc.on` on its `ipcRenderer`, an event
 * emitter of the isolated world of the preload. Electron's own IPC emitters of
 * that world listen on no channel of the application.
 */
async function ipcListenerCounts(
  session: CDPSession,
  isolatedWorld: number,
): Promise<Record<string, number>> {
  const prototype = await session.send("Runtime.evaluate", {
    expression: "Object.prototype",
    contextId: isolatedWorld,
  });
  const prototypeId = prototype.result.objectId;
  assert.ok(prototypeId !== undefined, "the isolated world has an object prototype");
  const objects = await session.send("Runtime.queryObjects", { prototypeObjectId: prototypeId });
  const counts = await session.send("Runtime.callFunctionOn", {
    objectId: objects.objects.objectId,
    functionDeclaration: `function () {
      const emitters = this.filter((o) => Object.hasOwn(o, "_events")
        && typeof o.sendSync === "function" && typeof o.listenerCount === "function"
        && o.eventNames().includes("fsal-events"));
      if (emitters.length !== 1) {
        throw new Error(emitters.length + " IPC emitters in the isolated world");
      }
      const ipc = emitters[0];
      return Object.fromEntries(ipc.eventNames().map((name) => [String(name), ipc.listenerCount(name)]));
    }`,
    returnByValue: true,
  });
  assert.equal(counts.exceptionDetails, undefined, JSON.stringify(counts.exceptionDetails));
  return counts.result.value as Record<string, number>;
}

describe("assembled app: a file tree with many rows", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  const folderName = (index: number): string => `chapter-${String(index).padStart(2, "0")}`;

  before(async function () {
    const fixture = await createFixture("zettlr-file-tree-listeners-e2e-", {
      documentName: "index.md",
      documentContents: "# Notes\n",
      config: {
        darkMode: false,
        fileManagerMode: "combined",
        window: { fileManagerVisible: true, sidebarVisible: false },
      },
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    for (let index = 0; index < NOTE_COUNT; index++) {
      const name = `note-${String(index).padStart(3, "0")}.md`;
      await writeFile(path.join(workspace, name), `# Note ${index}\n`, "utf8");
    }
    for (let index = 0; index < FOLDER_COUNT; index++) {
      const folder = path.join(workspace, folderName(index));
      await mkdir(folder);
      await writeFile(path.join(folder, "draft.md"), `# Draft ${index}\n`, "utf8");
    }

    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());

    await page.setViewportSize({ width: 1200, height: 900 });
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

  function row(activePage: Page, itemPath: string) {
    return activePage.locator(`.tree-item[data-path=${JSON.stringify(itemPath)}]`);
  }

  it("adds no IPC listener for a row", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    const lastNote = path.join(workspace, "note-149.md");
    const lastFolder = path.join(workspace, folderName(FOLDER_COUNT - 1));
    await row(shown, lastNote).waitFor({ state: "attached", timeout: 30_000 });
    await row(shown, lastFolder).waitFor({ state: "attached", timeout: 30_000 });

    const session = await shown.context().newCDPSession(shown);
    const worlds: { id: number; name: string }[] = [];
    session.on("Runtime.executionContextCreated", ({ context }) => {
      worlds.push({ id: context.id, name: context.name });
    });
    await session.send("Runtime.enable");
    // Electron runs the preload in an isolated world of this name.
    const isolated = worlds.find((world) => world.name === "Electron Isolated Context");
    assert.ok(isolated !== undefined, "the window has the isolated world of its preload");

    const withRows = await ipcListenerCounts(session, isolated.id);
    await row(shown, workspace).locator(".item-icon cds-icon").click();
    await row(shown, lastNote).waitFor({ state: "detached", timeout: 10_000 });
    await row(shown, lastFolder).waitFor({ state: "detached", timeout: 10_000 });
    const collapsed = await ipcListenerCounts(session, isolated.id);
    await row(shown, workspace).locator(".item-icon cds-icon").click();
    await row(shown, lastNote).waitFor({ state: "attached", timeout: 10_000 });
    await session.detach();

    assert.deepEqual(
      withRows,
      collapsed,
      `${NOTE_COUNT + FOLDER_COUNT} rows change the IPC listeners of the window`,
    );
  });

  it("shows a file that appears on disk", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    const appeared = path.join(workspace, "appeared.md");
    await writeFile(appeared, "# Appeared\n", "utf8");
    await row(shown, appeared).waitFor({ state: "attached", timeout: 20_000 });
    screenshots.set("file-tree.png", await shown.screenshot());
  });

  it("makes one new folder, in the selected folder", async function () {
    const shown = requireInitialized(page, "The editor page must be initialized");
    const target = path.join(workspace, folderName(3));
    await row(shown, target).locator(".display-text").click();
    await row(shown, target).and(shown.locator(".selected")).waitFor({ timeout: 10_000 });

    await shown.evaluate(() => {
      window.ipc.send("menu-provider", { command: "click-menu-item", payload: "menu.new_dir" });
    });
    const field = shown.locator("input.filename-input");
    await field.first().waitFor({ state: "visible", timeout: 10_000 });
    screenshots.set("new-directory-field.png", await shown.screenshot());
    assert.equal(await field.count(), 1, "the window shows one name field");

    await field.fill("proofs");
    await field.press("Enter");
    await row(shown, path.join(target, "proofs")).waitFor({ state: "attached", timeout: 10_000 });

    const made: string[] = [];
    for (const entry of await readdir(workspace, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === "proofs") {
        made.push(path.join(entry.parentPath, entry.name));
      }
    }
    assert.deepEqual(made, [path.join(target, "proofs")]);
  });
});
