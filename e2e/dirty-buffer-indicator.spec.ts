// Renders the real tab bar so the unsaved-changes indicator can be looked at
// rather than reasoned about. A dirty-state affordance is only correct if it
// reads as dirty on screen, and the claim being made for it — that an unsaved
// tab is findable while scanning — is only testable against a row of tabs, in
// both themes. Screenshots land in the artifact directory for inspection.
import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { stringify } from "yaml";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

// One directory per theme: preserveArtifacts clears its target, so a shared
// directory would leave only whichever theme tore down last.
const ARTIFACTS_ROOT = path.join(tmpdir(), "zettlr-dirty-buffer-indicator-e2e-latest");
const SIBLINGS = ["second-note.md", "third-note.md", "fourth-note.md"];
// A second file with the name of a sibling, in a folder of its own: two tabs
// with one title.
const NAMESAKE_FOLDER = "drafts";
const NAMESAKE = path.join(NAMESAKE_FOLDER, SIBLINGS[0]);

async function attributeOf(element: Locator, name: string): Promise<string> {
  const value = await element.getAttribute(name);
  assert.ok(value !== null, `the element has no ${name}`);
  return value;
}

interface RunningFixture {
  fixtureRoot: string | undefined;
  appProcess: ChildProcess | undefined;
  browser: Browser | undefined;
  getOutput: () => string;
  rendererEvents: string[];
  screenshots: Map<string, Buffer>;
}

/**
 * Boots the app with four documents open in one leaf. createFixture opens a
 * single file, which cannot show whether one dirty tab stands out among clean
 * ones — so the extra files and the leaf state are written over its output
 * before the app starts, rather than by widening the shared harness for one
 * spec's needs.
 */
async function bootWithTabRow(fixture: RunningFixture, darkMode: boolean): Promise<Page> {
  const created = await createFixture("zettlr-dirty-buffer-indicator-e2e-", {
    documentName: "first-note.md",
    documentContents: "# First note\n\nSome prose to type into.\n",
    config: { darkMode, editor: { inputMode: "default" } },
  });
  fixture.fixtureRoot = created.root;

  const workspace = path.dirname(created.documentPath);
  const openFiles = [{ path: created.documentPath, pinned: false }];
  for (const sibling of SIBLINGS) {
    const siblingPath = path.join(workspace, sibling);
    await writeFile(siblingPath, `# ${sibling}\n\nUntouched.\n`, "utf8");
    openFiles.push({ path: siblingPath, pinned: false });
  }
  await mkdir(path.join(workspace, NAMESAKE_FOLDER));
  const namesakePath = path.join(workspace, NAMESAKE);
  await writeFile(namesakePath, `# ${SIBLINGS[0]}\n\nUntouched.\n`, "utf8");
  openFiles.push({ path: namesakePath, pinned: false });
  await writeFile(
    path.join(created.configDirectory, "documents.yaml"),
    stringify({
      "56b44854-b144-4a6f-8061-dcfeb6e512e8": {
        type: "leaf",
        id: "7b4dd4f2-48a2-4279-b6c9-577132e64480",
        openFiles,
        activeFile: openFiles[0],
      },
    }),
    "utf8",
  );

  const app = await attach(created.configDirectory, fixture.rendererEvents);
  fixture.appProcess = app.appProcess;
  fixture.browser = app.browser;
  fixture.getOutput = app.getOutput;
  return await findEditorPage(requireInitialized(fixture.browser, "browser"), 60_000);
}

for (const theme of ["light", "dark"] as const) {
  describe(`unsaved-changes indicator (${theme})`, function () {
    const fixture: RunningFixture = {
      fixtureRoot: undefined,
      appProcess: undefined,
      browser: undefined,
      getOutput: () => "",
      rendererEvents: [],
      screenshots: new Map<string, Buffer>(),
    };
    let page: Page;

    async function shoot(name: string): Promise<void> {
      fixture.screenshots.set(
        `${theme}-${name}.png`,
        await page.locator("div.tab-container").screenshot(),
      );
    }

    /** The row is too small to judge a 2px edge; this crops one tab. */
    async function shootTab(name: string): Promise<void> {
      fixture.screenshots.set(
        `${theme}-${name}-tab.png`,
        await page.locator('div[role="tab"]').first().screenshot({ scale: "device" }),
      );
    }

    before(async function () {
      page = await bootWithTabRow(fixture, theme === "dark");
    });

    after(async function () {
      const artifactDirectory: string =
        theme === "dark" ? path.join(ARTIFACTS_ROOT, "dark") : path.join(ARTIFACTS_ROOT, "light");
      await shutdown(fixture.browser, fixture.appProcess);
      await preserveArtifacts(
        artifactDirectory,
        fixture.fixtureRoot,
        fixture.getOutput(),
        fixture.rendererEvents,
        fixture.screenshots,
      );
      if (fixture.fixtureRoot !== undefined) {
        await rm(fixture.fixtureRoot, { recursive: true, force: true });
      }
      assertCleanExit(fixture.getOutput());
      assert.deepEqual(
        fixture.rendererEvents,
        [],
        "the renderer reported no error, page error or dialog",
      );
    });

    it("marks only the dirty tab, and yields the slot back on hover", async function () {
      const tabs = page.locator('div[role="tab"]');
      await tabs.first().waitFor({ state: "visible", timeout: 60_000 });
      assert.equal(await tabs.count(), 2 + SIBLINGS.length);

      const indicators = page.locator("span.modification-indicator");
      assert.equal(await indicators.count(), 0, "no clean tab may carry an indicator");
      await shoot("row-clean");

      await page.locator(".cm-content").first().click();
      await page.keyboard.type("dirty");
      await indicators.first().waitFor({ state: "visible", timeout: 30_000 });
      assert.equal(
        await indicators.count(),
        1,
        "exactly the edited tab is marked, not the whole row",
      );
      await shoot("row-one-dirty");
      await shootTab("one-dirty");

      // The dot sits in the close control's slot, so the cross must be out of
      // the way while the pointer is elsewhere — otherwise the tab shows two
      // glyphs competing for the same meaning.
      const dirtyTab = tabs.first();
      const close = dirtyTab.locator("span.close");
      const dirtyIndicator = indicators.first();
      assert.equal(await close.isVisible(), false, "the close cross must yield to the dot");
      assert.equal(
        await dirtyIndicator.evaluate((el) => getComputedStyle(el).visibility),
        "visible",
        "the dirty dot must be visually present before hover",
      );
      assert.match(
        await dirtyTab.ariaSnapshot(),
        /Unsaved changes/,
        "the dirty tab must expose the unsaved state to assistive technology",
      );

      // ...and so must every other tab's, or the dot is just one more small
      // glyph in a row of small glyphs and stands out from none of them.
      const visibleCrosses = await page.locator("span.close:visible").count();
      assert.equal(visibleCrosses, 0, "an unhovered row shows no close crosses");

      // ...and take the slot back on hover, so closing a dirty tab stays a
      // single click rather than a hunt for a target that moved.
      await dirtyTab.hover();
      const closeElement = await close.elementHandle();
      assert.ok(closeElement, "the close control must remain mounted during hover");
      await page.waitForFunction(
        (element) => getComputedStyle(element).visibility === "visible",
        closeElement,
      );
      // The cross appearing and the dot going are two separate style commits,
      // so waiting on the cross says nothing about the dot yet: wait on the
      // dot's own state or this races the swap and fails under load.
      const dotElement = await dirtyIndicator.elementHandle();
      assert.ok(dotElement, "the dirty dot must remain mounted during hover");
      await page.waitForFunction(
        (element) => getComputedStyle(element).visibility === "hidden",
        dotElement,
        { timeout: 10_000 },
      );
      assert.match(
        await dirtyTab.ariaSnapshot(),
        /Unsaved changes/,
        "hover may replace the visible dot, but not the accessible unsaved-state cue",
      );

      // The old '* ' prefix shifted the filename sideways; the dot must not.
      const filename = await dirtyTab.locator("span.filename").innerText();
      assert.equal(filename.includes("*"), false, "the filename must carry no asterisk");

      // The case that matters most: the author edits a note, moves to another
      // tab, and the unsaved one is now neither active nor under the pointer.
      // That is the tab whose state has to survive on its own.
      await tabs.nth(2).click();
      await page.locator('div[role="tab"].active').first().waitFor({ timeout: 10_000 });
      assert.equal(
        await dirtyTab.evaluate((el) => el.classList.contains("active")),
        false,
        "the edited tab must have handed off active state",
      );
      assert.equal(await indicators.count(), 1, "the unsaved mark survives losing focus");
      await shoot("row-dirty-inactive");
      await shootTab("dirty-inactive");

      // Return the fixture to a saved state through the same IPC call
      // MainEditor makes for the save-file shortcut. CDP-injected key events
      // do not run Electron's main-process menu accelerators, so Ctrl+S here
      // would save nothing and leave the real close guard blocking teardown.
      const dirtyPath = await dirtyTab.getAttribute("data-path");
      assert.ok(dirtyPath !== null, "The dirty tab must identify its document");
      assert.deepEqual(
        await page.evaluate(
          async ([documentPath]) =>
            await window.ipc.invoke("documents:save-file", { path: documentPath }),
          [dirtyPath],
        ),
        { ok: true },
        "The dirty fixture document must save before teardown",
      );
      await dirtyIndicator.waitFor({ state: "detached", timeout: 30_000 });
    });

    it("names the folder of each of two tabs with one title", async function () {
      const workspace = path.dirname(
        await attributeOf(page.locator('div[role="tab"]').first(), "data-path"),
      );
      const namesakes = [path.join(workspace, SIBLINGS[0]), path.join(workspace, NAMESAKE)];
      const names: string[] = [];
      for (const namesake of namesakes) {
        const tab = page.locator(`div[role="tab"][data-path="${namesake}"]`);
        const name = await attributeOf(tab, "aria-label");
        assert.ok(
          name.includes(path.basename(path.dirname(namesake))),
          `the accessible name "${name}" of ${namesake} must name its folder`,
        );
        names.push(name);
      }
      assert.notEqual(names[0], names[1], "a screen reader must tell the two tabs apart");
    });

    it("puts the unsaved dot in the slot of the close control on macOS", async function () {
      // The tab bar of macOS puts the close control at the left edge of the
      // tab. The style sheet of a platform follows the class of the body.
      await page.evaluate(() => document.body.classList.replace("linux", "darwin"));
      const tab = page.locator('div[role="tab"]').first();
      await tab.click();
      await page.locator(".cm-content:visible").first().click();
      await page.keyboard.type("dirty");
      const indicator = tab.locator("span.modification-indicator");
      await indicator.waitFor({ state: "visible", timeout: 30_000 });
      await shootTab("darwin-dirty");
      // A function that runs in the page declares no name (AGENTS.md §13).
      const [dotX, dotY] = await indicator.evaluate((element): [number, number] => {
        const box = element.getBoundingClientRect();
        return [box.left + box.width / 2, box.top + box.height / 2];
      });
      const [closeX, closeY] = await tab
        .locator("span.close")
        .evaluate((element): [number, number] => {
          const box = element.getBoundingClientRect();
          return [box.left + box.width / 2, box.top + box.height / 2];
        });
      assert.ok(
        Math.abs(dotX - closeX) <= 1 && Math.abs(dotY - closeY) <= 1,
        `the dot (${dotX}, ${dotY}) must sit where the close control (${closeX}, ${closeY}) appears`,
      );

      await page.evaluate(() => document.body.classList.replace("darwin", "linux"));
      const dirtyPath = await attributeOf(tab, "data-path");
      assert.deepEqual(
        await page.evaluate(
          async ([documentPath]) =>
            await window.ipc.invoke("documents:save-file", { path: documentPath }),
          [dirtyPath],
        ),
        { ok: true },
        "The dirty fixture document must save before teardown",
      );
      await indicator.waitFor({ state: "detached", timeout: 30_000 });
    });
  });
}
