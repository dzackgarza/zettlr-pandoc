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
import { ChangeSet } from "@codemirror/state";
import { AGENT_ERROR_CODES, type AgentEvent } from "@dts/common/agent-api";
import { DP_EVENTS, type SerializedUpdate } from "@dts/common/documents";
import type { CodeFileDescriptor } from "@dts/common/fsal";
import { strict as assert } from "assert";
import { createPatch } from "diff";
import { app } from "electron";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import AgentHTTPProvider, {
  MAX_SEARCH_CONTEXT,
  MAX_SEARCH_HITS,
  MAX_SEARCH_PATTERN_LENGTH,
} from "source/app/service-providers/agent-api/http-server";
import DocumentManager from "source/app/service-providers/documents";
import {
  ReviewSidecarStore,
  reviewSidecarFilePath,
} from "source/app/service-providers/documents/review-sidecar-store";
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

/**
 * The search request-body properties as the server publishes them. Search is
 * the one endpoint whose cost a caller chooses, so these are the numbers a
 * caller plans a request against; tests read them from here rather than
 * repeating literals, which is what keeps a published bound and an enforced
 * bound from drifting apart unnoticed.
 */
const searchRequestBody =
  openApiDocument.paths["/v1/documents/{documentId}/search"].post.requestBody;
assert.ok(
  searchRequestBody !== undefined,
  "openapi.yaml declares no request body for the search operation",
);
const searchRequestProperties =
  searchRequestBody.content["application/json"].schema.properties;

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
  // What the close prompt answers: 0 = Save, 1 = Don't save, 2 = Cancel. The
  // suite default is Cancel so no test loses a buffer by accident; the discard
  // test sets 1 to make the user's "Don't save" the answer under test.
  let saveChangesResponse = 2;

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
            tokenEnvironmentVariable: "ZETTLR_AGENT_API_TOKEN",
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
          response: saveChangesResponse,
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

  // The sidecar directory is app data shared by every DocumentManager this
  // process constructs, so it is cleared per test: review write-through would
  // otherwise leak one test's detached reviews into another's /v1/reviews.
  const sidecarDirectory = path.join(app.getPath("userData"), "review-sidecars");
  const sidecars = new ReviewSidecarStore(sidecarDirectory);

  /** Await the provider-owned asynchronous write queue. */
  async function flushSidecarWrites(): Promise<void> {
    await provider.flushReviewSidecarWrites();
  }

  beforeEach(async function () {
    scratch = mkdtempSync(path.join(os.tmpdir(), "zettlr-http-api-"));
    openWorkspaces = [scratch];
    saveChangesResponse = 2;
    rmSync(sidecarDirectory, { recursive: true, force: true });
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
            tokenEnvironmentVariable: "ZETTLR_AGENT_API_TOKEN",
          },
        }),
      },
    });
    await httpProvider.boot();
  });

  afterEach(async function () {
    await httpProvider.shutdown();
    await provider.shutdown();
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("bearer token enforcement", function () {
    const TOKEN = "s3cret-token-value";
    const TOKEN_ENVIRONMENT_VARIABLE = "ZETTLR_TEST_AGENT_API_TOKEN";
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
      previousToken = process.env[TOKEN_ENVIRONMENT_VARIABLE];
      process.env[TOKEN_ENVIRONMENT_VARIABLE] = TOKEN;
      guarded = new AgentHTTPProvider(new LogProvider(), provider, {
        config: {
          get: () => ({
            app: { openWorkspaces: [scratch] },
            agentApi: {
              enabled: true,
              port: tokenPort,
              tokenEnvironmentVariable: TOKEN_ENVIRONMENT_VARIABLE,
            },
          }),
        },
      });
      await guarded.boot();
    });

    afterEach(async function () {
      await guarded.shutdown();
      if (previousToken === undefined) {
        delete process.env.ZETTLR_TEST_AGENT_API_TOKEN;
      } else {
        process.env[TOKEN_ENVIRONMENT_VARIABLE] = previousToken;
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
      // writing both encodings from the one document parsed at construction is
      // what keeps them from drifting.
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
          agentApi: {
            enabled: true,
            port: takenPort,
            tokenEnvironmentVariable: "ZETTLR_AGENT_API_TOKEN",
          },
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

  it("publishes the search bounds the server actually enforces", function () {
    // Search is the one endpoint whose cost a caller controls, on the process
    // that draws the editor. A bound the server enforces but does not publish
    // is a refusal the caller cannot anticipate, and a bound published but not
    // enforced is a promise nothing keeps — so both dimensions of the request
    // are compared against the constants the decoder refuses by.
    assert.equal(searchRequestProperties.literal.maxLength, MAX_SEARCH_PATTERN_LENGTH);
    assert.equal(searchRequestProperties.context.minimum, 0);
    assert.equal(searchRequestProperties.context.maximum, MAX_SEARCH_CONTEXT);
    const searchResponseSchema = openApiDocument.components.schemas.SearchDocumentResponse as {
      properties: { hits: { maxItems: number } };
    };
    assert.equal(searchResponseSchema.properties.hits.maxItems, MAX_SEARCH_HITS);
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

  it("POST /v1/documents/{id}/proposals applies an ordered claims batch atomically", async function () {
    const filePath = path.join(scratch, "claims.md");
    const original = "alpha\nx\ny\nz\nbeta\n";
    const docId = await openFile(filePath, original);
    const readResponse = await httpRequest("GET", `/v1/documents/${docId}/content`);
    const snapshot = JSON.parse(readResponse.body).snapshot;

    // Claim 2's patch is built against claim 1's output: it only applies if
    // the server really applies the sequence in order.
    const afterFirst = "ALPHA\nx\ny\nz\nbeta\n";
    const afterSecond = "ALPHA\nx\ny\nz\nBETA\n";
    const response = await httpRequest("POST", `/v1/documents/${docId}/proposals`, {
      body: JSON.stringify({
        snapshot,
        patchFormat: "unified-diff",
        claims: [
          { description: "Capitalize the opening", patch: makePatch(original, afterFirst) },
          { description: "Capitalize the closing", patch: makePatch(afterFirst, afterSecond) },
        ],
        clientRequestId: "http-claims-1",
      }),
    });
    assert.equal(response.status, 200, response.body);
    const body = JSON.parse(response.body) as {
      packetId: string;
      packetIds: string[];
      reviewId: string;
      unresolvedChunks: number;
    };
    assertMatchesSchema(body, "SubmitProposalResponse");
    assert.equal(body.packetIds.length, 2);
    assert.equal(body.packetId, body.packetIds[1]);
    assert.equal(body.unresolvedChunks, 2);

    // The ledger carries one packet per claim, in claim order, each with its
    // own description.
    const packets = await httpRequest("GET", `/v1/reviews/${body.reviewId}/packets`);
    const packetsBody = JSON.parse(packets.body) as {
      packets: Array<{ packetId: string; description?: string }>;
    };
    assert.deepEqual(
      packetsBody.packets.map((p) => p.packetId),
      body.packetIds,
    );
    assert.deepEqual(
      packetsBody.packets.map((p) => p.description),
      ["Capitalize the opening", "Capitalize the closing"],
    );

    // And the document shows the text after the whole sequence.
    const doc = provider.loadedDocuments.find((d) => d.filePath === filePath)!;
    assert.equal(doc.document.toString(), afterSecond);

    // The chunk list exposes the attribution: each chunk names the packet
    // whose claim produced it and carries that claim's description, so the
    // agent can see which of its claims survive as which chunks.
    const chunksResponse = await httpRequest("GET", `/v1/reviews/${body.reviewId}/chunks`);
    assert.equal(chunksResponse.status, 200);
    const chunksBody = JSON.parse(chunksResponse.body) as {
      chunks: Array<{ packetIds: string[]; descriptions: string[] }>;
    };
    assertMatchesSchema(chunksBody, "ReviewChunksResponse");
    assert.equal(chunksBody.chunks.length, 2);
    assert.deepEqual(chunksBody.chunks[0].packetIds, [body.packetIds[0]]);
    assert.deepEqual(chunksBody.chunks[0].descriptions, ["Capitalize the opening"]);
    assert.deepEqual(chunksBody.chunks[1].packetIds, [body.packetIds[1]]);
    assert.deepEqual(chunksBody.chunks[1].descriptions, ["Capitalize the closing"]);
  });

  it("refuses a claims batch whole when one claim fails, leaving no review behind", async function () {
    const filePath = path.join(scratch, "claims-atomic.md");
    const original = "alpha\nbeta\n";
    const docId = await openFile(filePath, original);
    const readResponse = await httpRequest("GET", `/v1/documents/${docId}/content`);
    const snapshot = JSON.parse(readResponse.body).snapshot;

    const response = await httpRequest("POST", `/v1/documents/${docId}/proposals`, {
      body: JSON.stringify({
        snapshot,
        patchFormat: "unified-diff",
        claims: [
          { description: "applies", patch: makePatch(original, "ALPHA\nbeta\n") },
          // Built against text the sequence never produces: zero fuzz refuses it.
          { description: "does not", patch: makePatch("unrelated\ntext\n", "other\n") },
        ],
        clientRequestId: "http-claims-broken",
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, "PATCH_NOT_APPLICABLE");

    // All-or-nothing: no review opened, no packet applied, text untouched.
    const reviews = await httpRequest("GET", "/v1/reviews");
    assert.deepEqual(JSON.parse(reviews.body).reviews, []);
    const doc = provider.loadedDocuments.find((d) => d.filePath === filePath)!;
    assert.equal(doc.document.toString(), original);
  });

  it("refuses a proposal carrying both the patch and the claims shape", async function () {
    const filePath = path.join(scratch, "claims-shapes.md");
    const docId = await openFile(filePath, "alpha\n");
    const readResponse = await httpRequest("GET", `/v1/documents/${docId}/content`);
    const snapshot = JSON.parse(readResponse.body).snapshot;
    const patch = makePatch("alpha\n", "ALPHA\n");
    const response = await httpRequest("POST", `/v1/documents/${docId}/proposals`, {
      body: JSON.stringify({
        snapshot,
        patchFormat: "unified-diff",
        patch,
        claims: [{ description: "duplicate shape", patch }],
        clientRequestId: "http-claims-shapes",
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, "INVALID_PARAMS");
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

  it("decodes a workspace id once and scopes document opens to that workspace", async function () {
    const encodedWorkspace = path.join(scratch, "workspace%25");
    const otherWorkspace = path.join(scratch, "other-workspace");
    mkdirSync(encodedWorkspace);
    mkdirSync(otherWorkspace);
    writeFileSync(path.join(encodedWorkspace, "unopened.md"), "encoded workspace\n", "utf8");
    const otherDocument = path.join(otherWorkspace, "outside.md");
    writeFileSync(otherDocument, "other workspace\n", "utf8");
    openWorkspaces = [encodedWorkspace, otherWorkspace];

    const listed = await httpRequest(
      "GET",
      `/v1/workspaces/${encodeURIComponent(encodedWorkspace)}/documents`,
    );
    assert.equal(listed.status, 200, listed.body);
    const listedPayload: unknown = JSON.parse(listed.body);
    assert.ok(
      listedPayload !== null &&
        typeof listedPayload === "object" &&
        "workspaceId" in listedPayload,
      `Workspace listing carried no workspaceId: ${listed.body}`,
    );
    assert.equal(
      listedPayload.workspaceId,
      encodedWorkspace,
      "the workspace identifier on the wire must be the once-decoded requested path",
    );

    const otherDocumentId = provider.ensureDocumentId(otherDocument);
    const refused = await httpRequest(
      "POST",
      `/v1/workspaces/${encodeURIComponent(encodedWorkspace)}/documents/${otherDocumentId}/open`,
    );
    assert.equal(refused.status, 404, refused.body);
    const refusedPayload: unknown = JSON.parse(refused.body);
    assert.ok(
      refusedPayload !== null &&
        typeof refusedPayload === "object" &&
        "error" in refusedPayload &&
        refusedPayload.error !== null &&
        typeof refusedPayload.error === "object" &&
        "code" in refusedPayload.error,
      `Workspace refusal carried no error code: ${refused.body}`,
    );
    assert.equal(
      refusedPayload.error.code,
      "DOCUMENT_NOT_FOUND",
    );
    assert.equal(
      provider.loadedDocuments.some((document) => document.filePath === otherDocument),
      false,
      "a document from another configured workspace must not be opened through this route",
    );
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

  it("refuses a search context outside the declared range with INVALID_PARAMS", async function () {
    // `context` is a per-hit multiplier: every hit copies that many lines from
    // each side into the response, so a caller naming a context the size of
    // the document makes each hit carry a whole copy of it, in the main
    // process. Both ends of the declared range are refused at the decode
    // boundary — the endpoint never sees a request it cannot afford.
    const filePath = path.join(scratch, "context-range.md");
    const docId = await openFile(filePath, "alpha\n");
    for (const context of [MAX_SEARCH_CONTEXT + 1, 1_000_000, -1]) {
      const response = await httpRequest("POST", `/v1/documents/${docId}/search`, {
        body: JSON.stringify({ literal: "alpha", context }),
        headers: { "content-type": "application/json" },
      });
      assert.equal(response.status, 400, `context ${context} must be refused`);
      assert.equal(JSON.parse(response.body).error.code, "INVALID_PARAMS");
    }
  });

  it("carries at most the declared context around a hit in a longer document", async function () {
    // The control for the refusal above, and the ceiling itself: a request at
    // the maximum is served, and on a document three times the cap the hit
    // carries exactly the capped window from each side — not the document.
    const lines = Array.from({ length: 3 * MAX_SEARCH_CONTEXT }, (_, index) =>
      `line-${String(index + 1).padStart(4, "0")}`,
    );
    const hitIndex = 2 * MAX_SEARCH_CONTEXT - 1;
    const filePath = path.join(scratch, "context-window.md");
    const docId = await openFile(filePath, lines.join("\n") + "\n");
    const response = await httpRequest("POST", `/v1/documents/${docId}/search`, {
      body: JSON.stringify({ literal: lines[hitIndex], context: MAX_SEARCH_CONTEXT }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 200);
    const hits = JSON.parse(response.body).hits as Array<{
      line: number;
      contextBefore: string;
      contextAfter: string;
    }>;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, hitIndex + 1);
    assert.deepEqual(
      hits[0].contextBefore.split("\n"),
      lines.slice(hitIndex - MAX_SEARCH_CONTEXT, hitIndex),
    );
    assert.deepEqual(
      hits[0].contextAfter.split("\n"),
      lines.slice(hitIndex + 1, hitIndex + 1 + MAX_SEARCH_CONTEXT),
    );
  });

  it("carries the context the specification publishes as the default", async function () {
    // `context` is optional, so the published default is the multiplier on
    // every request that omits it — the ordinary case, and the one a caller
    // sizes its own buffers against. The window served here is measured
    // against the number the document publishes rather than a literal
    // repeated in this file, so a decoder default that drifts from the
    // published one fails here instead of silently multiplying every
    // response.
    const declaredDefault = searchRequestProperties.context.default;
    assert.ok(
      typeof declaredDefault === "number",
      "openapi.yaml must publish a default for context",
    );
    const lines = Array.from({ length: 2 * declaredDefault + 5 }, (_, index) =>
      `line-${String(index + 1).padStart(4, "0")}`,
    );
    const hitIndex = declaredDefault + 2;
    const filePath = path.join(scratch, "context-default.md");
    const docId = await openFile(filePath, lines.join("\n") + "\n");
    const response = await httpRequest("POST", `/v1/documents/${docId}/search`, {
      body: JSON.stringify({ literal: lines[hitIndex] }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 200);
    const hits = JSON.parse(response.body).hits as Array<{
      line: number;
      contextBefore: string;
      contextAfter: string;
    }>;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, hitIndex + 1);
    assert.deepEqual(
      hits[0].contextBefore.split("\n"),
      lines.slice(hitIndex - declaredDefault, hitIndex),
    );
    assert.deepEqual(
      hits[0].contextAfter.split("\n"),
      lines.slice(hitIndex + 1, hitIndex + 1 + declaredDefault),
    );
  });

  it("stops a catastrophic search pattern on ONE line with SEARCH_TIMEOUT", async function () {
    // The whole document is a single line: `(a+)+$` against 30 a's ending in
    // a non-match backtracks exponentially inside ONE exec call — about ten
    // seconds of frozen main process here, unbounded as the line grows. A
    // deadline observed between lines never gets to run, so this is exactly
    // the input the declared budget exists to survive, and the elapsed
    // assertion is the declaration: the answer arrives on the budget's scale,
    // not the pattern's. Then a plain search on the same document must still
    // answer, because a ceiling that leaves the process wedged is no ceiling.
    this.timeout(30000);
    const filePath = path.join(scratch, "catastrophic.md");
    const docId = await openFile(filePath, "a".repeat(30) + "!\n");
    const started = Date.now();
    const response = await httpRequest("POST", `/v1/documents/${docId}/search`, {
      body: JSON.stringify({ literal: "/(a+)+$/" }),
      headers: { "content-type": "application/json" },
    });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 422);
    assert.equal(JSON.parse(response.body).error.code, "SEARCH_TIMEOUT");
    assert.ok(elapsed < 5000, `search returned after ${elapsed} ms, past the declared budget`);

    const after = await httpRequest("POST", `/v1/documents/${docId}/search`, {
      body: JSON.stringify({ literal: "!" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(after.status, 200);
    assert.equal(JSON.parse(after.body).hits.length, 1);
  });

  it("returns every hit on a line that matches more than once", async function () {
    // Two hits on one line is the ordinary case, and the per-line loop only
    // advances if it re-executes after each hit. Without that, the same match
    // is pushed forever and the search never returns.
    this.timeout(10000);
    const filePath = path.join(scratch, "repeated-hits.md");
    const docId = await openFile(filePath, "alpha beta alpha gamma\n");
    const response = await httpRequest("POST", `/v1/documents/${docId}/search`, {
      body: JSON.stringify({ literal: "alpha" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 200);
    const hits = JSON.parse(response.body).hits;
    assert.deepEqual(
      hits.map((hit: { line: number; column: number; length: number }) => [
        hit.line,
        hit.column,
        hit.length,
      ]),
      [
        [1, 1, 5],
        [1, 12, 5],
      ],
    );
    assert.equal(JSON.parse(response.body).truncated, false);
  });

  it("caps frequent search results and reports truncation truthfully", async function () {
    const filePath = path.join(scratch, "truncated-hits.md");
    const docId = await openFile(filePath, Array.from({ length: MAX_SEARCH_HITS + 1 }, () => "alpha").join("\n"));
    const response = await httpRequest("POST", `/v1/documents/${docId}/search`, {
      body: JSON.stringify({ literal: "alpha", context: 0 }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body) as {
      hits: Array<{ line: number }>;
      truncated: boolean;
    };
    assert.equal(body.hits.length, MAX_SEARCH_HITS);
    assert.equal(body.hits.at(-1)?.line, MAX_SEARCH_HITS);
    assert.equal(body.truncated, true);
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

  it("refuses proposal ingress when disk drifted before the first review opened", async function () {
    const filePath = path.join(scratch, "ingress-drift.md");
    const docId = await openFile(filePath, "alpha\n");
    const snapshot = provider.createSnapshot(docId)!;

    // The editor still owns the snapshot bytes, but an external writer has
    // already changed disk. Opening a review against that external baseline
    // would make a later accepted proposal overwrite it.
    writeFileSync(filePath, "external\n", "utf8");
    const response = await httpRequest("POST", `/v1/documents/${docId}/proposals`, {
      body: JSON.stringify({
        snapshot: snapshot.token,
        patchFormat: "unified-diff",
        patch: makePatch("alpha\n", "ALPHA\n"),
        clientRequestId: "http-ingress-drift",
      }),
    });
    assert.equal(response.status, 412);
    assert.equal(JSON.parse(response.body).error.code, "REVISION_MISMATCH");
    assert.equal(provider.reviewStore.listReviews().length, 0, "refusal must not open a review");
    assert.equal(readFileSync(filePath, "utf8"), "external\n", "external bytes must remain untouched");
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

  it("POST /v1/reviews/{id}/accept-all accepts the whole partition without touching the document", async function () {
    const filePath = path.join(scratch, "racceptall.md");
    // Separated edits so the sweep has more than one chunk to resolve.
    const original = "alpha\nx\ny\nz\nbeta\n";
    const proposed = "ALPHA\nx\ny\nz\nBETA\n";
    const docId = await openFile(filePath, original);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(
      snap.token,
      makePatch(original, proposed),
      "http-racceptall-req",
    );
    const review = provider.reviewStore.getReview(docId)!;
    assert.equal(provider.reviewStore.countUnresolved(docId), 2);

    const response = await httpRequest("POST", `/v1/reviews/${review.reviewId}/accept-all`);
    assert.equal(response.status, 200, response.body);
    const body = JSON.parse(response.body) as {
      acceptedChunks: number;
      unresolvedChunks: number;
      state: string;
    };
    assertMatchesSchema(body, "AcceptAllChunksResponse");
    assert.equal(body.acceptedChunks, 2);
    assert.equal(body.unresolvedChunks, 0);
    assert.equal(body.state, "resolved-awaiting-save");

    // Accept moves the reference only: the document keeps the proposed text,
    // and the reference now agrees with it.
    const doc = provider.loadedDocuments.find((d) => d.filePath === filePath)!;
    assert.equal(doc.document.toString(), proposed);
    assert.equal(provider.reviewStore.getReview(docId)!.referenceText, proposed);
    assert.equal(provider.reviewStore.countUnresolved(docId), 0);

    // An unknown review fails loudly.
    const missing = await httpRequest("POST", "/v1/reviews/no-such-review/accept-all");
    assert.equal(missing.status, 404);
    assert.equal(JSON.parse(missing.body).error.code, "REVIEW_NOT_FOUND");
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

  it("POST /v1/reviews/{id}/chunks/{chunkId}/hold annotates without adjudicating", async function () {
    const filePath = path.join(scratch, "rhold.md");
    const original = "alpha\nx\ny\nz\nbeta\n";
    const proposed = "ALPHA\nx\ny\nz\nBETA\n";
    const docId = await openFile(filePath, original);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(snap.token, makePatch(original, proposed), "http-rhold-req");
    const review = provider.reviewStore.getReview(docId)!;
    const chunks = provider.reviewStore.getOutstandingChunks(docId)!;
    assert.equal(chunks.length, 2);

    // Hold the first chunk with a comment.
    const held = await httpRequest(
      "POST",
      `/v1/reviews/${review.reviewId}/chunks/${chunks[0].chunkId}/hold`,
      {
        body: JSON.stringify({ comment: "verify the constant first" }),
        headers: { "content-type": "application/json" },
      },
    );
    assert.equal(held.status, 200, held.body);
    const heldBody = JSON.parse(held.body) as { decision: string; unresolvedChunks: number };
    assertMatchesSchema(heldBody, "ChunkDecisionResponse");
    assert.equal(heldBody.decision, "hold");
    assert.equal(heldBody.unresolvedChunks, 1);

    // No text moved: the document still shows the full proposal.
    const doc = provider.loadedDocuments.find((d) => d.filePath === filePath)!;
    assert.equal(doc.document.toString(), proposed);

    // The chunk list carries the state and the comment.
    const listed = await httpRequest("GET", `/v1/reviews/${review.reviewId}/chunks`);
    const listedBody = JSON.parse(listed.body) as {
      chunks: Array<{ state: string; holdComment?: string }>;
    };
    assertMatchesSchema(listedBody, "ReviewChunksResponse");
    assert.equal(listedBody.chunks[0].state, "held");
    assert.equal(listedBody.chunks[0].holdComment, "verify the constant first");
    assert.equal(listedBody.chunks[1].state, "pending");

    // A hold without a body is legal, and a held-only review is saveable.
    const bare = await httpRequest(
      "POST",
      `/v1/reviews/${review.reviewId}/chunks/${chunks[1].chunkId}/hold`,
    );
    assert.equal(bare.status, 200, bare.body);
    const bareBody = JSON.parse(bare.body) as { unresolvedChunks: number; state: string };
    assert.equal(bareBody.unresolvedChunks, 0);
    assert.equal(bareBody.state, "resolved-awaiting-save");

    const detail = await httpRequest("GET", `/v1/reviews/${review.reviewId}`);
    const detailBody = JSON.parse(detail.body) as {
      heldChunks: number;
      unresolvedChunks: number;
      comments: unknown[];
    };
    assertMatchesSchema(detailBody, "ReviewDetailResponse");
    assert.equal(detailBody.unresolvedChunks, 0);
    assert.equal(detailBody.heldChunks, 2);
    assert.deepEqual(detailBody.comments, []);
  });

  it("POST /v1/reviews/{id}/comments attaches a comment the generation cursor sees", async function () {
    const filePath = path.join(scratch, "rcomment.md");
    const docId = await openFile(filePath, "alpha\n");
    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(snap.token, makePatch("alpha\n", "ALPHA\n"), "http-rcomment");
    const review = provider.reviewStore.getReview(docId)!;
    assert.equal(review.generation, 1);

    const posted = await httpRequest("POST", `/v1/reviews/${review.reviewId}/comments`, {
      body: JSON.stringify({ text: "keep the original spelling of my name" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(posted.status, 200, posted.body);
    const postedBody = JSON.parse(posted.body) as {
      reviewGeneration: number;
      comment: { text: string };
    };
    assertMatchesSchema(postedBody, "ReviewCommentResponse");
    assert.equal(postedBody.comment.text, "keep the original spelling of my name");
    assert.equal(postedBody.reviewGeneration, 2);

    // The existing generation cursor IS the "what changed since my last
    // turn" query: a long-poll parked after generation 1 returns at once.
    const events = await httpRequest(
      "GET",
      `/v1/reviews/${review.reviewId}/events?afterGeneration=1&waitSeconds=0`,
    );
    const eventsBody = JSON.parse(events.body) as {
      status?: { generation: number };
      timedOut?: boolean;
    };
    assert.notEqual(eventsBody.timedOut, true, "the comment must wake the cursor");
    assert.equal(eventsBody.status?.generation, 2);

    // And the detail read carries it.
    const detail = await httpRequest("GET", `/v1/reviews/${review.reviewId}`);
    const detailBody = JSON.parse(detail.body) as { comments: Array<{ text: string }> };
    assert.equal(detailBody.comments.length, 1);
    assert.equal(detailBody.comments[0].text, "keep the original spelling of my name");

    // An empty comment is refused loudly, not stored as noise.
    const empty = await httpRequest("POST", `/v1/reviews/${review.reviewId}/comments`, {
      body: JSON.stringify({ text: "" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(empty.status, 400);
    assert.equal(JSON.parse(empty.body).error.code, "INVALID_PARAMS");
  });

  it("saves a review with accepted+rejected+held chunks and the held chunk survives", async function () {
    const filePath = path.join(scratch, "rhold-save.md");
    const original = "alpha\nx\ny\nz\nbeta\np\nq\nr\ngamma\n";
    const proposed = "ALPHA\nx\ny\nz\nBETA\np\nq\nr\nGAMMA\n";
    const docId = await openFile(filePath, original);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(snap.token, makePatch(original, proposed), "http-hold-save");
    const review = provider.reviewStore.getReview(docId)!;
    const chunks = provider.reviewStore.getOutstandingChunks(docId)!;
    assert.equal(chunks.length, 3);

    assert.equal(provider.decideChunk(review.reviewId, chunks[0].chunkId, "accept").ok, true);
    assert.equal(provider.decideChunk(review.reviewId, chunks[1].chunkId, "reject").ok, true);
    assert.equal(
      provider.decideChunk(review.reviewId, chunks[2].chunkId, "hold", "gamma is undecided").ok,
      true,
    );

    // Held chunks do not block the save gate.
    const saved = await provider.saveFile(filePath);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const written = normalizedRead(filePath);
    assert.equal(written, "ALPHA\nx\ny\nz\nbeta\np\nq\nr\nGAMMA\n");

    // The review survives: the reference retains its disagreement over the
    // held span, the chunk is still held with its comment, and nothing was
    // invalidated — this is what keeps the annotation rendered in the panes.
    const survivor = provider.reviewStore.getReview(docId);
    assert.ok(survivor !== undefined, "a save with held chunks must retain the review");
    assert.equal(survivor.reviewId, review.reviewId);
    assert.equal(survivor.invalidated, false);
    const remaining = provider.reviewStore.getOutstandingChunks(docId)!;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].state, "held");
    assert.equal(remaining[0].holdComment, "gamma is undecided");
    assert.equal(remaining[0].workingText, "GAMMA");

    // The disk fence moved to the saved content: a second save is not
    // refused as external drift, and the review still survives it.
    const savedAgain = await provider.saveFile(filePath);
    assert.equal(savedAgain.ok, true, JSON.stringify(savedAgain));
    assert.ok(provider.reviewStore.getReview(docId) !== undefined);

    // Deciding the held chunk afterwards completes the review on the next save.
    assert.equal(provider.decideChunk(review.reviewId, remaining[0].chunkId, "accept").ok, true);
    const finalSave = await provider.saveFile(filePath);
    assert.equal(finalSave.ok, true);
    assert.equal(provider.reviewStore.getReview(docId), undefined);
  });

  it("refuses to save an unresolved review, and refuses again once the disk drifted", async function () {
    const filePath = path.join(scratch, "save-gate.md");
    const original = "alpha\nx\ny\nz\nbeta\n";
    const proposed = "ALPHA\nx\ny\nz\nBETA\n";
    const docId = await openFile(filePath, original);

    const snap = provider.createSnapshot(docId)!;
    await provider.submitProposal(snap.token, makePatch(original, proposed), "save-gate-1");
    const review = provider.reviewStore.getReview(docId)!;
    const chunks = provider.reviewStore.getOutstandingChunks(docId)!;
    assert.equal(chunks.length, 2);

    // An undecided chunk closes the gate: the buffer here is a mixture of
    // baseline and proposed content, and that mixture must not reach the disk.
    const refused = await provider.saveFile(filePath);
    assert.ok(!refused.ok, "an unresolved review must refuse the save");
    assert.equal(refused.refusal?.reason, "unresolved-chunks");
    assert.equal(normalizedRead(filePath), original, "the baseline on disk must be untouched");

    // Resolve every chunk, then let the file drift on disk underneath the
    // review — the case where stored positions would otherwise overwrite
    // content the review never saw.
    assert.equal(provider.decideChunk(review.reviewId, chunks[0].chunkId, "accept").ok, true);
    assert.equal(provider.decideChunk(review.reviewId, chunks[1].chunkId, "reject").ok, true);
    assert.equal(provider.reviewStore.countUnresolved(docId), 0);
    writeFileSync(filePath, "externally rewritten\n", "utf8");

    const drifted = await provider.saveFile(filePath);
    assert.ok(!drifted.ok, "a drifted disk fence must refuse the save");
    assert.equal(drifted.refusal?.reason, "disk-changed");
    assert.equal(
      normalizedRead(filePath),
      "externally rewritten\n",
      "the external edit must survive the refused save",
    );
    assert.ok(
      provider.reviewStore.getReview(docId) !== undefined,
      "a refused save resolves nothing: the review stays open for an explicit path",
    );
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
    let lifecycleLog: LogProvider;
    let lifecycleLogPath: string;

    beforeEach(async function () {
      const probe = net.createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      lifecyclePort = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const logDirectory = path.join(app.getPath("userData"), "logs");
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
                tokenEnvironmentVariable: "ZETTLR_AGENT_API_TOKEN",
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

    it("answers an oversized body with structured 413 and logs the refusal", async function () {
      const logBoundary = await markLogBoundary();
      const body = JSON.stringify({ uri: `safe-file://${"x".repeat(25 * 1024 * 1024)}` });
      const response = await new Promise<{
        status: number;
        body: string;
      }>((resolve, reject) => {
        const request = http.request(
          {
            hostname: "127.0.0.1",
            port: lifecyclePort,
            path: "/v1/documents",
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
            line.includes("POST /v1/documents"),
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
  // Review sidecars: detach on close, reattach on open (issue #54)
  // ==========================================================================

  describe("review sidecar persistence", function () {
    it("surfaces an invalid sidecar without aborting the valid document open", async function () {
      const filePath = path.join(scratch, "sidecar-invalid.md");
      writeFileSync(filePath, "valid document\n", "utf8");
      mkdirSync(sidecarDirectory, { recursive: true });
      writeFileSync(
        reviewSidecarFilePath(sidecarDirectory, filePath),
        JSON.stringify({ version: 1, reviewId: "incomplete" }),
        "utf8",
      );
      const failures: AgentEvent[] = [];
      provider.reviewStore.on("review.sidecar-error", (event: AgentEvent) =>
        failures.push(event),
      );

      const opened = await provider.getDocument(filePath);

      assert.equal(opened.content, "valid document\n");
      assert.equal(failures.length, 1);
      const failureMessage = failures[0].message;
      assert.ok(typeof failureMessage === "string");
      assert.match(
        failureMessage,
        /is not a version-1 review sidecar/,
        "the documented sidecar error must name the validation failure",
      );
    });

    it("writes the sidecar through on every review mutation", async function () {
      const filePath = path.join(scratch, "sidecar-write.md");
      const docId = await openFile(filePath, "alpha\nbeta\n");
      const snap = provider.createSnapshot(docId)!;
      const submitted = await provider.submitProposal(
        snap.token,
        makePatch("alpha\nbeta\n", "ALPHA\nbeta\n"),
        "sidecar-write-1",
      );
      assert.equal(submitted.ok, true);
      if (!submitted.ok) {
        return;
      }
      await flushSidecarWrites();

      const first = await sidecars.read(filePath);
      assert.ok(first !== undefined, "a review mutation must write its sidecar through");
      assert.equal(first.reviewId, submitted.reviewId);
      assert.equal(first.generation, 1);
      assert.equal(first.referenceText, "alpha\nbeta\n");
      assert.equal(first.workingText, "ALPHA\nbeta\n");
      assert.equal(first.unresolvedChunks, 1);

      // A decision is a mutation too: the hold and its comment reach disk.
      const chunks = provider.reviewStore.getOutstandingChunks(docId)!;
      const held = provider.decideChunk(
        submitted.reviewId,
        chunks[0].chunkId,
        "hold",
        "needs thought",
      );
      assert.equal(held.ok, true);
      await flushSidecarWrites();
      const second = (await sidecars.read(filePath))!;
      assert.equal(second.generation, 2);
      assert.deepEqual(
        second.holds.map((hold) => hold.comment),
        ["needs thought"],
      );
      assert.equal(second.unresolvedChunks, 0);
      assert.equal(second.heldChunks, 1);
    });

    it("detaches on close and reattaches on open with identical review state", async function () {
      const filePath = path.join(scratch, "sidecar-cycle.md");
      const original = "alpha\nx\ny\nz\nbeta\n";
      const docId = await openFile(filePath, original);
      const snap = provider.createSnapshot(docId)!;
      const submitted = await provider.submitProposalClaims(
        snap.token,
        [
          {
            description: "caps alpha",
            patch: makePatch(original, "ALPHA\nx\ny\nz\nbeta\n"),
          },
          {
            description: "caps beta",
            patch: makePatch("ALPHA\nx\ny\nz\nbeta\n", "ALPHA\nx\ny\nz\nBETA\n"),
          },
        ],
        "sidecar-cycle-1",
      );
      assert.equal(submitted.ok, true);
      if (!submitted.ok) {
        return;
      }
      const reviewId = submitted.reviewId;
      const beforeChunks = provider.reviewStore.getOutstandingChunks(docId)!;
      assert.equal(beforeChunks.length, 2);
      const held = provider.decideChunk(reviewId, beforeChunks[1].chunkId, "hold", "revisit");
      assert.equal(held.ok, true);
      const commented = provider.reviewStore.addReviewComment(docId, "overall note");
      assert.equal(commented.ok, true);

      const review = provider.reviewStore.getReview(docId)!;
      const generation = review.generation;
      const referenceText = review.referenceText;
      const workingText = provider.loadedDocuments
        .find((d) => d.filePath === filePath)!
        .document.toString();
      const chunkStatesBefore = provider.reviewStore
        .getOutstandingChunks(docId)!
        .map((chunk) => [chunk.chunkId, chunk.state]);

      await flushSidecarWrites();
      await provider.closeFileEverywhere(filePath);
      assert.equal(provider.reviewStore.getReview(docId), undefined);
      assert.equal(
        provider.loadedDocuments.some((d) => d.filePath === filePath),
        false,
      );

      // The closed-file review is enumerable over the wire, distinguishable
      // from open-document reviews.
      const listed = await httpRequest("GET", "/v1/reviews");
      assert.equal(listed.status, 200);
      const body = JSON.parse(listed.body) as { reviews: Array<Record<string, unknown>> };
      assertMatchesSchema(body, "ReviewListResponse");
      const detached = body.reviews.find((entry) => entry.reviewId === reviewId);
      assert.ok(detached !== undefined, "/v1/reviews must list the closed-file review");
      assert.equal(detached.attached, false);
      assert.equal(detached.documentPath, filePath);
      assert.equal(detached.unresolvedChunks, 1);
      assert.equal(detached.heldChunks, 1);
      assert.equal(detached.packetCount, 2);

      // Reattachment IS opening the file: no reattach API, no registry.
      await provider.getDocument(filePath);
      const reattached = provider.reviewStore.getReview(docId);
      assert.ok(reattached !== undefined, "opening the file must reattach the review");
      assert.equal(reattached.reviewId, reviewId);
      assert.equal(reattached.generation, generation);
      assert.equal(reattached.referenceText, referenceText);
      assert.equal(
        provider.loadedDocuments.find((d) => d.filePath === filePath)!.document.toString(),
        workingText,
        "the buffer must be restored to the working text",
      );
      const afterChunks = provider.reviewStore.getOutstandingChunks(docId)!;
      assert.deepEqual(
        afterChunks.map((chunk) => [chunk.chunkId, chunk.state]),
        chunkStatesBefore,
        "content-addressed chunk ids and held states must survive the gap",
      );
      assert.equal(afterChunks.find((chunk) => chunk.state === "held")!.holdComment, "revisit");
      assert.deepEqual(
        reattached.comments.map((comment) => comment.text),
        ["overall note"],
      );
      // Attribution survives: the restored spans still bind claims to chunks.
      assert.deepEqual(afterChunks[0].descriptions, ["caps alpha"]);
    });

    it("invalidates instead of reattaching when the disk changed while closed", async function () {
      const filePath = path.join(scratch, "sidecar-fence.md");
      const docId = await openFile(filePath, "alpha\n");
      const snap = provider.createSnapshot(docId)!;
      const submitted = await provider.submitProposal(
        snap.token,
        makePatch("alpha\n", "ALPHA\n"),
        "sidecar-fence-1",
      );
      assert.equal(submitted.ok, true);
      if (!submitted.ok) {
        return;
      }
      await flushSidecarWrites();
      await provider.closeFileEverywhere(filePath);
      assert.ok((await sidecars.read(filePath)) !== undefined, "the close must have detached");

      // The external edit that invalidates a review in-process, landing
      // across the gap instead.
      writeFileSync(filePath, "externally rewritten\n", "utf8");

      const invalidated: AgentEvent[] = [];
      provider.reviewStore.on("review.invalidated", (event: AgentEvent) =>
        invalidated.push(event),
      );
      await provider.getDocument(filePath);

      assert.equal(
        provider.reviewStore.getReview(docId),
        undefined,
        "a drifted review must not reattach",
      );
      assert.equal(
        provider.loadedDocuments.find((d) => d.filePath === filePath)!.document.toString(),
        "externally rewritten\n",
        "the external disk content must be preserved",
      );
      assert.equal(
        await sidecars.read(filePath),
        undefined,
        "the drifted sidecar must be discarded",
      );
      assert.equal(invalidated.length, 1);
      assert.equal(invalidated[0].reviewId, submitted.reviewId);
    });

    it("destroys the review when the user discards the unsaved changes", async function () {
      // The user's own decision, taken at the close prompt: throw the unsaved
      // edit away. Detaching the review here relocated that edit into the
      // sidecar instead of destroying it, and because a discard writes nothing
      // to disk the sidecar's fence still matched the untouched file — so the
      // next open passed the fence and put the discarded text back.
      const filePath = path.join(scratch, "sidecar-discard.md");
      const onDisk = "alpha\n";
      const docId = await openFile(filePath, onDisk);
      const windowId = provider.windowKeys()[0];
      const leafId = provider.leafIds(windowId)[0];
      assert.equal(await provider.openFile(windowId, leafId, filePath, true), true);

      const snap = provider.createSnapshot(docId)!;
      const submitted = await provider.submitProposal(
        snap.token,
        makePatch(onDisk, "ALPHA\n"),
        "sidecar-discard-1",
      );
      assert.equal(submitted.ok, true);
      if (!submitted.ok) {
        return;
      }
      await flushSidecarWrites();
      assert.equal(
        provider.loadedDocuments.find((d) => d.filePath === filePath)!.document.toString(),
        "ALPHA\n",
        "the proposal must be in the buffer before it can be discarded",
      );
      assert.ok((await sidecars.read(filePath)) !== undefined, "write-through must have run");

      const discarded: AgentEvent[] = [];
      provider.reviewStore.on("review.discarded", (event: AgentEvent) =>
        discarded.push(event),
      );
      const cleared: Array<Record<string, unknown>> = [];
      provider.on(DP_EVENTS.REVIEW_DIFF, (...args: unknown[]) => {
        const context = args[0] as Record<string, unknown>;
        if (context.reviewCleared === true) {
          cleared.push(context);
        }
      });

      saveChangesResponse = 1; // "Don't save"
      assert.equal(await provider.closeFile(windowId, leafId, filePath), true);
      await flushSidecarWrites();

      assert.equal(readFileSync(filePath, "utf8"), onDisk, "a discard must not write to disk");
      assert.equal(
        await sidecars.read(filePath),
        undefined,
        "no store may still hold the discarded text",
      );
      assert.deepEqual(
        discarded.map((event) => event.reviewId),
        [submitted.reviewId],
        "destroying a review the user discarded must be announced to agents",
      );
      assert.deepEqual(
        cleared.map((context) => context.reviewId),
        [submitted.reviewId],
        "and to every pane still drawing that review's chunks",
      );

      // Reopening is where the reversal used to happen.
      await provider.getDocument(filePath);
      assert.equal(
        provider.loadedDocuments.find((d) => d.filePath === filePath)!.document.toString(),
        onDisk,
        "reopening a discarded file must show the bytes on disk",
      );
      assert.equal(
        provider.reviewStore.getReview(docId),
        undefined,
        "a discarded review must not come back",
      );
      assert.equal(provider.isModified(filePath), false);
    });

    it("preserves a saved held review when discarding a later editor edit", async function () {
      const filePath = path.join(scratch, "sidecar-discard-after-save.md");
      const original = "alpha\nx\ny\nz\nbeta\n";
      const proposed = "ALPHA\nx\ny\nz\nbeta\n";
      const laterEdit = "ALPHA\nx\ny\nz\nBETA edited\n";
      const docId = await openFile(filePath, original);
      const windowId = provider.windowKeys()[0];
      const leafId = provider.leafIds(windowId)[0];
      assert.equal(await provider.openFile(windowId, leafId, filePath, true), true);
      provider.newWindow();

      const submitted = await provider.submitProposal(
        provider.createSnapshot(docId)!.token,
        makePatch(original, proposed),
        "sidecar-discard-after-save-1",
      );
      assert.equal(submitted.ok, true);
      if (!submitted.ok) {
        return;
      }
      const chunk = provider.reviewStore.getOutstandingChunks(docId)![0];
      assert.ok(chunk !== undefined, "the saved held review must have an outstanding chunk");
      assert.equal(provider.decideChunk(submitted.reviewId, chunk.chunkId, "hold", "revisit").ok, true);
      assert.deepEqual(await provider.saveFile(filePath), { ok: true });
      await flushSidecarWrites();

      const loaded = provider.loadedDocuments.find((document) => document.filePath === filePath)!;
      const pushUpdates = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(provider),
        "pushUpdates",
      )?.value as
        | ((filePath: string, version: number, updates: SerializedUpdate[]) => Promise<boolean>)
        | undefined;
      assert.equal(typeof pushUpdates, "function", "the authority update seam must exist");
      if (pushUpdates === undefined) {
        return;
      }
      const update: SerializedUpdate = {
        clientID: "discard-after-save-test",
        changes: ChangeSet.of([{ from: 12, to: 17, insert: "BETA edited\n" }], 17).toJSON(),
      };
      assert.equal(await pushUpdates.call(provider, filePath, loaded.currentVersion, [update]), true);
      await flushSidecarWrites();
      assert.equal(
        provider.loadedDocuments.find((document) => document.filePath === filePath)!.document.toString(),
        laterEdit,
      );
      const persistedBeforeDiscard = (await sidecars.read(filePath))!;
      assert.equal(persistedBeforeDiscard.heldChunks, 1);
      assert.equal(persistedBeforeDiscard.workingText, laterEdit);

      saveChangesResponse = 1; // "Don't save"
      assert.equal(await provider.askUserToCloseWindow(windowId), true);
      await flushSidecarWrites();

      assert.equal(readFileSync(filePath, "utf8"), proposed);
      assert.equal(
        provider.reviewStore.getReview(docId),
        undefined,
        "closing the final owner still detaches the preserved review",
      );
      const detached = await provider.findDetachedReview(submitted.reviewId);
      assert.ok(detached !== undefined, "discarding the later edit must keep the saved held review");
      assert.equal(detached.workingText, proposed);
      assert.equal(detached.heldChunks, 1);
    });

    it("puts the buffer back on current disk content when the close prompt discards", async function () {
      // The window-close prompt discards without closing the documents, so
      // this is the branch where the discarded bytes have somewhere to
      // survive: the buffer the panes keep drawing. Silencing the dirty flag
      // left them there, visible and one save away from disk.
      //
      // Reaching that branch at all is half the proof. The gate in front of
      // the prompt asked isClean(windowId) without saying the id names a
      // window, which sent it looking for a leaf by that id, found none, and
      // called the window clean — so the prompt never opened and the answer
      // was never taken.
      const filePath = path.join(scratch, "sidecar-discard-window.md");
      const onDisk = "alpha\n";
      const docId = await openFile(filePath, onDisk);
      const windowId = provider.windowKeys()[0];
      const leafId = provider.leafIds(windowId)[0];
      assert.equal(await provider.openFile(windowId, leafId, filePath, true), true);
      assert.equal(
        provider.isClean(windowId),
        true,
        "a window whose files are all saved is clean",
      );

      const snap = provider.createSnapshot(docId)!;
      const submitted = await provider.submitProposal(
        snap.token,
        makePatch(onDisk, "ALPHA\n"),
        "sidecar-discard-window-1",
      );
      assert.equal(submitted.ok, true);
      if (!submitted.ok) {
        return;
      }
      await flushSidecarWrites();
      assert.equal(provider.isModified(filePath), true);
      assert.equal(
        provider.isClean(windowId),
        false,
        "and dirty once one of them is — this is what opens the prompt",
      );
      const currentDisk = "externally updated\n";
      writeFileSync(filePath, currentDisk, "utf8");

      saveChangesResponse = 1; // "Don't save"
      assert.equal(await provider.askUserToCloseWindow(windowId), true);
      await flushSidecarWrites();

      assert.equal(
        provider.loadedDocuments.find((d) => d.filePath === filePath)!.document.toString(),
        currentDisk,
        "the still-open buffer must show the current bytes on disk, not a stale saved snapshot",
      );
      assert.equal(provider.isModified(filePath), false, "and be clean because it now is");
      assert.equal(provider.reviewStore.getReview(docId), undefined);
      assert.equal(
        await sidecars.read(filePath),
        undefined,
        "no store may still hold the discarded text",
      );
      assert.equal(readFileSync(filePath, "utf8"), currentDisk);
    });

    it("discards only documents exclusively owned by the closing window", async function () {
      // The prompt speaks for the window being closed. A discard that reached
      // every loaded document would answer it on behalf of every other window
      // too — the same destruction, aimed at bytes the user never discarded.
      const closing = path.join(scratch, "discard-scope-closing.md");
      const kept = path.join(scratch, "discard-scope-kept.md");
      const onDisk = "alpha\n";
      const closingId = await openFile(closing, onDisk);
      const keptId = await openFile(kept, onDisk);

      const closingWindow = provider.windowKeys()[0];
      assert.equal(
        await provider.openFile(closingWindow, provider.leafIds(closingWindow)[0], closing, true),
        true,
      );
      provider.newWindow();
      const keptWindow = provider.windowKeys().find((key) => key !== closingWindow)!;
      assert.equal(
        await provider.openFile(keptWindow, provider.leafIds(keptWindow)[0], kept, true),
        true,
      );
      assert.equal(
        await provider.openFile(closingWindow, provider.leafIds(closingWindow)[0], kept, true),
        true,
        "the kept document must also be open in the window being closed",
      );

      for (const [documentId, key] of [
        [closingId, "discard-scope-closing-1"],
        [keptId, "discard-scope-kept-1"],
      ] as const) {
        const submitted = await provider.submitProposal(
          provider.createSnapshot(documentId)!.token,
          makePatch(onDisk, "ALPHA\n"),
          key,
        );
        assert.equal(submitted.ok, true);
      }
      await flushSidecarWrites();

      saveChangesResponse = 1; // "Don't save"
      assert.equal(await provider.askUserToCloseWindow(closingWindow), true);
      await flushSidecarWrites();

      assert.equal(
        provider.loadedDocuments.some((document) => document.filePath === closing),
        false,
        "the closing window's exclusively owned document must be unloaded",
      );
      assert.equal(readFileSync(closing, "utf8"), onDisk);
      assert.equal(await sidecars.read(closing), undefined);
      assert.equal(provider.reviewStore.getReview(closingId), undefined);

      assert.equal(
        provider.loadedDocuments.find((d) => d.filePath === kept)!.document.toString(),
        "ALPHA\n",
        "the other window's unsaved edit is not the one that was discarded",
      );
      assert.equal(provider.isModified(kept), true);
      assert.ok(
        (await sidecars.read(kept)) !== undefined,
        "and its review must still be there to decide",
      );
      assert.ok(provider.reviewStore.getReview(keptId) !== undefined);
    });

    it("detaches a saved held review when its final window owner closes", async function () {
      const filePath = path.join(scratch, "sidecar-save-close.md");
      const original = "alpha\n";
      const docId = await openFile(filePath, original);
      const closingWindow = provider.windowKeys()[0];
      const closingLeaf = provider.leafIds(closingWindow)[0];
      assert.equal(await provider.openFile(closingWindow, closingLeaf, filePath, true), true);
      provider.newWindow();

      const snapshot = provider.createSnapshot(docId);
      assert.ok(snapshot !== undefined, "The open document must produce a proposal snapshot.");
      const submitted = await provider.submitProposal(
        snapshot.token,
        makePatch(original, "ALPHA\n"),
        "sidecar-save-close-1",
      );
      if (!submitted.ok) {
        assert.fail(`Held-review proposal was refused: ${JSON.stringify(submitted)}`);
      }
      const chunks = provider.reviewStore.getOutstandingChunks(docId);
      assert.ok(
        chunks !== undefined && chunks.length === 1,
        "The held-review proposal must create exactly one outstanding chunk.",
      );
      const chunk = chunks[0];
      assert.ok(chunk !== undefined, "The held-review proposal produced no addressable chunk.");
      assert.equal(
        provider.decideChunk(submitted.reviewId, chunk.chunkId, "hold", "revisit").ok,
        true,
      );
      assert.deepEqual(await provider.saveFile(filePath), { ok: true });
      await flushSidecarWrites();

      await provider.closeWindow(closingWindow);
      await flushSidecarWrites();

      assert.equal(
        provider.loadedDocuments.some((document) => document.filePath === filePath),
        false,
        "closing the document's final window owner must unload its live buffer",
      );
      assert.equal(
        provider.reviewStore.getReview(docId),
        undefined,
        "the live review must detach when its document has no remaining owner",
      );
      const detached = await provider.findDetachedReview(submitted.reviewId);
      assert.ok(detached !== undefined, "the held review must persist as a detached sidecar");
      assert.equal(detached.workingText, "ALPHA\n");
      assert.equal(detached.heldChunks, 1);

      await provider.getDocument(filePath);
      assert.equal(
        provider.reviewStore.getReview(docId)?.reviewId,
        submitted.reviewId,
        "opening the saved file later must reattach the same review",
      );
      assert.equal(
        provider.reviewStore.getOutstandingChunks(docId)?.[0].state,
        "held",
        "the held decision must survive save, close, and reattachment",
      );
    });

    it("answers every review route for the reviewId the listing hands out", async function () {
      // Enumeration and addressability are one contract: /v1/reviews vouches
      // for a detached review's id, so the routes that take a reviewId must
      // answer it. They used to consult only the in-memory store, which made
      // every listed detached review a 404 on read — the agent could see the
      // unfinished work and could not open it.
      const filePath = path.join(scratch, "sidecar-address.md");
      const original = "alpha\nx\ny\nz\nbeta\n";
      const docId = await openFile(filePath, original);
      const snap = provider.createSnapshot(docId)!;
      const submitted = await provider.submitProposalClaims(
        snap.token,
        [
          { description: "caps alpha", patch: makePatch(original, "ALPHA\nx\ny\nz\nbeta\n") },
          {
            description: "caps beta",
            patch: makePatch("ALPHA\nx\ny\nz\nbeta\n", "ALPHA\nx\ny\nz\nBETA\n"),
          },
        ],
        "sidecar-address-1",
      );
      assert.equal(submitted.ok, true);
      if (!submitted.ok) {
        return;
      }
      const reviewId = submitted.reviewId;
      const before = provider.reviewStore.getOutstandingChunks(docId)!;
      assert.equal(before.length, 2);
      assert.equal(
        provider.decideChunk(reviewId, before[1].chunkId, "hold", "revisit").ok,
        true,
      );
      assert.equal(provider.reviewStore.addReviewComment(docId, "overall note").ok, true);
      const generation = provider.reviewStore.getReview(docId)!.generation;
      const chunksBefore = provider.reviewStore
        .getOutstandingChunks(docId)!
        .map((chunk) => [chunk.chunkId, chunk.state, chunk.holdComment]);

      await flushSidecarWrites();
      await provider.closeFileEverywhere(filePath);
      assert.equal(provider.reviewStore.getReview(docId), undefined, "the close must detach");

      const listed = JSON.parse((await httpRequest("GET", "/v1/reviews")).body) as {
        reviews: Array<{ reviewId: string; attached: boolean }>;
      };
      const entry = listed.reviews.find((review) => review.reviewId === reviewId);
      assert.ok(entry !== undefined, "/v1/reviews must list the closed-file review");
      assert.equal(entry.attached, false);

      // Read routes: served from the sidecar, which carries the whole review.
      const detail = await httpRequest("GET", `/v1/reviews/${reviewId}`);
      assert.equal(detail.status, 200, detail.body);
      const detailBody = JSON.parse(detail.body) as {
        attached: boolean;
        generation: number;
        unresolvedChunks: number;
        heldChunks: number;
        packetCount: number;
        comments: Array<{ text: string }>;
        documentRevision?: unknown;
      };
      assertMatchesSchema(detailBody, "ReviewDetailResponse");
      assert.equal(detailBody.attached, false);
      assert.equal(detailBody.generation, generation);
      assert.equal(detailBody.unresolvedChunks, 1);
      assert.equal(detailBody.heldChunks, 1);
      assert.equal(detailBody.packetCount, 2);
      assert.deepEqual(
        detailBody.comments.map((comment) => comment.text),
        ["overall note"],
      );
      assert.equal(
        detailBody.documentRevision,
        undefined,
        "a closed document has no revision to report",
      );

      const chunks = await httpRequest("GET", `/v1/reviews/${reviewId}/chunks`);
      assert.equal(chunks.status, 200, chunks.body);
      const chunksBody = JSON.parse(chunks.body) as {
        documentId?: string;
        chunks: Array<{ chunkId: string; state: string; holdComment?: string; descriptions: string[] }>;
      };
      assertMatchesSchema(chunksBody, "ReviewChunksResponse");
      assert.deepEqual(
        chunksBody.chunks.map((chunk) => [chunk.chunkId, chunk.state, chunk.holdComment]),
        chunksBefore,
        "the detached partition must be the one the open document had",
      );
      assert.deepEqual(chunksBody.chunks[0].descriptions, ["caps alpha"]);
      assert.equal(chunksBody.documentId, undefined, "no document is open to name");

      const diff = await httpRequest("GET", `/v1/reviews/${reviewId}/diff`);
      assert.equal(diff.status, 200, diff.body);
      const diffBody = JSON.parse(diff.body) as { patch: string; generation: number };
      assertMatchesSchema(diffBody, "ReviewDiffResponse");
      assert.ok(diffBody.patch.includes("+ALPHA"), diffBody.patch);
      assert.equal(diffBody.generation, generation);

      const packets = await httpRequest("GET", `/v1/reviews/${reviewId}/packets`);
      assert.equal(packets.status, 200, packets.body);
      const packetsBody = JSON.parse(packets.body) as {
        packets: Array<{ description: string; refSpans?: unknown }>;
      };
      assertMatchesSchema(packetsBody, "ReviewPacketsResponse");
      assert.deepEqual(
        packetsBody.packets.map((packet) => packet.description),
        ["caps alpha", "caps beta"],
      );

      // Write routes: the review is real, so the refusal is a conflict that
      // names the file to open — never "not found".
      const heldChunkId = chunksBefore[1][0];
      for (const [method, route] of [
        ["POST", `/v1/reviews/${reviewId}/accept-all`],
        ["POST", `/v1/reviews/${reviewId}/clear`],
        ["POST", `/v1/reviews/${reviewId}/chunks/${heldChunkId!}/accept`],
        ["GET", `/v1/reviews/${reviewId}/events?waitSeconds=0`],
      ] as const) {
        const refused = await httpRequest(method, route);
        assert.equal(refused.status, 409, `${method} ${route}: ${refused.body}`);
        const error = (JSON.parse(refused.body) as { error: { code: string; message: string } })
          .error;
        assert.equal(error.code, "DOCUMENT_CLOSED", route);
        assert.ok(error.message.includes(filePath), `${route}: ${error.message}`);
      }
      const commented = await httpRequest("POST", `/v1/reviews/${reviewId}/comments`, {
        body: JSON.stringify({ text: "later" }),
        headers: { "content-type": "application/json" },
      });
      assert.equal(commented.status, 409, commented.body);
      assert.equal(
        (JSON.parse(commented.body) as { error: { code: string } }).error.code,
        "DOCUMENT_CLOSED",
      );

      // Nothing the refusal did may have touched the review.
      assert.equal(
        (
          JSON.parse((await httpRequest("GET", `/v1/reviews/${reviewId}`)).body) as {
            generation: number;
            unresolvedChunks: number;
          }
        ).generation,
        generation,
      );

      // An id no review carries is still a 404: DOCUMENT_CLOSED is a claim
      // about a review that exists, not a blanket answer.
      const unknown = await httpRequest("GET", "/v1/reviews/rev-nonexistent");
      assert.equal(unknown.status, 404);
      assert.equal(
        (JSON.parse(unknown.body) as { error: { code: string } }).error.code,
        "REVIEW_NOT_FOUND",
      );

      // Opening the file is the reattachment, and the same id keeps working.
      await provider.getDocument(filePath);
      const reattached = await httpRequest("GET", `/v1/reviews/${reviewId}`);
      assert.equal(reattached.status, 200, reattached.body);
      const reattachedBody = JSON.parse(reattached.body) as {
        attached: boolean;
        documentRevision?: { sha256: string };
      };
      assertMatchesSchema(reattachedBody, "ReviewDetailResponse");
      assert.equal(reattachedBody.attached, true);
      assert.ok(
        reattachedBody.documentRevision !== undefined,
        "an attached review reports the open document's revision",
      );
    });

    it("answers the packetIds a detached review's packet listing hands out", async function () {
      // The packets route serves a closed file from its sidecar, so the ids in
      // that answer are ids the API vouched for. Retraction consults the live
      // packet index, which the close empties, so every one of those ids came
      // back "The packet was not found." with an empty reviewId — a denial that
      // the packet exists, about a packet the API had just published.
      const filePath = path.join(scratch, "sidecar-packet-address.md");
      const original = "alpha\nx\ny\nz\nbeta\n";
      const docId = await openFile(filePath, original);
      const snap = provider.createSnapshot(docId)!;
      const submitted = await provider.submitProposal(
        snap.token,
        makePatch(original, "ALPHA\nx\ny\nz\nbeta\n"),
        "sidecar-packet-address-1",
      );
      assert.equal(submitted.ok, true);
      if (!submitted.ok) {
        return;
      }
      const reviewId = submitted.reviewId;
      const generation = provider.reviewStore.getReview(docId)!.generation;

      await flushSidecarWrites();
      await provider.closeFileEverywhere(filePath);
      assert.equal(provider.reviewStore.getReview(docId), undefined, "the close must detach");

      const packets = await httpRequest("GET", `/v1/reviews/${reviewId}/packets`);
      assert.equal(packets.status, 200, packets.body);
      const listed = (JSON.parse(packets.body) as { packets: Array<{ packetId: string }> })
        .packets;
      assert.equal(listed.length, 1);
      const packetId = listed[0].packetId;

      const refused = await httpRequest("POST", `/v1/proposals/${packetId}/retract`);
      assert.equal(refused.status, 409, refused.body);
      const refusedBody = JSON.parse(refused.body) as {
        error: {
          code: string;
          message: string;
          reviewId: string;
          canClearUnresolved: boolean;
        };
      };
      assertMatchesSchema(refusedBody, "AgentErrorResponse");
      assert.equal(refusedBody.error.code, "DOCUMENT_CLOSED");
      assert.ok(refusedBody.error.message.includes(filePath), refusedBody.error.message);
      assert.equal(
        refusedBody.error.reviewId,
        reviewId,
        "the refusal names the review that owns the packet",
      );
      assert.equal(
        refusedBody.error.canClearUnresolved,
        false,
        "clearing a detached review refuses too, so offering it would misdirect",
      );

      // A packetId no review carries stays PACKET_NOT_RETRACTABLE: the closed
      // file is a claim about a packet that exists, not a blanket answer.
      const unknown = await httpRequest("POST", "/v1/proposals/pkt-nonexistent/retract");
      assert.equal(unknown.status, 409, unknown.body);
      assert.equal(
        (JSON.parse(unknown.body) as { error: { code: string } }).error.code,
        "PACKET_NOT_RETRACTABLE",
      );

      // Opening the file is what the refusal asked for, and the same id then
      // retracts for real — the id the listing handed out was always this one.
      await provider.getDocument(filePath);
      const retracted = await httpRequest("POST", `/v1/proposals/${packetId}/retract`);
      assert.equal(retracted.status, 200, retracted.body);
      const retractedBody = JSON.parse(retracted.body) as {
        packetId: string;
        reviewId: string;
        reviewGeneration: number;
      };
      assertMatchesSchema(retractedBody, "RetractProposalResponse");
      assert.equal(retractedBody.packetId, packetId);
      assert.equal(retractedBody.reviewId, reviewId);
      assert.ok(
        retractedBody.reviewGeneration > generation,
        "retraction advances the generation it refused to touch while closed",
      );
    });

    it("deletes the sidecar when saving completes the review", async function () {
      const filePath = path.join(scratch, "sidecar-resolve.md");
      const docId = await openFile(filePath, "alpha\n");
      const snap = provider.createSnapshot(docId)!;
      const submitted = await provider.submitProposal(
        snap.token,
        makePatch("alpha\n", "ALPHA\n"),
        "sidecar-resolve-1",
      );
      assert.equal(submitted.ok, true);
      if (!submitted.ok) {
        return;
      }
      await flushSidecarWrites();
      assert.ok((await sidecars.read(filePath)) !== undefined);

      const chunks = provider.reviewStore.getOutstandingChunks(docId)!;
      const accepted = provider.decideChunk(submitted.reviewId, chunks[0].chunkId, "accept");
      assert.equal(accepted.ok, true);
      const saved = await provider.saveFile(filePath);
      assert.equal(saved.ok, true);
      await flushSidecarWrites();

      assert.equal(provider.reviewStore.getReview(docId), undefined);
      assert.equal(
        await sidecars.read(filePath),
        undefined,
        "a resolved review must leave no residue",
      );
    });
  });

  it("GET /v1/workspace/files lists files across workspaces with open state", async function () {
    const expected = path.join(scratch, "unopened.md"); // what the fsal seam reports
    const first = await httpRequest("GET", "/v1/workspace/files");
    assert.equal(first.status, 200);
    const firstBody = JSON.parse(first.body) as {
      files: Array<{ path: string; workspaceId: string; open: boolean }>;
    };
    assertMatchesSchema(firstBody, "WorkspaceFilesResponse");
    assert.deepEqual(
      firstBody.files.map((file) => [file.path, file.workspaceId, file.open]),
      [[expected, scratch, false]],
    );

    await openFile(expected, "alpha\n");
    const second = JSON.parse((await httpRequest("GET", "/v1/workspace/files")).body) as {
      files: Array<{ open: boolean }>;
    };
    assert.deepEqual(
      second.files.map((file) => file.open),
      [true],
    );
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

    it("publishes exactly the routes the running server serves", async function () {
      this.timeout(20000);
      // Negative control first: the discriminator the probe below relies on.
      const missing = await httpRequest("GET", "/v1/no-such-route");
      assert.equal(JSON.parse(missing.body).error.code, "METHOD_NOT_FOUND");

      // The route table belonging to the instance that is answering these
      // requests. Reading it asks the server what it serves; deriving the same
      // list from the implementation's source text would only prove that two
      // spellings of the route table agree, which they can do while the server
      // disagrees with both.
      const registered = httpProvider.routes.map(
        ({ method, path: routePath }) => `${method} ${routePath}`,
      );
      // The other side is fetched, not read off disk. What a consumer is bound
      // by is the document this server hands out, and the provider loads its
      // specification from whichever of two candidate paths exists — the copy
      // beside this suite is not by itself evidence of what the server
      // publishes.
      const published = JSON.parse((await httpRequest("GET", "/openapi.json")).body) as {
        paths: Record<string, Record<string, unknown>>;
      };
      const declared = Object.entries(published.paths).flatMap(([specPath, pathItem]) =>
        HTTP_METHODS.filter((method) => pathItem[method] !== undefined).map(
          (method) => `${method.toUpperCase()} ${specPath}`,
        ),
      );
      assert.deepEqual(
        [...registered].sort(),
        [...declared].sort(),
        "the served specification and the server's route table must name the same routes",
      );

      // The structural audits in this block read the committed file. They only
      // describe the contract if that file is the document being served, so
      // that identity is asserted here rather than assumed.
      assert.deepEqual(
        published.paths,
        openApiDocument.paths,
        "the served specification must be the committed one",
      );

      // And that table is what the server answers from: every entry is asked
      // for over the wire and must reach a handler. An entry that dispatch
      // cannot reach fails here as METHOD_NOT_FOUND, so the list above cannot
      // be a decorative one kept beside the real routing.
      for (const { method, path: routePath } of httpProvider.routes) {
        const probePath = routePath.replace(/\{[^}]+\}/g, "conformance-probe");
        if (routePath === "/v1/events") {
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
          assert.equal(observed.status, 200, `${method} ${routePath} must be routed`);
          assert.equal(observed.contentType, "text/event-stream");
          continue;
        }
        const response = await httpRequest(method, probePath);
        if (response.status >= 400) {
          const parsed = JSON.parse(response.body) as { error: { code: string } };
          assert.notEqual(
            parsed.error.code,
            "METHOD_NOT_FOUND",
            `${method} ${routePath} is published but not routed`,
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
