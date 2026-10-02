/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reopen closed tab E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Closes the last document tab in the assembled app and
 *                  reopens it through the Window menu.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertCleanExit,
  attach,
  createWorkspaceFixture,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  REPO_ROOT,
  shutdown,
} from "./support/electron-app";

describe("reopen closed document tab", function () {
  it("reopens the last closed tab from the Window menu", async function () {
    const artifactDirectory = path.join(tmpdir(), "zettlr-reopen-tab-e2e-latest");
    const fixture = await createWorkspaceFixture("zettlr-reopen-tab-e2e-", {
      workspaceSource: path.join(REPO_ROOT, "test", "fixtures", "quarto-book"),
      activeDocument: path.join("foundations", "forms.md"),
      config: { darkMode: false },
    });
    const rendererEvents: string[] = [];
    const screenshots = new Map<string, Buffer>();
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    try {
      const page = await findEditorPage(app.browser, this.timeout());
      await hideDevServerOverlay(page);
      const tab = page.locator('[role="tab"][data-path$="/forms.md"]');
      await tab.waitFor({ state: "visible", timeout: this.timeout() });
      await tab.hover();
      await tab.locator(".close").click();
      await tab.waitFor({ state: "detached", timeout: 20_000 });

      await page.evaluate(() => {
        window.ipc.send("menu-provider", {
          command: "click-menu-item",
          payload: "menu.tab_reopen_closed",
        });
      });
      await tab.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await tab.evaluate((element) => element.classList.contains("active")), true);
    } finally {
      await shutdown(app.browser, app.appProcess);
      await preserveArtifacts(
        artifactDirectory,
        fixture.root,
        app.getOutput(),
        rendererEvents,
        screenshots,
      );
      await rm(fixture.root, { recursive: true, force: true });
      assertCleanExit(app.getOutput());
    }
  });
});
