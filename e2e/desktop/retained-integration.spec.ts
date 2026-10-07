import { strict as assert } from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createPatch } from "diff";
import { type Browser, chromium, type Page } from "playwright";
import { stringify } from "yaml";
import type { components } from "../../source/types/generated/agent-api";
import {
  createFixture,
  type Fixture,
  findEditorPage,
  REPO_ROOT,
  readAgentApiPort,
  requireInitialized,
  shutdown,
  waitForDevTools,
} from "../support/electron-app";

type Submitted = components["schemas"]["ReviewSubmissionResponse"];
type ReadDocument = components["schemas"]["ReadDocumentResponse"];
const chapter =
  "# Bibliography integration\n\nA mixed-source cluster [@Shared24, pp. 12-14; @Web26].\n\nEnd of chapter.\n";
const baseline = "# Review target\n\nThe form is symmetric.\n";
const proposed = "# Review target\n\nThe form is symmetric and nondegenerate.\n";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("retained integration in packaged Electron", function () {
  this.timeout(180_000);
  let fixture: Fixture;
  let app: Browser | undefined;
  let appProcess: ChildProcess | undefined;
  let page: Page | undefined;
  let api: string;
  let targetPath: string;
  const events: string[] = [];

  before(async function () {
    fixture = await createFixture("zettlr-retained-packaged-", {
      documentName: "chapter.md",
      documentContents: chapter,
      config: { agentApi: { enabled: true, port: 0 }, editor: { autoSave: "off" } },
    });
    const workspace = path.dirname(fixture.documentPath);
    targetPath = path.join(workspace, "review-target.md");
    await writeFile(targetPath, baseline);
    await writeFile(
      path.join(workspace, "_quarto.yml"),
      stringify({
        project: { type: "book" },
        book: { title: "Integration", chapters: ["chapter.md"] },
        bibliography: ["first.bib", "second.bib"],
      }),
    );
    await writeFile(
      path.join(workspace, "first.bib"),
      "@book{Shared24, author={Shared, Ada}, title={Forms}, year={2024}}\n",
    );
    await writeFile(
      path.join(workspace, "second.bib"),
      "@book{Web26, author={Webster, Ben}, title={Spaces}, year={2026}}\n",
    );
    appProcess = spawn(
      path.join(REPO_ROOT, "out/Zettlr-Pandoc-linux-x64/zettlr-pandoc"),
      [
        `--data-dir=${fixture.configDirectory}`,
        "--remote-debugging-port=0",
        "--no-sandbox",
        "--ozone-platform=x11",
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    appProcess.stdout?.on("data", (chunk: Buffer) => events.push(chunk.toString()));
    appProcess.stderr?.on("data", (chunk: Buffer) => events.push(chunk.toString()));
    app = await chromium.connectOverCDP(
      await waitForDevTools(appProcess, () => events.join(""), 60_000),
    );
    await app.contexts()[0].tracing.start({ screenshots: true, snapshots: true, sources: true });
    api = `http://127.0.0.1:${await readAgentApiPort(fixture.configDirectory, 60_000)}`;
    page = await findEditorPage(app, 60_000);
    const editor = requireInitialized(page, "The packaged editor did not open");
    editor.on("pageerror", (error) => events.push(error.stack ?? error.message));
    await editor.setViewportSize({ width: 1440, height: 1000 });
  });

  after(async function () {
    if (page !== undefined && !page.isClosed()) {
      await page.screenshot({ path: path.join(fixture.root, "final-state.png") });
    }
    if (app !== undefined) {
      await app.contexts()[0].tracing.stop({ path: path.join(fixture.root, "trace.zip") });
    }
    await shutdown(app, appProcess);
    await writeFile(path.join(fixture.root, "electron.log"), events.join("\n"));
    console.log(`Packaged integration artifacts: ${fixture.root}`);
  });

  it("renders a citation cluster from both Quarto bibliographies with its locator", async function () {
    const editor = requireInitialized(page, "The editor must be running");
    await editor.waitForFunction(
      () => {
        const text = document.querySelector(".citeproc-citation")?.textContent;
        return (
          text?.includes("Shared") &&
          text.includes("Webster") &&
          text.includes("12") &&
          text.includes("14")
        );
      },
      undefined,
      { timeout: 30_000 },
    );
    const rendered = await editor.locator(".citeproc-citation").innerText();
    assert.match(rendered, /Shared.*2024/);
    assert.match(rendered, /Webster.*2026/);
    assert.match(rendered, /12[–-]14/);
    const citations = await editor.evaluate(async (documentPath) => {
      const state = await window.ipc.invoke("reference-provider", { command: "get-snapshot" });
      return state.snapshots.find((snapshot) => snapshot.documentPath === documentPath)?.citations;
    }, fixture.documentPath);
    assert.deepEqual(
      citations?.[0].items.map((item) => item.id),
      ["Shared24", "Web26"],
    );
    assert.equal(citations?.[0].items[0].locator, "12-14");
    await editor.screenshot({ path: path.join(fixture.root, "mixed-bibliography.png") });
  });

  it("submits reviews without opening or selecting a tab", async function () {
    const editor = requireInitialized(page, "The editor must be running");
    const focusedDocumentId = async (): Promise<string | undefined> => {
      const context: components["schemas"]["EditorContext"] = await (
        await fetch(`${api}/v1/context`)
      ).json();
      return context.focusedDocument?.documentId;
    };
    const selected = await focusedDocumentId();
    assert.equal(typeof selected, "string", "the chapter must be the selected document");
    const request = {
      document: { uri: targetPath },
      baseline: { sha256: sha256(baseline) },
      patch: createPatch(targetPath, baseline, proposed),
      description: "Specify nondegeneracy.",
      clientRequestId: "packaged-submission",
    };
    const submitted = await fetch(`${api}/v1/review-submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(submitted.status, 200, await submitted.clone().text());
    const result: Submitted = await submitted.json();
    const read: ReadDocument = await (
      await fetch(`${api}/v1/documents/${result.documentId}?includeContent=true`)
    ).json();
    assert.equal(read.content, proposed);
    assert.equal(await focusedDocumentId(), selected);
    assert.equal(
      await editor.locator(`[role="tab"][data-path="${targetPath}"]`).count(),
      0,
      "a review of a closed document must not open a tab",
    );
    const stale = await fetch(`${api}/v1/review-submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, clientRequestId: "packaged-stale" }),
    });
    assert.equal(stale.status, 412);
    assert.equal((await stale.json()).error.code, "BASELINE_MISMATCH");
    const replay = await fetch(`${api}/v1/review-submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, baseline: undefined }),
    });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error.code, "IDEMPOTENCY_CONFLICT");
    const updatedChapter = chapter.replace("End of chapter.", "The chapter is complete.");
    const visible = await fetch(`${api}/v1/review-submissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        document: { uri: fixture.documentPath },
        patch: createPatch(fixture.documentPath, chapter, updatedChapter),
        description: "Complete the closing sentence.",
        clientRequestId: "packaged-visible",
      }),
    });
    assert.equal(visible.status, 200, await visible.clone().text());
    // A review of the document the user is reading appears in its editor.
    await editor.waitForFunction(() =>
      document.querySelector(".cm-content")?.textContent?.includes("The chapter is complete."),
    );
    assert.equal(await focusedDocumentId(), selected);
    await editor.screenshot({ path: path.join(fixture.root, "review-submission.png") });
  });
});
