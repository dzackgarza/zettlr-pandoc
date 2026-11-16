/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Agent API operations against the assembled app E2E
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Starts the assembled app one time with the Agent API on
 *                  and calls nineteen operations over HTTP (#38). Each case
 *                  reads the effect of its operation where the app keeps
 *                  it: a file of the fixture, the text of the window, or a
 *                  later read of the API.
 *
 *                  The cases of the annotations and the review are one
 *                  journey on the open document. The author annotates a
 *                  phrase in the window. An agent answers with a review of
 *                  two proposals, a message on the thread and a comment on
 *                  the review, waits for the next change, and takes one
 *                  proposal back. Another program then writes the file two
 *                  times: the agent makes the frozen review live again
 *                  after the first write and removes it after the second.
 *
 *                  The four Zotero operations are not here: a run has no
 *                  network and no Zotero (AGENTS.md, section 13).
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createPatch } from "diff";
import type { Browser, Page } from "playwright";
import {
  AGENT_API_DISCOVERY_FILE,
  parseAgentApiDiscovery,
} from "source/app/service-providers/agent-api/discovery-file";
import type { components } from "source/types/generated/agent-api";
import { sha256Text } from "../source/common/util/sha256";
import {
  AGENT_API_AUTHORIZATION,
  type AgentClient,
  agentClient,
  assertCleanExit,
  attach,
  createFixture,
  delay,
  findEditorPage,
  preserveArtifacts,
  REPO_ROOT,
  readAgentApiPort,
  requireInitialized,
  shutdown,
} from "./support/electron-app";

type Schemas = components["schemas"];

const ARTIFACT_DIRECTORY = path.join(tmpdir(), "zettlr-agent-api-operations-e2e-latest");

// The open document. Each fact is a paragraph of its own, so a proposal of
// one fact is one hunk.
const DOCUMENT = [
  "# Lattices",
  "",
  "An even unimodular lattice has a rank that 8 divides.",
  "",
  "The Leech lattice has rank 24.",
  "",
  "The lattice E8 has 240 roots.",
  "",
].join("\n");
const ANNOTATED = "even unimodular";
const INSTRUCTION = "State the signature condition for the indefinite case.";
// The first proposal answers the annotation, the second is the one that the
// agent takes back.
const WITH_SIGNATURE = DOCUMENT.replace(
  "has a rank that 8 divides.",
  "has a rank that 8 divides, and a signature that 8 divides.",
);
const WITH_NORM = WITH_SIGNATURE.replace("has 240 roots.", "has 240 roots of norm 2.");
const AGENT_REPLY = "The proposal adds the signature condition after the rank.";
const REVIEW_COMMENT = "The first proposal answers the annotation of the author.";
const WAKING_COMMENT = "The second proposal is independent of the first.";
const FIRST_WRITE = `${DOCUMENT}\nThe lattice D4 has 24 roots.\n`;
const SECOND_WRITE = `${FIRST_WRITE}\nThe lattice A2 has 6 roots.\n`;

// A file of the workspace that no pane shows.
const CLOSED_DOCUMENT =
  "# Genus\n\nTwo lattices in one genus are isometric over each localization.\n";

const LIBRARY = `@article{Nik80,
  title = {Integral symmetric bilinear forms and some of their applications},
  author = {Nikulin, V. V.},
  year = 1980,
  journal = {Mathematics of the USSR-Izvestiya},
  volume = {14},
  pages = {103--167},
}
`;

const SKILL = "# Proof style\n\nPrefer diagrams to prose.\n";
const KEPT_FIGURE = "\\begin{tikzpicture}\n\\node {root lattice};\n\\end{tikzpicture}\n";
const NEW_FIGURE = "\\begin{tikzpicture}\n\\node {Leech lattice};\n\\end{tikzpicture}\n";
const REPLACED_FIGURE = "\\begin{tikzpicture}\n\\node {Niemeier lattice};\n\\end{tikzpicture}\n";

/** The operations of this file, as the contract names them. */
const OPERATIONS: ReadonlyArray<{ operationId: string; method: "get" | "post"; route: string }> = [
  { operationId: "getHelp", method: "get", route: "/help" },
  { operationId: "getCapabilities", method: "get", route: "/v1/capabilities" },
  { operationId: "getContext", method: "get", route: "/v1/context" },
  { operationId: "listViews", method: "get", route: "/v1/views" },
  { operationId: "searchWorkspace", method: "get", route: "/v1/workspace/search" },
  { operationId: "createWorkspaceEntry", method: "post", route: "/v1/workspace/entries" },
  { operationId: "searchDocument", method: "post", route: "/v1/documents/{documentId}/search" },
  { operationId: "listAnnotations", method: "get", route: "/v1/annotations" },
  { operationId: "getAnnotation", method: "get", route: "/v1/annotations/{annotationId}" },
  {
    operationId: "addAnnotationMessage",
    method: "post",
    route: "/v1/annotations/{annotationId}/messages",
  },
  { operationId: "addReviewComment", method: "post", route: "/v1/reviews/{reviewId}/comments" },
  { operationId: "reapplyReview", method: "post", route: "/v1/reviews/{reviewId}/reapply" },
  { operationId: "discardReview", method: "post", route: "/v1/reviews/{reviewId}/discard" },
  { operationId: "retractProposal", method: "post", route: "/v1/proposals/{packetId}/retract" },
  { operationId: "waitForReviewEvents", method: "get", route: "/v1/reviews/{reviewId}/events" },
  { operationId: "queryCitations", method: "get", route: "/v1/citations" },
  { operationId: "listMacros", method: "get", route: "/v1/macros" },
  { operationId: "queryFigures", method: "get", route: "/v1/figures" },
  { operationId: "saveFigure", method: "post", route: "/v1/figures" },
];

/** Polls `probe` until `holds` accepts its answer, and gives that answer. */
async function until<T>(
  probe: () => Promise<T>,
  holds: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!holds(last)) {
    assert.ok(Date.now() < deadline, `${what}. Last answer: ${JSON.stringify(last)}`);
    await delay(150);
    last = await probe();
  }
  return last;
}

/** The text that the editor of the window shows. */
async function editorText(page: Page): Promise<string> {
  return await page.locator(".main-editor-wrapper .cm-content").first().innerText();
}

/** The paths of the documents that hold text which is not on disk. */
function modifiedDocuments(page: Page): Promise<string[]> {
  return page.evaluate(
    async () =>
      await window.ipc.invoke("documents-provider", { command: "get-file-modification-status" }),
  );
}

/** The editor takes the text of the file, as "Load from disk" does. */
async function loadFromDisk(page: Page, documentPath: string): Promise<void> {
  await page.evaluate(
    async (pathInPage: string) =>
      await window.ipc.invoke("documents-provider", {
        command: "load-from-disk",
        payload: { path: pathInPage },
      }),
    documentPath,
  );
}

describe("assembled app: the operations of the Agent API", function () {
  let appProcess: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let api: AgentClient | undefined;
  let fixtureRoot: string | undefined;
  let configDirectory = "";
  let origin = "";
  let workspace = "";
  let documentPath = "";
  let closedPath = "";
  let libraryPath = "";
  let skillsRoot = "";
  let figuresRoot = "";
  let documentId = "";
  let annotationId = "";
  let reviewId = "";
  let packetIds: string[] = [];
  let getOutput: () => string = () => "";
  const rendererEvents: string[] = [];
  const screenshots = new Map<string, Buffer>();

  /** A request without the client of the harness: the status and the parsed body of each answer. */
  async function request(
    route: string,
    init: RequestInit,
  ): Promise<{ status: number; headers: Headers; body: unknown }> {
    const response = await fetch(`${origin}${route}`, init);
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body:
        text !== "" && response.headers.get("content-type")?.startsWith("application/json") === true
          ? JSON.parse(text)
          : text,
    };
  }

  /** The review as `getReview` answers it. */
  async function review(agent: AgentClient): Promise<Schemas["ReviewDetailResponse"]> {
    return (await agent.get(`/v1/reviews/${reviewId}`)) as Schemas["ReviewDetailResponse"];
  }

  /** The working text of the open document as `getDocument` answers it. */
  async function workingText(agent: AgentClient): Promise<string> {
    const read = (await agent.get(
      `/v1/documents/${documentId}?includeContent=true`,
    )) as Schemas["ReadDocumentResponse"];
    return read.content;
  }

  /** Another program writes the file, and the app freezes the review of the document. */
  async function writeFileUnderReview(agent: AgentClient, text: string): Promise<void> {
    await writeFile(documentPath, text, "utf8");
    await until(
      async () => (await review(agent)).state,
      (state) => state === "invalidated",
      "the app freezes the review of a document whose file another program wrote",
    );
  }

  before(async function () {
    const fixture = await createFixture("zettlr-agent-api-operations-e2e-", {
      documentName: "lattices.md",
      documentContents: DOCUMENT,
      config: {
        darkMode: false,
        // A save is an action of the author: no save writes a proposal into
        // the file while another program writes it.
        editor: { autoSave: "off" },
        window: { sidebarVisible: true },
      },
    });
    fixtureRoot = fixture.root;
    configDirectory = fixture.configDirectory;
    documentPath = fixture.documentPath;
    workspace = path.dirname(documentPath);
    closedPath = path.join(workspace, "genus.md");
    await writeFile(closedPath, CLOSED_DOCUMENT, "utf8");

    libraryPath = path.join(fixture.root, "references.bib");
    await writeFile(libraryPath, LIBRARY, "utf8");
    skillsRoot = path.join(fixture.root, "skills");
    await mkdir(path.join(skillsRoot, "proofs"), { recursive: true });
    await writeFile(path.join(skillsRoot, "proofs", "proof-style.md"), SKILL, "utf8");
    figuresRoot = path.join(fixture.root, "figures");
    await mkdir(path.join(figuresRoot, "diagrams"), { recursive: true });
    await writeFile(path.join(figuresRoot, "diagrams", "roots.tikz"), KEPT_FIGURE, "utf8");

    // The folders of the fixture have their paths after its creation.
    const configPath = path.join(configDirectory, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.agentApi = { enabled: true, port: 0, skillsDirectory: skillsRoot };
    config.export = { cslLibrary: libraryPath, cslStyle: "" };
    config.tikz = { figuresDir: figuresRoot };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const app = await attach(configDirectory, rendererEvents);
    appProcess = app.appProcess;
    browser = app.browser;
    getOutput = app.getOutput;
    const port = await readAgentApiPort(configDirectory, 60_000);
    origin = `http://127.0.0.1:${port}`;
    api = agentClient(port);
    page = await findEditorPage(app.browser, this.timeout());

    await page.locator(".cm-content").waitFor({ state: "visible", timeout: this.timeout() });
    // The id that the document routes take for the open document.
    const { documents } = (await api.get("/v1/documents")) as Schemas["DocumentListResponse"];
    assert.deepEqual(
      documents.map((open) => open.path),
      [documentPath],
    );
    documentId = documents[0].documentId;
  });

  after(async function () {
    try {
      // A case that stopped early can leave a frozen review and text that is
      // not on disk, and a quit would then ask about it. The agent removes
      // the review, and the editor takes the text of the file.
      if (page !== undefined && api !== undefined && (await modifiedDocuments(page)).length > 0) {
        const { reviews } = (await api.get("/v1/reviews")) as Schemas["ReviewListResponse"];
        for (const frozen of reviews.filter((entry) => entry.state === "invalidated")) {
          await api.post(`/v1/reviews/${frozen.reviewId}/discard`, {
            expectedReviewGeneration: frozen.generation,
          });
        }
        await loadFromDisk(page, documentPath);
        const deadline = Date.now() + 10_000;
        while ((await modifiedDocuments(page)).length > 0 && Date.now() < deadline) {
          await delay(50);
        }
      }
    } finally {
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
    }
    assertCleanExit(getOutput());
  });

  it("refuses a request that carries no token, and changes nothing for it (401 UNAUTHORIZED)", async function () {
    const refusedPath = path.join(workspace, "refused.md");
    const anonymous = await request("/v1/context", {});
    const foreign = await request("/v1/context", {
      headers: { authorization: "Bearer not-the-token-of-the-app" },
    });
    const write = await request("/v1/workspace/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: refusedPath, kind: "file", content: "refused\n" }),
    });

    for (const refused of [anonymous, foreign, write]) {
      assert.equal(refused.status, 401, JSON.stringify(refused.body));
      assert.equal(refused.headers.get("www-authenticate"), "Bearer");
      assert.equal((refused.body as Schemas["AgentErrorResponse"]).error.code, "UNAUTHORIZED");
    }
    await assert.rejects(
      stat(refusedPath),
      { code: "ENOENT" },
      "the refused request wrote no file",
    );
    assert.equal(
      (await request("/v1/context", { headers: AGENT_API_AUTHORIZATION })).status,
      200,
      "the same request with the token is answered",
    );
  });

  it("serves the contract to a caller without the token, with each operation of this file (/openapi.json)", async function () {
    const served = await request("/openapi.json", {});
    assert.equal(served.status, 200);
    const contract = served.body as {
      openapi: string;
      info: { version: string };
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    assert.match(contract.openapi, /^3\.1\./);
    assert.deepEqual(
      OPERATIONS.map(({ method, route }) => contract.paths[route]?.[method]?.operationId),
      OPERATIONS.map(({ operationId }) => operationId),
      "the served contract declares each operation at its route",
    );
    assert.deepEqual(
      Object.keys(contract.paths).filter((route) => route.startsWith("/v1/zotero")),
      [],
      "the served contract leaves out the Zotero routes",
    );
    assert.deepEqual(
      contract.servers.map((server) => server.url),
      [origin],
      "the contract names the listener that served it",
    );

    // The YAML encoding is the same document.
    const yaml = await request("/openapi.yaml", {});
    assert.equal(yaml.status, 200);
    assert.equal(yaml.headers.get("content-type"), "application/yaml");
    assert.ok(
      typeof yaml.body === "string" && yaml.body.includes(`version: ${contract.info.version}`),
      "the YAML document has the version of the JSON document",
    );
  });

  it("serves the authoring guide, and lists and reads the skills folder of the settings (getHelp)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");

    // The guide is HELP.md with the table of the theorem families at its mark.
    const [beforeTable, afterTable] = (
      await readFile(path.join(REPO_ROOT, "HELP.md"), "utf8")
    ).split("<!-- theorem-families -->");
    const markdown = await request("/help", { headers: AGENT_API_AUTHORIZATION });
    assert.equal(markdown.status, 200);
    assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.ok(typeof markdown.body === "string");
    assert.ok(markdown.body.startsWith(beforeTable), "the guide starts as HELP.md does");
    assert.ok(markdown.body.endsWith(afterTable), "the guide ends as HELP.md does");
    assert.ok(
      markdown.body.includes("| Theorem | `.theorem` | `#thm:key` |"),
      "the guide has the row of the theorem family",
    );
    const asJson = (await agent.get("/help?format=json")) as Schemas["HelpResponse"];
    assert.equal(asJson.help, markdown.body, "the JSON answer holds the same guide");

    const listed = (await agent.get(
      "/help?resource=skills&action=list",
    )) as Schemas["SkillsListResponse"];
    assert.equal(listed.root, skillsRoot);
    assert.deepEqual(
      listed.entries.map((entry) => [entry.path, entry.kind]),
      [
        ["proofs", "directory"],
        ["proofs/proof-style.md", "markdown"],
      ],
    );
    const skill = (await agent.get(
      "/help?resource=skills&action=read&path=proofs%2Fproof-style.md",
    )) as Schemas["SkillFileResponse"];
    assert.equal(skill.content, SKILL);
    assert.equal(skill.sha256, sha256Text(SKILL));
  });

  it("names the running instance and the version of the app (getCapabilities)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const capabilities = (await agent.get("/v1/capabilities")) as Schemas["CapabilitiesResponse"];

    const discovery = parseAgentApiDiscovery(
      await readFile(path.join(configDirectory, AGENT_API_DISCOVERY_FILE), "utf8"),
    );
    assert.equal(
      capabilities.instanceId,
      discovery.instanceId,
      "the instance is the one that wrote the discovery file of the fixture",
    );
    const packageMetadata = JSON.parse(
      await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { version: string };
    assert.equal(capabilities.applicationVersion, packageMetadata.version);
    const contract = (await request("/openapi.json", {})).body as { info: { version: string } };
    assert.equal(capabilities.protocolVersion, contract.info.version);
    assert.deepEqual(capabilities.supportedPatchFormats, ["unified-diff"]);
    assert.equal(capabilities.reviewSupport, true);
    assert.equal(capabilities.retractionSupport, true);
  });

  it("names the open document as the document that the author works in (getContext)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const editorPage = requireInitialized(page, "The editor page must be initialized");

    // The author works in a pane after a click in its editor.
    await editorPage.locator(".main-editor-wrapper .cm-content").first().click();
    const context = await until(
      async () => (await agent.get("/v1/context")) as Schemas["EditorContext"],
      (answer) => answer.focusedDocument !== undefined,
      "the context names a focused document after a click in the editor",
    );

    assert.deepEqual(
      context.openDocuments.map((open) => [
        open.documentId,
        open.path,
        open.name,
        open.type,
        open.dirty,
      ]),
      [[documentId, documentPath, "lattices.md", "markdown", false]],
    );
    const [open] = context.openDocuments;
    assert.equal(open.revision.sha256, sha256Text(DOCUMENT));
    assert.equal(open.lineCount, DOCUMENT.split("\n").length);
    assert.deepEqual(context.focusedDocument, open);
    assert.equal(context.focusedView?.documentId, documentId);
    assert.deepEqual(
      open.views.map((view) => [view.viewId, view.focused, view.active]),
      [[context.focusedView?.viewId, true, true]],
    );
  });

  it("lists the pane that shows the open document (listViews)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const { views } = (await agent.get("/v1/views")) as Schemas["ViewsResponse"];

    assert.deepEqual(
      views.map((view) => [view.documentId, view.focused, view.documents]),
      [[documentId, true, [{ documentId, path: documentPath }]]],
      "one pane, with the open document as its one tab",
    );
    const context = (await agent.get("/v1/context")) as Schemas["EditorContext"];
    assert.equal(views[0].viewId, context.focusedView?.viewId);
  });

  it("finds text of a file that no pane shows (searchWorkspace)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const found = (await agent.get(
      "/v1/workspace/search?text=isometric",
    )) as Schemas["WorkspaceSearchResponse"];

    assert.equal(found.matchCount, 1);
    assert.equal(found.truncated, false);
    assert.deepEqual(found.notSearched, []);
    assert.deepEqual(
      found.files.map((file) => [file.path, file.name, file.workspaceId, file.open]),
      [[closedPath, "genus.md", workspace, false]],
    );
    const from = CLOSED_DOCUMENT.indexOf("isometric");
    assert.deepEqual(
      found.files[0].matches.map((match) => [
        match.range,
        match.line,
        match.preview.inside,
        match.preview.after,
      ]),
      [[{ from, to: from + "isometric".length }, 3, "isometric", " over each localization."]],
    );

    // The word of both files is found in the open document too.
    const both = (await agent.get(
      "/v1/workspace/search?text=lattice&matchCase=true",
    )) as Schemas["WorkspaceSearchResponse"];
    assert.deepEqual(
      both.files.map((file) => [file.path, file.open, file.matches.map((match) => match.line)]),
      [
        [closedPath, false, [3]],
        [documentPath, true, [3, 5, 7]],
      ],
    );
  });

  it("creates a folder and a file in the workspace (createWorkspaceEntry)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const folderPath = path.join(workspace, "notes");
    const filePath = path.join(folderPath, "niemeier.md");
    const contents = "# Niemeier lattices\n\nThere are 24 of them.\n";

    const folder = (await agent.post("/v1/workspace/entries", {
      path: folderPath,
      kind: "folder",
    })) as Schemas["WorkspaceEntryResponse"];
    assert.deepEqual(folder, {
      kind: "folder",
      path: folderPath,
      name: "notes",
      workspaceId: workspace,
    });
    assert.ok((await stat(folderPath)).isDirectory(), "the folder is in the workspace");

    const file = (await agent.post("/v1/workspace/entries", {
      workspaceId: workspace,
      path: "notes/niemeier.md",
      kind: "file",
      content: contents,
    })) as Schemas["WorkspaceEntryResponse"];
    assert.deepEqual(file, {
      kind: "file",
      path: filePath,
      name: "niemeier.md",
      workspaceId: workspace,
    });
    assert.equal(await readFile(filePath, "utf8"), contents, "the file has the content");

    // The app reads the new file as a document of the workspace.
    const found = await until(
      async () =>
        (await agent.get(
          "/v1/workspace/search?text=Niemeier",
        )) as Schemas["WorkspaceSearchResponse"],
      (answer) => answer.files.length > 0,
      "the search of the workspace reads the new file",
    );
    assert.deepEqual(
      found.files.map((entry) => entry.path),
      [filePath],
    );
  });

  it("finds a word of the open document at its line and column (searchDocument)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const found = (await agent.post(`/v1/documents/${documentId}/search`, {
      literal: "Leech",
      context: 1,
    })) as Schemas["SearchDocumentResponse"];

    assert.equal(found.documentId, documentId);
    assert.equal(found.revision.sha256, sha256Text(DOCUMENT));
    assert.equal(found.truncated, false);
    assert.deepEqual(
      found.hits.map((hit) => [hit.line, hit.column, hit.length]),
      [[5, 5, 5]],
    );

    const absent = (await agent.post(`/v1/documents/${documentId}/search`, {
      literal: "isometric",
    })) as Schemas["SearchDocumentResponse"];
    assert.deepEqual(absent.hits, [], "a word of another file is not in this document");
  });

  it("returns the entry of the main library (queryCitations)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");

    const databases = (await agent.get(
      "/v1/citations?target=databases",
    )) as Schemas["CitationDatabasesResponse"];
    assert.deepEqual(
      databases.databases.map((database) => database.path),
      [libraryPath],
    );
    assert.deepEqual(databases.notLoaded, []);

    const items = (await agent.get("/v1/citations")) as Schemas["CitationItemsResponse"];
    assert.equal(items.count, 1);
    assert.deepEqual(
      items.items.map((item) => [item.id, item.title]),
      [["Nik80", "Integral symmetric bilinear forms and some of their applications"]],
    );

    const item = (await agent.get("/v1/citations?citeKey=Nik80")) as Schemas["CitationItem"];
    assert.deepEqual(item, items.items[0]);
  });

  it("lists the macros of ~/.pandoc with the source line of each (listMacros)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const inventory = (await agent.get("/v1/macros")) as Schemas["MacroInventoryResponse"];

    assert.equal(inventory.root, path.join(homedir(), ".pandoc", "styles", "macros"));
    assert.equal(inventory.count, inventory.macros.length);
    assert.deepEqual(inventory.notRead, []);

    // Each declaration is a line of a source file of the directory, without
    // the space around it.
    const sources = new Map<string, string[]>();
    let declarations = 0;
    for (const macro of inventory.macros) {
      for (const declaration of macro.declarations) {
        let lines = sources.get(declaration.sourcePath);
        if (lines === undefined) {
          lines = (await readFile(path.join(inventory.root, declaration.sourcePath), "utf8")).split(
            "\n",
          );
          sources.set(declaration.sourcePath, lines);
        }
        assert.equal(
          lines[declaration.line - 1].trim(),
          declaration.declaration,
          `${macro.name} is declared at ${declaration.sourcePath}:${declaration.line}`,
        );
        declarations += 1;
      }
    }
    assert.ok(declarations > 0, "the inventory holds declarations of the directory");

    // A query narrows the inventory to the macros that it matches.
    const declared = inventory.macros.find((macro) => macro.declarations.length > 0);
    assert.ok(declared !== undefined);
    const filtered = (await agent.get(
      `/v1/macros?query=${encodeURIComponent(declared.name)}`,
    )) as Schemas["MacroInventoryResponse"];
    assert.ok(filtered.count < inventory.count, "the query leaves macros out");
    assert.ok(
      filtered.macros.some((macro) => macro.name === declared.name),
      `the query holds ${declared.name}`,
    );
    assert.deepEqual(
      filtered.macros,
      inventory.macros.filter((macro) => filtered.macros.some((kept) => kept.name === macro.name)),
      "each macro of the query is the macro of the inventory",
    );
  });

  it("lists, reads and searches the figures folder of the settings (queryFigures)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");

    const listed = (await agent.get("/v1/figures")) as Schemas["FigureListResponse"];
    assert.equal(listed.root, figuresRoot);
    assert.deepEqual(
      listed.entries.map((entry) => [entry.path, entry.kind]),
      [
        ["diagrams", "directory"],
        ["diagrams/roots.tikz", "file"],
      ],
    );
    assert.equal(listed.count, 2);
    assert.equal(listed.entries[1].size, Buffer.byteLength(KEPT_FIGURE));

    const read = (await agent.get(
      "/v1/figures?action=read&path=diagrams%2Froots.tikz",
    )) as Schemas["FigureFileResponse"];
    assert.deepEqual(
      [read.path, read.encoding, read.content, read.sha256],
      ["diagrams/roots.tikz", "utf8", KEPT_FIGURE, sha256Text(KEPT_FIGURE)],
    );

    const searched = (await agent.get(
      "/v1/figures?action=search&query=root%20lattice",
    )) as Schemas["FigureSearchResponse"];
    assert.deepEqual(
      searched.hits.map((hit) => [hit.path, hit.matchType, hit.line]),
      [["diagrams/roots.tikz", "content", 2]],
    );
  });

  it("writes a new figure into the figures folder, which the listing then holds (saveFigure)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const figurePath = path.join(figuresRoot, "generated", "leech.tikz");

    const created = (await agent.post("/v1/figures", {
      path: "generated/leech.tikz",
      content: NEW_FIGURE,
    })) as Schemas["FigureFileResponse"];
    assert.deepEqual(
      [created.path, created.encoding, created.content, created.sha256],
      ["generated/leech.tikz", "utf8", NEW_FIGURE, sha256Text(NEW_FIGURE)],
    );
    assert.equal(await readFile(figurePath, "utf8"), NEW_FIGURE, "the figure is in the folder");

    const listed = (await agent.get("/v1/figures")) as Schemas["FigureListResponse"];
    assert.deepEqual(
      listed.entries.map((entry) => entry.path),
      ["diagrams", "generated", "diagrams/roots.tikz", "generated/leech.tikz"],
    );

    // A write replaces the figure.
    const written = (await agent.post("/v1/figures", {
      action: "write",
      path: "generated/leech.tikz",
      content: REPLACED_FIGURE,
    })) as Schemas["FigureFileResponse"];
    assert.equal(written.sha256, sha256Text(REPLACED_FIGURE));
    assert.equal(await readFile(figurePath, "utf8"), REPLACED_FIGURE, "the write replaced it");
  });

  it("lists the annotation that the author made in the window (listAnnotations)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    assert.deepEqual(
      ((await agent.get("/v1/annotations")) as Schemas["AnnotationListResponse"]).annotations,
      [],
      "no document has an annotation before the author makes one",
    );

    // The author annotates a phrase of the open document.
    const from = DOCUMENT.indexOf(ANNOTATED);
    const created = await editorPage.evaluate(
      async (input) => {
        const session = await window.ipc.invoke("documents-provider", {
          command: "get-collaboration-session",
          payload: { path: input.path },
        });
        if (session === undefined) {
          throw new Error(`No collaboration session for ${input.path}`);
        }
        return await window.ipc.invoke("documents:create-annotation", {
          ...input,
          expectedAnnotationGeneration: session.annotations.generation,
        });
      },
      { path: documentPath, from, to: from + ANNOTATED.length, instruction: INSTRUCTION },
    );
    assert.ok("annotationId" in created, `the annotation was created: ${JSON.stringify(created)}`);
    annotationId = created.annotationId;

    const { annotations } = (await agent.get(
      "/v1/annotations",
    )) as Schemas["AnnotationListResponse"];
    assert.deepEqual(
      annotations.map((annotation) => [
        annotation.annotationId,
        annotation.documentId,
        annotation.state,
        annotation.agentStatus.state,
        annotation.target,
        annotation.messages.map((message) => [message.author, message.text]),
      ]),
      [
        [
          annotationId,
          documentId,
          "open",
          "pending",
          {
            state: "range",
            quotedText: ANNOTATED,
            from,
            to: from + ANNOTATED.length,
            line: 3,
            column: 4,
            endLine: 3,
            endColumn: 4 + ANNOTATED.length,
          },
          [["owner", INSTRUCTION]],
        ],
      ],
    );

    // The filters of the listing: the document, and the state.
    const ofDocument = (await agent.get(
      `/v1/annotations?documentId=${documentId}&state=open`,
    )) as Schemas["AnnotationListResponse"];
    assert.deepEqual(ofDocument.annotations, annotations);
    const resolved = (await agent.get(
      "/v1/annotations?state=resolved",
    )) as Schemas["AnnotationListResponse"];
    assert.deepEqual(resolved.annotations, []);
  });

  it("reads the annotation with the proposal that answers it (getAnnotation)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const unanswered = (await agent.get(
      `/v1/annotations/${annotationId}`,
    )) as Schemas["AnnotationResponse"];
    assert.deepEqual(unanswered.proposalActions, []);

    // The agent submits a review of two proposals; the first answers the annotation.
    const submitted = (await agent.post("/v1/review-submissions", {
      document: { uri: documentPath },
      baseline: { sha256: sha256Text(DOCUMENT) },
      clientRequestId: "agent-api-operations-review",
      claims: [
        {
          description: "State the signature condition",
          patch: createPatch(documentPath, DOCUMENT, WITH_SIGNATURE, "", "", { context: 0 }),
          addressesAnnotationIds: [annotationId],
        },
        {
          description: "Name the norm of the roots",
          patch: createPatch(documentPath, WITH_SIGNATURE, WITH_NORM, "", "", { context: 0 }),
        },
      ],
    })) as Schemas["ReviewSubmissionResponse"];
    reviewId = submitted.reviewId;
    packetIds = submitted.packetIds;
    assert.equal(packetIds.length, 2);
    await until(
      async () => await editorText(editorPage),
      (text) => text.includes("of norm 2"),
      "the editor of the window shows the proposals",
    );

    const answered = (await agent.get(
      `/v1/annotations/${annotationId}`,
    )) as Schemas["AnnotationResponse"];
    assert.deepEqual(
      answered.proposalActions.map((action) => [action.packetId, action.reviewId]),
      [[packetIds[0], reviewId]],
      "the annotation names the proposal that answers it",
    );
    assert.equal(answered.documentId, documentId);
    assert.equal(answered.target.quotedText, ANNOTATED);
    assert.ok(
      answered.annotationGeneration > unanswered.annotationGeneration,
      "the link is a new version of the annotation",
    );
  });

  it("adds a message of the agent to the thread, which the window shows (addAnnotationMessage)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    const read = (await agent.get(
      `/v1/annotations/${annotationId}`,
    )) as Schemas["AnnotationResponse"];
    const row = editorPage.locator(
      `#annotations-panel .annotation-workspace-row[data-annotation-id="${annotationId}"]`,
    );
    assert.equal(
      await row.locator(".annotation-lifecycle-pill").innerText(),
      "Open",
      "the Annotations view shows the annotation as open before the agent answers",
    );

    const added = (await agent.post(`/v1/annotations/${annotationId}/messages`, {
      text: AGENT_REPLY,
      clientRequestId: "agent-api-operations-reply",
      markActed: true,
      expectedAnnotationGeneration: read.annotationGeneration,
    })) as Schemas["AddAnnotationMessageResponse"];
    assert.deepEqual(
      [added.annotationId, added.documentId, added.message.author, added.message.text],
      [annotationId, documentId, "agent", AGENT_REPLY],
    );
    assert.deepEqual(
      [added.agentStatus.state, "messageId" in added.agentStatus && added.agentStatus.messageId],
      ["acted", added.message.messageId],
      "the message is the disposition of the agent",
    );

    const answered = (await agent.get(
      `/v1/annotations/${annotationId}`,
    )) as Schemas["AnnotationResponse"];
    assert.deepEqual(
      answered.messages.map((message) => [message.author, message.text]),
      [
        ["owner", INSTRUCTION],
        ["agent", AGENT_REPLY],
      ],
    );
    assert.equal(answered.state, "open", "the message of an agent does not resolve the annotation");
    assert.equal(answered.annotationGeneration, added.annotationGeneration);

    // The window shows the disposition in the Annotations view, and the
    // message in the thread that the row of the annotation opens.
    await row.locator(".annotation-lifecycle-pill.acted").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await row.click();
    const thread = editorPage.locator(
      `.main-editor-wrapper .cm-collaborationControl-annotation-thread [data-annotation-detail][data-annotation-id="${annotationId}"]`,
    );
    await thread.waitFor({ state: "visible", timeout: 30_000 });
    assert.deepEqual(await thread.locator(".annotation-message-text").allInnerTexts(), [
      INSTRUCTION,
      AGENT_REPLY,
    ]);
    screenshots.set("annotation-thread.png", await editorPage.screenshot());
  });

  it("adds a comment to the review (addReviewComment)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const before = await review(agent);
    assert.deepEqual(before.comments, []);

    // The contract declares a ReviewDetailResponse for this answer, and the
    // app sends a ReviewCommentResponse. The case reads the one field that
    // both have; the review itself says what the comment did.
    const answer = (await agent.post(`/v1/reviews/${reviewId}/comments`, {
      expectedReviewGeneration: before.generation,
      text: REVIEW_COMMENT,
    })) as { reviewId: string };
    assert.equal(answer.reviewId, reviewId);

    const after = await review(agent);
    assert.deepEqual(
      after.comments.map((comment) => comment.text),
      [REVIEW_COMMENT],
    );
    assert.equal(after.generation, before.generation + 1, "the comment is a new generation");
    assert.equal(after.unresolvedChunks, 2, "a comment decides no proposal");
  });

  it("answers a wait with the next change of the review, or at its time limit (waitForReviewEvents)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const { generation } = await review(agent);
    const events = (after: number, waitSeconds: number): string =>
      `/v1/reviews/${reviewId}/events?afterGeneration=${after}&waitSeconds=${waitSeconds}`;

    // A generation that the caller has not seen answers without a wait.
    const behind = (await agent.get(events(generation - 1, 30))) as Schemas["ReviewEventsResponse"];
    assert.deepEqual(
      [behind.reviewId, behind.status?.generation, behind.events, behind.timedOut],
      [reviewId, generation, [], undefined],
    );

    // A wait at the current generation has no answer until the review
    // changes. The comment follows the request by a quarter of a second, so
    // the listener of the wait is in place when the comment arrives.
    const waiting = agent.get(events(generation, 60));
    await delay(250);
    await agent.post(`/v1/reviews/${reviewId}/comments`, {
      expectedReviewGeneration: generation,
      text: WAKING_COMMENT,
    });
    const woken = (await waiting) as Schemas["ReviewEventsResponse"];
    assert.equal(woken.timedOut, undefined);
    assert.equal(woken.status?.generation, generation + 1);
    assert.deepEqual(
      woken.events?.map((event) => [
        event.event,
        event.reviewId,
        event.documentId,
        event.reviewGeneration,
        event.comment,
      ]),
      [["review.commented", reviewId, documentId, generation + 1, WAKING_COMMENT]],
    );

    // A wait with no change answers at its limit.
    const quiet = (await agent.get(events(generation + 1, 1))) as Schemas["ReviewEventsResponse"];
    assert.deepEqual([quiet.timedOut, quiet.status?.generation], [true, generation + 1]);
  });

  it("takes a proposal back out of the document (retractProposal)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const editorPage = requireInitialized(page, "The editor page must be initialized");
    assert.equal(await workingText(agent), WITH_NORM, "the document holds both proposals");
    const chunks = (await agent.get(
      `/v1/reviews/${reviewId}?view=chunks`,
    )) as Schemas["ReviewChunksResponse"];
    assert.deepEqual(
      chunks.chunks.map((chunk) => chunk.packetIds),
      packetIds.map((packetId) => [packetId]),
    );

    const retracted = (await agent.post(`/v1/proposals/${packetIds[1]}/retract`, {
      expectedReviewGeneration: chunks.generation,
      expectedWorkingSha256: chunks.workingSha256,
    })) as Schemas["RetractProposalResponse"];
    assert.deepEqual(
      [
        retracted.retracted,
        retracted.packetId,
        retracted.reviewId,
        retracted.documentId,
        retracted.unresolvedChunks,
        retracted.documentRevision.sha256,
      ],
      [true, packetIds[1], reviewId, documentId, 1, sha256Text(WITH_SIGNATURE)],
    );

    const after = await review(agent);
    assert.deepEqual(
      [after.state, after.unresolvedChunks, after.generation, after.documentRevision?.sha256],
      ["active", 1, retracted.reviewGeneration, sha256Text(WITH_SIGNATURE)],
    );
    assert.equal(await workingText(agent), WITH_SIGNATURE, "the document holds the first proposal");
    await until(
      async () => await editorText(editorPage),
      (text) => !text.includes("of norm 2") && text.includes("a signature that 8 divides"),
      "the editor of the window shows the first proposal and not the second",
    );
    screenshots.set("proposal-retracted.png", await editorPage.screenshot());
    assert.equal(await readFile(documentPath, "utf8"), DOCUMENT, "a proposal writes no file");
  });

  it("makes a review live again that a write of the file froze (reapplyReview)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");

    await writeFileUnderReview(agent, FIRST_WRITE);
    const frozen = await review(agent);
    assert.equal(frozen.unresolvedChunks, 1, "the frozen review keeps its proposal");

    const reapplied = (await agent.post(`/v1/reviews/${reviewId}/reapply`, {
      expectedReviewGeneration: frozen.generation,
    })) as Schemas["ReapplyReviewResponse"];
    assert.deepEqual(
      [
        reapplied.reviewId,
        reapplied.documentId,
        reapplied.state,
        reapplied.unresolvedChunks,
        reapplied.withdrawnChunkIds,
      ],
      [reviewId, documentId, "active", 1, []],
    );

    const after = await review(agent);
    assert.deepEqual(
      [after.state, after.unresolvedChunks, after.generation],
      ["active", 1, reapplied.reviewGeneration],
      "the review is live again with its proposal",
    );
    assert.equal(
      await workingText(agent),
      WITH_SIGNATURE,
      "the open document keeps its text with the proposal",
    );
    assert.equal(await readFile(documentPath, "utf8"), FIRST_WRITE, "the file keeps its text");
  });

  it("removes a review that a write of the file froze, and the file keeps its text (discardReview)", async function () {
    const agent = requireInitialized(api, "The Agent API client must be initialized");
    const editorPage = requireInitialized(page, "The editor page must be initialized");

    await writeFileUnderReview(agent, SECOND_WRITE);
    const frozen = await review(agent);

    const discarded = (await agent.post(`/v1/reviews/${reviewId}/discard`, {
      expectedReviewGeneration: frozen.generation,
    })) as Schemas["DiscardReviewResponse"];
    assert.deepEqual(discarded, { reviewId, documentId });

    const gone = await request(`/v1/reviews/${reviewId}`, { headers: AGENT_API_AUTHORIZATION });
    assert.equal(gone.status, 404, JSON.stringify(gone.body));
    assert.equal((gone.body as Schemas["AgentErrorResponse"]).error.code, "REVIEW_NOT_FOUND");
    assert.deepEqual(
      ((await agent.get("/v1/reviews")) as Schemas["ReviewListResponse"]).reviews,
      [],
      "no document has a review",
    );
    assert.equal(await readFile(documentPath, "utf8"), SECOND_WRITE, "the file keeps its text");

    // The author takes the text of the file, and no document holds text
    // that is not on disk: the quit of the app asks nothing.
    await loadFromDisk(editorPage, documentPath);
    await until(
      async () => await editorText(editorPage),
      (text) => text.includes("The lattice A2 has 6 roots."),
      "the editor of the window shows the text of the file",
    );
    await until(
      async () => await modifiedDocuments(editorPage),
      (modified) => modified.length === 0,
      "no document holds text that is not on disk",
    );
    assert.equal(await workingText(agent), SECOND_WRITE);
    screenshots.set("review-discarded.png", await editorPage.screenshot());
  });
});
