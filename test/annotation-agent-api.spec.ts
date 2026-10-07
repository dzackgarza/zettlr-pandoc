/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Annotation agent API integration tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     Drives the real embedded HTTP server (real DocumentManager,
 *                   real files, real sidecar persistence) against the
 *                   `/v1/annotations` surface: collection and item reads,
 *                   idempotent message posting, generation fencing, and the
 *                   absence of any owner-only lifecycle operation (I3). Mirrors
 *                   the harness in agent-http-api.spec.ts, which owns the rest
 *                   of this same server's contract.
 *
 * END HEADER
 */

// Installs process-wide test doubles; it must load before the modules that read them.
import "./headless-electron-harness.cjs";
import { sha256Text } from "@common/util/sha256";
import { WikilinkIndex } from "@common/util/wikilink-resolution";
import type { AgentApiComponents } from "@dts/common/agent-api";
import type { CodeFileDescriptor } from "@dts/common/fsal";
import Ajv2020 from "ajv/dist/2020";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import http from "http";
import os from "os";
import path from "path";
import AgentHTTPProvider from "source/app/service-providers/agent-api/http-server";
import DocumentLintProvider from "source/app/service-providers/document-lint";
import DocumentManager from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";
import { SearchProvider } from "source/app/service-providers/search";
import { parse as parseYaml } from "yaml";
import { userData } from "./headless-electron-harness.cjs";

// ============================================================================
// Schema conformance — validates every response against the OpenAPI document
// the server itself publishes, the same way agent-http-api.spec.ts does.
// ============================================================================

const openApiDocument = parseYaml(
  readFileSync(
    path.join(__dirname, "../source/app/service-providers/agent-api/openapi.yaml"),
    "utf8",
  ),
) as { components: { schemas: Record<string, unknown> } };

const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const [name, schema] of Object.entries(openApiDocument.components.schemas)) {
  ajv.addSchema(schema as object, `#/components/schemas/${name}`);
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type AgentApiSchemas = AgentApiComponents["schemas"];

/** Parse a response body and prove that it conforms to the named OpenAPI schema. */
function parseAs<N extends keyof AgentApiSchemas & string>(
  body: string,
  schemaName: N,
): AgentApiSchemas[N] {
  const value: JsonValue = JSON.parse(body);
  if (ajv.validate<AgentApiSchemas[N]>(`#/components/schemas/${schemaName}`, value)) {
    return value;
  }
  assert.fail(`Response does not conform to ${schemaName}: ${ajv.errorsText()}\n${body}`);
}

/** Line/column computed independently of the server's own offsetToLineColumn. */
function referenceLineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, column: before[before.length - 1].length + 1 };
}

describe("Annotation Agent API (/v1/annotations)", function () {
  let scratch: string;
  let provider: DocumentManager;
  let httpProvider: AgentHTTPProvider;
  let httpPort: number;
  let openWorkspaces: string[] = [];

  function descriptorFor(filePath: string): CodeFileDescriptor {
    const stat = statSync(filePath);
    return {
      path: filePath,
      dir: path.dirname(filePath),
      name: path.basename(filePath),
      ext: path.extname(filePath),
      type: "code",
      size: stat.size,
      modtime: stat.mtimeMs,
      creationtime: stat.birthtimeMs,
      bom: "",
      linefeed: "\n",
    };
  }

  function normalizedRead(filePath: string): string {
    return readFileSync(filePath, "utf8")
      .split(/\r\n|\n\r|\n|\r/g)
      .join("\n");
  }

  async function createProvider(): Promise<DocumentManager> {
    const userDataDir = path.join(os.tmpdir(), "zettlr-pandoc-annotation-api-test");
    mkdirSync(userDataDir, { recursive: true });
    mkdirSync(path.join(userDataDir, "logs"), { recursive: true });
    rmSync(path.join(userDataDir, "documents.yaml"), { force: true });

    const watcherSeam = {
      on: () => {},
      getWatched: () => ({}),
      watchPath: (_path: string) => {},
      unwatchPath: (_path: string) => {},
      shutdown: async () => {},
    };
    let activeWindowId = "";
    const appSeam = {
      log: new LogProvider(),
      config: {
        get: () => ({
          app: { openFiles: [], openWorkspaces },
          system: { avoidNewTabs: false },
          editor: { autoSave: "off" as const },
          files: {
            images: { openWith: "zettlr" as const },
            pdf: { openWith: "zettlr" as const },
          },
          appLang: "en-US",
          alwaysReloadFiles: false,
          agentApi: { enabled: true, port: httpPort },
        }),
        addPath: (_path: string) => false,
        set: (_key: string, _value: unknown) => {},
      },
      fsal: {
        getWatchdog: () => watcherSeam,
        testAccess: async () => true,
        getDescriptorForAnySupportedFile: async (filePath: string) => descriptorFor(filePath),
        loadAnySupportedFile: async (filePath: string) => normalizedRead(filePath),
        writeTextFile: async (filePath: string, content: string) => {
          writeFileSync(filePath, content, "utf8");
        },
        getDescriptorFor: async (filePath: string) => descriptorFor(filePath),
        getFilesystemMetadata: async (_filePath: string) => ({ modtime: 0 }),
        readDirectoryRecursively: async (workspacePath: string) =>
          readdirSync(workspacePath, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(entry.parentPath, entry.name)),
      },
      citeproc: { synchronizeDatabases: async (_libraries: string[]) => {} },
      recentDocs: {
        add: (_path: string) => {},
        markEdited: (_path: string) => {},
      },
      stats: { updateCounts: (_words: number, _chars: number) => {} },
      windows: {
        askSaveChanges: async (_detail?: string) => ({
          response: 2,
          checkboxChecked: false,
        }),
        getFirstMainWindow: () => undefined,
        getMainWindowKey: (_window: unknown) => activeWindowId,
      },
      references: {
        reportAuthorityBuffer: (_filePath: string) => {},
        dropAuthorityBuffer: (_filePath: string) => {},
      },
    };

    const manager = new DocumentManager(appSeam);
    await manager.boot();
    activeWindowId = manager.windowKeys()[0];
    return manager;
  }

  // The Search view's provider over the scratch workspace. The FSAL seam walks
  // and reads the real files, and open documents are read through the real
  // document manager, so the search sees what the editor shows.
  function createSearch(): SearchProvider {
    return new SearchProvider(
      new LogProvider(),
      {
        readDirectoryRecursively: async (workspacePath: string) =>
          readdirSync(workspacePath, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(entry.parentPath, entry.name)),
        isFile: async (filePath: string) => statSync(filePath).isFile(),
        getDescriptorForAnySupportedFile: async (filePath: string) => descriptorFor(filePath),
        loadAnySupportedFile: async (filePath: string) => normalizedRead(filePath),
      },
      { get: () => ({ app: { openWorkspaces, openFiles: [] } }) },
      provider,
      userData,
    );
  }

  async function openFile(filePath: string, content: string): Promise<string> {
    writeFileSync(filePath, content, "utf8");
    await provider.getDocument(filePath);
    const docId = provider.getDocumentId(filePath);
    assert.ok(docId !== undefined, "documentId must be assigned");
    return docId;
  }

  async function httpRequest(
    method: string,
    pathname: string,
    options: { body?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: httpPort,
          path: pathname,
          method,
          headers: { "Content-Type": "application/json", ...options.headers },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      if (options.body !== undefined) {
        req.write(options.body);
      }
      req.end();
    });
  }

  async function postMessage(
    annotationId: string,
    body: {
      text: string;
      clientRequestId: string;
      expectedAnnotationGeneration: number;
      markActed?: boolean;
    },
  ): Promise<{ status: number; body: string }> {
    return httpRequest("POST", `/v1/annotations/${annotationId}/messages`, {
      body: JSON.stringify(body),
    });
  }

  async function postProposal(
    documentId: string,
    body: {
      baselineSha256: string;
      expectedReviewGeneration: number;
      clientRequestId: string;
      claims: Array<{
        description: string;
        patch: string;
        addressesAnnotationIds?: string[];
      }>;
    },
  ): Promise<{ status: number; body: string }> {
    return httpRequest("POST", `/v1/documents/${documentId}/proposals`, {
      body: JSON.stringify(body),
    });
  }

  beforeEach(async function () {
    scratch = mkdtempSync(path.join(os.tmpdir(), "zettlr-annotation-api-"));
    openWorkspaces = [scratch];

    provider = await createProvider();
    const config = {
      get: () => ({
        app: { openWorkspaces },
        export: { cslLibrary: "" },
        tikz: { dataDir: "", figuresDir: "" },
        editor: { lint: { flowmark: { timeoutMs: 60_000 } } },
        agentApi: {
          enabled: true,
          port: 0,
          claimDescriptionSimilarityThreshold: 0.94,
          skillsDirectory: null,
        },
      }),
    };
    httpProvider = new AgentHTTPProvider(new LogProvider(), provider, {
      config,
      links: { index: new WikilinkIndex([]) },
      search: createSearch(),
      documentLint: new DocumentLintProvider({
        log: new LogProvider(),
        config,
        buffers: provider,
        homeDirectory: scratch,
        env: {},
        userDataDirectory: scratch,
      }),
    });
    await httpProvider.boot();
    httpPort = Number.parseInt(
      readFileSync(path.join(userData, "agent-api.port"), "utf8").trim(),
      10,
    );
    assert.ok(Number.isInteger(httpPort) && httpPort > 0);
  });

  afterEach(async function () {
    await httpProvider.shutdown();
    await provider.shutdown();
    rmSync(scratch, { recursive: true, force: true });
  });

  // ==========================================================================
  // Reads and schema conformance
  // ==========================================================================

  it("lists an open annotation across the workspace with a UTF-16 line/column target", async function () {
    const content = "The quick brown fox jumps.\nover the lazy dog.\n";
    const filePath = path.join(scratch, "fox.md");
    const documentId = await openFile(filePath, content);
    const from = content.indexOf("brown fox");
    const to = from + "brown fox".length;
    const created = await provider.createAnnotation(
      documentId,
      "owner",
      from,
      to,
      "Rewrite this to name the actual animal.",
      0,
    );
    assert.ok("annotationId" in created, "fixture creation must succeed");

    const listed = await httpRequest("GET", "/v1/annotations");
    assert.equal(listed.status, 200);
    const parsed = parseAs(listed.body, "AnnotationListResponse");
    assert.equal(parsed.annotations.length, 1);
    const [annotation] = parsed.annotations;
    assert.equal(annotation.annotationId, created.annotationId);
    assert.equal(annotation.documentId, documentId);
    assert.equal(annotation.state, "open");
    assert.equal(annotation.target.state, "range");
    assert.equal(annotation.target.quotedText, "brown fox");
    assert.equal(annotation.target.from, from);
    assert.equal(annotation.target.to, to);
    const expectedStart = referenceLineColumn(content, from);
    const expectedEnd = referenceLineColumn(content, to);
    assert.equal(annotation.target.line, expectedStart.line);
    assert.equal(annotation.target.column, expectedStart.column);
    assert.equal(annotation.target.endLine, expectedEnd.line);
    assert.equal(annotation.target.endColumn, expectedEnd.column);
    assert.equal(annotation.messages.length, 1);
    assert.equal(annotation.messages[0].author, "owner");
    assert.equal(annotation.messages[0].text, "Rewrite this to name the actual animal.");
  });

  it("computes line and column correctly for a target that crosses a line break", async function () {
    const content = "First line here.\nSecond line has the target inside it.\nThird.\n";
    const filePath = path.join(scratch, "multiline.md");
    const documentId = await openFile(filePath, content);
    const from = content.indexOf("here.\nSecond line");
    const to = from + "here.\nSecond line".length;
    await provider.createAnnotation(documentId, "owner", from, to, "Spans two lines.", 0);

    const response = await httpRequest("GET", `/v1/annotations?documentId=${documentId}`);
    assert.equal(response.status, 200);
    const parsed = parseAs(response.body, "AnnotationListResponse");
    const [annotation] = parsed.annotations;
    const expectedStart = referenceLineColumn(content, from);
    const expectedEnd = referenceLineColumn(content, to);
    assert.equal(expectedStart.line, 1);
    assert.equal(expectedEnd.line, 2);
    assert.equal(annotation.target.line, expectedStart.line);
    assert.equal(annotation.target.column, expectedStart.column);
    assert.equal(annotation.target.endLine, expectedEnd.line);
    assert.equal(annotation.target.endColumn, expectedEnd.column);
  });

  it("scopes GET /v1/annotations?documentId={documentId} to that document alone", async function () {
    const contentA = "Document A body text for scoping.\n";
    const contentB = "Document B body text for scoping.\n";
    const docA = await openFile(path.join(scratch, "a.md"), contentA);
    const docB = await openFile(path.join(scratch, "b.md"), contentB);
    await provider.createAnnotation(docA, "owner", 0, 8, "About A.", 0);
    await provider.createAnnotation(docB, "owner", 0, 8, "About B.", 0);

    const onlyA = await httpRequest("GET", `/v1/annotations?documentId=${docA}`);
    const parsedA = parseAs(onlyA.body, "AnnotationListResponse");
    assert.equal(parsedA.annotations.length, 1);
    assert.equal(parsedA.annotations[0].documentId, docA);

    const across = await httpRequest("GET", "/v1/annotations");
    const parsedAcross = parseAs(across.body, "AnnotationListResponse");
    assert.equal(parsedAcross.annotations.length, 2);
  });

  it("GET /v1/annotations/{annotationId} returns full detail and 404s for an unknown id", async function () {
    const content = "Some document text to annotate.\n";
    const documentId = await openFile(path.join(scratch, "detail.md"), content);
    const created = await provider.createAnnotation(documentId, "owner", 0, 4, "Note.", 0);
    assert.ok("annotationId" in created);

    const found = await httpRequest("GET", `/v1/annotations/${created.annotationId}`);
    assert.equal(found.status, 200);
    const parsed = parseAs(found.body, "AnnotationResponse");
    assert.equal(parsed.annotationId, created.annotationId);

    const missing = await httpRequest("GET", "/v1/annotations/does-not-exist");
    assert.equal(missing.status, 404);
    const error = parseAs(missing.body, "AgentErrorResponse");
    assert.equal(error.error.code, "ANNOTATION_NOT_FOUND");
  });

  it("filters GET /v1/annotations by state", async function () {
    const content = "Annotate this line of text please.\n";
    const documentId = await openFile(path.join(scratch, "state.md"), content);
    const resolvedAnnotation = await provider.createAnnotation(
      documentId,
      "owner",
      0,
      9,
      "Resolve this note.",
      0,
    );
    assert.ok("annotationId" in resolvedAnnotation);
    const resolved = await provider.resolveAnnotation(
      documentId,
      resolvedAnnotation.annotationId,
      "owner",
      1,
    );
    assert.ok("annotationId" in resolved);

    const openAnnotation = await provider.createAnnotation(
      documentId,
      "owner",
      10,
      14,
      "Keep this note open.",
      2,
    );
    assert.ok("annotationId" in openAnnotation);

    const allList = parseAs(
      (await httpRequest("GET", "/v1/annotations")).body,
      "AnnotationListResponse",
    );
    assert.deepEqual(
      new Set(allList.annotations.map((annotation) => annotation.annotationId)),
      new Set([resolvedAnnotation.annotationId, openAnnotation.annotationId]),
      "omitting state must not hide resolved annotations",
    );

    const openList = parseAs(
      (await httpRequest("GET", "/v1/annotations?state=open")).body,
      "AnnotationListResponse",
    );
    assert.equal(openList.annotations.length, 1);
    assert.equal(openList.annotations[0].annotationId, openAnnotation.annotationId);

    const resolvedList = parseAs(
      (await httpRequest("GET", "/v1/annotations?state=resolved")).body,
      "AnnotationListResponse",
    );
    assert.equal(resolvedList.annotations.length, 1);
    assert.equal(resolvedList.annotations[0].annotationId, resolvedAnnotation.annotationId);
    assert.equal(resolvedList.annotations[0].state, "resolved");
  });

  // ==========================================================================
  // Closed documents — read parity with the UI workspace panel
  // ==========================================================================

  it("serves and updates a closed document's annotations through its sidecar, including acted state", async function () {
    const content = "This sentence stays annotated after its tab closes.\n";
    const filePath = path.join(scratch, "closed.md");
    const documentId = await openFile(filePath, content);
    const created = await provider.createAnnotation(
      documentId,
      "owner",
      0,
      13,
      "Explain the persistence contract.",
      0,
    );
    assert.ok("annotationId" in created);
    const annotationId = created.annotationId;

    // Close: detachCollaboration persists the sidecar and drops the live state.
    await provider.closeFileEverywhere(filePath);
    assert.equal(
      provider.annotationQueries.getAnnotations(documentId).items.length,
      0,
      "closing must drop the in-memory state",
    );

    // The listing must still show it — exactly what the UI panel shows for
    // a closed document, from the sidecar.
    const listed = parseAs(
      (await httpRequest("GET", "/v1/annotations")).body,
      "AnnotationListResponse",
    );
    assert.equal(listed.annotations.length, 1);
    assert.equal(listed.annotations[0].annotationId, annotationId);
    assert.equal(listed.annotations[0].documentId, documentId);
    assert.equal(listed.annotations[0].state, "open");
    assert.equal(listed.annotations[0].target.state, "range");
    assert.equal(listed.annotations[0].target.quotedText, "This sentence");
    // Line/column still resolve: the sidecar carries the working text the
    // anchors were measured against.
    const expectedStart = referenceLineColumn(content, 0);
    assert.equal(listed.annotations[0].target.line, expectedStart.line);
    assert.equal(listed.annotations[0].target.column, expectedStart.column);

    // Scoped reads agree, and by-id detail agrees.
    const scoped = parseAs(
      (await httpRequest("GET", `/v1/annotations?documentId=${documentId}`)).body,
      "AnnotationListResponse",
    );
    assert.equal(scoped.annotations.length, 1);
    assert.equal(scoped.annotations[0].annotationId, annotationId);
    const detail = parseAs(
      (await httpRequest("GET", `/v1/annotations/${annotationId}`)).body,
      "AnnotationResponse",
    );
    assert.equal(detail.annotationId, annotationId);
    assert.equal(detail.messages.length, 1);

    // The agent workflow is workspace-wide: replying and recording completed
    // remediation mutates only sidecar metadata, so the file need not be
    // opened merely to acknowledge work on its annotation.
    const acted = await postMessage(annotationId, {
      text: "Implemented the requested persistence correction in commit abc123.",
      clientRequestId: "closed-req-1",
      expectedAnnotationGeneration: 1,
      markActed: true,
    });
    assert.equal(acted.status, 200, acted.body);
    const actedBody = parseAs(acted.body, "AddAnnotationMessageResponse");
    assert.equal(actedBody.annotationGeneration, 2);
    assert.equal(actedBody.agentStatus.state, "acted");

    const whileClosed = parseAs(
      (await httpRequest("GET", `/v1/annotations/${annotationId}`)).body,
      "AnnotationResponse",
    );
    assert.equal(whileClosed.state, "open", "agent action is not owner resolution");
    assert.equal(whileClosed.messages.length, 2);
    assert.deepEqual(whileClosed.agentStatus, actedBody.agentStatus);

    // Reopen restores exactly the sidecar state the agent mutated while the
    // document was closed; it does not manufacture another lifecycle turn.
    await provider.getDocument(filePath);
    const afterReopen = parseAs(
      (await httpRequest("GET", `/v1/annotations/${annotationId}`)).body,
      "AnnotationResponse",
    );
    assert.equal(afterReopen.annotationGeneration, 2, "reopen must not move the generation");
    assert.equal(afterReopen.messages.length, 2);
    assert.deepEqual(afterReopen.agentStatus, actedBody.agentStatus);
  });

  it("leaves a closed document outside every configured workspace out of the annotation listing", async function () {
    // A sidecar survives its workspace leaving the configuration; the sidecar
    // store keys by path hash and knows nothing about provenance. The listing
    // must not serve it: the workspace gate is the only provenance check.
    const content = "A sidecar from another workspace must not appear.\n";
    const outsidePath = path.join(os.tmpdir(), "zettlr-annotation-api-outside-workspace.md");
    writeFileSync(outsidePath, content, "utf8");
    try {
      const outsideId = await openFile(outsidePath, content);
      const created = await provider.createAnnotation(
        outsideId,
        "owner",
        0,
        8,
        "Note for a workspace the user has since removed.",
        0,
      );
      assert.ok("annotationId" in created);
      await provider.closeFileEverywhere(outsidePath);

      const listed = parseAs(
        (await httpRequest("GET", "/v1/annotations")).body,
        "AnnotationListResponse",
      );
      assert.equal(
        listed.annotations.some((annotation) => annotation.annotationId === created.annotationId),
        false,
        "a closed document outside every configured workspace must not be listed",
      );
      assert.equal(
        listed.annotations.some((annotation) => annotation.documentId === outsideId),
        false,
      );
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  // ==========================================================================
  // Idempotent message posting and generation fencing
  // ==========================================================================

  it("posts exactly one message for a repeated clientRequestId, and a fresh one for a new id", async function () {
    const content = "Please look at this specific sentence.\n";
    const documentId = await openFile(path.join(scratch, "reply.md"), content);
    const created = await provider.createAnnotation(documentId, "owner", 0, 6, "Explain this.", 0);
    assert.ok("annotationId" in created);
    const annotationId = created.annotationId;

    const first = await postMessage(annotationId, {
      text: "Here is my first analysis.",
      clientRequestId: "agent-req-1",
      expectedAnnotationGeneration: 1,
    });
    assert.equal(first.status, 200);
    const firstParsed = parseAs(first.body, "AddAnnotationMessageResponse");
    assert.equal(firstParsed.message.author, "agent");
    const firstMessageId = firstParsed.message.messageId;

    // Replayed with the SAME clientRequestId, and against a deliberately
    // stale expectedAnnotationGeneration — the replay check runs before the
    // generation fence, so this must still succeed and answer the original
    // message rather than refuse or duplicate it.
    const replay = await postMessage(annotationId, {
      text: "A different sentence that must be ignored.",
      clientRequestId: "agent-req-1",
      expectedAnnotationGeneration: 999,
    });
    assert.equal(replay.status, 200);
    const replayParsed = parseAs(replay.body, "AddAnnotationMessageResponse");
    assert.equal(replayParsed.message.messageId, firstMessageId);
    assert.equal(replayParsed.message.text, "Here is my first analysis.");

    const afterReplay = parseAs(
      (await httpRequest("GET", `/v1/annotations/${annotationId}`)).body,
      "AnnotationResponse",
    );
    // Owner's opening message + exactly one agent reply, despite two POSTs.
    assert.equal(afterReplay.messages.length, 2);
    assert.equal(afterReplay.messages.filter((m) => m.author === "agent").length, 1);

    // A genuinely new clientRequestId is a genuinely new message.
    const second = await postMessage(annotationId, {
      text: "A follow-up with new content.",
      clientRequestId: "agent-req-2",
      expectedAnnotationGeneration: afterReplay.annotationGeneration,
    });
    assert.equal(second.status, 200);
    const afterSecond = parseAs(
      (await httpRequest("GET", `/v1/annotations/${annotationId}`)).body,
      "AnnotationResponse",
    );
    assert.equal(afterSecond.messages.length, 3);
    assert.equal(afterSecond.messages.filter((m) => m.author === "agent").length, 2);
  });

  it("marks an agent disposition acted while leaving owner resolution open and linking the exact message", async function () {
    const content = "This annotation needs an agent remediation.\n";
    const documentId = await openFile(path.join(scratch, "acted.md"), content);
    const created = await provider.createAnnotation(
      documentId,
      "owner",
      0,
      15,
      "Correct this and report the concrete remediation.",
      0,
    );
    assert.ok("annotationId" in created);

    const acted = await postMessage(created.annotationId, {
      text: "Corrected the implementation in commit abc123; the linked change is ready for review.",
      clientRequestId: "acted-disposition-1",
      expectedAnnotationGeneration: 1,
      markActed: true,
    });
    assert.equal(acted.status, 200, acted.body);
    const response = parseAs(acted.body, "AddAnnotationMessageResponse");
    assert.equal(response.agentStatus.state, "acted");
    assert.equal(
      response.agentStatus.state === "acted" ? response.agentStatus.messageId : undefined,
      response.message.messageId,
    );

    const detail = parseAs(
      (await httpRequest("GET", `/v1/annotations/${created.annotationId}`)).body,
      "AnnotationResponse",
    );
    assert.equal(detail.state, "open", "agent action must not resolve the owner's annotation");
    assert.deepEqual(detail.agentStatus, response.agentStatus);
    assert.equal(
      detail.messages.find((message) => message.messageId === response.message.messageId)?.text,
      response.message.text,
    );
  });

  it("upgrades an existing agent disposition to acted by replaying its request id without duplicating the thread", async function () {
    const content = "This annotation already has a remediation disposition.\n";
    const documentId = await openFile(path.join(scratch, "acted-upgrade.md"), content);
    const created = await provider.createAnnotation(
      documentId,
      "owner",
      0,
      15,
      "Apply the requested correction.",
      0,
    );
    assert.ok("annotationId" in created);

    const posted = await postMessage(created.annotationId, {
      text: "Implemented in commit def456.",
      clientRequestId: "existing-disposition-1",
      expectedAnnotationGeneration: 1,
    });
    assert.equal(posted.status, 200, posted.body);
    const postedBody = parseAs(posted.body, "AddAnnotationMessageResponse");
    assert.deepEqual(postedBody.agentStatus, { state: "pending" });

    const upgraded = await postMessage(created.annotationId, {
      text: "Implemented in commit def456.",
      clientRequestId: "existing-disposition-1",
      expectedAnnotationGeneration: postedBody.annotationGeneration,
      markActed: true,
    });
    assert.equal(upgraded.status, 200, upgraded.body);
    const upgradedBody = parseAs(upgraded.body, "AddAnnotationMessageResponse");
    assert.equal(upgradedBody.message.messageId, postedBody.message.messageId);
    assert.equal(upgradedBody.agentStatus.state, "acted");

    const detail = parseAs(
      (await httpRequest("GET", `/v1/annotations/${created.annotationId}`)).body,
      "AnnotationResponse",
    );
    assert.equal(detail.messages.length, 2, "owner instruction + one agent disposition only");
    assert.equal(detail.state, "open");
    assert.equal(
      detail.agentStatus.state === "acted" ? detail.agentStatus.messageId : undefined,
      postedBody.message.messageId,
    );
  });

  it("refuses a stale expectedAnnotationGeneration with 409 and persists nothing", async function () {
    const content = "Generation fencing check sentence.\n";
    const documentId = await openFile(path.join(scratch, "fence.md"), content);
    const created = await provider.createAnnotation(documentId, "owner", 0, 10, "Check this.", 0);
    assert.ok("annotationId" in created);
    const annotationId = created.annotationId;

    const stale = await postMessage(annotationId, {
      text: "This should be refused.",
      clientRequestId: "stale-attempt",
      expectedAnnotationGeneration: 999,
    });
    assert.equal(stale.status, 409);
    const error = parseAs(stale.body, "AgentErrorResponse");
    assert.equal(error.error.code, "ANNOTATION_GENERATION_MISMATCH");

    const after = parseAs(
      (await httpRequest("GET", `/v1/annotations/${annotationId}`)).body,
      "AnnotationResponse",
    );
    assert.equal(after.messages.length, 1, "the refused attempt must not have posted anything");
  });

  it("refuses whitespace-only message text with 400 INVALID_PARAMS", async function () {
    const content = "Empty message body check.\n";
    const documentId = await openFile(path.join(scratch, "empty.md"), content);
    const created = await provider.createAnnotation(documentId, "owner", 0, 5, "Check.", 0);
    assert.ok("annotationId" in created);

    const result = await postMessage(created.annotationId, {
      text: "   ",
      clientRequestId: "whitespace-only",
      expectedAnnotationGeneration: 1,
    });
    assert.equal(result.status, 400);
    const error = parseAs(result.body, "AgentErrorResponse");
    assert.equal(error.error.code, "INVALID_PARAMS");
  });

  it("404s a message posted against an unknown annotationId", async function () {
    const result = await postMessage("no-such-annotation", {
      text: "Hello.",
      clientRequestId: "req-1",
      expectedAnnotationGeneration: 0,
    });
    assert.equal(result.status, 404);
    const error = parseAs(result.body, "AgentErrorResponse");
    assert.equal(error.error.code, "ANNOTATION_NOT_FOUND");
  });

  // ==========================================================================
  // I3 — an agent request never changes the owner's annotation resolution state
  // ==========================================================================

  it("publishes no lifecycle-mutating annotation operation in the served document", async function () {
    // Mirrors agent-http-api.spec.ts's adjudication-absence proof: the
    // product boundary is that these actions are inexpressible through this
    // API, not merely refused. Only a thread reply (addAnnotationMessage) is
    // agent-writable. `markActed` is deliberately part of that thread reply:
    // it records agent work state without adding an owner-lifecycle operation.
    const ownerOnly = [
      "createAnnotation",
      "resolveAnnotation",
      "reopenAnnotation",
      "reattachAnnotation",
      "deleteAnnotation",
    ];
    const document = JSON.parse((await httpRequest("GET", "/openapi.json")).body) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const declared = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId),
    );
    assert.ok(declared.includes("listAnnotations"));
    assert.ok(declared.includes("addAnnotationMessage"));
    for (const operationId of ownerOnly) {
      assert.ok(!declared.includes(operationId), `must not declare ${operationId}`);
    }
  });

  it("refuses an agent's resolve, reopen, reattach, and delete attempt on the real, sidecar-backed pipeline", async function () {
    const content = "This annotation must stay exactly as the owner left it.\n";
    const documentId = await openFile(path.join(scratch, "i3.md"), content);
    const created = await provider.createAnnotation(documentId, "owner", 0, 20, "Owner's note.", 0);
    assert.ok("annotationId" in created);
    const annotationId = created.annotationId;

    const resolveAttempt = await provider.resolveAnnotation(documentId, annotationId, "agent", 1);
    assert.deepEqual(
      "ok" in resolveAttempt ? resolveAttempt.ok : true,
      false,
      "an agent resolve must be refused",
    );
    assert.equal((resolveAttempt as { code: string }).code, "ANNOTATION_OWNER_ONLY");

    const reopenAttempt = await provider.reopenAnnotation(documentId, annotationId, "agent", 1);
    assert.equal((reopenAttempt as { code: string }).code, "ANNOTATION_OWNER_ONLY");

    const reattachAttempt = await provider.reattachAnnotation(
      documentId,
      annotationId,
      "agent",
      0,
      5,
      1,
    );
    assert.equal((reattachAttempt as { code: string }).code, "ANNOTATION_OWNER_ONLY");

    const deleteAttempt = await provider.deleteAnnotation(documentId, annotationId, "agent", 1);
    assert.equal((deleteAttempt as { code: string }).code, "ANNOTATION_OWNER_ONLY");

    // Every refusal above ran against the exact DocumentManager instance
    // backing the live HTTP server, with real sidecar persistence wired in.
    // Re-reading over real HTTP proves none of the four attempts left a
    // mark: the annotation is still open, at its original target.
    const after = parseAs(
      (await httpRequest("GET", `/v1/annotations/${annotationId}`)).body,
      "AnnotationResponse",
    );
    assert.equal(after.state, "open");
    assert.equal(after.target.state, "range");
    assert.equal(after.target.from, 0);
    assert.equal(after.target.to, 20);
    assert.equal(
      after.annotationGeneration,
      1,
      "no refused attempt may have advanced the generation",
    );
  });

  // ==========================================================================
  // Packet-level proposal linkage (invariant 4): a claim's
  // addressesAnnotationIds reaches CollaborationApplicationService and lands
  // atomically with the packet it names.
  // ==========================================================================

  it("links a submitted proposal to the annotation it addresses", async function () {
    const original = "The quick brown fox jumps over the lazy dog.\n";
    const revised = "The quick red fox jumps over the lazy dog.\n";
    const documentId = await openFile(path.join(scratch, "linked.md"), original);
    const from = original.indexOf("brown fox");
    const to = from + "brown fox".length;
    const created = await provider.createAnnotation(
      documentId,
      "owner",
      from,
      to,
      "The fox's color is wrong.",
      0,
    );
    assert.ok("annotationId" in created);
    const annotationId = created.annotationId;

    const submitted = await postProposal(documentId, {
      baselineSha256: sha256Text(original),
      expectedReviewGeneration: 0,
      clientRequestId: "agent-linked-claim-1",
      claims: [
        {
          description: "Correct the fox's color from brown to red.",
          patch: createPatch("document", original, revised, "", "", {
            context: 0,
          }),
          addressesAnnotationIds: [annotationId],
        },
      ],
    });
    assert.equal(submitted.status, 200);
    const result = parseAs(submitted.body, "SubmitProposalResponse");
    assert.equal(result.packetIds.length, 1);
    const [packetId] = result.packetIds;

    // Prove the link landed by reading it back, not by trusting the POST
    // response: the annotation itself now carries a proposalAction for
    // exactly this packet and review.
    const annotation = parseAs(
      (await httpRequest("GET", `/v1/annotations/${annotationId}`)).body,
      "AnnotationResponse",
    );
    assert.equal(annotation.proposalActions.length, 1);
    assert.equal(annotation.proposalActions[0].packetId, packetId);
    assert.equal(annotation.proposalActions[0].reviewId, result.reviewId);
    assert.equal(annotation.proposalActions[0].terminalOutcome, undefined);
  });

  it("refuses a claim addressing a non-open annotation, committing neither the packet nor the annotation", async function () {
    const original = "The quick brown fox jumps over the lazy dog.\n";
    const revised = "The quick red fox jumps over the lazy dog.\n";
    const documentId = await openFile(path.join(scratch, "refused-link.md"), original);
    const from = original.indexOf("brown fox");
    const to = from + "brown fox".length;
    const created = await provider.createAnnotation(
      documentId,
      "owner",
      from,
      to,
      "The fox's color is wrong.",
      0,
    );
    assert.ok("annotationId" in created);
    const annotationId = created.annotationId;
    const resolved = await provider.resolveAnnotation(documentId, annotationId, "owner", 1);
    assert.ok("annotationId" in resolved);

    const submitted = await postProposal(documentId, {
      baselineSha256: sha256Text(original),
      expectedReviewGeneration: 0,
      clientRequestId: "agent-linked-claim-refused",
      claims: [
        {
          description: "Correct the fox's color from brown to red.",
          patch: createPatch("document", original, revised, "", "", {
            context: 0,
          }),
          addressesAnnotationIds: [annotationId],
        },
      ],
    });
    assert.equal(submitted.status, 409);
    const error = parseAs(submitted.body, "AgentErrorResponse");
    assert.equal(error.error.code, "ANNOTATION_RESOLVED");

    // Nothing committed: the document text is unchanged, no review exists,
    // and the annotation carries no proposalAction (M3's guarantee — the
    // linked proposal commits with the annotation change or not at all).
    const document = parseAs(
      (await httpRequest("GET", `/v1/documents/${documentId}`)).body,
      "DocumentSummary",
    );
    assert.equal(document.review, undefined);
    const content = parseAs(
      (await httpRequest("GET", `/v1/documents/${documentId}?includeContent=true`)).body,
      "ReadDocumentResponse",
    );
    assert.equal(content.content.trimEnd(), original.trimEnd());
    const annotation = parseAs(
      (await httpRequest("GET", `/v1/annotations/${annotationId}`)).body,
      "AnnotationResponse",
    );
    assert.equal(annotation.proposalActions.length, 0);
    assert.equal(annotation.state, "resolved");
  });
});
