/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Agent HTTP API integration tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     Drives the embedded HTTP server against the OpenAPI
 *                  specification. Tests REST routes, ETag concurrency,
 *                  unauthenticated loopback access and SSE.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import Ajv2020 from "ajv/dist/2020";
import { parse as parseYaml } from "yaml";
import { AGENT_ERROR_CODES } from "@dts/common/agent-api";
import type { CodeFileDescriptor } from "@dts/common/fsal";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import AgentHTTPProvider, {
  MAX_SEARCH_PATTERN_LENGTH,
} from "source/app/service-providers/agent-api/http-server";
import DocumentManager from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";

// ============================================================================
// Contract conformance
// ============================================================================

/**
 * Validates a response body against the schema the server itself publishes.
 * Field-by-field assertions cannot catch drift in a field nobody thought to
 * assert — `type` shipped as the internal enum ordinal (1) instead of the
 * declared "markdown" | "code" through a fully green suite. Every response
 * asserted here is checked against openapi.yaml as a whole.
 */
const openApiDocument = parseYaml(
  readFileSync(
    path.join(__dirname, "../source/app/service-providers/agent-api/openapi.yaml"),
    "utf8",
  ),
) as {
  components: { schemas: Record<string, unknown> };
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const [name, schema] of Object.entries(openApiDocument.components.schemas)) {
  ajv.addSchema(schema as object, `#/components/schemas/${name}`);
}

function assertMatchesSchema(body: unknown, schemaName: string): void {
  const validate = ajv.getSchema(`#/components/schemas/${schemaName}`);
  assert.ok(validate !== undefined, `openapi.yaml declares no schema ${schemaName}`);
  if (validate(body) !== true) {
    assert.fail(
      `Response does not conform to ${schemaName}: ${ajv.errorsText(validate.errors)}\n` +
        JSON.stringify(body, null, 2),
    );
  }
}

describe("Agent HTTP API (OpenAPI / REST)", function () {
  let scratch: string;
  let provider: DocumentManager;
  let httpProvider: AgentHTTPProvider;
  let httpPort: number;
  // The configured workspace set, read live by the config seam so a test can
  // exercise the no-workspace-open profile the app ships with.
  let openWorkspaces: string[] = [];

  // The suite owns this variable outright. It is a real token on a developer
  // machine that has it in ~/.envrc, and every test outside the enforcement
  // block below is written for a server that requires nothing: inheriting it
  // turned twenty-three unrelated tests red for a reason none of them named.
  let ambientToken: string | undefined;
  before(function () {
    ambientToken = process.env.ZETTLR_AGENT_API_TOKEN;
    delete process.env.ZETTLR_AGENT_API_TOKEN;
  });
  after(function () {
    if (ambientToken !== undefined) {
      process.env.ZETTLR_AGENT_API_TOKEN = ambientToken;
    }
  });

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
    const userData = path.join(os.tmpdir(), "zettlr-pandoc-http-api-test");
    mkdirSync(userData, { recursive: true });
    mkdirSync(path.join(userData, "logs"), { recursive: true });
    rmSync(path.join(userData, "documents.yaml"), { force: true });

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
          app: {
            openFiles: [],
            openWorkspaces,
          },
          system: {
            avoidNewTabs: false,
          },
          editor: {
            autoSave: "off" as const,
          },
          files: {
            images: { openWith: "zettlr" as const },
            pdf: { openWith: "zettlr" as const },
          },
          appLang: "en-US",
          alwaysReloadFiles: false,
          agentApi: {
            enabled: true,
            port: httpPort,
          },
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
        readDirectoryRecursively: async (workspacePath: string) => [
          path.join(workspacePath, "unopened.md"),
        ],
      },
      citeproc: {
        synchronizeDatabases: async (_libraries: string[]) => {},
      },
      recentDocs: {
        add: (_path: string) => {},
      },
      stats: {
        updateCounts: (_words: number, _chars: number) => {},
      },
      windows: {
        askSaveChanges: async (_detail?: string) => ({
          response: 2,
          checkboxChecked: false,
        }),
        getFirstMainWindow: () => undefined,
        getMainWindowKey: (_window: unknown) => activeWindowId,
      },
    };

    const manager = new DocumentManager(appSeam);
    await manager.boot();
    activeWindowId = manager.windowKeys()[0];
    return manager;
  }

  async function openFile(filePath: string, content: string): Promise<string> {
    writeFileSync(filePath, content, "utf8");
    await provider.getDocument(filePath);
    const docId = provider.getDocumentId(filePath);
    assert.ok(docId !== undefined, "documentId must be assigned");
    return docId;
  }

  // HTTP client helper
  async function httpRequest(
    method: string,
    pathname: string,
    options: {
      body?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: httpPort,
          path: pathname,
          method,
          headers: {
            ...options.headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString("utf8");
          });
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: data,
            });
          });
        },
      );
      req.on("error", reject);
      if (options.body !== undefined) {
        req.write(options.body);
      }
      req.end();
    });
  }

  function makePatch(oldText: string, newText: string): string {
    return createPatch("document", oldText, newText, "", "", { context: 3 });
  }

  beforeEach(async function () {
    scratch = mkdtempSync(path.join(os.tmpdir(), "zettlr-http-api-"));
    openWorkspaces = [scratch];
    // Find a free port
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    httpPort = (server.address() as net.AddressInfo).port;
    server.close();

    provider = await createProvider();
    httpProvider = new AgentHTTPProvider(new LogProvider(), provider, {
      config: {
        get: () => ({
          app: {
            openWorkspaces,
          },
          agentApi: {
            enabled: true,
            port: httpPort,
          },
        }),
      },
    });
    await httpProvider.boot();
  });

  afterEach(async function () {
    await httpProvider.shutdown();
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("bearer token enforcement", function () {
    const TOKEN = "s3cret-token-value";
    let tokenPort: number;
    let guarded: AgentHTTPProvider;
    let previousToken: string | undefined;

    async function request(
      pathname: string,
      headers: Record<string, string> = {},
    ): Promise<{ status: number; body: string }> {
      return await new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port: tokenPort, path: pathname, method: "GET", headers },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    }

    beforeEach(async function () {
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      tokenPort = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      // The provider reads the variable once, in its constructor, so it has to
      // be in place before the instance exists.
      previousToken = process.env.ZETTLR_AGENT_API_TOKEN;
      process.env.ZETTLR_AGENT_API_TOKEN = TOKEN;
      guarded = new AgentHTTPProvider(new LogProvider(), provider, {
        config: {
          get: () => ({
            app: { openWorkspaces: [scratch] },
            agentApi: { enabled: true, port: tokenPort },
          }),
        },
      });
      await guarded.boot();
    });

    afterEach(async function () {
      await guarded.shutdown();
      if (previousToken === undefined) {
        delete process.env.ZETTLR_AGENT_API_TOKEN;
      } else {
        process.env.ZETTLR_AGENT_API_TOKEN = previousToken;
      }
    });

    it("serves a request carrying the configured token", async function () {
      const response = await request("/v1/ping", { authorization: `Bearer ${TOKEN}` });
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).instanceId.length > 0, true);
    });

    it("refuses every route without the token", async function () {
      // The check sits ahead of the route table rather than on the handlers.
      // /health is included deliberately: it reports the instance id and the
      // process id of a running editor, which a published tunnel must not hand
      // to an anonymous caller.
      for (const pathname of ["/health", "/v1/ping", "/v1/context"]) {
        const anonymous = await request(pathname);
        assert.equal(anonymous.status, 401, `${pathname} must refuse an anonymous caller`);
        assert.equal(JSON.parse(anonymous.body).error.code, "UNAUTHORIZED");
      }
    });

    it("tells an anonymous caller nothing about how this server is configured", async function () {
      // The refusal used to name the environment variable carrying the secret,
      // and so did the specification, which is served anonymously. Between them
      // a stranger who reached a published tunnel learned the exact variable to
      // ask about and the exact misconfiguration to probe for. Neither sentence
      // helped anyone who was entitled to call the API: the operator already
      // knows, and reads it in the log instead.
      const surfaces = [
        (await request("/v1/ping")).body,
        (await request("/openapi.yaml")).body,
        (await request("/openapi.json")).body,
      ];
      for (const body of surfaces) {
        assert.equal(
          /ZETTLR_AGENT_API_TOKEN/.test(body),
          false,
          "an anonymous response must not name the variable carrying the secret",
        );
        assert.equal(
          /environment variable|is not enforced|loopback caller/i.test(body),
          false,
          "an anonymous response must not describe the server's auth posture",
        );
      }
      assert.equal(JSON.parse(surfaces[0]).error.message, "Authentication required.");
    });

    it("serves the specification anonymously, with the origin it was asked on", async function () {
      // The one deliberate exemption: the document describes the API rather
      // than exposing it, and the identical file is in the public repository.
      // Reading it grants nothing — every route it describes still needs the
      // token. Serving it openly is what lets a consumer import by URL rather
      // than carry a pasted copy that drifts.
      const anonymous = await request("/openapi.yaml");
      assert.equal(anonymous.status, 200);
      assert.ok(anonymous.body.includes("openapi:"));

      // And it must describe the endpoint the caller actually reached, or an
      // importer behind a tunnel builds every call against its own loopback.
      const forwarded = await request("/openapi.yaml", { host: "zettlr.example.com" });
      assert.match(forwarded.body, /servers:\n {2}- url: https:\/\/zettlr\.example\.com\n/);
      assert.equal(
        forwarded.body.includes("127.0.0.1:27412"),
        false,
        "the loopback origin must not survive the rewrite",
      );

      // Asked on loopback it stays http, since nothing terminated TLS.
      assert.match(anonymous.body, /servers:\n {2}- url: http:\/\/127\.0\.0\.1:\d+\n/);
    });

    it("serves the same specification as JSON, anonymously, at /openapi.json", async function () {
      // The Custom GPT builder reads a URL and imports nothing when it is
      // handed YAML. Offering JSON is what makes import-by-URL work at all;
      // parsing the YAML per request is what keeps the two from drifting.
      const asJson = await request("/openapi.json", { host: "zettlr.example.com" });
      assert.equal(asJson.status, 200);
      const parsed = JSON.parse(asJson.body);
      const asYaml = await request("/openapi.yaml", { host: "zettlr.example.com" });
      assert.deepEqual(parsed, parseYaml(asYaml.body), "the two encodings must agree");
      assert.equal(parsed.servers[0].url, "https://zettlr.example.com");

      // 3.1.1 is editorially identical to 3.1.0, and consumers key off the
      // version string they were built against.
      assert.equal(parsed.openapi, "3.1.0");
    });

    it("refuses a wrong token, a wrong scheme, and a token that is merely a prefix", async function () {
      const rejected = [
        `Bearer ${TOKEN}x`,
        `Bearer ${TOKEN.slice(0, -1)}`,
        // A prefix of the right length family: the comparison must not accept
        // on an early match, and must not throw on a length mismatch either.
        "Bearer s",
        `Basic ${TOKEN}`,
        TOKEN,
        "Bearer",
      ];
      for (const authorization of rejected) {
        const response = await request("/v1/ping", { authorization });
        assert.equal(response.status, 401, `"${authorization}" must be refused`);
      }
    });
  });

  it("serves any loopback caller when no token is configured", async function () {
    // The unauthenticated loopback posture is the intended default for personal
    // hooks, and the rest of this suite depends on it. Assert it explicitly so
    // adding the token check cannot quietly become mandatory.
    assert.equal(process.env.ZETTLR_AGENT_API_TOKEN, undefined);
    const response = await httpRequest("GET", "/v1/ping");
    assert.equal(response.status, 200);
  });

  it("boots without a listener when the configured port is taken", async function () {
    // The API is enabled by default, and AppServiceContainer._informativeBoot
    // rethrows whatever boot() rejects with — so an unrelated process holding
    // the port used to abort the entire editor launch. The API is optional; the
    // editor is not. Occupy the port and assert boot resolves anyway.
    const squatter = net.createServer();
    const takenPort = await new Promise<number>((resolve) => {
      squatter.listen(0, "127.0.0.1", () => {
        resolve((squatter.address() as net.AddressInfo).port);
      });
    });

    const collided = new AgentHTTPProvider(new LogProvider(), provider, {
      config: {
        get: () => ({
          app: { openWorkspaces: [scratch] },
          agentApi: { enabled: true, port: takenPort },
        }),
      },
    });

    try {
      // The assertion is that this resolves at all: before the fix it rejected
      // with EADDRINUSE, and AppServiceContainer rethrows that as a boot abort.
      await collided.boot();
      // And it must not have moved itself elsewhere — a silently relocated
      // endpoint is worse than an absent one, because every configured agent
      // keeps talking to whatever now answers on the expected port.
      assert.equal(
        collided.isListening,
        false,
        "a collided boot must leave no listener behind",
      );
    } finally {
      await collided.shutdown();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("publishes exactly the error codes the server can emit", function () {
    // The enum was written out by hand and drifted: it omitted INTERNAL_ERROR
    // while four 500 paths emitted it, so those responses failed validation
    // against the spec the server itself serves. Compare the sets rather than
    // spot-checking one code, and compare against the runtime constant the
    // AgentErrorCode type is derived from, so neither side can drift alone.
    const declared = (
      openApiDocument.components.schemas.AgentError as {
        properties: { code: { enum?: string[] } };
      }
    ).properties.code.enum;
    assert.ok(
      declared !== undefined,
      "openapi.yaml must constrain AgentError.code to an enum",
    );
    assert.deepEqual(
      [...declared].sort(),
      [...AGENT_ERROR_CODES].sort(),
      "openapi.yaml's AgentError.code enum and AGENT_ERROR_CODES must agree",
    );
  });

  it("GET /openapi.yaml serves the OpenAPI specification without auth", async function () {
    const response = await httpRequest("GET", "/openapi.yaml", {
      headers: {}, // No auth header
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.includes("openapi:"));
    assert.ok(response.body.includes("Zettlr-Pandoc Editor Agent API"));
  });

  it("GET /v1/ping returns protocol version", async function () {
    const response = await httpRequest("GET", "/v1/ping");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.protocolVersion !== undefined);
    assert.ok(body.instanceId !== undefined);
    assertMatchesSchema(body, "PingResponse");
  });

  it("GET /v1/capabilities reports supported features", async function () {
    const response = await httpRequest("GET", "/v1/capabilities");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.supportedPatchFormats, ["unified-diff"]);
    assert.equal(body.reviewSupport, true);
    assertMatchesSchema(body, "CapabilitiesResponse");
  });

  it("GET /v1/context returns open documents", async function () {
    const filePath = path.join(scratch, "ctx.md");
    await openFile(filePath, "content\n");
    const response = await httpRequest("GET", "/v1/context");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.openDocuments.length > 0);
    assertMatchesSchema(body, "EditorContext");
  });

  it("GET /v1/documents lists open documents", async function () {
    const filePath = path.join(scratch, "list.md");
    await openFile(filePath, "content\n");
    const response = await httpRequest("GET", "/v1/documents");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body) as {
      documents: Array<{ path: string }>;
    };
    assert.ok(body.documents.length > 0);
    assert.ok(body.documents.some((d: { path: string }) => d.path === filePath));
    assertMatchesSchema(body, "DocumentListResponse");
    for (const document of body.documents) {
      assertMatchesSchema(document, "DocumentSummary");
    }
  });

  it("GET /v1/documents/{id} returns document metadata", async function () {
    const filePath = path.join(scratch, "meta.md");
    const docId = await openFile(filePath, "content\n");
    const response = await httpRequest("GET", `/v1/documents/${docId}`);
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.documentId, docId);
    assert.equal(body.path, filePath);
    assertMatchesSchema(body, "DocumentSummary");
  });

  it("GET /v1/documents/{id}/content returns live buffer with ETag", async function () {
    const filePath = path.join(scratch, "read.md");
    const docId = await openFile(filePath, "alpha\nbeta\n");
    const response = await httpRequest("GET", `/v1/documents/${docId}/content`);
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body) as {
      content: string;
      snapshot: string;
    };
    assert.ok(body.content.includes("alpha"));
    assert.ok(body.snapshot.startsWith("snap_v1_"));
    assertMatchesSchema(body, "ReadDocumentResponse");
    // ETag must be present
    const etag = response.headers["etag"];
    assert.ok(etag !== undefined, "ETag header must be present");
    assert.ok(etag.includes("sha256:"));
  });

  it("POST /v1/documents/{id}/proposals submits a patch carrying its own clientRequestId", async function () {
    const filePath = path.join(scratch, "propose.md");
    const docId = await openFile(filePath, "alpha\n");

    // Read to get the snapshot token, which is the only concurrency check.
    const readResponse = await httpRequest("GET", `/v1/documents/${docId}/content`);
    const snapshot = JSON.parse(readResponse.body).snapshot;

    // Submit proposal
    const response = await httpRequest("POST", `/v1/documents/${docId}/proposals`, {
      body: JSON.stringify({
        snapshot,
        patchFormat: "unified-diff",
        patch: makePatch("alpha\n", "ALPHA\n"),
        clientRequestId: "http-req-1",
      }),
    });
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.packetId !== undefined);
    assert.ok(body.reviewId !== undefined);
    assert.equal(body.state, "active");
    assertMatchesSchema(body, "SubmitProposalResponse");
  });

  it("rejects reuse of an idempotency key for a different proposal", async function () {
    const filePath = path.join(scratch, "idempotency.md");
    const docId = await openFile(filePath, "alpha\n");
    const readResponse = await httpRequest("GET", `/v1/documents/${docId}/content`);
    const snapshot = JSON.parse(readResponse.body).snapshot;
    const first = await httpRequest("POST", `/v1/documents/${docId}/proposals`, {
      body: JSON.stringify({
        snapshot,
        patchFormat: "unified-diff",
        patch: makePatch("alpha\n", "ALPHA\n"),
        clientRequestId: "one-key",
      }),
    });
    assert.equal(first.status, 200);
    const conflicting = await httpRequest("POST", `/v1/documents/${docId}/proposals`, {
      body: JSON.stringify({
        snapshot,
        patchFormat: "unified-diff",
        patch: makePatch("alpha\n", "BETA\n"),
        clientRequestId: "one-key",
      }),
    });
    assert.equal(conflicting.status, 409);
    assert.equal(JSON.parse(conflicting.body).error.code, "IDEMPOTENCY_CONFLICT");
  });

  it("does not expose a working snapshot or ETag for reference reads", async function () {
    const filePath = path.join(scratch, "reference.md");
    const docId = await openFile(filePath, "alpha\n");
    const snapshot = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snapshot.token,
      makePatch("alpha\n", "ALPHA\n"),
      "reference-read",
    );
    const response = await httpRequest("GET", `/v1/documents/${docId}/content?side=reference`);
    const body = JSON.parse(response.body);
    assert.equal(response.headers.etag, undefined);
    assert.equal(body.snapshot, undefined);
    assert.equal(body.content, "alpha\n");
  });

  it("lists and opens an unopened workspace document by its assigned resource id", async function () {
    const unopenedPath = path.join(scratch, "unopened.md");
    writeFileSync(unopenedPath, "unopened\n", "utf8");
    const response = await httpRequest(
      "GET",
      `/v1/workspaces/${encodeURIComponent(scratch)}/documents`,
    );
    assert.equal(response.status, 200);
    const documents = JSON.parse(response.body).documents as Array<{
      documentId: string;
      loaded: boolean;
      path: string;
    }>;
    const document = documents.find((item) => item.path === unopenedPath);
    assert.ok(document !== undefined);
    assert.equal(document.loaded, false);
    // A listing entry for a file the provider has never opened carries identity
    // only: there is no revision, line count, or view to report without
    // inventing one. The published schema has to admit that shape.
    for (const entry of documents) {
      assertMatchesSchema(entry, "WorkspaceDocumentSummary");
    }
    const opened = await httpRequest(
      "POST",
      `/v1/workspaces/${encodeURIComponent(scratch)}/documents/${document.documentId}/open`,
    );
    assert.equal(opened.status, 200);
    const openedBody = JSON.parse(opened.body);
    assert.equal(openedBody.documentId, document.documentId);
    assertMatchesSchema(openedBody, "FocusDocumentResponse");
  });

  it("refuses to open an unopened path when no workspace is configured", async function () {
    // A fresh profile enables the agent API and opens no workspace. If an empty
    // workspace set meant "unrestricted", any loopback client could POST an
    // absolute path and read the file back through the content endpoint.
    const secret = path.join(scratch, "outside.md");
    writeFileSync(secret, "private\n", "utf8");
    const alreadyOpen = path.join(scratch, "already-open.md");
    const openDocId = await openFile(alreadyOpen, "visible\n");
    openWorkspaces = [];

    const denied = await httpRequest("POST", "/v1/documents", {
      body: JSON.stringify({ uri: `file://${secret}` }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(denied.status, 404);
    assert.equal(JSON.parse(denied.body).error.code, "DOCUMENT_NOT_FOUND");

    // What the user already opened stays reachable: workspace containment is
    // not the thing that made those documents legitimate.
    const focused = await httpRequest("POST", `/v1/documents/${openDocId}/focus`);
    assert.equal(focused.status, 200);
    assertMatchesSchema(JSON.parse(focused.body), "FocusDocumentResponse");

    // An id assigned earlier is not standing authorization. Document ids are
    // cached permanently and handed out to every file a workspace listing
    // enumerates, so closing a document has to take its path back out of
    // scope — otherwise closing the last workspace leaves every path the
    // editor ever touched reloadable through the API.
    await provider.closeFileEverywhere(alreadyOpen);
    const reopened = await httpRequest("POST", "/v1/documents", {
      body: JSON.stringify({ uri: `file://${alreadyOpen}` }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(reopened.status, 404);
  });

  it("refuses paths that escape a configured workspace by traversal or symlink", async function () {
    const wsDir = path.join(scratch, "ws");
    mkdirSync(wsDir);
    const secret = path.join(scratch, "secret.md");
    writeFileSync(secret, "private\n", "utf8");
    openWorkspaces = [wsDir];

    // `..` traversal: the URI names a path inside the workspace textually,
    // but it resolves outside it.
    const traversed = await httpRequest("POST", "/v1/documents", {
      body: JSON.stringify({ uri: `file://${wsDir}/inner/../../secret.md` }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(traversed.status, 404);
    assert.equal(JSON.parse(traversed.body).error.code, "DOCUMENT_NOT_FOUND");

    // Symlink escape: the path sits inside the workspace, its target does not.
    // Containment must judge the canonical target, not the link's location.
    symlinkSync(secret, path.join(wsDir, "inside.md"));
    const linked = await httpRequest("POST", "/v1/documents", {
      body: JSON.stringify({ uri: `file://${wsDir}/inside.md` }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(linked.status, 404);
    assert.equal(JSON.parse(linked.body).error.code, "DOCUMENT_NOT_FOUND");

    // Control: a genuine workspace file opens, so the refusals above are the
    // containment check refusing — not a broken fixture refusing everything.
    const real = path.join(wsDir, "real.md");
    writeFileSync(real, "ok\n", "utf8");
    const opened = await httpRequest("POST", "/v1/documents", {
      body: JSON.stringify({ uri: `file://${real}` }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(opened.status, 201);
  });

  it("refuses an over-length search pattern with INVALID_PARAMS", async function () {
    const filePath = path.join(scratch, "long-pattern.md");
    const docId = await openFile(filePath, "alpha\n");
    const response = await httpRequest("POST", `/v1/documents/${docId}/search`, {
      body: JSON.stringify({ literal: "a".repeat(MAX_SEARCH_PATTERN_LENGTH + 1) }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, "INVALID_PARAMS");
  });

  it("stops a catastrophic search pattern with SEARCH_TIMEOUT", async function () {
    // (a+)+$ against a line of a's ending in a non-match backtracks
    // exponentially — 2^24 steps per line here. Unbounded, these 200 lines
    // hold the main process for tens of seconds; the deadline between
    // per-line executions must cut that off with a declared error instead.
    this.timeout(15000);
    const filePath = path.join(scratch, "catastrophic.md");
    const line = "a".repeat(24) + "!";
    const docId = await openFile(filePath, Array(200).fill(line).join("\n") + "\n");
    const response = await httpRequest("POST", `/v1/documents/${docId}/search`, {
      body: JSON.stringify({ literal: "/(a+)+$/" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 422);
    assert.equal(JSON.parse(response.body).error.code, "SEARCH_TIMEOUT");
  });

  it("POST /v1/documents/{id}/proposals returns 412 on a stale snapshot", async function () {
    const filePath = path.join(scratch, "stale.md");
    const docId = await openFile(filePath, "alpha\n");

    // Use a valid snapshot token format but with a mismatched hash
    // snap_v1_ prefix + base64url of {"documentId":"<docId>","version":1,"sha256":"<wrong>"}
    const wrongSha = "0000000000000000000000000000000000000000000000000000000000000000";
    const snapPayload = Buffer.from(
      JSON.stringify({
        documentId: docId,
        version: 1,
        sha256: wrongSha,
      }),
    ).toString("base64url");

    const response = await httpRequest("POST", `/v1/documents/${docId}/proposals`, {
      body: JSON.stringify({
        snapshot: `snap_v1_${snapPayload}`,
        patchFormat: "unified-diff",
        patch: makePatch("alpha\n", "ALPHA\n"),
        clientRequestId: "http-req-stale",
      }),
    });
    assert.equal(response.status, 412);
  });

  it("GET /v1/reviews lists active reviews", async function () {
    const filePath = path.join(scratch, "reviews.md");
    const docId = await openFile(filePath, "alpha\n");

    // Create a review
    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(snap.token, makePatch("alpha\n", "ALPHA\n"), "http-reviews-req");

    const response = await httpRequest("GET", "/v1/reviews");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.reviews.length > 0);
    // Every entry carries the documentId that maps the review to its document.
    assert.equal(body.reviews[0].documentId, docId);
    assertMatchesSchema(body, "ReviewListResponse");
  });

  it("GET /v1/reviews/{id}/diff returns the composite unresolved diff", async function () {
    const filePath = path.join(scratch, "rdiff.md");
    const docId = await openFile(filePath, "alpha\n");

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(snap.token, makePatch("alpha\n", "ALPHA\n"), "http-rdiff-req");

    const reviewsResponse = await httpRequest("GET", "/v1/reviews");
    const reviewId = JSON.parse(reviewsResponse.body).reviews[0].reviewId;

    const response = await httpRequest("GET", `/v1/reviews/${reviewId}/diff`);
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body) as { patch: string };
    assert.ok(body.patch.includes("-alpha"));
    assert.ok(body.patch.includes("+ALPHA"));
    assertMatchesSchema(body, "ReviewDiffResponse");
  });

  it("POST /v1/reviews/{id}/clear discards unresolved", async function () {
    const filePath = path.join(scratch, "rclear.md");
    // Separated edits so the review carries two chunks: one to accept, one
    // for /clear to discard.
    const original = "alpha\nx\ny\nz\nbeta\n";
    const proposed = "ALPHA\nx\ny\nz\nBETA\n";
    const docId = await openFile(filePath, original);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snap.token,
      makePatch(original, proposed),
      "http-rclear-req",
    );

    // Accept ALPHA first, through the one real decision path.
    const review = provider.reviewStore.getReview(docId)!;
    const chunks = provider.reviewStore.getOutstandingChunks(docId)!;
    assert.equal(chunks.length, 2);
    const accepted = provider.decideChunk(review.reviewId, chunks[0].chunkId, "accept");
    assert.equal(accepted.ok, true);

    const response = await httpRequest("POST", `/v1/reviews/${review.reviewId}/clear`);
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.state, "cleared");
    assertMatchesSchema(body, "ClearReviewResponse");
  });

  it("POST /v1/reviews/{id}/chunks/{chunkId}/accept and /reject decide through the provider", async function () {
    const filePath = path.join(scratch, "rdecide.md");
    const original = "alpha\nx\ny\nz\nbeta\n";
    const proposed = "ALPHA\nx\ny\nz\nBETA\n";
    const docId = await openFile(filePath, original);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snap.token,
      makePatch(original, proposed),
      "http-rdecide-req",
    );
    const review = provider.reviewStore.getReview(docId)!;

    const listed = await httpRequest("GET", `/v1/reviews/${review.reviewId}/chunks`);
    assert.equal(listed.status, 200);
    const listedBody = JSON.parse(listed.body) as {
      chunks: Array<{ chunkId: string; referenceText: string; workingText: string }>;
    };
    assertMatchesSchema(listedBody, "ReviewChunksResponse");
    assert.equal(listedBody.chunks.length, 2);
    assert.equal(listedBody.chunks[0].referenceText, "alpha");
    assert.equal(listedBody.chunks[0].workingText, "ALPHA");

    // Accept the first chunk: the reference moves, the document does not.
    const accept = await httpRequest(
      "POST",
      `/v1/reviews/${review.reviewId}/chunks/${listedBody.chunks[0].chunkId}/accept`,
    );
    assert.equal(accept.status, 200, accept.body);
    const acceptBody = JSON.parse(accept.body) as {
      decision: string;
      unresolvedChunks: number;
    };
    assertMatchesSchema(acceptBody, "ChunkDecisionResponse");
    assert.equal(acceptBody.decision, "accept");
    assert.equal(acceptBody.unresolvedChunks, 1);

    // The second chunk's content-addressed id survived the first decision.
    const reject = await httpRequest(
      "POST",
      `/v1/reviews/${review.reviewId}/chunks/${listedBody.chunks[1].chunkId}/reject`,
    );
    assert.equal(reject.status, 200, reject.body);
    const rejectBody = JSON.parse(reject.body) as { unresolvedChunks: number };
    assert.equal(rejectBody.unresolvedChunks, 0);

    // Mixed outcome: ALPHA accepted, beta restored.
    const doc = provider.loadedDocuments.find((d) => d.filePath === filePath)!;
    assert.equal(doc.document.toString(), "ALPHA\nx\ny\nz\nbeta\n");

    // A stale id — the chunk was already decided — fails loudly.
    const stale = await httpRequest(
      "POST",
      `/v1/reviews/${review.reviewId}/chunks/${listedBody.chunks[0].chunkId}/accept`,
    );
    assert.equal(stale.status, 404);
    assert.equal(JSON.parse(stale.body).error.code, "CHUNK_NOT_FOUND");
  });

  it("POST /v1/proposals/{id}/retract retracts an untouched packet", async function () {
    const filePath = path.join(scratch, "retract.md");
    const docId = await openFile(filePath, "alpha\nbeta\n");

    const snap = provider.createSnapshot(docId)!;
    const first = await provider.submitProposal(
      snap.token,
      makePatch("alpha\nbeta\n", "alpha\nBETA\n"),
      "http-retract-1",
    );
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }

    const response = await httpRequest("POST", `/v1/proposals/${first.packetId}/retract`);
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.retracted, true);
    assertMatchesSchema(body, "RetractProposalResponse");
  });

  it("answers a refused retraction with the declared PACKET_NOT_RETRACTABLE envelope", async function () {
    // Issue #43: the refusal is not a RetractProposalResponse — it is a 409
    // AgentErrorResponse whose error carries the owning reviewId and the
    // canClearUnresolved hint. AgentError declares additionalProperties: false,
    // so an undeclared detail field sneaking into the refusal fails here.
    const filePath = path.join(scratch, "retract-refused.md");
    const original = "alpha\nx\ny\nz\nbeta\n";
    const docId = await openFile(filePath, original);

    const snap = provider.createSnapshot(docId)!;
    const submitted = await provider.submitProposal(
      snap.token,
      makePatch(original, "ALPHA\nx\ny\nz\nBETA\n"),
      "http-retract-refused",
    );
    assert.equal(submitted.ok, true);
    if (!submitted.ok) {
      return;
    }

    // Deciding a chunk advances the review generation past the packet's,
    // which is exactly what makes the packet non-retractable.
    const chunks = provider.reviewStore.getOutstandingChunks(docId)!;
    const decided = provider.decideChunk(submitted.reviewId, chunks[0].chunkId, "accept");
    assert.equal(decided.ok, true);

    const refused = await httpRequest("POST", `/v1/proposals/${submitted.packetId}/retract`);
    assert.equal(refused.status, 409);
    const body = JSON.parse(refused.body);
    assertMatchesSchema(body, "AgentErrorResponse");
    assert.equal(body.error.code, "PACKET_NOT_RETRACTABLE");
    assert.equal(body.error.reviewId, submitted.reviewId);
    assert.equal(body.error.canClearUnresolved, true);
  });

  it("accepts unauthenticated loopback requests", async function () {
    const response = await new Promise<{
      status: number;
    }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: httpPort,
          path: "/v1/context",
          method: "GET",
          // The application API intentionally has no authentication layer.
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(response.status, 200);
  });

  it("GET /v1/events returns SSE stream", async function () {
    // Verify the SSE endpoint returns text/event-stream content type.
    // We resolve the promise from the response callback and abort the request.
    let resolved = false;
    const contentType = await new Promise<string>((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: httpPort,
          path: "/v1/events",
          method: "GET",
        },
        (res) => {
          const ct = res.headers["content-type"] ?? "";
          resolved = true;
          resolve(ct);
        },
      );
      req.on("error", () => {
        if (!resolved) {
          resolve("");
        }
      });
      req.setTimeout(5000, () => {
        if (!resolved) {
          resolved = true;
          resolve("");
        }
        req.destroy();
      });
      req.end();
    });
    assert.equal(contentType, "text/event-stream");
  });

  describe("request body lifecycle", function () {
    // Short enough for a test, long enough that a loopback client actually
    // transmitting never trips it. The production default (tens of seconds)
    // takes the same code path; only the constant differs.
    const DEADLINE_MS = 300;
    let lifecyclePort: number;
    let lifecycle: AgentHTTPProvider;
    let recordedErrors: string[];

    /** Captures error-level log entries so a test can assert none occurred. */
    class RecordingLog extends LogProvider {
      public error(msg: string): void {
        recordedErrors.push(msg);
      }
    }

    beforeEach(async function () {
      recordedErrors = [];
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      lifecyclePort = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      lifecycle = new AgentHTTPProvider(
        new RecordingLog(),
        provider,
        {
          config: {
            get: () => ({
              app: { openWorkspaces: [scratch] },
              agentApi: { enabled: true, port: lifecyclePort },
            }),
          },
        },
        DEADLINE_MS,
      );
      await lifecycle.boot();
    });

    afterEach(async function () {
      await lifecycle.shutdown();
    });

    /** Opens a raw TCP connection to the lifecycle server. */
    async function connect(): Promise<net.Socket> {
      const socket = net.connect(lifecyclePort, "127.0.0.1");
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return socket;
    }

    /**
     * Collects everything the server sends until it closes the connection.
     * Resolving at all is therefore itself the close assertion: a server
     * that answers but holds the socket open times the test out here.
     */
    async function readUntilClose(socket: net.Socket): Promise<string> {
      return await new Promise((resolve) => {
        let data = "";
        socket.on("data", (chunk: Buffer) => {
          data += chunk.toString("utf8");
        });
        // A reset after the response still ends the exchange; the bytes
        // already received are the answer.
        socket.on("error", () => {});
        socket.on("close", () => resolve(data));
      });
    }

    // Promises 64 body bytes and delivers a fragment, then goes quiet.
    const STALLED_REQUEST =
      "POST /v1/documents HTTP/1.1\r\n" +
      "Host: 127.0.0.1\r\n" +
      "Content-Type: application/json\r\n" +
      "Content-Length: 64\r\n" +
      "\r\n" +
      '{"uri": "safe-file';

    it("answers a stalled body with 408 REQUEST_BODY_TIMEOUT and closes the socket", async function () {
      const socket = await connect();
      socket.write(STALLED_REQUEST);
      const response = await readUntilClose(socket);
      assert.match(response, /^HTTP\/1\.1 408 /);
      const body = JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4));
      assert.equal(body.error.code, "REQUEST_BODY_TIMEOUT");
      assertMatchesSchema(body.error, "AgentError");
    });

    it("abandons the read when the client disconnects mid-body and keeps serving", async function () {
      const socket = await connect();
      socket.write(STALLED_REQUEST);
      // Let the server take the headers and begin the body read, then vanish.
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.destroy();

      // Wait out the deadline too: the abandoned read's timer must have been
      // cleared with its listeners, and the disconnect must not be booked as
      // a failure — before the fix this path logged an unhandled error and
      // wrote a 500 into the dead socket.
      await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS + 100));
      assert.deepEqual(recordedErrors, []);

      // And the server is still answering.
      const check = await connect();
      check.write("GET /v1/ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      const response = await readUntilClose(check);
      assert.match(response, /^HTTP\/1\.1 200 /);
    });
  });

  // ==========================================================================
  // OpenAPI conformance (issues #40/#43)
  //
  // The served specification, the shared TypeScript types, and the runtime
  // route table are three statements of one contract. Everything below checks
  // them against each other mechanically, so a change to any one of them that
  // is not carried to the others fails here instead of shipping as drift.
  // ==========================================================================

  describe("OpenAPI conformance", function () {
    const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

    /** Every operation in the published document, as METHOD + template path. */
    function specOperations(): Array<{
      method: string;
      path: string;
      operation: Record<string, unknown>;
    }> {
      const out: Array<{ method: string; path: string; operation: Record<string, unknown> }> = [];
      for (const [specPath, pathItem] of Object.entries(openApiDocument.paths)) {
        for (const method of HTTP_METHODS) {
          const operation = pathItem[method];
          if (operation !== undefined) {
            out.push({ method: method.toUpperCase(), path: specPath, operation });
          }
        }
      }
      return out;
    }

    it("resolves every $ref in the served specification", function () {
      const refs: string[] = [];
      (function collect(node: unknown): void {
        if (Array.isArray(node)) {
          node.forEach(collect);
          return;
        }
        if (node === null || typeof node !== "object") {
          return;
        }
        for (const [key, value] of Object.entries(node)) {
          if (key === "$ref" && typeof value === "string") {
            refs.push(value);
          } else {
            collect(value);
          }
        }
      })(openApiDocument);
      assert.ok(refs.length > 0, "the specification must contain component references");
      for (const ref of refs) {
        assert.match(ref, /^#\//, `only document-internal references are servable: ${ref}`);
        let cursor: unknown = openApiDocument;
        for (const part of ref.slice(2).split("/")) {
          assert.ok(
            cursor !== null && typeof cursor === "object" && part in (cursor as object),
            `dangling reference: ${ref}`,
          );
          cursor = (cursor as Record<string, unknown>)[part];
        }
      }
    });

    it("compiles every published component schema", function () {
      // ajv compiles lazily; forcing each one surfaces schemas that are
      // structurally broken in ways a reference walk cannot see.
      for (const name of Object.keys(openApiDocument.components.schemas)) {
        assert.ok(
          ajv.getSchema(`#/components/schemas/${name}`) !== undefined,
          `schema ${name} must compile`,
        );
      }
    });

    it("declares responses on every operation, and the AgentError envelope on every declared error", function () {
      for (const { method, path: specPath, operation } of specOperations()) {
        const responses = operation.responses as
          | Record<string, { content?: Record<string, { schema?: unknown }> }>
          | undefined;
        assert.ok(
          responses !== undefined && Object.keys(responses).length > 0,
          `${method} ${specPath} must declare its responses`,
        );
        for (const [status, response] of Object.entries(responses)) {
          if (!/^[45]/.test(status)) {
            continue;
          }
          const schema = response.content?.["application/json"]?.schema;
          assert.deepEqual(
            schema,
            { $ref: "#/components/schemas/AgentErrorResponse" },
            `${method} ${specPath} ${status} must declare the AgentError envelope`,
          );
        }
      }
    });

    it("backs every declared success body with a named schema exported from the TS types", function () {
      // The wire shapes live twice by design: as OpenAPI components for
      // consumers and as TypeScript types for the implementation. This pins
      // the correspondence at the name level so neither list can grow alone.
      const typeSource = readFileSync(
        path.join(__dirname, "../source/types/common/agent-api.ts"),
        "utf8",
      );
      const exported = new Set(
        [...typeSource.matchAll(/^export (?:interface|type|const) (\w+)/gm)].map((m) => m[1]),
      );
      for (const { method, path: specPath, operation } of specOperations()) {
        if (specPath.startsWith("/openapi.")) {
          continue; // The specification routes serve the document itself.
        }
        const responses = operation.responses as Record<
          string,
          { content?: Record<string, { schema?: { $ref?: string } }> }
        >;
        for (const [status, response] of Object.entries(responses)) {
          if (!/^2/.test(status)) {
            continue;
          }
          const schema = response.content?.["application/json"]?.schema;
          if (schema === undefined) {
            continue; // Not a JSON body (the SSE stream).
          }
          const ref = schema.$ref;
          assert.ok(
            ref !== undefined,
            `${method} ${specPath} ${status} must reference a named component, not an inline schema`,
          );
          const name = ref.split("/").pop()!;
          assert.ok(
            exported.has(name),
            `${method} ${specPath} ${status} references ${name}, which agent-api.ts does not export`,
          );
        }
      }
    });

    it("publishes exactly the routes the runtime registers", function () {
      // The dispatcher is stylized: literal `pathname === "..."` guards, and
      // anchored `pathname.match(/^...$/)` patterns whose scoped variants
      // branch on a captured sub-path. This extraction understands exactly
      // those idioms; a route written another way surfaces as a set mismatch
      // below rather than passing silently.
      const source = readFileSync(
        path.join(__dirname, "../source/app/service-providers/agent-api/http-server.ts"),
        "utf8",
      );
      const runtimeRoutes = new Set<string>();

      // The anonymous specification routes, served ahead of dispatch.
      const specGate = source.match(
        /req\.method === "GET" && \(req\.url === "([^"]+)" \|\| req\.url === "([^"]+)"\)/,
      );
      assert.ok(specGate !== null, "the anonymous specification gate must be extractable");
      runtimeRoutes.add(`GET ${specGate[1]}`);
      runtimeRoutes.add(`GET ${specGate[2]}`);

      // Literal routes.
      for (const m of source.matchAll(/pathname === "([^"]+)" && method === "([A-Z]+)"/g)) {
        runtimeRoutes.add(`${m[2]} ${m[1]}`);
      }

      // Anchored patterns. `([^/]+)` is a path parameter; a trailing
      // `(\/.*)?` marks a scope whose block branches on the sub-path.
      const template = (regexBody: string): string =>
        regexBody
          .replace(/^\^/, "")
          .replace(/\$$/, "")
          .replace(/\(\[\^\/\]\+\)/g, "{}")
          .replace(/\\\//g, "/");
      const SCOPED_SUFFIX = "(\\/.*)?$";

      const segments = source.split(/const \w+ = pathname\.match\(/).slice(1);
      assert.ok(segments.length > 0, "dispatch must contain pattern routes");
      for (const segment of segments) {
        const literal = segment.match(/^\s*\/(.*)\/,?\s*\)/);
        assert.ok(literal !== null, "every pathname.match must open with its regex literal");
        const body = literal[1];

        if (!body.endsWith(SCOPED_SUFFIX)) {
          const method = segment.match(/!== null && method === "([A-Z]+)"/);
          assert.ok(method !== null, `anchored route needs a method guard: ${body}`);
          runtimeRoutes.add(`${method[1]} ${template(body)}`);
          continue;
        }

        const base = template(body.slice(0, -SCOPED_SUFFIX.length));
        // The bare scope (sub-path absent, optionally a lone trailing slash).
        for (const m of segment.matchAll(
          /\(?(\w*[sS]ubPath) === undefined(?: \|\| \1 === "\/"\))? && method === "([A-Z]+)"/g,
        )) {
          runtimeRoutes.add(`${m[2]} ${base}`);
        }
        // Named sub-paths.
        for (const m of segment.matchAll(
          /\w*[sS]ubPath === "(\/[^"]+)" && method === "([A-Z]+)"/g,
        )) {
          runtimeRoutes.add(`${m[2]} ${base}${m[1]}`);
        }
        // Nested sub-path patterns (the accept|reject decision pair).
        for (const m of segment.matchAll(/const \w+ = \w+\?\.match\(\/(.*)\/\);/g)) {
          const tail = segment.slice((m.index ?? 0) + m[0].length);
          const method = tail.match(/method === "([A-Z]+)"/);
          assert.ok(method !== null, `nested route needs a method guard: ${m[1]}`);
          const sub = template(m[1]);
          const alternation = sub.match(/^(.*)\((\w+(?:\|\w+)+)\)(.*)$/);
          if (alternation !== null) {
            for (const option of alternation[2].split("|")) {
              runtimeRoutes.add(`${method[1]} ${base}${alternation[1]}${option}${alternation[3]}`);
            }
          } else {
            runtimeRoutes.add(`${method[1]} ${base}${sub}`);
          }
        }
      }

      // Parameter names differ between the two statements; identity does not.
      const declaredRoutes = specOperations().map(
        ({ method, path: specPath }) => `${method} ${specPath.replace(/\{[^}]+\}/g, "{}")}`,
      );
      assert.deepEqual(
        [...runtimeRoutes].sort(),
        declaredRoutes.sort(),
        "runtime route table and openapi.yaml paths must agree",
      );
    });

    it("routes every declared operation (none falls through to METHOD_NOT_FOUND)", async function () {
      this.timeout(10000);
      // Negative control first: the discriminator this probe relies on.
      const missing = await httpRequest("GET", "/v1/no-such-route");
      assert.equal(JSON.parse(missing.body).error.code, "METHOD_NOT_FOUND");

      for (const { method, path: specPath } of specOperations()) {
        const probePath = specPath.replace(/\{[^}]+\}/g, "conformance-probe");
        if (specPath === "/v1/events") {
          // SSE holds the connection open; headers alone prove the route.
          const observed = await new Promise<{ status: number; contentType: string }>(
            (resolve) => {
              const req = http.request(
                { hostname: "127.0.0.1", port: httpPort, path: probePath, method },
                (res) => {
                  resolve({
                    status: res.statusCode ?? 0,
                    contentType: res.headers["content-type"] ?? "",
                  });
                  res.destroy();
                },
              );
              req.on("error", () => resolve({ status: 0, contentType: "" }));
              req.end();
            },
          );
          assert.equal(observed.status, 200, `${method} ${specPath} must be routed`);
          assert.equal(observed.contentType, "text/event-stream");
          continue;
        }
        const response = await httpRequest(method, probePath);
        if (response.status >= 400) {
          const parsed = JSON.parse(response.body) as { error: { code: string } };
          assert.notEqual(
            parsed.error.code,
            "METHOD_NOT_FOUND",
            `${method} ${specPath} is declared but not routed`,
          );
        }
      }
    });

    it("serves the remaining declared bodies matching their schemas", async function () {
      // The response shapes not already pinned by a dedicated test above:
      // health, views, workspaces, search, review detail, packets, and the
      // long-poll. Together with those tests, every 2xx JSON component the
      // specification names is validated against a live response.
      const health = await httpRequest("GET", "/health");
      assert.equal(health.status, 200);
      assertMatchesSchema(JSON.parse(health.body), "PingResponse");

      const views = await httpRequest("GET", "/v1/views");
      assert.equal(views.status, 200);
      assertMatchesSchema(JSON.parse(views.body), "ViewsResponse");

      const workspaces = await httpRequest("GET", "/v1/workspaces");
      assert.equal(workspaces.status, 200);
      assertMatchesSchema(JSON.parse(workspaces.body), "WorkspacesResponse");

      const filePath = path.join(scratch, "conformance-flow.md");
      const docId = await openFile(filePath, "alpha\nbeta\n");

      const search = await httpRequest("POST", `/v1/documents/${docId}/search`, {
        body: JSON.stringify({ literal: "alpha" }),
        headers: { "content-type": "application/json" },
      });
      assert.equal(search.status, 200);
      const searchBody = JSON.parse(search.body);
      assert.equal(searchBody.hits.length, 1);
      assertMatchesSchema(searchBody, "SearchDocumentResponse");

      const snap = provider.createSnapshot(docId)!;
      const submitted = await provider.submitProposal(
        snap.token,
        makePatch("alpha\nbeta\n", "ALPHA\nbeta\n"),
        "conformance-flow",
      );
      assert.equal(submitted.ok, true);
      if (!submitted.ok) {
        return;
      }

      const detail = await httpRequest("GET", `/v1/reviews/${submitted.reviewId}`);
      assert.equal(detail.status, 200);
      assertMatchesSchema(JSON.parse(detail.body), "ReviewDetailResponse");

      const packets = await httpRequest("GET", `/v1/reviews/${submitted.reviewId}/packets`);
      assert.equal(packets.status, 200);
      const packetsBody = JSON.parse(packets.body);
      // applicationGeneration is required: a packet ledger without it is the
      // exact drift #43 exists to prevent.
      assert.equal(packetsBody.packets[0].applicationGeneration, 1);
      assertMatchesSchema(packetsBody, "ReviewPacketsResponse");

      const events = await httpRequest(
        "GET",
        `/v1/reviews/${submitted.reviewId}/events?afterGeneration=0&waitSeconds=0`,
      );
      assert.equal(events.status, 200);
      const eventsBody = JSON.parse(events.body);
      assert.equal(eventsBody.status.generation, 1);
      assertMatchesSchema(eventsBody, "ReviewEventsResponse");
    });
  });
});
