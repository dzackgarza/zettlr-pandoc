/**
 * Assembled-app proof that a move asks before it changes a link (#6).
 *
 * A move of a file, a file rename and a folder rename change the document
 * that a relative link reaches: a link to the moved file, and a relative link
 * of the moved file. After the move, the window that started it shows each
 * document whose links the move changed, with each changed line before and
 * after. No file changes until the author applies; Cancel leaves each link as
 * it is. A Markdown link and an image follow the move as a wikilink does: the
 * new path is relative to the document, keeps its `./`, its fragment and the
 * encoding as written. A link with a scheme, an anchor in the document and a
 * link to a file that does not exist stay as they are.
 */

import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, type Page } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  hideDevServerOverlay,
  preserveArtifacts,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-link-update-preview-e2e-latest");
const PREVIEW = ".workspace-edit-preview";

const INDEX = `# Index

Chain: [[./programs/chain.md]]

Read [the chain](./programs/chain.md#second-step) and [the basis](notes/basis.md).

Also [the plan](<notes/the plan.md>), [the plan again](notes/the%20plan.md),
[the web](https://example.com/programs/chain.md), [the top](#index) and
[nothing](./programs/nothing.md).
`;

const CHAIN = `# First step

See [basis](../notes/basis.md) and ![a plot](plot.png).

# Second step

Done.
`;

const WORKSPACE: Record<string, string> = {
  "programs/chain.md": CHAIN,
  "programs/plot.png": "not an image\n",
  "notes/basis.md": "# Basis\n",
  "notes/the plan.md": "# The plan\n",
  "archive/2026/placeholder.md": "# Placeholder\n",
};

interface PreviewRow {
  documentPath: string;
  changes: Array<{ before: string; after: string }>;
}

/** The rows of the preview dialog, in the order in which it shows them. */
async function previewRows(page: Page): Promise<PreviewRow[]> {
  return await page.locator(`${PREVIEW} [data-preview-path]`).evaluateAll((rows) =>
    rows.map((row) => ({
      documentPath: row.getAttribute("data-preview-path") ?? "",
      changes: [...row.querySelectorAll("[data-preview-change]")].map((change) => ({
        before: change.querySelector("[data-preview-before]")?.textContent ?? "",
        after: change.querySelector("[data-preview-after]")?.textContent ?? "",
      })),
    })),
  );
}

/** The text of a file once it is `expected`, or its text after ten seconds. */
async function textOnceItIs(file: string, expected: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  let text = await readFile(file, "utf8");
  while (Date.now() < deadline && text !== expected) {
    await delay(100);
    text = await readFile(file, "utf8");
  }
  return text;
}

describe("assembled app: a move asks before it changes a link (#6)", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let fixtureRoot: string | undefined;
  let workspace = "";
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-link-update-preview-e2e-", {
      documentName: "index.md",
      documentContents: INDEX,
      config: { darkMode: false },
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    for (const [relativePath, contents] of Object.entries(WORKSPACE)) {
      await mkdir(path.dirname(path.join(workspace, relativePath)), { recursive: true });
      await writeFile(path.join(workspace, relativePath), contents, "utf8");
    }

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout());
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    page = await findEditorPage(app.browser, this.timeout());
    await hideDevServerOverlay(page);
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

  it("shows the links that a move changes, and changes them when the author applies", async function () {
    const activePage = requireInitialized(page, "The editor window must be open");
    const moved = await activePage.evaluate(
      async (payload) => await window.ipc.invoke("application", { command: "request-move", payload }),
      {
        from: path.join(workspace, "programs", "chain.md"),
        to: path.join(workspace, "archive", "2026"),
      },
    );
    assert.equal(moved, true);
    const movedChain = path.join(workspace, "archive", "2026", "chain.md");

    // The move itself is done; no link changed.
    assert.equal(await readFile(path.join(workspace, "index.md"), "utf8"), INDEX);
    assert.equal(await readFile(movedChain, "utf8"), CHAIN);

    const preview = activePage.locator(PREVIEW);
    await preview.waitFor({ state: "visible", timeout: 30_000 });
    screenshots.set("move-preview.png", await activePage.screenshot());
    assert.deepEqual(await previewRows(activePage), [
      {
        documentPath: path.join(workspace, "index.md"),
        changes: [
          { before: "Chain: [[./programs/chain.md]]", after: "Chain: [[chain]]" },
          {
            before:
              "Read [the chain](./programs/chain.md#second-step) and [the basis](notes/basis.md).",
            after:
              "Read [the chain](./archive/2026/chain.md#second-step) and [the basis](notes/basis.md).",
          },
        ],
      },
      {
        documentPath: movedChain,
        changes: [
          {
            before: "See [basis](../notes/basis.md) and ![a plot](plot.png).",
            after: "See [basis](../../notes/basis.md) and ![a plot](../../programs/plot.png).",
          },
        ],
      },
    ]);
    // The preview stays until the author decides.
    await delay(1000);
    assert.equal(await readFile(path.join(workspace, "index.md"), "utf8"), INDEX);

    await preview.locator("[data-apply]").click();
    await preview.waitFor({ state: "detached", timeout: 30_000 });

    const index = INDEX.replace("[[./programs/chain.md]]", "[[chain]]").replace(
      "./programs/chain.md#second-step",
      "./archive/2026/chain.md#second-step",
    );
    assert.equal(await textOnceItIs(path.join(workspace, "index.md"), index), index);
    const chain = CHAIN.replace("../notes/basis.md", "../../notes/basis.md").replace(
      "(plot.png)",
      "(../../programs/plot.png)",
    );
    assert.equal(await textOnceItIs(movedChain, chain), chain);
  });

  it("changes the Markdown links to a renamed file when the author applies", async function () {
    const activePage = requireInitialized(page, "The editor window must be open");
    const renamed = activePage.evaluate(
      async (payload) => await window.ipc.invoke("application", { command: "file-rename", payload }),
      { path: path.join(workspace, "notes", "the plan.md"), name: "the outline.md" },
    );

    const preview = activePage.locator(PREVIEW);
    await preview.waitFor({ state: "visible", timeout: 30_000 });
    await renamed;
    const before = await readFile(path.join(workspace, "index.md"), "utf8");
    assert.deepEqual(await previewRows(activePage), [
      {
        documentPath: path.join(workspace, "index.md"),
        changes: [
          {
            before: "Also [the plan](<notes/the plan.md>), [the plan again](notes/the%20plan.md),",
            after:
              "Also [the plan](<notes/the outline.md>), [the plan again](notes/the%20outline.md),",
          },
        ],
      },
    ]);

    await preview.locator("[data-apply]").click();
    await preview.waitFor({ state: "detached", timeout: 30_000 });
    const after = before
      .replace("<notes/the plan.md>", "<notes/the outline.md>")
      .replace("notes/the%20plan.md", "notes/the%20outline.md");
    assert.equal(await textOnceItIs(path.join(workspace, "index.md"), after), after);
  });

  it("leaves each link as it is when the author cancels the preview of a folder rename", async function () {
    const activePage = requireInitialized(page, "The editor window must be open");
    const index = await readFile(path.join(workspace, "index.md"), "utf8");
    const chain = await readFile(path.join(workspace, "archive", "2026", "chain.md"), "utf8");
    const renamed = await activePage.evaluate(
      async (payload) => await window.ipc.invoke("application", { command: "dir-rename", payload }),
      { path: path.join(workspace, "notes"), name: "sources" },
    );
    assert.equal(renamed, true);
    assert.ok((await stat(path.join(workspace, "sources", "basis.md"))).isFile());

    const preview = activePage.locator(PREVIEW);
    await preview.waitFor({ state: "visible", timeout: 30_000 });
    assert.deepEqual(
      (await previewRows(activePage)).map((row) => row.documentPath),
      [path.join(workspace, "index.md"), path.join(workspace, "archive", "2026", "chain.md")],
    );
    await preview.locator("[data-cancel]").click();
    await preview.waitFor({ state: "detached", timeout: 30_000 });

    await delay(1000);
    assert.equal(await readFile(path.join(workspace, "index.md"), "utf8"), index);
    assert.equal(await readFile(path.join(workspace, "archive", "2026", "chain.md"), "utf8"), chain);
  });
});
