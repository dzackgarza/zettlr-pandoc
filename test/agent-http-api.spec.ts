/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Agent HTTP API integration tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     Drives only the embedded HTTP protocol boundary against
 *                  the OpenAPI specification. Review state and persistence
 *                  are tested at the service boundary; assembled Electron
 *                  behavior is covered by the real Electron capture probes.
 *
 * END HEADER
 */

import { userData } from "./headless-electron-harness.cjs";
import Ajv2020 from "ajv/dist/2020";
import { parse as parseYaml } from "yaml";
import { type ReadDocumentResponse } from "@dts/common/agent-api";
import type { CodeFileDescriptor } from "@dts/common/fsal";
import { strict as assert } from "assert";
import { spawn } from "child_process";
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
import net from "net";
import os from "os";
import path from "path";
import AgentHTTPProvider from "source/app/service-providers/agent-api/http-server";
import DocumentManager from "source/app/service-providers/documents";
import { sha256Text } from "source/common/util/sha256";
import LogProvider from "source/app/service-providers/log";

// ============================================================================
// Contract conformance
// ============================================================================

/**
 * The specification as this file reads it. An operation keeps an index
 * signature so the structural audits below can walk any field generically,
 * and `requestBody` is spelled out because tests read published request
 * bounds out of it: a value reached through a declared path needs no cast to
 * be used, and a cast is what would let this shape drift from the document
 * without anything noticing.
 */
interface PublishedNumericBounds {
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: number;
}

interface PublishedOperation {
  [field: string]: unknown;
  requestBody?: {
    content: Record<
      string,
      { schema: { properties: Record<string, PublishedNumericBounds> } }
    >;
  };
}

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
  paths: Record<string, Record<string, PublishedOperation>>;
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
  let saveDialogResponse = 2;
  let peerServers: http.Server[] = [];
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
        // A real walk of the scratch workspace. Closed-file routes answer for
        // exactly the ids this listing hands out, so a seam that reported one
        // fixed name would let those tests pass against files that are not
        // there and miss files that are.
        readDirectoryRecursively: async (workspacePath: string) =>
          readdirSync(workspacePath, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => path.join(entry.parentPath, entry.name)),
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
          response: saveDialogResponse,
          checkboxChecked: false,
        }),
        getFirstMainWindow: () => undefined,
        getMainWindowKey: (_window: unknown) => activeWindowId,
      },
      // The manager drives the references provider's live overlay at its
      // mutation points (issue #53); this spec asserts the agent API, so
      // the seam only has to exist.
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

  function runReviewDiffCli(args: string[]): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(__dirname, "../scripts/desktop/zettlr-pandoc-review-diff"), ...args],
        { cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
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
    for (const peerServer of peerServers) {
      peerServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        peerServer.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
    peerServers = [];
    saveDialogResponse = 2;
    await httpProvider.shutdown();
    await provider.shutdown();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("fails enabled startup when the configured port is taken", async function () {
    // An enabled API without its configured listener is a broken application
    // state. Startup must report the bind failure instead of claiming success.
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
          agentApi: {
            enabled: true,
            port: takenPort,
          },
        }),
      },
    });

    try {
      await assert.rejects(
        collided.boot(),
        (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
      );
      assert.equal(
        collided.isListening,
        false,
        "a failed boot must leave no listener behind",
      );
    } finally {
      await collided.shutdown();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("GET /openapi.yaml serves the OpenAPI specification without auth", async function () {
    const response = await httpRequest("GET", "/openapi.yaml", {
      headers: {}, // No auth header
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.includes("openapi:"));
    assert.ok(response.body.includes("Zettlr-Pandoc Editor Agent API"));
  });

  it("serves a parsable specification for a Host header that is not a YAML scalar", async function () {
    // The origin the caller reached is written into the served document. Any
    // header value is legal input here — `Host: example.com: x` arrives intact
    // — and spliced into the document's text it produced YAML that no longer
    // parsed. /openapi.json parsed it back, in a request callback on the
    // Electron main process, with the 200 already on the wire: one anonymous
    // request ended the editor for the user working in it.
    const hostileHost = "zettlr.example.com: x";
    const asJson = await httpRequest("GET", "/openapi.json", {
      headers: { host: hostileHost },
    });
    assert.equal(asJson.status, 200);
    assert.equal(JSON.parse(asJson.body).servers[0].url, `https://${hostileHost}`);

    const asYaml = await httpRequest("GET", "/openapi.yaml", {
      headers: { host: hostileHost },
    });
    assert.equal(asYaml.status, 200);
    assert.deepEqual(
      parseYaml(asYaml.body),
      JSON.parse(asJson.body),
      "the served YAML must parse, and to the same document as the JSON",
    );

    // And the editor is still running to answer the next caller.
    assert.equal((await httpRequest("GET", "/v1/ping")).status, 200);

    // That next caller gets the committed document, not this one's origin. The
    // rewrite happens on a per-request copy; on the shared one, a caller that
    // sends no Host at all — legal in HTTP/1.0, so anyone may — would be handed
    // whichever origin the previous caller claimed.
    const withoutHost = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(httpPort, "127.0.0.1", () => {
        socket.write("GET /openapi.json HTTP/1.0\r\n\r\n");
      });
      let received = "";
      socket.on("data", (chunk: Buffer) => (received += chunk.toString("utf8")));
      socket.on("error", reject);
      socket.on("close", () => resolve(received));
    });
    assert.match(withoutHost.split("\r\n")[0], /^HTTP\/1\.[01] 200 /);
    assert.equal(
      JSON.parse(withoutHost.split("\r\n\r\n")[1]).servers[0].url,
      "http://127.0.0.1:27412",
      "the committed servers entry must survive another caller's Host header",
    );
  });

  it("serves an Action-compatible projection that differs only by the SSE route", async function () {
    // An Action importer cannot consume Server-Sent Events: it calls /v1/events
    // and waits on it forever. The projection drops that one route, and is
    // derived from the same parsed document per request, so there is no second
    // copy of the contract for this one to drift from.
    const host = "zettlr.example.com";
    const full = JSON.parse(
      (await httpRequest("GET", "/openapi.json", { headers: { host } })).body,
    );
    const projected = await httpRequest("GET", "/openapi-actions.json", {
      headers: { host },
    });
    assert.equal(projected.status, 200);
    assert.equal(projected.headers["content-type"], "application/json");
    const actions = JSON.parse(projected.body);

    assert.ok("/v1/events" in full.paths, "/openapi.json must keep the SSE route");
    assert.ok(!("/v1/events" in actions.paths), "the projection must drop the SSE route");
    assert.ok(
      "/v1/reviews/{reviewId}/events" in actions.paths,
      "the long-poll route is an ordinary request and must survive the projection",
    );

    // Everything else is the same document: every other operation, the schemas,
    // and the servers entry rewritten to the origin this request arrived on.
    delete full.paths["/v1/events"];
    assert.deepEqual(actions, full);
    assert.equal(actions.servers[0].url, `https://${host}`);

    for (const document of [full, actions]) {
      assert.equal(document.security, undefined, "the API declares no authentication");
      assert.equal(document.components.securitySchemes, undefined);
    }
  });

  it("publishes no adjudication operation in either served document", async function () {
    // The product boundary: an agent submits revisions and may comment on
    // them; disposing of a chunk is the reviewer's, through the editor. A
    // Custom GPT builds its callable surface from these documents alone, so
    // the absence of these operationIds is what makes adjudication
    // inexpressible to it — not a refusal it could retry.
    const adjudication = [
      "acceptReviewChunk",
      "rejectReviewChunk",
      "acceptAllReviewChunks",
      "clearReview",
    ];
    for (const route of ["/openapi.json", "/openapi-actions.json"]) {
      const document = JSON.parse((await httpRequest("GET", route)).body) as {
        paths: Record<string, Record<string, { operationId?: string }>>;
      };
      const declared = Object.values(document.paths).flatMap((methods) =>
        Object.values(methods).map((operation) => operation.operationId),
      );
      // Submission and comment prove the enumeration reads real operationIds:
      // a selector that found nothing would pass the absence check alone.
      assert.ok(declared.includes("submitProposal"), route);
      assert.ok(declared.includes("addReviewComment"), route);
      for (const operationId of adjudication) {
        assert.ok(!declared.includes(operationId), `${route} must not declare ${operationId}`);
      }
    }
  });

  it("declares every submitProposal response status in the served OpenAPI", async function () {
    const document = JSON.parse((await httpRequest("GET", "/openapi.json")).body) as {
      paths: Record<
        string,
        {
          post?: {
            responses?: Record<
              string,
              {
                content?: {
                  "application/json"?: { schema?: { $ref?: string } };
                };
              }
            >;
          };
        }
      >;
    };
    const responses = document.paths["/v1/documents/{documentId}/proposals"]?.post?.responses;
    assert.ok(responses !== undefined, "submitProposal must publish responses");

    assert.ok(responses["200"] !== undefined, "submitProposal must declare success");
    for (const status of ["400", "404", "409", "412", "500"]) {
      assert.equal(
        responses[status]?.content?.["application/json"]?.schema?.$ref,
        "#/components/schemas/AgentErrorResponse",
        `submitProposal ${status} must declare AgentErrorResponse`,
      );
    }
  });

  it("answers a request target that is not a URL instead of dying on it", async function () {
    // Absolute-form request targets are legal HTTP/1.1 and Node hands them to
    // the handler verbatim, so `new URL(req.url, ...)` refuses input that the
    // wire is entitled to send. A throw anywhere in the request callback is an
    // uncaught exception in the main process, not a failed request.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(httpPort, "127.0.0.1", () => {
        socket.write("GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      });
      let received = "";
      socket.on("data", (chunk: Buffer) => (received += chunk.toString("utf8")));
      socket.on("error", reject);
      socket.on("close", () => resolve(received));
    });
    assert.match(raw.split("\r\n")[0], /^HTTP\/1\.1 500 /);
    assert.equal(JSON.parse(raw.split("\r\n\r\n")[1]).error.code, "INTERNAL_ERROR");

    assert.equal((await httpRequest("GET", "/v1/ping")).status, 200);
  });

  it("GET /v1/ping returns protocol version", async function () {
    const response = await httpRequest("GET", "/v1/ping");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.protocolVersion !== undefined);
    assert.ok(body.instanceId !== undefined);
    assertMatchesSchema(body, "PingResponse");
  });

  it("preserves workspace walk failures in the HTTP error detail", async function () {
    const invalidWorkspace = path.join(scratch, "not-a-directory");
    writeFileSync(invalidWorkspace, "workspace path is a file\n", "utf8");
    openWorkspaces = [invalidWorkspace];

    const response = await httpRequest("GET", "/v1/workspace/files");
    assert.equal(response.status, 500);
    const body = JSON.parse(response.body) as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.match(body.error.message, /ENOTDIR|not a directory/i);
    assert.ok(body.error.message.includes(invalidWorkspace));
    assertMatchesSchema(body, "AgentErrorResponse");

    const documents = await httpRequest(
      "GET",
      `/v1/workspaces/${encodeURIComponent(invalidWorkspace)}/documents`,
    );
    assert.equal(documents.status, 500);
    const documentsBody = JSON.parse(documents.body) as {
      error: { code: string; message: string };
    };
    assert.equal(documentsBody.error.code, "INTERNAL_ERROR");
    assert.match(documentsBody.error.message, /ENOTDIR|not a directory/i);
    assert.ok(documentsBody.error.message.includes(invalidWorkspace));
    assertMatchesSchema(documentsBody, "AgentErrorResponse");
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
    const body = JSON.parse(response.body) as ReadDocumentResponse;
    assert.ok(body.content.includes("alpha"));
    // The revision hash is the whole external identity a proposal sends back.
    assert.equal(body.revision.sha256, sha256Text("alpha\nbeta\n"));
    assertMatchesSchema(body, "ReadDocumentResponse");
    // ETag must be present
    const etag = response.headers["etag"];
    assert.ok(etag !== undefined, "ETag header must be present");
    assert.ok(etag.includes("sha256:"));
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
      req.end();
    });
    assert.equal(contentType, "text/event-stream");
  });

  it("submits a review through the standalone external CLI process", async function () {
    const filePath = path.join(scratch, "cli-review.md");
    const original = "before\n";
    const revised = "after\n";
    const documentId = await openFile(filePath, original);
    const patchPath = path.join(scratch, "cli-review.diff");
    writeFileSync(
      patchPath,
      createPatch("document", original, revised, "", "", { context: 0 }),
      "utf8",
    );

    const result = await runReviewDiffCli([
      "--document",
      filePath,
      "--patch",
      patchPath,
      "--description",
      "standalone CLI proposition",
      "--port",
      String(httpPort),
      "--baseline-sha256",
      sha256Text(original),
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const submitted = JSON.parse(result.stdout) as {
      ok: boolean;
      documentId: string;
      reviewId: string;
      packetIds: string[];
      unresolvedChunks: number;
    };
    assert.equal(submitted.ok, true);
    assert.equal(submitted.documentId, documentId);
    assert.equal(submitted.packetIds.length, 1);
    assert.equal(submitted.unresolvedChunks, 1);

    const content = await httpRequest("GET", `/v1/documents/${documentId}/content`);
    assert.equal(content.status, 200);
    assert.equal((JSON.parse(content.body) as ReadDocumentResponse).content, revised);

    const chunks = await httpRequest("GET", `/v1/reviews/${submitted.reviewId}/chunks`);
    assert.equal(chunks.status, 200);
    const chunkBody = JSON.parse(chunks.body) as {
      chunks: Array<{ descriptions: string[]; workingText: string }>;
    };
    assert.deepEqual(chunkBody.chunks.map((chunk) => chunk.workingText), [revised.trimEnd()]);
    assert.deepEqual(chunkBody.chunks[0].descriptions, ["standalone CLI proposition"]);
  });

  it("rejects an incompatible Agent API before any mutating request", async function () {
    const requestPaths: string[] = [];
    const incompatiblePeer = http.createServer((request, response) => {
      requestPaths.push(request.url ?? "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ protocolVersion: "999.0" }));
    });
    peerServers.push(incompatiblePeer);
    await new Promise<void>((resolve) => {
      incompatiblePeer.listen(0, "127.0.0.1", resolve);
    });
    const address = incompatiblePeer.address();
    assert.ok(address !== null && typeof address !== "string");

    const filePath = path.join(scratch, "incompatible-protocol.md");
    const patchPath = path.join(scratch, "incompatible-protocol.diff");
    writeFileSync(filePath, "before\n", "utf8");
    writeFileSync(patchPath, "a non-empty proposition\n", "utf8");

    const result = await runReviewDiffCli([
      "--document",
      filePath,
      "--patch",
      patchPath,
      "--description",
      "incompatible protocol",
      "--port",
      String(address.port),
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const refusal = JSON.parse(result.stderr) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(refusal.ok, false);
    assert.equal(refusal.error.code, "PROTOCOL_VERSION_UNSUPPORTED");
    assert.deepEqual(requestPaths, ["/v1/ping"]);
  });

  it("detaches a saved pending review before closing its final pane", async function () {
    const filePath = path.join(scratch, "save-close-review.md");
    writeFileSync(filePath, "before\n", "utf8");
    const windowId = provider.windowKeys()[0];
    const leafId = provider.leafIds(windowId)[0];
    assert.ok(leafId !== undefined);
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, leafId, filePath), true);
    const documentId = provider.getDocumentId(filePath);
    assert.ok(documentId !== undefined);

    const submitted = await provider.submitProposal(
      documentId,
      sha256Text("before\n"),
      [
        {
          description: "save-close review",
          patch: createPatch("document", "before\n", "after\n", "", "", { context: 0 }),
        },
      ],
      "save-close-review",
      0,
    );
    if (!submitted.ok) {
      assert.fail(`The review proposal was refused: ${submitted.code}`);
    }

    saveDialogResponse = 0;
    assert.equal(await provider.closeFile(windowId, leafId, filePath), true);
    assert.equal(provider.loadedDocuments.length, 0);
    assert.equal(provider.reviewQueries.getReview(documentId), undefined);

    const reopenedLeafId = provider.leafIds(windowId)[0];
    assert.ok(reopenedLeafId !== undefined);
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, reopenedLeafId, filePath), true);
    assert.equal(provider.reviewStatus(documentId)?.unresolvedChunks, 1);
    assert.equal(provider.reviewQueries.getReview(documentId)?.reviewId, submitted.reviewId);
  });

  it("returns a patch refusal without opening an unopened document", async function () {
    const filePath = path.join(scratch, "cli-malformed.md");
    writeFileSync(filePath, "unchanged\n", "utf8");
    const patchPath = path.join(scratch, "cli-malformed.diff");
    writeFileSync(patchPath, "not a unified diff\n", "utf8");

    const result = await runReviewDiffCli([
      "--document",
      filePath,
      "--patch",
      patchPath,
      "--description",
      "malformed proposition",
      "--port",
      String(httpPort),
    ]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const refusal = JSON.parse(result.stderr) as {
      ok: boolean;
      error: { code: string; status: number };
    };
    assert.equal(refusal.ok, false);
    assert.equal(refusal.error.code, "PATCH_INVALID");
    assert.equal(refusal.error.status, 400);

    const documents = JSON.parse((await httpRequest("GET", "/v1/documents")).body) as {
      documents: Array<{ path: string }>;
    };
    assert.equal(documents.documents.some((document) => document.path === filePath), false);
    const content = await httpRequest("GET", "/v1/workspace/files");
    assert.equal(content.status, 200);
    const files = JSON.parse(content.body) as { files: Array<{ path: string; open: boolean }> };
    const file = files.files.find((entry) => entry.path === filePath);
    assert.ok(file !== undefined);
    assert.equal(file.open, false);
  });

  describe("request body lifecycle", function () {
    // Short enough for a test, long enough that a loopback client actually
    // transmitting never trips it. The production default (tens of seconds)
    // takes the same code path; only the constant differs.
    const DEADLINE_MS = 300;
    let lifecyclePort: number;
    let lifecycle: AgentHTTPProvider;
    let lifecycleLog: LogProvider;
    let lifecycleLogPath: string;

    beforeEach(async function () {
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      lifecyclePort = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const logDirectory = path.join(userData, "logs");
      mkdirSync(logDirectory, { recursive: true });
      lifecycleLog = new LogProvider();
      lifecycleLogPath = path.join(logDirectory, lifecycleLog._getLogfileName());
      lifecycle = new AgentHTTPProvider(
        lifecycleLog,
        provider,
        {
          config: {
            get: () => ({
              app: { openWorkspaces: [scratch] },
              agentApi: {
                enabled: true,
                port: lifecyclePort,
              },
            }),
          },
        },
        DEADLINE_MS,
      );
      await lifecycle.boot();
    });

    afterEach(async function () {
      await lifecycle.shutdown();
      await lifecycleLog.shutdown();
    });

    /**
     * Flushes the production logger and returns the byte boundary after which
     * the next request's records must appear.
     */
    async function markLogBoundary(): Promise<number> {
      await lifecycleLog.shutdown();
      return statSync(lifecycleLogPath).size;
    }

    /** Reads production log bytes emitted after a previously flushed boundary. */
    function readLogAfter(byteOffset: number): string {
      const logBytes = readFileSync(lifecycleLogPath);
      assert.ok(
        logBytes.byteLength >= byteOffset,
        "The production logfile shrank while the lifecycle request was in flight.",
      );
      return logBytes.subarray(byteOffset).toString("utf8");
    }

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

    // Promises 64 body bytes and delivers a fragment, then goes quiet. The
    // route is any that reads a body: the refusal happens in the read, before
    // the handler ever sees a request.
    const STALLED_REQUEST =
      "POST /v1/documents/doc-lifecycle/proposals HTTP/1.1\r\n" +
      "Host: 127.0.0.1\r\n" +
      "Content-Type: application/json\r\n" +
      "Content-Length: 64\r\n" +
      "\r\n" +
      '{"clientRequestId": "sta';

    it("answers a stalled body with 408 REQUEST_BODY_TIMEOUT and closes the socket", async function () {
      const socket = await connect();
      socket.write(STALLED_REQUEST);
      const response = await readUntilClose(socket);
      assert.match(response, /^HTTP\/1\.1 408 /);
      const body = JSON.parse(response.slice(response.indexOf("\r\n\r\n") + 4));
      assert.equal(body.error.code, "REQUEST_BODY_TIMEOUT");
      assertMatchesSchema(body.error, "AgentError");
    });

    it("answers an oversized body with structured 413 and logs the refusal", async function () {
      const logBoundary = await markLogBoundary();
      const body = JSON.stringify({ clientRequestId: "x".repeat(25 * 1024 * 1024) });
      const response = await new Promise<{
        status: number;
        body: string;
      }>((resolve, reject) => {
        const request = http.request(
          {
            hostname: "127.0.0.1",
            port: lifecyclePort,
            path: "/v1/documents/doc-lifecycle/proposals",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (incoming) => {
            let responseBody = "";
            incoming.on("data", (chunk: Buffer) => {
              responseBody += chunk.toString("utf8");
            });
            incoming.on("end", () => {
              if (incoming.statusCode === undefined) {
                reject(new Error("Oversized-body HTTP response carried no status code."));
                return;
              }
              resolve({ status: incoming.statusCode, body: responseBody });
            });
          },
        );
        request.on("error", reject);
        request.end(body);
      });

      assert.equal(response.status, 413, response.body);
      const responsePayload: unknown = JSON.parse(response.body);
      assert.ok(
        responsePayload !== null &&
          typeof responsePayload === "object" &&
          "error" in responsePayload &&
          responsePayload.error !== null &&
          typeof responsePayload.error === "object" &&
          "code" in responsePayload.error,
        `Oversized-body refusal carried no error code: ${response.body}`,
      );
      assert.equal(responsePayload.error.code, "REQUEST_TOO_LARGE");
      assertMatchesSchema(responsePayload.error, "AgentError");

      await lifecycleLog.shutdown();
      const emittedRecord = readLogAfter(logBoundary)
        .split("\n")
        .find(
          (line) =>
            line.includes("[Warning]") &&
            line.includes("REQUEST_TOO_LARGE") &&
            line.includes("POST /v1/documents/doc-lifecycle/proposals"),
        );
      assert.ok(
        emittedRecord !== undefined,
        "The real application logfile contains no warning identifying the refused oversized request.",
      );
    });

    it("abandons the read when the client disconnects mid-body and keeps serving", async function () {
      const logBoundary = await markLogBoundary();
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
      await lifecycleLog.shutdown();
      assert.equal(
        readLogAfter(logBoundary)
          .split("\n")
          .some((line) => line.includes("[Error]")),
        false,
        "An abandoned request must not emit an error record into the production logfile.",
      );

      // And the server is still answering.
      const check = await connect();
      check.write("GET /v1/ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
      const response = await readUntilClose(check);
      assert.match(response, /^HTTP\/1\.1 200 /);
    });
  });

  // ==========================================================================
  // ==========================================================================

  describe("live OpenAPI response conformance", function () {
    it("serves the remaining declared bodies matching their schemas", async function () {
      // Keep this boundary check limited to response shapes.
      const health = await httpRequest("GET", "/health");
      assert.equal(health.status, 200);
      assertMatchesSchema(JSON.parse(health.body), "PingResponse");

      const views = await httpRequest("GET", "/v1/views");
      assert.equal(views.status, 200);
      assertMatchesSchema(JSON.parse(views.body), "ViewsResponse");

      const workspaces = await httpRequest("GET", "/v1/workspaces");
      assert.equal(workspaces.status, 200);
      assertMatchesSchema(JSON.parse(workspaces.body), "WorkspacesResponse");

    });
  });
});
