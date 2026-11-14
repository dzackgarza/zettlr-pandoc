/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Shortcuts that the author binds (e2e)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A key of the X server, not a key that CDP synthesises,
 *                  goes to the main window (#202). A command that the author
 *                  binds to a new key runs from that key only: its old key
 *                  does nothing, and the menu item of the command shows the
 *                  new key. No two items of the application menu have one
 *                  key.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  findMenuNode,
  preserveArtifacts,
  readApplicationMenu,
  requireInitialized,
  type SerializedMenuNode,
  shutdown,
} from "./support/electron-app";
import { pressKey, windowOfPage } from "./support/native-dialog";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-window-shortcut-keys-e2e-latest");
const DOCUMENT = "# Genus\n\nTwo forms of one genus.\n";

/** The CodeMirror view of the first pane, as this spec reads it. */
interface PageContentElement extends Element {
  cmTile?: {
    root?: {
      view?: {
        state: { doc: { toString: () => string } };
        dispatch: (spec: unknown) => void;
      };
    };
  };
}

/** The text of the document in the first pane. */
async function documentText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const content = document.querySelector(
      ".main-editor-wrapper .cm-content",
    ) as PageContentElement;
    const view = content.cmTile?.root?.view;
    if (view === undefined) {
      throw new Error("The first pane has no editor view.");
    }
    return view.state.doc.toString();
  });
}

/** Gives the editor the focus and selects the first occurrence of `word`. */
async function selectWord(page: Page, word: string): Promise<void> {
  await page.locator(".main-editor-wrapper .cm-content").first().click();
  await page.evaluate((target) => {
    const content = document.querySelector(
      ".main-editor-wrapper .cm-content",
    ) as PageContentElement;
    const view = content.cmTile?.root?.view;
    if (view === undefined) {
      throw new Error("The first pane has no editor view.");
    }
    const from = view.state.doc.toString().indexOf(target);
    view.dispatch({ selection: { anchor: from, head: from + target.length } });
  }, word);
}

/** Each item of the menu tree that has a key, with its label path. */
function itemsWithKeys(nodes: SerializedMenuNode[], trail: string[] = []): Array<[string, string]> {
  return nodes.flatMap((node): Array<[string, string]> => {
    const name = node.label ?? node.id;
    const hasKey = typeof node.accelerator === "string" && node.accelerator !== "";
    if (name === undefined) {
      if (hasKey || node.submenu !== undefined) {
        throw new Error(
          `A menu node with a key or a submenu has no label and no id: ${JSON.stringify(node)}`,
        );
      }
      return [];
    }
    const label = [...trail, name];
    const own: Array<[string, string]> =
      hasKey && typeof node.accelerator === "string" ? [[node.accelerator, label.join(" → ")]] : [];
    return [...own, ...(node.submenu === undefined ? [] : itemsWithKeys(node.submenu, label))];
  });
}

/**
 * One key in one spelling: modifiers in a fixed order, the key in upper case.
 * Electron reads `CmdOrCtrl+Shift+P` and `Ctrl+Shift+P` as one key on Linux.
 */
function normalisedKey(accelerator: string): string {
  const parts = accelerator.split("+").map((part) => part.trim().toLowerCase());
  const key = parts.pop();
  if (key === undefined) {
    throw new Error(`The accelerator "${accelerator}" has no key.`);
  }
  const modifiers = new Set(
    parts.map((part) =>
      ["cmdorctrl", "commandorcontrol", "control"].includes(part) ? "ctrl" : part,
    ),
  );
  const ordered = ["ctrl", "alt", "shift", "super"].filter((modifier) => modifiers.has(modifier));
  return [...ordered, key.toUpperCase()].join("+");
}

describe("shortcuts that the author binds", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    assert.equal(process.env.DISPLAY !== undefined, true, "the run has a display");
    const fixture = await createFixture("zettlr-window-shortcut-keys-e2e-", {
      documentName: "note.md",
      documentContents: DOCUMENT,
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
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

  it("runs a rebound command from its new key only", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const xWindow = await windowOfPage(editorPage);
    await editorPage.evaluate(() => {
      window.ipc.sendSync("config-provider", {
        command: "set-config-single",
        payload: { key: "shortcuts.editor.md-bold", val: "Mod-Shift-b" },
      });
    });
    await delay(500);

    const bold = findMenuNode(await readApplicationMenu(editorPage), "menu.format_bold");

    await selectWord(editorPage, "Two");
    await pressKey(xWindow, "ctrl+b");
    await delay(1000);
    screenshots.set("after-old-key.png", await editorPage.screenshot());
    const afterOldKey = await documentText(editorPage);

    await pressKey(xWindow, "ctrl+z");
    await delay(500);
    await selectWord(editorPage, "Two");
    await pressKey(xWindow, "ctrl+shift+b");
    await delay(1000);
    screenshots.set("after-new-key.png", await editorPage.screenshot());
    const afterNewKey = await documentText(editorPage);

    // The author undoes the edit and saves, so the quit asks about no
    // unsaved text.
    await pressKey(xWindow, "ctrl+z");
    await delay(500);
    assert.equal(await documentText(editorPage), DOCUMENT);
    await pressKey(xWindow, "ctrl+s");
    await editorPage.locator('[role="tab"].modified').waitFor({ state: "detached" });

    // Format → Bold shows the new key; the old key Ctrl+B does nothing; the
    // new key Ctrl+Shift+B makes the word bold one time.
    assert.deepEqual(
      { menuKey: bold?.accelerator, afterOldKey, afterNewKey },
      {
        menuKey: "CmdOrCtrl+Shift+B",
        afterOldKey: DOCUMENT,
        afterNewKey: DOCUMENT.replace("Two", "**Two**"),
      },
    );
  });

  it("gives each key of the application menu to one item", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const byKey = new Map<string, string[]>();
    for (const [accelerator, label] of itemsWithKeys(await readApplicationMenu(editorPage))) {
      const key = normalisedKey(accelerator);
      const labels = byKey.get(key);
      if (labels === undefined) {
        byKey.set(key, [label]);
      } else {
        labels.push(label);
      }
    }
    const shared = Object.fromEntries([...byKey].filter(([, labels]) => labels.length > 1));
    assert.deepEqual(shared, {}, "no two menu items have one key");
  });
});
