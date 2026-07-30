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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import AgentHTTPProvider from "source/app/service-providers/agent-api/http-server";
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
) as { components: { schemas: Record<string, unknown> } };

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

  it("POST /v1/documents/{id}/proposals submits a patch with If-Match and Idempotency-Key", async function () {
    const filePath = path.join(scratch, "propose.md");
    const docId = await openFile(filePath, "alpha\n");

    // Read to get the ETag
    const readResponse = await httpRequest("GET", `/v1/documents/${docId}/content`);
    const etag = readResponse.headers["etag"] as string;
    const snapshot = JSON.parse(readResponse.body).snapshot;

    // Submit proposal
    const response = await httpRequest("POST", `/v1/documents/${docId}/proposals`, {
      body: JSON.stringify({
        snapshot,
        patchFormat: "unified-diff",
        patch: makePatch("alpha\n", "ALPHA\n"),
        clientRequestId: "http-req-1",
      }),
      headers: {
        "If-Match": etag,
        "Idempotency-Key": "http-idem-1",
      },
    });
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.packetId !== undefined);
    assert.ok(body.reviewId !== undefined);
    assert.equal(body.state, "active");
  });

  it("rejects reuse of an idempotency key for a different proposal", async function () {
    const filePath = path.join(scratch, "idempotency.md");
    const docId = await openFile(filePath, "alpha\n");
    const readResponse = await httpRequest("GET", `/v1/documents/${docId}/content`);
    const etag = readResponse.headers["etag"] as string;
    const snapshot = JSON.parse(readResponse.body).snapshot;
    const headers = { "If-Match": etag, "Idempotency-Key": "one-key" };
    const first = await httpRequest("POST", `/v1/documents/${docId}/proposals`, {
      headers,
      body: JSON.stringify({
        snapshot,
        patchFormat: "unified-diff",
        patch: makePatch("alpha\n", "ALPHA\n"),
      }),
    });
    assert.equal(first.status, 200);
    const conflicting = await httpRequest("POST", `/v1/documents/${docId}/proposals`, {
      headers,
      body: JSON.stringify({
        snapshot,
        patchFormat: "unified-diff",
        patch: makePatch("alpha\n", "BETA\n"),
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
    assert.equal(JSON.parse(opened.body).documentId, document.documentId);
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
  });

  it("POST /v1/documents/{id}/proposals returns 412 on stale ETag", async function () {
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
      headers: {
        "If-Match": `"sha256:${wrongSha}"`,
        "Idempotency-Key": "http-idem-stale",
      },
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
  });

  it("POST /v1/reviews/{id}/clear discards unresolved", async function () {
    const filePath = path.join(scratch, "rclear.md");
    const docId = await openFile(filePath, "alpha\nbeta\n");

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snap.token,
      makePatch("alpha\nbeta\n", "ALPHA\nBETA\n"),
      "http-rclear-req",
    );

    // Accept ALPHA first
    const review = provider.reviewStore.getReview(docId)!;
    provider.reviewStore.applyChunkAccept(docId, review.reviewId, 0, 6, 1);

    const response = await httpRequest("POST", `/v1/reviews/${review.reviewId}/clear`);
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.state, "cleared");
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
});
