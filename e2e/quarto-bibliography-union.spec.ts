import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser } from "playwright";
import {
  assertCleanExit,
  attach,
  createFixture,
  findEditorPage,
  preserveArtifacts,
  shutdown,
} from "./support/electron-app";

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-quarto-bibliography-union-e2e-latest");
const DOCUMENT = "# Chapter\n\nA project citation [@nlab:locally_ringed_space].\n";

const SHARED_LIBRARY = `@book{Shared24,
  author = {Shared, Ada},
  title = {A Shared Bibliography Entry},
  year = {2024},
}
`;

const WEB_LIBRARY = `@misc{nlab:locally_ringed_space,
  author = {{nLab authors}},
  title = {locally ringed space},
  howpublished = {\\url{https://ncatlab.org/nlab/show/locally+ringed+space}},
  note = {Revision 30},
  year = {2026},
}
`;

describe("Quarto bibliography union in the editor", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let fixtureRoot: string | undefined;
  let workspace: string | undefined;
  let chapterPath: string | undefined;
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  before(async function () {
    const fixture = await createFixture("zettlr-quarto-bibliography-union-e2e-", {
      documentName: "initial.md",
      documentContents: "# Initial\n",
    });
    fixtureRoot = fixture.root;
    workspace = path.dirname(fixture.documentPath);
    const chapterDirectory = path.join(workspace, "framework");
    chapterPath = path.join(chapterDirectory, "chapter.md");
    await mkdir(chapterDirectory);
    await writeFile(chapterPath, DOCUMENT, "utf8");
    await writeFile(
      path.join(workspace, "_quarto.yml"),
      `project:\n  type: book\nbook:\n  title: Citation fixture\n  chapters:\n    - framework/chapter.md\nbibliography:\n  - references.bib\n  - refs-web.bib\n`,
      "utf8",
    );

    const sharedLibraryPath = path.join(fixture.root, "shared-library.bib");
    await writeFile(sharedLibraryPath, SHARED_LIBRARY, "utf8");
    await symlink(sharedLibraryPath, path.join(workspace, "references.bib"));
    await writeFile(path.join(workspace, "refs-web.bib"), WEB_LIBRARY, "utf8");

    const configPath = path.join(fixture.configDirectory, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.app = { openFiles: [], openWorkspaces: [] };
    config.export = { cslLibrary: sharedLibraryPath, cslStyle: "" };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const app = await attach(fixture.configDirectory, rendererEvents, this.timeout(), {
      files: [chapterPath],
    });
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
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
    assertCleanExit(getOutput());
  });

  it("refreshes a citation after its Quarto bibliography sources become available", async function () {
    assert.ok(browser, "The application must be running");
    if (workspace === undefined) {
      throw new Error("The workspace path must be initialized");
    }
    const page = await findEditorPage(browser, this.timeout());
    const citation = page.locator(".citeproc-citation");
    await citation.waitFor({ timeout: this.timeout() });
    assert.equal(await citation.innerText(), "[@nlab:locally_ringed_space]");
    assert.equal(await citation.evaluate((element) => element.classList.contains("error")), true);

    await page.evaluate(async (projectPath) => {
      await window.ipc.invoke("application", {
        command: "roots-add",
        payload: [projectPath],
      });
    }, workspace);

    await page.waitForFunction(
      () => {
        const element = document.querySelector(".citeproc-citation");
        return element !== null && !element.classList.contains("error");
      },
      undefined,
      { timeout: 20_000 },
    );
    screenshots.set("quarto-bibliography-union.png", await page.screenshot());
    assert.equal(await citation.innerText(), "(nLab authors 2026)");
  });
});
