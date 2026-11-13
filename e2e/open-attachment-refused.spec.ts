/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Assembled-app test of a refused attachment open
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The citation context menu opens the PDF of a reference:
 *                  a file that the library names, or else the PDF that
 *                  Zotero has. When neither gives a file, the window that
 *                  asked shows one message that names the cite key and the
 *                  cause.
 *
 *                  The cite key is one that no Zotero library holds, so the
 *                  spec gives the same result with and without a Zotero on
 *                  the machine of the run. The spec sends the request of the
 *                  menu item: the menu is a native popup.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Browser, Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-open-attachment-refused-e2e-latest");
const ERROR_TOAST = "#zettlr-toast-container .zettlr-toast.error";
/** A cite key that no library of an author holds. */
const CITEKEY = "ZettlrFixtureNoAttachment1980";
const LIBRARY = `@article{${CITEKEY},
  author = {Nikulin, V. V.},
  title = {Integral symmetric bilinear forms and some of their applications},
  year = {1980},
  journaltitle = {Mathematics of the USSR-Izvestiya},
}
`;

describe("A refused attachment open", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentPath = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-open-attachment-refused-e2e-", {
      documentName: "forms.md",
      documentContents: `---\nbibliography: forms.bib\n---\n\n# Forms\n\nSee [@${CITEKEY}].\n`,
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    await writeFile(path.join(path.dirname(documentPath), "forms.bib"), LIBRARY);

    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
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

  it("names the cite key and the cause in one message", async function () {
    const editorPage = requireInitialized(page, "The editor page must be initialized");

    const opened = await editorPage.evaluate(
      async ({ citekey, filePath }) =>
        await window.ipc
          .invoke("application", {
            command: "open-attachment",
            payload: { citekey, filePath },
          })
          .then(
            () => "opened",
            (rejection: Error) => rejection.message,
          ),
      { citekey: CITEKEY, filePath: documentPath },
    );

    const toast = editorPage.locator(ERROR_TOAST);
    await toast.first().waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("refused.png", await editorPage.screenshot());
    const toasts = await toast.allInnerTexts();
    assert.notEqual(opened, "opened", "the request rejects");
    assert.equal(toasts.length, 1, "one refusal shows one message");
    assert.ok(toasts[0].includes(CITEKEY), "the message names the cite key");
  });
});
