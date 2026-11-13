/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Visual TikZ Editor launch journey
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Drives the assembled app together with the installed
 *                  Visual TikZ Editor: the control on a figure starts the
 *                  editor on that diagram, a save in the editor lands in the
 *                  Markdown document, and the editor stops with the app. The
 *                  save goes through the document route of the editor's own
 *                  file host, the route that its window uses.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { type ChildProcess, execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  requireInitialized,
  shutdown,
} from "../support/electron-app";

const run = promisify(execFile);

const SQUARE = String.raw`\begin{tikzcd}
A \arrow[r, "f"] & B
\end{tikzcd}`;
const EDITED = String.raw`\begin{tikzcd}
A \arrow[r, "f"] \arrow[d, "g"'] & B \\
C
\end{tikzcd}`;
const DOCUMENT = `# External editor\n\nBefore the diagram.\n\n${SQUARE}\n\nAfter the diagram.\n`;

interface EditorHost {
  pid: number;
  arguments: string[];
}

/** The file hosts of Visual TikZ Editor whose image directory is `resources`. */
async function editorHosts(resources: string): Promise<EditorHost[]> {
  const listing = await run("ps", ["-eo", "pid=,args="]);
  const hosts: EditorHost[] = [];
  for (const line of listing.stdout.split("\n")) {
    const [pid, command, ...rest] = line.trim().split(/\s+/u);
    if (command?.endsWith("/workbench-host") === true && rest.includes(resources)) {
      hosts.push({ pid: Number(pid), arguments: rest });
    }
  }
  return hosts;
}

function header(response: Response, name: string): string {
  const value = response.headers.get(name);
  assert.ok(value !== null, `the editor's file host sends the ${name} header`);
  return value;
}

async function waitForEditorHost(resources: string, timeoutMs: number): Promise<EditorHost> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [host] = await editorHosts(resources);
    if (host !== undefined) return host;
    await delay(250);
  }
  throw new Error(`No Visual TikZ Editor file host started for ${resources}`);
}

async function hostUrl(host: EditorHost, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sockets = await run("ss", ["-ltnpH"]);
    // The app under test runs with a DevTools port, and every process that
    // the app starts inherits that listening socket. The socket of the file
    // host is the one that the host alone holds.
    const line = sockets.stdout
      .split("\n")
      .find((entry) => entry.includes(`pid=${host.pid},`) && entry.split("pid=").length === 2);
    const address = line === undefined ? null : /127\.0\.0\.1:\d+/u.exec(line);
    if (address !== null && address !== undefined) return `http://${address[0]}`;
    await delay(250);
  }
  throw new Error(`The Visual TikZ Editor file host ${host.pid} opened no port`);
}

describe("editing a diagram in Visual TikZ Editor", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let documentDirectory = "";
  let documentPath = "";
  let appOutput: () => string = () => "";
  const rendererEvents: string[] = [];

  before(async function () {
    // The installed editor is a precondition of this proof, as the packaged
    // binary is of the launcher proofs beside it.
    await run("sh", ["-c", "command -v visual-tikz-editor"]);
    const fixture = await createFixture("zettlr-tikz-external-editor-e2e-", {
      documentName: "external-editor.md",
      documentContents: DOCUMENT,
    });
    fixtureRoot = fixture.root;
    documentPath = fixture.documentPath;
    documentDirectory = path.dirname(documentPath);
    const app = await attach(fixture.configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    appOutput = app.getOutput;
    page = await findEditorPage(browser, this.timeout());
  });

  after(async function () {
    await shutdown(browser, appProcess);
    if (fixtureRoot !== undefined) {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("starts the editor on the diagram and takes its saves into the document", async function () {
    const editor = requireInitialized(page, "the main editor page must be attached");

    const launch = editor.getByRole("button", { name: "Edit in Visual TikZ Editor" }).first();
    await launch.waitFor({ state: "visible", timeout: 60_000 });
    await launch.click();

    const host = await waitForEditorHost(documentDirectory, 60_000);
    const url = await hostUrl(host, 60_000);
    const opened = await fetch(`${url}/api/document`);
    assert.equal(await opened.text(), SQUARE, "the editor opens the authored diagram");
    assert.equal(
      path.extname(header(opened, "x-document-path")),
      ".tikzcd",
      "a tikzcd diagram opens as a tikzcd file, which the editor gives to Quiver",
    );

    const saved = await fetch(`${url}/api/document`, {
      method: "PUT",
      headers: {
        "if-match": header(opened, "etag"),
        "x-document-id": header(opened, "x-document-id"),
      },
      body: EDITED,
    });
    assert.equal(saved.status, 204, "the editor saves the edited diagram");

    await editor.waitForFunction(
      (expected) =>
        (
          document.querySelector(".cm-content") as
            | (HTMLElement & {
                cmTile?: { root: { view: { state: { doc: { toString: () => string } } } } };
              })
            | null
        )?.cmTile?.root.view.state.doc.toString() === expected,
      DOCUMENT.replace(SQUARE, EDITED),
      { timeout: 30_000 },
    );

    // The edit is an ordinary change of the document: Save writes it. This
    // is the IPC call that the save-file shortcut makes; CDP key events do
    // not reach the menu accelerator.
    await editor.evaluate(
      async (pathInPage) => await window.ipc.invoke("documents:save-file", { path: pathInPage }),
      documentPath,
    );
    const deadline = Date.now() + 30_000;
    while (
      (await readFile(documentPath, "utf8")) !== DOCUMENT.replace(SQUARE, EDITED) &&
      Date.now() < deadline
    ) {
      await delay(250);
    }
    assert.equal(await readFile(documentPath, "utf8"), DOCUMENT.replace(SQUARE, EDITED));

    assert.deepEqual(rendererEvents, [], `the renderer emitted errors: ${rendererEvents.join()}`);
  });

  it("stops the editor when the app stops", async function () {
    assert.equal((await editorHosts(documentDirectory)).length, 1);
    await shutdown(browser, appProcess);
    browser = undefined;
    appProcess = undefined;
    assertCleanExit(appOutput());
    const deadline = Date.now() + 20_000;
    while ((await editorHosts(documentDirectory)).length > 0 && Date.now() < deadline) {
      await delay(250);
    }
    assert.deepEqual(await editorHosts(documentDirectory), []);
  });
});
