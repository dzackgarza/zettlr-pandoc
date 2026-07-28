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
import type { CodeFileDescriptor } from "@dts/common/fsal";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import type { AppServiceContainer } from "source/app/app-service-container";
import AgentHTTPProvider from "source/app/service-providers/agent-api/http-server";
import DocumentManager from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";

describe("Agent HTTP API (OpenAPI / REST)", function () {
  let scratch: string;
  let provider: DocumentManager;
  let httpProvider: AgentHTTPProvider;
  let httpPort: number;

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
            openWorkspaces: [scratch],
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
            openWorkspaces: [scratch],
          },
          agentApi: {
            enabled: true,
            port: httpPort,
          },
        }),
      },
    } as unknown as AppServiceContainer);
    await httpProvider.boot();
  });

  afterEach(async function () {
    await httpProvider.shutdown();
    rmSync(scratch, { recursive: true, force: true });
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
  });

  it("GET /v1/capabilities reports supported features", async function () {
    const response = await httpRequest("GET", "/v1/capabilities");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.supportedPatchFormats, ["unified-diff"]);
    assert.equal(body.reviewSupport, true);
  });

  it("GET /v1/context returns open documents", async function () {
    const filePath = path.join(scratch, "ctx.md");
    await openFile(filePath, "content\n");
    const response = await httpRequest("GET", "/v1/context");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.openDocuments.length > 0);
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
  });

  it("GET /v1/documents/{id} returns document metadata", async function () {
    const filePath = path.join(scratch, "meta.md");
    const docId = await openFile(filePath, "content\n");
    const response = await httpRequest("GET", `/v1/documents/${docId}`);
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.documentId, docId);
    assert.equal(body.path, filePath);
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
    const opened = await httpRequest(
      "POST",
      `/v1/workspaces/${encodeURIComponent(scratch)}/documents/${document.documentId}/open`,
    );
    assert.equal(opened.status, 200);
    assert.equal(JSON.parse(opened.body).documentId, document.documentId);
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
