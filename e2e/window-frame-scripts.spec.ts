/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Main window frame script E2E
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Loads the main window of the assembled app with an empty
 *                  frame in it and reads which scripts the content security
 *                  policy of that frame refused. An empty frame has the
 *                  policy of the window, which permits no inline script, so
 *                  each refusal is a script that some part of the start put
 *                  into the frame (#183).
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
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  shutdown,
} from "./support/electron-app";

declare global {
  interface Window {
    /** One entry for each script that the policy of the empty frame refused. */
    refusedFrameScripts: string[];
  }
}

// A script that looks for the frames of a window does so for some seconds
// after the load: the Vue devtools look once a second for five seconds
// (`detectIframeApp` in @vue/devtools-kit).
const FRAME_SEARCH_MS = 7000;

describe("scripts in a frame of the main window", function () {
  it("puts no inline script into an empty frame", async function () {
    const artifactDirectory = path.join(tmpdir(), "zettlr-window-frame-scripts-e2e-latest");
    const fixture = await createFixture("zettlr-window-frame-scripts-e2e-", {
      documentName: "note.md",
      documentContents: "# Note\n",
    });

    const rendererEvents: string[] = [];
    const screenshots = new Map<string, Buffer>();
    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    try {
      const firstWindow = await findEditorPage(app.browser, this.timeout());
      const context = firstWindow.context();
      // The script runs at the start of each document that loads from now on.
      await context.addInitScript(() => {
        if (window.top !== window) {
          return;
        }
        window.refusedFrameScripts = [];
        document.addEventListener("DOMContentLoaded", () => {
          const frame = document.createElement("iframe");
          frame.id = "empty-frame";
          document.body.appendChild(frame);
          const frameDocument = frame.contentDocument;
          if (frameDocument === null) {
            throw new Error("The empty frame has no document");
          }
          frameDocument.addEventListener("securitypolicyviolation", (event) => {
            window.refusedFrameScripts.push(`${event.violatedDirective} ${event.blockedURI}`);
          });
        });
      });

      // A window cannot load again from its own page: the page refuses each
      // unload. A second main window is a load that the script is in time for.
      const opened = context.waitForEvent("page", { timeout: 30_000 });
      await firstWindow.evaluate(() => {
        window.ipc.send("menu-provider", {
          command: "click-menu-item",
          payload: "menu.new_window",
        });
      });
      const page = await opened;
      await page.locator("#empty-frame").waitFor({ state: "attached", timeout: 30_000 });
      await delay(FRAME_SEARCH_MS);
      screenshots.set("window.png", await page.screenshot());

      const refused = await page.evaluate(() => window.refusedFrameScripts);
      await page.close({ runBeforeUnload: true });
      assert.deepEqual(refused, []);
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
