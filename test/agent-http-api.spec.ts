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

// This side-effect import must run before any main-process module import. It
// installs the headless Electron module shim that those imports consume. Keep
// the named import below for the harness-owned userData path.
import "./headless-electron-harness.cjs";

import type {
  AgentApiComponents,
  ReapplyReviewRequest,
  ReviewMutationPrecondition,
} from "@dts/common/agent-api";
import type { CodeFileDescriptor } from "@dts/common/fsal";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Ajv2020 from "ajv/dist/2020";
import { strict as assert } from "assert";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { createPatch } from "diff";
import {
  chmodSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { access } from "fs/promises";
import http from "http";
import net from "net";
import type { Document as OpenApiDefinition } from "openapi-backend";
import os from "os";
import path from "path";
import { HELP_DOCUMENT } from "source/app/service-providers/agent-api/help-content";
import AgentHTTPProvider, {
  type AgentApiHost,
  AgentApiTokenRequiredError,
} from "source/app/service-providers/agent-api/http-server";
import CiteprocProvider from "source/app/service-providers/citeproc";
import DocumentLintProvider from "source/app/service-providers/document-lint";
import DocumentManager from "source/app/service-providers/documents";
import { readDirectoryRecursivelyFromDisk } from "source/app/service-providers/fsal/util/read-directory";
import LogProvider from "source/app/service-providers/log";
import { SearchProvider } from "source/app/service-providers/search";
import { createIgnoreFilter, EVERY_FILE_TYPE } from "source/common/util/ignore-rules";
import { sha256Text } from "source/common/util/sha256";
import { WikilinkIndex } from "source/common/util/wikilink-resolution";
import { parse as parseYaml } from "yaml";
import { DATABASE_LOADER_THREAD } from "./citeproc-loader-thread";
import { userData } from "./headless-electron-harness.cjs";

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
  operationId: string;
  tags?: string[];
  requestBody?: {
    content: Record<string, { schema: { properties: Record<string, PublishedNumericBounds> } }>;
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

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** The token that each provider of this spec is started with. */
const API_TOKEN = randomUUID();
/** The environment of a provider: the variable that the app reads its token from. */
const TOKEN_ENVIRONMENT = { ZETTLR_AGENT_API_TOKEN: API_TOKEN };
/** The header of a caller that holds the token. */
const AUTHORIZED = { authorization: `Bearer ${API_TOKEN}` };

/** The filter of a workspace without rules: every path that the FSAL can list. */
const EVERY_PATH = createIgnoreFilter({
  globalRules: [],
  workspaceRules: new Map(),
  showIgnored: true,
  fileTypes: EVERY_FILE_TYPE,
});

/**
 * The walk of the FSAL over a workspace of the scratch directory. The
 * closed-file routes answer for exactly the ids this listing hands out, so a
 * seam that reported one fixed name would let those tests pass against files
 * that are not there and miss files that are.
 */
async function walkWorkspace(workspacePath: string) {
  return await readDirectoryRecursivelyFromDisk(workspacePath, EVERY_PATH, new LogProvider());
}

/**
 * OpenAI publishes these constraints as prose, but it does not publish an
 * importer validation schema or a distributable validator. This audit is a
 * supplementary regression over those documented constraints and constraints
 * observed directly in the importer. It runs against bytes served through the
 * real HTTP boundary. It does not independently certify that the current
 * authenticated Custom GPT Action builder accepts the document.
 *
 * The two length limits and the unsupported-header rule are documented at
 * https://developers.openai.com/api/docs/actions/production. The
 * object-schema rule is OpenAI's function-schema requirement that an object
 * declare `properties`; `additionalProperties` alone does not satisfy it,
 * which is how the two spec-serving routes stayed broken through a fix that
 * declared only that.
 *
 * A header parameter is a finding too: the builder drops it silently, so an
 * operation that needs one cannot work as an Action at all.
 *
 * Finding text follows the builder's, so a report from it can be matched to a
 * rule here by reading. The context tuple is this document's own JSON path,
 * which locates the same schema more precisely than the builder's does.
 */
const ACTION_DESCRIPTION_LIMIT = 300;
const ACTION_PARAMETER_DESCRIPTION_LIMIT = 700;
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function auditAsGptAction(document: JsonValue): string[] {
  const findings: string[] = [];
  const asObject = (node: JsonValue): { [key: string]: JsonValue } | undefined =>
    node !== null && typeof node === "object" && !Array.isArray(node) ? node : undefined;
  const asText = (node: JsonValue | undefined): string => (typeof node === "string" ? node : "");

  const root = asObject(document);
  const paths = root === undefined ? undefined : asObject(root.paths);
  for (const [route, methodsNode] of Object.entries(paths ?? {})) {
    const methods = asObject(methodsNode);
    for (const method of HTTP_METHODS) {
      const operation = methods === undefined ? undefined : asObject(methods[method]);
      if (operation === undefined) {
        continue;
      }
      const where = `In path ${route}, method ${method}, operationId ${asText(operation.operationId)}`;
      for (const field of ["description", "summary"]) {
        const length = asText(operation[field]).length;
        if (length > ACTION_DESCRIPTION_LIMIT) {
          findings.push(
            `${where}, ${field} has length ${length} exceeding limit of ${ACTION_DESCRIPTION_LIMIT}`,
          );
        }
      }
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      for (const parameterNode of parameters) {
        const parameter = asObject(parameterNode);
        if (parameter === undefined) {
          continue;
        }
        const name = asText(parameter.name);
        const length = asText(parameter.description).length;
        if (length > ACTION_PARAMETER_DESCRIPTION_LIMIT) {
          findings.push(
            `${where}, parameter ${name} description has length ${length} exceeding limit of ${ACTION_PARAMETER_DESCRIPTION_LIMIT}`,
          );
        }
        if (asText(parameter.in) === "header") {
          findings.push(`${where}, parameter ${name} has location header; ignoring`);
        }
      }
    }
  }

  const walkSchemas = (node: JsonValue, context: string[]): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walkSchemas(item, [...context, String(index)]));
      return;
    }
    if (asText(node.type) === "object" && !("properties" in node)) {
      findings.push(
        `In context=(${context.map((step) => `'${step}'`).join(", ")}), object schema missing properties`,
      );
    }
    for (const [key, value] of Object.entries(node)) {
      walkSchemas(value, [...context, key]);
    }
  };
  walkSchemas(document, []);

  return findings;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const [name, schema] of Object.entries(openApiDocument.components.schemas)) {
  ajv.addSchema(schema as object, `#/components/schemas/${name}`);
}

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

describe("Agent HTTP API (OpenAPI / REST)", function () {
  let scratch: string;
  let provider: DocumentManager;
  let httpProvider: AgentHTTPProvider;
  let documentLint: DocumentLintProvider;
  /** `editor.lint.flowmark.timeoutMs` of the configuration of a test. */
  let flowmarkTimeoutMs: number;
  /** How many times the background lint queue ran empty. */
  let lintDrains: number;
  let httpPort: number;
  let authoringHome: string;
  let figuresRoot: string;
  let skillsRoot: string;
  let configuredSkillsDirectory: string | null;
  let saveDialogResponse = 2;
  let peerServers: http.Server[] = [];
  // The configured workspace set, read live by the config seam so a test can
  // exercise the no-workspace-open profile the app ships with.
  let openWorkspaces: string[] = [];
  const links = { index: new WikilinkIndex([]) };
  /** The host of the provider of a test. */
  let agentHost: AgentApiHost;

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
        readDirectoryRecursively: walkWorkspace,
      },
      citeproc: {
        synchronizeDatabases: async (_libraries: string[]) => {},
      },
      recentDocs: {
        add: (_path: string) => {},
        markEdited: (_path: string) => {},
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
        // The spec has no main window, so no window gets a message.
        tellMainWindows: (
          _windowIds: readonly string[],
          _channel: string,
          ..._args: readonly unknown[]
        ) => {},
        getMainWindowKey: (_window: unknown) => activeWindowId,
        // No operation of this spec asks the author for a file.
        saveFile: async (_filePath: string): Promise<string | undefined> => {
          throw new Error("This spec shows no save dialog");
        },
        // No operation of this spec opens a file with the desktop.
        showErrorMessage: (_title: string, _message: string, _contents?: string) => {
          throw new Error("This spec opens no file with the desktop");
        },
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

  // The Search view's provider over the scratch workspace. The FSAL seam walks
  // and reads the real files, and open documents are read through the real
  // document manager, so the search sees what the editor shows.
  function createSearch(): SearchProvider {
    return new SearchProvider(
      new LogProvider(),
      {
        readDirectoryRecursively: walkWorkspace,
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

  /** Open a file in the first pane, and return its documentId. */
  async function openInPane(filePath: string, content: string): Promise<string> {
    writeFileSync(filePath, content, "utf8");
    const windowId = provider.windowKeys()[0];
    const leafId = provider.leafIds(windowId)[0];
    assert.ok(leafId !== undefined);
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, leafId, filePath), true);
    const documentId = provider.getDocumentId(filePath);
    assert.ok(documentId !== undefined);
    return documentId;
  }

  /**
   * Close the file with its review saved, change it on disk, and open it
   * again: the review that comes back no longer matches the file.
   */
  async function reopenAfterDiskEdit(filePath: string, diskText: string): Promise<void> {
    const windowId = provider.windowKeys()[0];
    const leafId = provider.leafIds(windowId)[0];
    assert.ok(leafId !== undefined);
    saveDialogResponse = 0;
    assert.equal(await provider.closeFile(windowId, leafId, filePath), true);
    writeFileSync(filePath, diskText, "utf8");
    const reopenedLeafId = provider.leafIds(windowId)[0];
    assert.ok(reopenedLeafId !== undefined);
    await provider.getDocument(filePath);
    assert.equal(await provider.openFile(windowId, reopenedLeafId, filePath), true);
  }

  async function httpRequest(
    method: string,
    pathname: string,
    options: {
      body?: string;
      headers?: Record<string, string>;
      /** Send no token. */
      anonymous?: true;
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
          headers:
            options.anonymous === true
              ? { ...options.headers }
              : { ...AUTHORIZED, ...options.headers },
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

  function runReviewDiffCli(
    args: string[],
    tokenEnvironment: NodeJS.ProcessEnv = TOKEN_ENVIRONMENT,
  ): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(__dirname, "../scripts/desktop/zettlr-pandoc-review-diff"), ...args],
        {
          cwd: path.join(__dirname, ".."),
          env: { ...process.env, ...tokenEnvironment },
          stdio: ["ignore", "pipe", "pipe"],
        },
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
    authoringHome = mkdtempSync(path.join(os.tmpdir(), "zettlr-http-authoring-"));
    figuresRoot = path.join(authoringHome, "central-figures");
    skillsRoot = path.join(authoringHome, "skills");
    configuredSkillsDirectory = skillsRoot;
    openWorkspaces = [scratch];

    const macroRoot = path.join(authoringHome, ".pandoc", "styles", "macros");
    const mathJaxRoot = path.join(authoringHome, ".pandoc", "templates", "css");
    const templateRoot = path.join(authoringHome, ".pandoc", "templates");
    mkdirSync(path.join(macroRoot, "nested"), { recursive: true });
    mkdirSync(mathJaxRoot, { recursive: true });
    mkdirSync(templateRoot, { recursive: true });
    writeFileSync(
      path.join(macroRoot, "tier1.tex"),
      ["\\newcommand{\\ZZ}{\\mathbb{Z}}", "\\DeclareMathOperator{\\Spec}{Spec}", ""].join("\n"),
    );
    writeFileSync(
      path.join(macroRoot, "nested", "compiler.tex"),
      "\\newcommand{\\CompilerOnly}[1]{\\mathbf{#1}}\n",
    );
    writeFileSync(
      path.join(mathJaxRoot, "mathjax-macros.json"),
      JSON.stringify({ ZZ: "\\mathbb{Z}", Spec: "\\operatorname{Spec}" }),
    );
    writeFileSync(
      path.join(templateRoot, "standalone-tikz.tex"),
      "\\documentclass{standalone}\n\\begin{document}\n$body$\n\\end{document}\n",
    );

    mkdirSync(path.join(figuresRoot, "diagrams"), { recursive: true });
    mkdirSync(path.join(figuresRoot, "images"), { recursive: true });
    writeFileSync(
      path.join(figuresRoot, "diagrams", "main.tikz"),
      "\\begin{tikzpicture}\n\\node {elliptic surface};\n\\end{tikzpicture}\n",
    );
    writeFileSync(path.join(figuresRoot, "images", "pixel.bin"), Buffer.from([0, 255, 1, 254]));

    mkdirSync(path.join(skillsRoot, "proofs", "nested"), { recursive: true });
    writeFileSync(path.join(skillsRoot, "SKILL.md"), "# Root skill\n\nUse exact maps.\n", "utf8");
    writeFileSync(
      path.join(skillsRoot, "proofs", "proof-style.md"),
      "# Proof style\n\nPrefer diagrams to prose.\n",
      "utf8",
    );
    writeFileSync(path.join(skillsRoot, "proofs", "ignore.txt"), "not a skill\n", "utf8");
    writeFileSync(path.join(skillsRoot, "proofs", "nested", "notes.md"), "# Notes\n", "utf8");
    writeFileSync(path.join(authoringHome, "outside-skill.md"), "# Outside\n", "utf8");
    symlinkSync(
      path.join(authoringHome, "outside-skill.md"),
      path.join(skillsRoot, "proofs", "outside.md"),
    );

    provider = await createProvider();
    const config = {
      get: () => ({
        export: { cslLibrary: "" },
        app: {
          openWorkspaces,
        },
        agentApi: {
          enabled: true,
          // Kernel-assigned: the provider owns the bind and publishes the
          // actual port, so no reservation can race the listener.
          port: 0,
          skillsDirectory: configuredSkillsDirectory,
        },
        tikz: {
          dataDir: path.join(__dirname, "../packages/tikz-render/test/fixtures/tikz-data"),
          figuresDir: figuresRoot,
        },
        editor: { lint: { flowmark: { timeoutMs: flowmarkTimeoutMs } } },
      }),
    };
    const lintUserData = path.join(authoringHome, "lint-user-data");
    mkdirSync(lintUserData);
    flowmarkTimeoutMs = 60_000;
    lintDrains = 0;
    documentLint = new DocumentLintProvider({
      log: new LogProvider(),
      config,
      buffers: provider,
      homeDirectory: authoringHome,
      env: {},
      userDataDirectory: lintUserData,
      onDrain: () => {
        lintDrains += 1;
      },
    });
    await documentLint.boot();
    agentHost = new (class {
      public get config() {
        return config;
      }

      public get links() {
        return links;
      }

      public readonly search = createSearch();
      public readonly documentLint = documentLint;
      public readonly workspaceFsal = {
        // The workspace-entry routes create against the real filesystem, so a
        // test creates an entry and then reads it back rather than asserting a
        // call was made. Containment is the provider's, not the seam's.
        createFile: async (filePath: string, content: string) => {
          writeFileSync(filePath, content, { encoding: "utf8", flag: "wx" });
        },
        createDir: async (dirPath: string) => {
          mkdirSync(dirPath);
        },
        isDir: async (absPath: string) => {
          const stats = lstatSync(absPath, { throwIfNoEntry: false });
          return stats !== undefined && stats.isDirectory();
        },
        readDirectoryRecursively: walkWorkspace,
      };
    })();
    httpProvider = new AgentHTTPProvider(new LogProvider(), provider, agentHost, {
      homeDirectory: authoringHome,
      env: TOKEN_ENVIRONMENT,
    });
    await httpProvider.boot();
    httpPort = Number.parseInt(
      readFileSync(path.join(userData, "agent-api.port"), "utf8").trim(),
      10,
    );
    assert.ok(Number.isInteger(httpPort) && httpPort > 0);
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
    await documentLint.shutdown();
    await provider.shutdown();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(authoringHome, { recursive: true, force: true });
  });

  it("review-submission applies a closed-file patch without changing focus and refuses a stale baseline", async function () {
    const filePath = path.join(scratch, "submission.md");
    const before = "A bilinear form is symmetric.\n";
    const after = "A bilinear form is symmetric and nondegenerate.\n";
    writeFileSync(filePath, before);
    const priorPath = path.join(scratch, "prior.md");
    await openFile(priorPath, "Previously selected document.\n");
    const windowId = provider.windowKeys()[0];
    await provider.openFile(windowId, provider.leafIds(windowId)[0], priorPath);
    const focused = provider.getFocusedView();
    const request = {
      document: { uri: filePath },
      baseline: { sha256: sha256Text(before) },
      patch: createPatch(filePath, before, after),
      description: "State the nondegeneracy hypothesis.",
      clientRequestId: "closed-submission",
    };
    const inapplicable = await httpRequest("POST", "/v1/review-submissions", {
      body: JSON.stringify({
        ...request,
        patch: createPatch(filePath, "An unrelated baseline.\n", after),
        clientRequestId: "inapplicable",
      }),
    });
    assert.equal(inapplicable.status, 400);
    assert.equal(
      parseAs(inapplicable.body, "AgentErrorResponse").error.code,
      "PATCH_NOT_APPLICABLE",
    );
    const response = await httpRequest("POST", "/v1/review-submissions", {
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200, response.body);
    const result = parseAs(response.body, "ReviewSubmissionResponse");
    const content = await httpRequest(
      "GET",
      `/v1/documents/${result.documentId}?includeContent=true`,
    );
    assert.equal(parseAs(content.body, "ReadDocumentResponse").content, after);
    assert.deepEqual(provider.getFocusedView(), focused);
    const stale = await httpRequest("POST", "/v1/review-submissions", {
      body: JSON.stringify({ ...request, clientRequestId: "stale-submission" }),
    });
    assert.equal(stale.status, 412);
    assert.equal(parseAs(stale.body, "AgentErrorResponse").error.code, "BASELINE_MISMATCH");
    const replay = await httpRequest("POST", "/v1/review-submissions", {
      body: JSON.stringify({ ...request, baseline: undefined }),
    });
    assert.equal(replay.status, 409);
    assert.equal(parseAs(replay.body, "AgentErrorResponse").error.code, "IDEMPOTENCY_CONFLICT");
  });

  it("review-submission applies ordered claims and rejects paths outside the workspace", async function () {
    const filePath = path.join(scratch, "claims.md");
    const before = "Let V be a vector space.\n";
    const middle = "Let V be a finite-dimensional vector space.\n";
    const after = "Let V be a finite-dimensional vector space over F.\n";
    writeFileSync(filePath, before);
    const documentId = await openFile(filePath, before);
    const windowId = provider.windowKeys()[0];
    await provider.openFile(windowId, provider.leafIds(windowId)[0], filePath);
    const annotation = await provider.createAnnotation(
      documentId,
      "owner",
      9,
      23,
      "Specify the hypotheses.",
      0,
    );
    assert.ok("annotationId" in annotation);
    const priorPath = path.join(scratch, "previous-selection.md");
    await openFile(priorPath, "Another open document.\n");
    await provider.openFile(windowId, provider.leafIds(windowId)[0], priorPath);
    const selected = provider.getFocusedView();
    const claims = [
      {
        description: "Specify finite dimension.",
        patch: createPatch(filePath, before, middle),
        addressesAnnotationIds: [annotation.annotationId],
      },
      {
        description: "Specify the field.",
        patch: createPatch(filePath, middle, after),
      },
    ];
    const outside = await httpRequest("POST", "/v1/review-submissions", {
      body: JSON.stringify({
        document: { uri: __filename },
        claims,
        clientRequestId: "outside",
      }),
    });
    assert.equal(outside.status, 404);
    const invalid = await httpRequest("POST", "/v1/review-submissions", {
      body: JSON.stringify({
        document: { uri: filePath },
        claims: [claims[0], { ...claims[1], addressesAnnotationIds: ["missing-annotation"] }],
        clientRequestId: "invalid-claims",
      }),
    });
    assert.equal(invalid.status, 404);
    assert.equal(parseAs(invalid.body, "AgentErrorResponse").error.code, "ANNOTATION_NOT_FOUND");
    const unchanged = await httpRequest("GET", `/v1/documents/${documentId}?includeContent=true`);
    assert.equal(parseAs(unchanged.body, "ReadDocumentResponse").content, before);
    const unlinked = await httpRequest("GET", `/v1/annotations/${annotation.annotationId}`);
    assert.deepEqual(parseAs(unlinked.body, "AnnotationResponse").proposalActions, []);
    const response = await httpRequest("POST", "/v1/review-submissions", {
      body: JSON.stringify({
        document: { uri: filePath },
        claims,
        clientRequestId: "claims-submission",
      }),
    });
    assert.equal(response.status, 200, response.body);
    const result = parseAs(response.body, "ReviewSubmissionResponse");
    // The reviewed document is open in a background tab: the submission
    // leaves the tab the user selected in front.
    assert.deepEqual(provider.getFocusedView(), selected);
    const content = await httpRequest(
      "GET",
      `/v1/documents/${result.documentId}?includeContent=true`,
    );
    assert.equal(parseAs(content.body, "ReadDocumentResponse").content, after);
    const packets = await httpRequest("GET", `/v1/reviews/${result.reviewId}?view=packets`);
    assert.deepEqual(
      parseAs(packets.body, "ReviewPacketsResponse").packets.map((packet) => packet.description),
      claims.map((claim) => claim.description),
    );
    const linked = await httpRequest("GET", `/v1/annotations/${annotation.annotationId}`);
    assert.equal(
      parseAs(linked.body, "AnnotationResponse").proposalActions[0].packetId,
      result.packetIds[0],
    );
  });

  it("accepts one description on claims that change different text", async function () {
    const filePath = path.join(scratch, "one-note-two-places.md");
    const lines = Array.from({ length: 12 }, (_, index) => `Statement ${index + 1} holds.`);
    const withLine = (source: readonly string[], index: number): string[] =>
      source.map((line, at) => (at === index ? `${line} [@Nik80]` : line));
    const middleLines = withLine(lines, 2);
    const before = `${lines.join("\n")}\n`;
    const middle = `${middleLines.join("\n")}\n`;
    const after = `${withLine(middleLines, 9).join("\n")}\n`;
    writeFileSync(filePath, before);
    await openFile(filePath, before);
    const description = "This sentence needs a citation.";

    const response = await httpRequest("POST", "/v1/review-submissions", {
      body: JSON.stringify({
        document: { uri: filePath },
        claims: [
          { description, patch: createPatch(filePath, before, middle) },
          { description, patch: createPatch(filePath, middle, after) },
        ],
        clientRequestId: "same-note-two-places",
      }),
    });

    assert.equal(response.status, 200, response.body);
    const result = parseAs(response.body, "ReviewSubmissionResponse");
    const content = await httpRequest(
      "GET",
      `/v1/documents/${result.documentId}?includeContent=true`,
    );
    assert.equal(parseAs(content.body, "ReadDocumentResponse").content, after);
    const packets = await httpRequest("GET", `/v1/reviews/${result.reviewId}?view=packets`);
    assert.deepEqual(
      parseAs(packets.body, "ReviewPacketsResponse").packets.map((packet) => packet.description),
      [description, description],
    );
  });

  it("rejects a claim that has the description of an earlier claim and changes its text", async function () {
    const filePath = path.join(scratch, "duplicate-claims.md");
    const before = "Let V be a vector space.\nAssume the form is symmetric.\n";
    const middle = "Let V be a finite-dimensional vector space.\nAssume the form is symmetric.\n";
    const again =
      "Let V be a finite-dimensional real vector space.\nAssume the form is symmetric.\n";
    const elsewhere =
      "Let V be a finite-dimensional vector space.\nAssume the form is symmetric and nondegenerate.\n";
    writeFileSync(filePath, before);
    const documentId = await openFile(filePath, before);

    // The second claim changes the words that the first claim wrote, and it
    // has the description of the first claim up to case and whitespace.
    const repeated = await httpRequest("POST", "/v1/review-submissions", {
      body: JSON.stringify({
        document: { uri: filePath },
        claims: [
          {
            description: "Add the missing hypothesis to this statement.",
            patch: createPatch(filePath, before, middle),
          },
          {
            description: "  add   the missing hypothesis to THIS statement.  ",
            patch: createPatch(filePath, middle, again),
          },
        ],
        clientRequestId: "duplicate-claim-same-text",
      }),
    });
    assert.equal(repeated.status, 400, repeated.body);
    const error = parseAs(repeated.body, "AgentErrorResponse").error;
    assert.equal(error.code, "DUPLICATE_CLAIM");
    assert.deepEqual(error.conflictingClaimIndices, [0, 1]);

    const unchanged = await httpRequest("GET", `/v1/documents/${documentId}?includeContent=true`);
    assert.equal(parseAs(unchanged.body, "ReadDocumentResponse").content, before);

    // The same two descriptions on two sentences are two claims.
    const apart = await httpRequest("POST", `/v1/documents/${documentId}/proposals`, {
      body: JSON.stringify({
        baselineSha256: sha256Text(before),
        expectedReviewGeneration: 0,
        claims: [
          {
            description: "Add the missing hypothesis to this statement.",
            patch: createPatch(filePath, before, middle),
          },
          {
            description: "  add   the missing hypothesis to THIS statement.  ",
            patch: createPatch(filePath, middle, elsewhere),
          },
        ],
        clientRequestId: "duplicate-claim-other-text",
      }),
    });
    assert.equal(apart.status, 200, apart.body);
    const changed = await httpRequest("GET", `/v1/documents/${documentId}?includeContent=true`);
    assert.equal(parseAs(changed.body, "ReadDocumentResponse").content, elsewhere);
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

    const collided = new AgentHTTPProvider(
      new LogProvider(),
      provider,
      {
        config: {
          get: () => ({
            app: { openWorkspaces: [scratch] },
            export: { cslLibrary: "" },
            tikz: { dataDir: "", figuresDir: "" },
            editor: { lint: { flowmark: { timeoutMs: 60_000 } } },
            agentApi: {
              enabled: true,
              port: takenPort,
              skillsDirectory: null,
            },
          }),
        },
        search: createSearch(),
        documentLint,
        links,
      },
      { homeDirectory: authoringHome, env: TOKEN_ENVIRONMENT },
    );

    try {
      await assert.rejects(
        collided.boot(),
        (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
      );
      assert.equal(collided.isListening, false, "a failed boot must leave no listener behind");
    } finally {
      await collided.shutdown();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });

  it("publishes the bound port for discovery and retracts it on shutdown", async function () {
    // The port file is the endpoint-discovery contract: with `port: 0` the
    // kernel chooses, so the file is the only place a client can learn the
    // endpoint. It must name the port that actually answers, and a clean
    // shutdown must not leave a stale endpoint behind.
    const portFile = path.join(userData, "agent-api.port");
    const published = Number.parseInt(readFileSync(portFile, "utf8").trim(), 10);
    assert.equal(published, httpPort);
    const response = await httpRequest("GET", "/v1/ping");
    assert.equal(response.status, 200);

    await httpProvider.shutdown();
    assert.equal(existsSync(portFile), false, "shutdown must remove the port file");
  });

  it("GET /openapi.yaml serves the OpenAPI specification without auth", async function () {
    const response = await httpRequest("GET", "/openapi.yaml", { anonymous: true });
    assert.equal(response.status, 200);
    assert.ok(response.body.includes("openapi:"));
    assert.ok(response.body.includes("Zettlr-Pandoc Editor Agent API"));
  });

  it("GET /help and /v1/help serve Markdown and JSON help documentation", async function () {
    const rawHelp = HELP_DOCUMENT;
    // The served guide is HELP.md with the theorem-family table filled in.
    assert.ok(
      rawHelp.startsWith(readFileSync(path.join(__dirname, "../HELP.md"), "utf8").split("<!--")[0]),
    );
    assert.ok(rawHelp.includes("| Lemma | `.lemma` | `#lem:key` |"));

    // Markdown by default
    const mdHelp = await httpRequest("GET", "/help");
    assert.equal(mdHelp.status, 200);
    assert.ok(mdHelp.headers["content-type"]?.includes("text/markdown"));
    assert.equal(mdHelp.body, rawHelp);

    const mdV1Help = await httpRequest("GET", "/v1/help");
    assert.equal(mdV1Help.status, 200);
    assert.ok(mdV1Help.headers["content-type"]?.includes("text/markdown"));
    assert.equal(mdV1Help.body, rawHelp);

    // JSON format via Accept header
    const jsonHelp = await httpRequest("GET", "/help", {
      headers: { accept: "application/json" },
    });
    assert.equal(jsonHelp.status, 200);
    assert.equal(parseAs(jsonHelp.body, "HelpResponse").help, rawHelp);

    // JSON format via query parameter
    const queryJson = await httpRequest("GET", "/v1/help?format=json");
    assert.equal(queryJson.status, 200);
    assert.equal(parseAs(queryJson.body, "HelpResponse").help, rawHelp);
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

  it("serves a document the Custom GPT Action importer accepts", async function () {
    // The importer's checks run against the served bytes, because those are
    // what the builder fetches. It refuses the whole document on any finding,
    // so a description written past 300 characters in openapi.yaml makes the
    // API uninstallable rather than merely verbose. There is one document:
    // every route it declares is one an Action can call.
    const document = JSON.parse((await httpRequest("GET", "/openapi.json")).body) as JsonValue;
    assert.deepEqual(auditAsGptAction(document), []);

    const withSecurity = JSON.parse((await httpRequest("GET", "/openapi.json")).body) as {
      security?: OpenApiDefinition["security"];
      components: {
        securitySchemes?: NonNullable<OpenApiDefinition["components"]>["securitySchemes"];
      };
    };
    assert.deepEqual(withSecurity.security, [{ bearerToken: [] }]);
    assert.deepEqual(withSecurity.components.securitySchemes, {
      bearerToken: { type: "http", scheme: "bearer" },
    });
  });

  it("marks every Custom GPT Action operation explicitly non-consequential", async function () {
    const document = JSON.parse((await httpRequest("GET", "/openapi.json")).body) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            "x-openai-isConsequential"?: boolean;
          }
        >
      >;
    };
    const operations = Object.entries(document.paths).flatMap(([route, methods]) =>
      HTTP_METHODS.flatMap((method) => {
        const operation = methods[method];
        return operation === undefined ? [] : [{ route, method, operation }];
      }),
    );
    assert.ok(operations.length > 0, "the served document must expose callable operations");
    assert.ok(
      operations.length <= 30,
      `OpenAPI spec operations (${operations.length}) must not exceed the 30-operation Custom GPT limit`,
    );
    for (const { route, method, operation } of operations) {
      assert.equal(
        operation["x-openai-isConsequential"],
        false,
        `${method.toUpperCase()} ${route} (${operation.operationId ?? "missing operationId"}) must explicitly allow persistent Custom GPT consent`,
      );
    }
  });

  it("reproduces each import finding on a document that breaks the rules", function () {
    // Without this, the empty findings above would also be what a checker
    // that inspects nothing reports. Each rule is violated once, in the shape
    // the real document uses.
    const broken: JsonValue = {
      openapi: "3.1.0",
      paths: {
        "/thing": {
          get: {
            operationId: "getThing",
            description: "x".repeat(301),
            parameters: [
              { name: "verbose", in: "query", description: "y".repeat(701) },
              { name: "Stream-Cursor", in: "header" },
            ],
            responses: {
              "200": {
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
    };
    assert.deepEqual(auditAsGptAction(broken), [
      "In path /thing, method get, operationId getThing, description has length 301 exceeding limit of 300",
      "In path /thing, method get, operationId getThing, parameter verbose description has length 701 exceeding limit of 700",
      "In path /thing, method get, operationId getThing, parameter Stream-Cursor has location header; ignoring",
      "In context=('paths', '/thing', 'get', 'responses', '200', 'content', 'application/json', 'schema'), object schema missing properties",
    ]);
  });

  it("publishes no adjudication operation in the served document", async function () {
    // The product boundary: an agent submits revisions and may comment on
    // them; disposing of a chunk is the reviewer's, through the editor. A
    // Custom GPT builds its callable surface from this document alone, so
    // the absence of these operationIds is what makes adjudication
    // inexpressible to it — not a refusal it could retry.
    const adjudication = [
      "acceptReviewChunk",
      "rejectReviewChunk",
      "acceptAllReviewChunks",
      "clearReview",
    ];
    const document = JSON.parse((await httpRequest("GET", "/openapi.json")).body) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const declared = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId),
    );
    // Submission and comment prove the enumeration reads real operationIds:
    // a selector that found nothing would pass the absence check alone.
    assert.ok(declared.includes("submitProposal"));
    assert.ok(declared.includes("addReviewComment"));
    for (const operationId of adjudication) {
      assert.ok(!declared.includes(operationId), `must not declare ${operationId}`);
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
        socket.write(
          `GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${API_TOKEN}\r\nConnection: close\r\n\r\n`,
        );
      });
      let received = "";
      socket.on("data", (chunk: Buffer) => (received += chunk.toString("utf8")));
      socket.on("error", reject);
      socket.on("close", () => resolve(received));
    });
    assert.match(raw.split("\r\n")[0], /^HTTP\/1\.1 500 /);
    assert.equal(
      parseAs(raw.split("\r\n\r\n")[1], "AgentErrorResponse").error.code,
      "INTERNAL_ERROR",
    );

    assert.equal((await httpRequest("GET", "/v1/ping")).status, 200);
  });

  it("GET /v1/ping returns protocol version", async function () {
    const response = await httpRequest("GET", "/v1/ping");
    assert.equal(response.status, 200);
    const body = parseAs(response.body, "PingResponse");
    assert.ok(body.protocolVersion.length > 0);
    assert.ok(body.instanceId.length > 0);
  });

  it("names each folder whose content a workspace listing does not hold (#210)", async function () {
    mkdirSync(path.join(scratch, "notes"));
    writeFileSync(path.join(scratch, "notes", "genus.md"), "# Genus\n", "utf8");
    const locked = path.join(scratch, "locked");
    mkdirSync(locked);
    writeFileSync(path.join(locked, "lattice.md"), "# Lattice\n", "utf8");
    chmodSync(locked, 0o000);
    const notListedOf = (body: string): string[] =>
      (JSON.parse(body) as { notListed: Array<{ path: string; cause: string }> }).notListed.map(
        (folder) => folder.path,
      );
    try {
      const files = await httpRequest(
        "GET",
        `/v1/workspaces?workspaceId=${encodeURIComponent(scratch)}&include=files`,
      );
      assert.equal(files.status, 200, files.body);
      assert.deepEqual(
        parseAs(files.body, "WorkspaceFilesResponse").files.map((file) =>
          path.relative(scratch, file.path),
        ),
        ["notes/genus.md"],
      );
      assert.deepEqual(notListedOf(files.body), [locked]);

      const documents = await httpRequest(
        "GET",
        `/v1/workspaces?workspaceId=${encodeURIComponent(scratch)}&include=documents`,
      );
      assert.equal(documents.status, 200, documents.body);
      assert.deepEqual(notListedOf(documents.body), [locked]);

      const directories = await httpRequest(
        "GET",
        `/v1/workspaces?workspaceId=${encodeURIComponent(scratch)}&include=directories`,
      );
      assert.equal(directories.status, 200, directories.body);
      assert.deepEqual(
        parseAs(directories.body, "WorkspaceDirectoriesResponse")
          .directories.map((directory) => path.relative(scratch, directory.path))
          .sort(),
        ["locked", "notes"],
      );
      assert.deepEqual(notListedOf(directories.body), [locked]);

      const everyWorkspace = await httpRequest("GET", "/v1/workspaces?include=files");
      assert.equal(everyWorkspace.status, 200, everyWorkspace.body);
      assert.deepEqual(notListedOf(everyWorkspace.body), [locked]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("names a workspace whose folder it cannot list (#210)", async function () {
    const invalidWorkspace = path.join(scratch, "not-a-directory");
    writeFileSync(invalidWorkspace, "workspace path is a file\n", "utf8");
    openWorkspaces = [invalidWorkspace];

    for (const include of ["files", "documents"]) {
      const response = await httpRequest(
        "GET",
        `/v1/workspaces?workspaceId=${encodeURIComponent(invalidWorkspace)}&include=${include}`,
      );
      assert.equal(response.status, 200, response.body);
      const body = JSON.parse(response.body) as {
        files?: unknown[];
        documents?: unknown[];
        notListed: Array<{ path: string; cause: string }>;
      };
      assert.deepEqual(body.files ?? body.documents, []);
      assert.deepEqual(
        body.notListed.map((folder) => folder.path),
        [invalidWorkspace],
      );
    }
  });

  it("GET /v1/capabilities reports supported features", async function () {
    const response = await httpRequest("GET", "/v1/capabilities");
    assert.equal(response.status, 200);
    const body = parseAs(response.body, "CapabilitiesResponse");
    assert.deepEqual(body.supportedPatchFormats, ["unified-diff"]);
    assert.equal(body.reviewSupport, true);
  });

  it("GET /v1/context returns open documents", async function () {
    const filePath = path.join(scratch, "ctx.md");
    await openFile(filePath, "content\n");
    const response = await httpRequest("GET", "/v1/context");
    assert.equal(response.status, 200);
    const body = parseAs(response.body, "EditorContext");
    assert.ok(body.openDocuments.length > 0);
  });

  it("GET /v1/documents lists open documents", async function () {
    const filePath = path.join(scratch, "list.md");
    await openFile(filePath, "content\n");
    const response = await httpRequest("GET", "/v1/documents");
    assert.equal(response.status, 200);
    const body = parseAs(response.body, "DocumentListResponse");
    assert.ok(body.documents.length > 0);
    assert.ok(body.documents.some((d) => d.path === filePath));
  });

  it("serves the Zotero operations at /zotero/mcp and every other operation at /mcp", async function () {
    const filePath = path.join(scratch, "mcp.md");
    const docId = await openFile(filePath, "mcp content\n");
    const operations = Object.values(openApiDocument.paths).flatMap((methods) =>
      Object.values(methods),
    );
    const zoteroClient = new Client({
      name: "agent-http-api-spec",
      version: "1.0.0",
    });
    await zoteroClient.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/zotero/mcp`), {
        requestInit: { headers: AUTHORIZED },
      }),
    );
    try {
      const { tools } = await zoteroClient.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        "getZoteroExtractions",
        "importZoteroIdentifier",
        "importZoteroUrl",
        "searchZoteroItems",
      ]);
    } finally {
      await zoteroClient.close();
    }
    const client = new Client({
      name: "agent-http-api-spec",
      version: "1.0.0",
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`), {
        requestInit: { headers: AUTHORIZED },
      }),
    );
    try {
      const { tools } = await client.listTools();
      const operationIds = operations
        .filter((operation) => operation.tags?.includes("zotero") !== true)
        .map((operation) => operation.operationId);
      assert.deepEqual(tools.map((tool) => tool.name).sort(), operationIds.sort());
      assert.ok(tools.length <= 30, "the ChatGPT MCP connector must remain within 30 tools");

      const read = await client.callTool({
        name: "getDocument",
        arguments: { documentId: docId, includeContent: true },
      });
      assert.equal(read.isError, false);
      const [content] = read.content as Array<{ type: "text"; text: string }>;
      const document = parseAs(content.text, "ReadDocumentResponse");
      assert.equal(document.content, "mcp content\n");

      const skills = await client.callTool({
        name: "getHelp",
        arguments: { resource: "skills", action: "list" },
      });
      assert.equal(skills.isError, false);
      const [skillsContent] = skills.content as Array<{ type: "text"; text: string }>;
      const skillsList = parseAs(skillsContent.text, "SkillsListResponse");
      assert.ok(skillsList.entries.some((entry) => entry.path === "SKILL.md"));

      const skillFile = await client.callTool({
        name: "getHelp",
        arguments: {
          resource: "skills",
          action: "read",
          path: "proofs/proof-style.md",
        },
      });
      assert.equal(skillFile.isError, false);
      const [skillFileContent] = skillFile.content as Array<{ type: "text"; text: string }>;
      assert.equal(
        parseAs(skillFileContent.text, "SkillFileResponse").content,
        "# Proof style\n\nPrefer diagrams to prose.\n",
      );

      const missing = await client.callTool({
        name: "getDocument",
        arguments: { documentId: "no-such-document" },
      });
      assert.equal(missing.isError, true);
    } finally {
      await client.close();
    }
  });

  it("GET /v1/workspace/search finds text across closed files and live buffers", async function () {
    const openPath = path.join(scratch, "open.md");
    const openId = await openFile(openPath, "saved text\n");
    const buffered = await httpRequest("GET", `/v1/documents/${openId}?includeContent=true`);
    await provider.applyWorkspaceTextEdits([
      { documentPath: openPath, range: { from: 0, to: 5 }, insert: "lattice" },
    ]);
    assert.equal(buffered.status, 200);
    const closedPath = path.join(scratch, "notes", "closed.md");
    mkdirSync(path.dirname(closedPath), { recursive: true });
    writeFileSync(closedPath, "first line\nan even lattice and a Lattice\n");

    const found = await httpRequest("GET", "/v1/workspace/search?text=lattice");
    assert.equal(found.status, 200);
    const body = parseAs(found.body, "WorkspaceSearchResponse");
    assert.equal(body.truncated, false);
    assert.equal(body.matchCount, 3);
    const byPath = new Map(body.files.map((file) => [file.path, file]));
    const open = byPath.get(openPath);
    assert.ok(open !== undefined, "the unsaved buffer text must be searched");
    assert.equal(open.documentId, openId);
    assert.equal(open.open, true);
    const closed = byPath.get(closedPath);
    assert.ok(closed !== undefined);
    assert.equal(closed.open, false);
    assert.equal(closed.workspaceId !== undefined, true);
    assert.deepEqual(
      closed.matches.map((match) => [match.line, match.preview.inside]),
      [
        [2, "lattice"],
        [2, "Lattice"],
      ],
    );
    const closedRead = parseAs(
      (await httpRequest("GET", `/v1/documents/${closed.documentId}?includeContent=true`)).body,
      "ReadDocumentResponse",
    );
    assert.equal(closedRead.content, "first line\nan even lattice and a Lattice\n");
    const closedSearch = await httpRequest("POST", `/v1/documents/${closed.documentId}/search`, {
      body: JSON.stringify({ literal: "Lattice" }),
    });
    assert.equal(closedSearch.status, 200, closedSearch.body);
    const closedHits = parseAs(closedSearch.body, "SearchDocumentResponse");
    assert.deepEqual(
      closedHits.hits.map((hit) => [hit.line, hit.column]),
      [
        [2, 9],
        [2, 23],
      ],
    );

    const cased = parseAs(
      (
        await httpRequest(
          "GET",
          "/v1/workspace/search?text=Lattice&matchCase=true&include=notes/*.md",
        )
      ).body,
      "WorkspaceSearchResponse",
    );
    assert.deepEqual(
      cased.files.map((file) => file.path),
      [closedPath],
    );
    assert.equal(cased.matchCount, 1);

    const capped = parseAs(
      (await httpRequest("GET", "/v1/workspace/search?text=lattice&maxMatches=2")).body,
      "WorkspaceSearchResponse",
    );
    assert.equal(capped.matchCount, 2);
    assert.equal(capped.truncated, true);

    // A workspace inside another workspace: its files belong to it, so an
    // include pattern is relative to it and it is the workspace of each hit.
    const inner = path.join(scratch, "zeta");
    const innerPath = path.join(inner, "foundations", "unimodular.md");
    mkdirSync(path.dirname(innerPath), { recursive: true });
    writeFileSync(innerPath, "a unimodular form\n");
    openWorkspaces.push(inner);
    const nested = parseAs(
      (await httpRequest("GET", "/v1/workspace/search?text=unimodular&include=foundations/*.md"))
        .body,
      "WorkspaceSearchResponse",
    );
    assert.deepEqual(
      nested.files.map((file) => [file.path, file.workspaceId]),
      [[innerPath, inner]],
    );

    const invalid = await httpRequest("GET", "/v1/workspace/search?text=(&regex=true");
    assert.equal(invalid.status, 400);
    assert.equal(parseAs(invalid.body, "AgentErrorResponse").error.code, "INVALID_PARAMS");

    // A catastrophic pattern is stopped at the per-file deadline, and the
    // refusal names the file it could not finish.
    const stallPath = path.join(scratch, "stall.md");
    writeFileSync(stallPath, `${"a".repeat(40)}!\n`);
    const stalled = await httpRequest(
      "GET",
      `/v1/workspace/search?regex=true&text=${encodeURIComponent("(a+)+$")}`,
    );
    assert.equal(stalled.status, 422);
    const refusal = parseAs(stalled.body, "AgentErrorResponse");
    assert.equal(refusal.error.code, "SEARCH_TIMEOUT");
    assert.ok(refusal.error.message.includes(stallPath), refusal.error.message);
  });

  it("GET /v1/workspace/search names a file that it could not read, and searches the other files", async function () {
    const readablePath = path.join(scratch, "search-readable.md");
    const unreadablePath = path.join(scratch, "search-unreadable.md");
    writeFileSync(readablePath, "The genus of a lattice.\n", "utf8");
    writeFileSync(unreadablePath, "The genus of a form.\n", "utf8");
    chmodSync(unreadablePath, 0o000);

    const found = await httpRequest("GET", "/v1/workspace/search?text=genus");
    chmodSync(unreadablePath, 0o600);
    assert.equal(found.status, 200, found.body);
    const body = parseAs(found.body, "WorkspaceSearchResponse");
    assert.deepEqual(
      body.notSearched.map((file) => ({ path: file.path, name: file.name })),
      [{ path: unreadablePath, name: "search-unreadable.md" }],
      "the answer names the file that the search did not read",
    );
    assert.ok(body.notSearched[0].cause.length > 0, "the file has the cause of the read");
    assert.deepEqual(
      body.files.map((file) => file.path),
      [readablePath],
      "the file that can be read is searched",
    );
    assert.equal(body.matchCount, 1);
  });

  it("GET /v1/workspace/search names a folder that it could not list, and searches the other files (#210)", async function () {
    const readablePath = path.join(scratch, "search-beside-locked.md");
    const lockedFolder = path.join(scratch, "search-locked");
    writeFileSync(readablePath, "The genus of a lattice.\n", "utf8");
    mkdirSync(lockedFolder);
    writeFileSync(path.join(lockedFolder, "form.md"), "The genus of a form.\n", "utf8");
    chmodSync(lockedFolder, 0o000);

    const found = await httpRequest("GET", "/v1/workspace/search?text=genus");
    chmodSync(lockedFolder, 0o700);
    assert.equal(found.status, 200, found.body);
    const body = parseAs(found.body, "WorkspaceSearchResponse");
    assert.deepEqual(
      body.notSearched.map((entry) => ({ path: entry.path, name: entry.name })),
      [{ path: lockedFolder, name: "search-locked" }],
      "the answer names the folder whose files the search did not read",
    );
    assert.ok(body.notSearched[0].cause.length > 0, "the folder has the cause of the listing");
    assert.deepEqual(
      body.files.map((file) => file.path),
      [readablePath],
      "the file beside the folder is searched",
    );
  });

  it("GET /v1/documents/{id} returns document metadata", async function () {
    const filePath = path.join(scratch, "meta.md");
    const docId = await openFile(filePath, "content\n");
    const response = await httpRequest("GET", `/v1/documents/${docId}`);
    assert.equal(response.status, 200);
    const body = parseAs(response.body, "DocumentSummary");
    assert.equal(body.documentId, docId);
    assert.equal(body.path, filePath);
  });

  it("GET /v1/documents/{id}?includeContent=true returns live buffer with ETag", async function () {
    const filePath = path.join(scratch, "read.md");
    const docId = await openFile(filePath, "alpha\nbeta\n");
    const response = await httpRequest("GET", `/v1/documents/${docId}?includeContent=true`);
    assert.equal(response.status, 200);
    const body = parseAs(response.body, "ReadDocumentResponse");
    assert.ok(body.content.includes("alpha"));
    // The revision hash is the whole external identity a proposal sends back.
    assert.equal(body.revision.sha256, sha256Text("alpha\nbeta\n"));
    // ETag must be present
    const etag = response.headers["etag"];
    assert.ok(etag !== undefined, "ETag header must be present");
    assert.ok(etag.includes("sha256:"));
  });

  it("reads an open document whose file was removed outside the app", async function () {
    // The document has unsaved text, so it stays open after the removal
    // of its file (§14); the caller reads the text that the author has.
    const filePath = path.join(scratch, "removed.md");
    const docId = await openInPane(filePath, "alpha\n");
    await provider.applyWorkspaceTextEdits([
      { documentPath: filePath, range: { from: 6, to: 6 }, insert: "beta\n" },
    ]);
    rmSync(filePath);

    const response = await httpRequest("GET", `/v1/documents/${docId}?includeContent=true`);

    assert.equal(response.status, 200, response.body);
    const body = parseAs(response.body, "ReadDocumentResponse");
    assert.equal(body.revision.sha256, sha256Text("alpha\nbeta\n"));
  });

  it("answers the metadata of a closed workspace document", async function () {
    // The workspace listing gives the id of a closed file; its metadata
    // describes the text that a read of the same id gives.
    const filePath = path.join(scratch, "closed-metadata.md");
    writeFileSync(filePath, "alpha\nbeta\n", "utf8");
    const docId = provider.ensureDocumentId(filePath);

    const response = await httpRequest("GET", `/v1/documents/${docId}`);

    assert.equal(response.status, 200, response.body);
    const summary = parseAs(response.body, "DocumentSummary");
    assert.deepEqual(
      {
        path: summary.path,
        type: summary.type,
        dirty: summary.dirty,
        revision: summary.revision,
        lineCount: summary.lineCount,
        byteLength: summary.byteLength,
        views: summary.views,
      },
      {
        path: filePath,
        type: "markdown",
        dirty: false,
        revision: { sha256: sha256Text("alpha\nbeta\n") },
        lineCount: 3,
        byteLength: 11,
        views: [],
      },
    );
  });

  it("answers that a closed document whose file was removed is not found", async function () {
    const filePath = path.join(scratch, "closed-removed.md");
    writeFileSync(filePath, "alpha\n", "utf8");
    const docId = provider.ensureDocumentId(filePath);
    rmSync(filePath);

    const response = await httpRequest("GET", `/v1/documents/${docId}?includeContent=true`);

    assert.equal(response.status, 404, response.body);
    assert.equal(parseAs(response.body, "AgentErrorResponse").error.code, "DOCUMENT_NOT_FOUND");
  });

  it("answers that a closed document whose file cannot be read is unreadable, and names the file", async function () {
    const filePath = path.join(scratch, "closed-unreadable.md");
    writeFileSync(filePath, "alpha\n", "utf8");
    const docId = provider.ensureDocumentId(filePath);
    chmodSync(filePath, 0o000);

    const response = await httpRequest("GET", `/v1/documents/${docId}?includeContent=true`);
    chmodSync(filePath, 0o600);

    assert.equal(response.status, 409, response.body);
    const refusal = parseAs(response.body, "AgentErrorResponse").error;
    assert.equal(refusal.code, "DOCUMENT_UNREADABLE");
    assert.ok(refusal.message.includes(filePath), refusal.message);
  });

  describe("citation libraries that did not load (#210)", function () {
    const LIBRARY = `@article{AW71,
  title = {Degenerate {{Fibers}} and {{Stable Reduction}} of {{Curves}}},
  author = {Artin, M. and Winters, G.},
  year = 1971,
  journal = {Topology},
  volume = {10},
  pages = {373--383},
}
`;
    let citeproc: CiteprocProvider | undefined;
    let libraryPath: string;
    let absentLibrary: string;

    beforeEach(function () {
      libraryPath = path.join(authoringHome, "references.bib");
      writeFileSync(libraryPath, LIBRARY);
      absentLibrary = path.join(authoringHome, "unmounted", "references.bib");
    });

    afterEach(async function () {
      await citeproc?.shutdown();
      citeproc = undefined;
    });

    /** Starts the API again, with a citation provider whose main library is `mainLibrary`. */
    async function startWithMainLibrary(mainLibrary: string): Promise<CiteprocProvider> {
      const started = new CiteprocProvider(
        new LogProvider(),
        {
          on: () => {},
          get: () => ({
            appLang: "en-US",
            export: {
              cslLibrary: mainLibrary,
              cslStyle: path.resolve("static", "csl-styles", "chicago-author-date.csl"),
            },
          }),
        },
        path.resolve("static", "csl-locales"),
        DATABASE_LOADER_THREAD,
      );
      citeproc = started;
      await started.boot();
      await httpProvider.shutdown();
      httpProvider = new AgentHTTPProvider(
        new LogProvider(),
        provider,
        agentHost,
        { homeDirectory: authoringHome, env: TOKEN_ENVIRONMENT },
        started,
      );
      await httpProvider.boot();
      httpPort = Number.parseInt(
        readFileSync(path.join(userData, "agent-api.port"), "utf8").trim(),
        10,
      );
      return started;
    }

    /** The error of the system for a read of a file that is not there. */
    async function readFailure(file: string): Promise<string> {
      const error: Error = await access(file, fsConstants.R_OK).then(
        () => new Error(`${file} is readable`),
        (cause: Error) => cause,
      );
      return error.message;
    }

    function postJson(pathname: string, body: JsonValue) {
      return httpRequest("POST", pathname, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("names the main library and its cause on each route that needs it", async function () {
      await startWithMainLibrary(absentLibrary);
      const expected = { path: absentLibrary, cause: await readFailure(absentLibrary) };
      const responses = {
        items: await httpRequest("GET", "/v1/citations"),
        item: await httpRequest("GET", "/v1/citations?citeKey=AW71"),
        citation: await postJson("/v1/citations/render", {
          mode: "citation",
          citations: [{ id: "AW71" }],
        }),
        bibliography: await postJson("/v1/citations/render", {
          mode: "bibliography",
          citekeys: ["AW71"],
        }),
        zotero: await httpRequest("GET", "/v1/zotero/items?q=Artin"),
      };
      for (const [route, response] of Object.entries(responses)) {
        assert.equal(response.status, 503, `${route}: ${response.body}`);
        const { error } = parseAs(response.body, "AgentErrorResponse");
        assert.equal(error.code, "CITATION_DATABASE_NOT_LOADED", route);
        assert.deepEqual(error.database, expected, route);
      }
    });

    it("refuses the main library when the settings name none", async function () {
      await startWithMainLibrary("");
      const response = await httpRequest("GET", "/v1/citations");
      assert.equal(response.status, 503, response.body);
      const { error } = parseAs(response.body, "AgentErrorResponse");
      assert.equal(error.code, "CITATION_DATABASE_NOT_LOADED");
      assert.equal(error.database, undefined);
    });

    it("lists each library that did not load beside the libraries that loaded", async function () {
      const started = await startWithMainLibrary(libraryPath);
      await started.synchronizeDatabases([absentLibrary]);
      const cause = await readFailure(absentLibrary);

      const listing = await httpRequest("GET", "/v1/citations?target=databases");
      assert.equal(listing.status, 200, listing.body);
      assert.deepEqual(parseAs(listing.body, "CitationDatabasesResponse"), {
        databases: [{ path: libraryPath, type: "biblatex" }],
        notLoaded: [{ path: absentLibrary, cause }],
      });

      const items = await httpRequest(
        "GET",
        `/v1/citations?database=${encodeURIComponent(absentLibrary)}`,
      );
      assert.equal(items.status, 503, items.body);
      assert.deepEqual(parseAs(items.body, "AgentErrorResponse").error.database, {
        path: absentLibrary,
        cause,
      });

      const neverRead = path.join(authoringHome, "never-read.bib");
      writeFileSync(neverRead, LIBRARY);
      const unknown = await httpRequest(
        "GET",
        `/v1/citations?database=${encodeURIComponent(neverRead)}`,
      );
      assert.equal(unknown.status, 503, unknown.body);
      const { error } = parseAs(unknown.body, "AgentErrorResponse");
      assert.equal(error.code, "CITATION_DATABASE_NOT_LOADED");
      assert.equal(error.database?.path, neverRead);
    });

    it("names the cite keys that a library does not hold", async function () {
      await startWithMainLibrary(libraryPath);

      const bibliography = await postJson("/v1/citations/render", {
        mode: "bibliography",
        citekeys: ["AW71"],
      });
      assert.equal(bibliography.status, 200, bibliography.body);
      assert.equal(parseAs(bibliography.body, "RenderBibliographyResponse").entries.length, 1);

      const withAMissingKey: Array<{ mode: string; [field: string]: JsonValue }> = [
        { mode: "bibliography", citekeys: ["AW71", "Nobody99"] },
        { mode: "citation", citations: [{ id: "AW71" }, { id: "Nobody99" }] },
      ];
      for (const body of withAMissingKey) {
        const response = await postJson("/v1/citations/render", body);
        assert.equal(response.status, 404, `${body.mode}: ${response.body}`);
        const { error } = parseAs(response.body, "AgentErrorResponse");
        assert.equal(error.code, "CITATION_NOT_FOUND", body.mode);
        assert.deepEqual(error.missingCitekeys, ["Nobody99"], body.mode);
      }

      const empty = await postJson("/v1/citations/render", {
        mode: "bibliography",
        citekeys: [],
      });
      assert.equal(empty.status, 400, empty.body);
      assert.equal(parseAs(empty.body, "AgentErrorResponse").error.code, "INVALID_PARAMS");
    });
  });

  describe("the token of a caller (#72)", function () {
    /** The providers that a test of this group made itself. */
    const started: AgentHTTPProvider[] = [];

    afterEach(async function () {
      for (const startedProvider of started.splice(0)) {
        await startedProvider.shutdown();
      }
    });

    const WITHOUT_TOKEN: Array<{ method: string; route: string }> = [
      { method: "GET", route: "/v1/workspaces" },
      { method: "GET", route: "/v1/context" },
      { method: "GET", route: "/v1/ping" },
      { method: "GET", route: "/health" },
      { method: "GET", route: "/v1/help" },
      { method: "POST", route: "/mcp" },
      { method: "POST", route: "/zotero/mcp" },
      { method: "POST", route: "/openapi.json" },
      { method: "GET", route: "/v1/no-such-route" },
    ];

    for (const { method, route } of WITHOUT_TOKEN) {
      it(`refuses ${method} ${route} from a caller without the token`, async function () {
        const response = await httpRequest(method, route, { anonymous: true });
        assert.equal(response.status, 401, response.body);
        assert.equal(parseAs(response.body, "AgentErrorResponse").error.code, "UNAUTHORIZED");
        assert.equal(response.headers["www-authenticate"], "Bearer");
      });
    }

    it("refuses a token that is not the token of the app", async function () {
      const credentials = [
        `Bearer ${randomUUID()}`,
        `Bearer ${API_TOKEN}x`,
        `Bearer ${API_TOKEN.slice(0, -1)}`,
        "Bearer ",
        `Basic ${API_TOKEN}`,
        API_TOKEN,
      ];
      for (const authorization of credentials) {
        const response = await httpRequest("GET", "/v1/workspaces", {
          anonymous: true,
          headers: { authorization },
        });
        assert.equal(response.status, 401, `${authorization.split(" ")[0]}: ${response.body}`);
        assert.equal(parseAs(response.body, "AgentErrorResponse").error.code, "UNAUTHORIZED");
      }
    });

    it("answers a caller that holds the token", async function () {
      const response = await httpRequest("GET", "/v1/workspaces");
      assert.equal(response.status, 200, response.body);
      parseAs(response.body, "WorkspacesResponse");
    });

    it("changes nothing for a caller without the token", async function () {
      const created = path.join(scratch, "from-a-stranger.md");
      const response = await httpRequest("POST", "/v1/workspace/entries", {
        anonymous: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: scratch,
          path: "from-a-stranger.md",
          kind: "file",
          content: "# Not the author\n",
        }),
      });
      assert.equal(response.status, 401, response.body);
      assert.equal(existsSync(created), false);
    });

    it("does not tell a caller without the token where the token is", async function () {
      const response = await httpRequest("GET", "/v1/workspaces", { anonymous: true });
      assert.equal(response.status, 401);
      for (const name of Object.keys(TOKEN_ENVIRONMENT)) {
        assert.equal(response.body.includes(name), false);
      }
    });

    it("serves the specification to a caller without the token", async function () {
      const response = await httpRequest("GET", "/openapi.json", { anonymous: true });
      assert.equal(response.status, 200, response.body);
      const document = JSON.parse(response.body) as { security: Array<Record<string, string[]>> };
      assert.deepEqual(document.security, [{ bearerToken: [] }]);
    });

    it("does not start an enabled API when its environment has no token", async function () {
      for (const env of [{}, { ZETTLR_AGENT_API_TOKEN: "" }]) {
        const unprotected = new AgentHTTPProvider(
          new LogProvider(),
          provider,
          {
            config: {
              get: () => ({
                app: { openWorkspaces: [scratch] },
                export: { cslLibrary: "" },
                tikz: { dataDir: "", figuresDir: "" },
                editor: { lint: { flowmark: { timeoutMs: 60_000 } } },
                agentApi: { enabled: true, port: 0, skillsDirectory: null },
              }),
            },
            search: createSearch(),
            documentLint,
            links,
          },
          { homeDirectory: authoringHome, env },
        );
        started.push(unprotected);
        await assert.rejects(unprotected.boot(), AgentApiTokenRequiredError);
        assert.equal(unprotected.isListening, false);
      }
    });
  });

  it("sends nothing from the external CLI when its environment has no token", async function () {
    let requestCount = 0;
    const peer = http.createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ protocolVersion: "1.0.0" }));
    });
    peerServers.push(peer);
    await new Promise<void>((resolve) => {
      peer.listen(0, "127.0.0.1", resolve);
    });
    const address = peer.address();
    assert.ok(address !== null && typeof address !== "string");

    const filePath = path.join(scratch, "no-token.md");
    const patchPath = path.join(scratch, "no-token.diff");
    writeFileSync(filePath, "before\n", "utf8");
    writeFileSync(patchPath, "a non-empty proposition\n", "utf8");

    const result = await runReviewDiffCli(
      [
        "--document",
        filePath,
        "--patch",
        patchPath,
        "--description",
        "no token",
        "--port",
        String(address.port),
      ],
      { ZETTLR_AGENT_API_TOKEN: "" },
    );
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    const refusal = JSON.parse(result.stderr) as { ok: boolean; error: { code: string } };
    assert.equal(refusal.ok, false);
    assert.equal(refusal.error.code, "TOKEN_REQUIRED");
    assert.equal(requestCount, 0);
  });

  it("submits a review through the standalone external CLI process without changing the selected tab", async function () {
    const filePath = path.join(scratch, "cli-review.md");
    const original = "before\n";
    const revised = "after\n";
    const documentId = await openFile(filePath, original);
    const selectedPath = path.join(scratch, "cli-selected.md");
    await openFile(selectedPath, "The document the user is reading.\n");
    const windowId = provider.windowKeys()[0];
    await provider.openFile(windowId, provider.leafIds(windowId)[0], selectedPath);
    const selected = provider.getFocusedView();
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
    assert.deepEqual(provider.getFocusedView(), selected);
    const tabPaths: string[] = [];
    await provider.forEachLeaf(async (tabMan) => {
      tabPaths.push(...tabMan.openFiles.map((file) => file.path));
      return false;
    });
    assert.ok(!tabPaths.includes(filePath), "the submission must not open a tab");

    const content = await httpRequest("GET", `/v1/documents/${documentId}?includeContent=true`);
    assert.equal(content.status, 200);
    assert.equal(parseAs(content.body, "ReadDocumentResponse").content, revised);

    const chunks = await httpRequest("GET", `/v1/reviews/${submitted.reviewId}?view=chunks`);
    assert.equal(chunks.status, 200);
    const chunkBody = parseAs(chunks.body, "ReviewChunksResponse");
    // The reviewer reads the chunk as text, so the change is reported the way
    // it reads -- one replaced word -- rather than as the letters a character
    // diff happens to share between "before" and "after".
    assert.deepEqual(
      chunkBody.chunks.map((chunk) => chunk.workingText),
      ["after"],
    );
    assert.deepEqual(chunkBody.chunks[0].workingSpans, [{ from: 0, to: 5 }]);
    assert.equal(
      chunkBody.chunks[0].workingSpans.map((span) => revised.slice(span.from, span.to)).join(""),
      chunkBody.chunks[0].workingText,
    );
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
          patch: createPatch("document", "before\n", "after\n", "", "", {
            context: 0,
          }),
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

  it("reads a review frozen by disk drift, and reapplies it onto the current file", async function () {
    const filePath = path.join(scratch, "frozen-review.md");
    const documentId = await openInPane(filePath, "alpha\nbeta\n");
    const submitted = await provider.submitProposal(
      documentId,
      sha256Text("alpha\nbeta\n"),
      [
        {
          description: "capitalize beta",
          patch: createPatch("document", "alpha\nbeta\n", "alpha\nBETA\n", "", "", { context: 0 }),
        },
      ],
      "frozen-review",
      0,
    );
    if (!submitted.ok) {
      assert.fail(`The review proposal was refused: ${submitted.code}`);
    }
    const live = await httpRequest("POST", `/v1/reviews/${submitted.reviewId}/reapply`, {
      body: JSON.stringify({
        expectedReviewGeneration: submitted.reviewGeneration,
      }),
    });
    assert.equal(live.status, 409);
    assert.equal(parseAs(live.body, "AgentErrorResponse").error.code, "REVIEW_NOT_INVALIDATED");

    await reopenAfterDiskEdit(filePath, "alpha\nBETA\ngamma\n");

    const frozen = await httpRequest("GET", `/v1/reviews/${submitted.reviewId}`);
    assert.equal(frozen.status, 200, frozen.body);
    const frozenBody = parseAs(frozen.body, "ReviewDetailResponse");
    assert.equal(frozenBody.state, "invalidated");
    const chunks = await httpRequest("GET", `/v1/reviews/${submitted.reviewId}?view=chunks`);
    assert.equal(chunks.status, 200, chunks.body);
    assert.equal(parseAs(chunks.body, "ReviewChunksResponse").chunks.length, 1);

    const reapplied = await httpRequest("POST", `/v1/reviews/${submitted.reviewId}/reapply`, {
      body: JSON.stringify({
        expectedReviewGeneration: frozenBody.generation,
      }),
    });
    assert.equal(reapplied.status, 200, reapplied.body);
    const body = parseAs(reapplied.body, "ReapplyReviewResponse");
    assert.equal(body.unresolvedChunks, 1);
    assert.deepEqual(body.withdrawnChunkIds, []);
    assert.equal(body.state, "active");
  });

  it("retracts an older overlapping proposal through MCP", async function () {
    const filePath = path.join(scratch, "mcp-older-retraction.md");
    const documentId = await openInPane(filePath, "alpha\n");
    const first = await provider.submitProposal(
      documentId,
      sha256Text("alpha\n"),
      [
        {
          description: "capitalize alpha",
          patch: createPatch("document", "alpha\n", "ALPHA\n", "", "", { context: 0 }),
        },
      ],
      "mcp-older-first",
      0,
    );
    if (!first.ok) {
      assert.fail(`The first proposal was refused: ${first.code}`);
    }
    const second = await provider.submitProposal(
      documentId,
      sha256Text("ALPHA\n"),
      [
        {
          description: "insert a hyphen",
          patch: createPatch("document", "ALPHA\n", "AL-PHA\n", "", "", { context: 0 }),
        },
      ],
      "mcp-older-second",
      first.reviewGeneration,
    );
    if (!second.ok) {
      assert.fail(`The second proposal was refused: ${second.code}`);
    }

    const client = new Client({ name: "agent-http-api-spec", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`), {
        requestInit: { headers: AUTHORIZED },
      }),
    );
    const call = async <N extends keyof AgentApiSchemas & string>(
      name: string,
      args: Record<string, string | ReviewMutationPrecondition>,
      schemaName: N,
    ): Promise<{ isError: boolean; body: AgentApiSchemas[N] }> => {
      const result = await client.callTool({ name, arguments: args });
      const [content] = result.content as Array<{ type: "text"; text: string }>;
      return {
        isError: result.isError === true,
        body: parseAs(content.text, schemaName),
      };
    };
    try {
      const retracted = await call(
        "retractProposal",
        {
          packetId: first.packetIds[0],
          body: {
            expectedReviewGeneration: second.reviewGeneration,
            expectedWorkingSha256: sha256Text("AL-PHA\n"),
          },
        },
        "RetractProposalResponse",
      );
      assert.equal(retracted.isError, false, JSON.stringify(retracted.body));
      assert.equal(retracted.body.documentRevision.sha256, sha256Text("alpha-\n"));

      const current = await call(
        "getDocument",
        { documentId, includeContent: "true" },
        "ReadDocumentResponse",
      );
      assert.equal(current.isError, false, JSON.stringify(current.body));
      assert.equal(current.body.content, "alpha-\n");

      const review = await call(
        "getReview",
        { reviewId: second.reviewId, view: "chunks" },
        "ReviewChunksResponse",
      );
      assert.equal(review.isError, false, JSON.stringify(review.body));
      assert.equal(review.body.chunks.length, 1);
      assert.equal(review.body.chunks[0].workingText, "-");
      assert.deepEqual(review.body.chunks[0].descriptions, ["insert a hyphen"]);
    } finally {
      await client.close();
    }
  });

  it("retracts a proposal and discards a frozen review through MCP", async function () {
    const filePath = path.join(scratch, "mcp-recovery.md");
    const documentId = await openInPane(filePath, "alpha\nbeta\n");
    const capitalize = {
      description: "capitalize beta",
      patch: createPatch("document", "alpha\nbeta\n", "alpha\nBETA\n", "", "", {
        context: 0,
      }),
    };
    const first = await provider.submitProposal(
      documentId,
      sha256Text("alpha\nbeta\n"),
      [capitalize],
      "mcp-first",
      0,
    );
    if (!first.ok) {
      assert.fail(`The first proposal was refused: ${first.code}`);
    }
    const client = new Client({
      name: "agent-http-api-spec",
      version: "1.0.0",
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`), {
        requestInit: { headers: AUTHORIZED },
      }),
    );
    const call = async <N extends keyof AgentApiSchemas & string>(
      name: string,
      args: Record<string, string | ReviewMutationPrecondition | ReapplyReviewRequest>,
      schemaName: N,
    ): Promise<{ isError: boolean; body: AgentApiSchemas[N] }> => {
      const result = await client.callTool({ name, arguments: args });
      const [content] = result.content as Array<{ type: "text"; text: string }>;
      return {
        isError: result.isError === true,
        body: parseAs(content.text, schemaName),
      };
    };
    try {
      const retracted = await call(
        "retractProposal",
        {
          packetId: first.packetIds[0],
          body: {
            expectedReviewGeneration: first.reviewGeneration,
            expectedWorkingSha256: sha256Text("alpha\nBETA\n"),
          },
        },
        "RetractProposalResponse",
      );
      assert.equal(retracted.isError, false, JSON.stringify(retracted.body));

      const second = await provider.submitProposal(
        documentId,
        sha256Text("alpha\nbeta\n"),
        [capitalize],
        "mcp-second",
        retracted.body.reviewGeneration,
      );
      if (!second.ok) {
        assert.fail(`The second proposal was refused: ${second.code}`);
      }
      await reopenAfterDiskEdit(filePath, "alpha\nBETA\ngamma\n");
      const frozen = await call("getReview", { reviewId: second.reviewId }, "ReviewDetailResponse");
      assert.equal(frozen.body.state, "invalidated");

      const refused = await call(
        "retractProposal",
        {
          packetId: second.packetIds[0],
          body: {
            expectedReviewGeneration: frozen.body.generation,
            expectedWorkingSha256: sha256Text("alpha\nBETA\ngamma\n"),
          },
        },
        "AgentErrorResponse",
      );
      assert.equal(refused.isError, true);
      assert.equal(refused.body.error.code, "REVIEW_INVALIDATED");

      const discarded = await call(
        "discardReview",
        {
          reviewId: second.reviewId,
          body: { expectedReviewGeneration: frozen.body.generation },
        },
        "DiscardReviewResponse",
      );
      assert.equal(discarded.isError, false, JSON.stringify(discarded.body));
      const gone = await call("getReview", { reviewId: second.reviewId }, "AgentErrorResponse");
      assert.equal(gone.body.error.code, "REVIEW_NOT_FOUND");
      assert.equal(readFileSync(filePath, "utf8"), "alpha\nBETA\ngamma\n");
    } finally {
      await client.close();
    }
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

    const documents = parseAs(
      (await httpRequest("GET", "/v1/documents")).body,
      "DocumentListResponse",
    );
    assert.equal(
      documents.documents.some((document) => document.path === filePath),
      false,
    );
    const content = await httpRequest(
      "GET",
      `/v1/workspaces?workspaceId=${encodeURIComponent(scratch)}&include=files`,
    );
    assert.equal(content.status, 200);
    const files = parseAs(content.body, "WorkspaceFilesResponse");
    const file = files.files.find((entry) => entry.path === filePath);
    assert.ok(file !== undefined);
    assert.equal(file.open, false);
  });

  it("GET /v1/workspaces?include=files names each Markdown file by its shortest unique wikilink", async function () {
    const relativePaths = ["programs/cusp-chain.md", "a/moduli.md", "b/moduli.md"];
    for (const relative of relativePaths) {
      mkdirSync(path.dirname(path.join(scratch, relative)), {
        recursive: true,
      });
      writeFileSync(path.join(scratch, relative), "# Note\n", "utf8");
    }
    links.index = new WikilinkIndex(
      relativePaths.map((relative) => ({
        path: path.join(scratch, relative),
        root: scratch,
        id: "",
        title: undefined,
        aliases: [],
      })),
    );
    try {
      const response = await httpRequest(
        "GET",
        `/v1/workspaces?workspaceId=${encodeURIComponent(scratch)}&include=files`,
      );
      assert.equal(response.status, 200);
      const body = parseAs(response.body, "WorkspaceFilesResponse");
      const linkTargets = Object.fromEntries(
        body.files
          .filter((entry) => entry.linkTarget !== undefined)
          .map((entry) => [path.relative(scratch, entry.path), entry.linkTarget]),
      );
      assert.deepEqual(linkTargets, {
        "programs/cusp-chain.md": "cusp-chain",
        "a/moduli.md": "a/moduli",
        "b/moduli.md": "b/moduli",
      });
    } finally {
      links.index = new WikilinkIndex([]);
    }
  });

  it("GET /v1/workspaces?include=directories lists every folder recursively", async function () {
    mkdirSync(path.join(scratch, "books", "volumes", "one"), {
      recursive: true,
    });
    mkdirSync(path.join(scratch, "notes"), { recursive: true });
    writeFileSync(path.join(scratch, "notes", "a.md"), "# A\n", "utf8");

    const response = await httpRequest(
      "GET",
      `/v1/workspaces?workspaceId=${encodeURIComponent(scratch)}&include=directories`,
    );
    assert.equal(response.status, 200, response.body);
    const body = parseAs(response.body, "WorkspaceDirectoriesResponse");
    assert.equal(body.workspaceId, scratch);
    const byRelative = body.directories.map((entry) => path.relative(scratch, entry.path)).sort();
    assert.deepEqual(byRelative, ["books", "books/volumes", "books/volumes/one", "notes"]);

    const nested = body.directories.find(
      (entry) => path.relative(scratch, entry.path) === "books/volumes",
    );
    assert.ok(nested !== undefined);
    assert.equal(nested.name, "volumes");
    assert.equal(nested.workspaceId, scratch);
    assert.equal(nested.parent, path.join(scratch, "books"));

    const unknown = await httpRequest(
      "GET",
      `/v1/workspaces?workspaceId=${encodeURIComponent(path.join(scratch, "nope"))}&include=directories`,
    );
    assert.equal(unknown.status, 404);
    assert.equal(parseAs(unknown.body, "AgentErrorResponse").error.code, "WORKSPACE_NOT_FOUND");

    const missingWorkspace = await httpRequest("GET", "/v1/workspaces?include=directories");
    assert.equal(missingWorkspace.status, 400);
    assert.equal(parseAs(missingWorkspace.body, "AgentErrorResponse").error.code, "INVALID_PARAMS");
  });

  it("creates files and folders inside a workspace and refuses a duplicate or a traversal", async function () {
    mkdirSync(path.join(scratch, "notes"), { recursive: true });

    // Relative path with an explicit workspaceId.
    const file = await httpRequest("POST", "/v1/workspace/entries", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: scratch,
        path: "notes/new.md",
        kind: "file",
        content: "# New\n",
      }),
    });
    assert.equal(file.status, 201, file.body);
    const created = parseAs(file.body, "WorkspaceEntryResponse");
    assert.equal(created.kind, "file");
    assert.equal(created.path, path.join(scratch, "notes", "new.md"));
    assert.equal(created.workspaceId, scratch);
    assert.equal(readFileSync(path.join(scratch, "notes", "new.md"), "utf8"), "# New\n");

    // Absolute path with a folder kind.
    const folder = await httpRequest("POST", "/v1/workspace/entries", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: path.join(scratch, "notes", "projects"),
        kind: "folder",
      }),
    });
    assert.equal(folder.status, 201, folder.body);
    assert.equal(statSync(path.join(scratch, "notes", "projects")).isDirectory(), true);

    // A second create at the same path is a conflict, never a silent replace.
    const duplicate = await httpRequest("POST", "/v1/workspace/entries", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: scratch,
        path: "notes/new.md",
        kind: "file",
        content: "x",
      }),
    });
    assert.equal(duplicate.status, 409, duplicate.body);
    assert.equal(
      parseAs(duplicate.body, "AgentErrorResponse").error.code,
      "WORKSPACE_ENTRY_EXISTS",
    );
    assert.equal(readFileSync(path.join(scratch, "notes", "new.md"), "utf8"), "# New\n");

    // `..` escapes are refused, not followed.
    const escape = await httpRequest("POST", "/v1/workspace/entries", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: scratch,
        path: "notes/../../outside.md",
        kind: "file",
        content: "x",
      }),
    });
    assert.equal(escape.status, 403, escape.body);
    assert.equal(parseAs(escape.body, "AgentErrorResponse").error.code, "WORKSPACE_OUTSIDE_SCOPE");
    assert.equal(existsSync(path.join(path.dirname(scratch), "outside.md")), false);

    // An absolute target outside every workspace is refused too.
    const outside = await httpRequest("POST", "/v1/workspace/entries", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: path.join(authoringHome, "elsewhere.md"),
        kind: "file",
        content: "x",
      }),
    });
    assert.equal(outside.status, 403, outside.body);
    assert.equal(parseAs(outside.body, "AgentErrorResponse").error.code, "WORKSPACE_OUTSIDE_SCOPE");
    assert.equal(existsSync(path.join(authoringHome, "elsewhere.md")), false);

    // A missing destination folder and a file without content are both 400.
    const missingParent = await httpRequest("POST", "/v1/workspace/entries", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: scratch,
        path: "absent/child.md",
        kind: "file",
        content: "x",
      }),
    });
    assert.equal(missingParent.status, 400, missingParent.body);
    assert.equal(parseAs(missingParent.body, "AgentErrorResponse").error.code, "INVALID_PARAMS");

    const noContent = await httpRequest("POST", "/v1/workspace/entries", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: scratch,
        path: "notes/empty.md",
        kind: "file",
      }),
    });
    assert.equal(noContent.status, 400, noContent.body);
    assert.equal(parseAs(noContent.body, "AgentErrorResponse").error.code, "INVALID_PARAMS");
    assert.equal(existsSync(path.join(scratch, "notes", "empty.md")), false);

    // The created entries are visible through the directory listing.
    const listing = parseAs(
      (
        await httpRequest(
          "GET",
          `/v1/workspaces?workspaceId=${encodeURIComponent(scratch)}&include=directories`,
        )
      ).body,
      "WorkspaceDirectoriesResponse",
    );
    assert.ok(
      listing.directories.some(
        (entry) => path.relative(scratch, entry.path) === path.join("notes", "projects"),
      ),
    );
  });

  it("answers PERSISTENCE_FAILED with the cause when the folder refuses a new entry (#210)", async function () {
    const locked = path.join(scratch, "locked-folder");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o555);
    const refused = await Promise.all(
      [
        { kind: "file", path: "locked-folder/new.md", content: "# New\n" },
        { kind: "folder", path: "locked-folder/sub" },
      ].map((entry) =>
        httpRequest("POST", "/v1/workspace/entries", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: scratch, ...entry }),
        }),
      ),
    );
    chmodSync(locked, 0o755);
    for (const response of refused) {
      assert.equal(response.status, 500, response.body);
      assert.equal(parseAs(response.body, "AgentErrorResponse").error.code, "PERSISTENCE_FAILED");
    }
    assert.equal(existsSync(path.join(locked, "new.md")), false);
    assert.equal(existsSync(path.join(locked, "sub")), false);
  });

  it("exposes the complete canonical macro inventory with source and MathJax metadata", async function () {
    const response = await httpRequest("GET", "/v1/macros");
    assert.equal(response.status, 200, response.body);
    const payload = parseAs(response.body, "MacroInventoryResponse");
    assert.equal(payload.root, path.join(authoringHome, ".pandoc", "styles", "macros"));

    const zz = payload.macros.find((macro) => macro.name === "\\ZZ");
    assert.ok(zz !== undefined);
    assert.ok(zz.mathjax !== undefined);
    assert.equal(zz.mathjax.replacement, "\\mathbb{Z}");
    assert.equal(zz.declarations[0].sourcePath, "tier1.tex");
    assert.match(zz.declarations[0].context, /newcommand\{\\ZZ\}/u);

    const compilerOnly = payload.macros.find((macro) => macro.name === "\\CompilerOnly");
    assert.ok(compilerOnly !== undefined);
    assert.equal(compilerOnly.mathjax, undefined);
    assert.equal(compilerOnly.declarations[0].sourcePath, "nested/compiler.tex");

    const filtered = await httpRequest("GET", "/v1/macros?query=compileronly");
    assert.equal(filtered.status, 200, filtered.body);
    const filteredPayload = parseAs(filtered.body, "MacroInventoryResponse");
    assert.deepEqual(
      filteredPayload.macros.map((macro) => macro.name),
      ["\\CompilerOnly"],
    );
  });

  it("names the macro sources that it cannot read, and a projection that it cannot use (#210)", async function () {
    const macroRoot = path.join(authoringHome, ".pandoc", "styles", "macros");
    const lockedFolder = path.join(macroRoot, "nested");
    const lockedFile = path.join(macroRoot, "tier2.tex");
    writeFileSync(lockedFile, "\\newcommand{\\QQ}{\\mathbb{Q}}\n");
    chmodSync(lockedFolder, 0o000);
    chmodSync(lockedFile, 0o000);
    const partial = await httpRequest("GET", "/v1/macros");
    chmodSync(lockedFolder, 0o755);
    chmodSync(lockedFile, 0o644);
    assert.equal(partial.status, 200, partial.body);
    const payload = parseAs(partial.body, "MacroInventoryResponse");
    assert.deepEqual(
      payload.macros.map((macro) => macro.name),
      ["\\Spec", "\\ZZ"],
    );
    assert.deepEqual(
      payload.notRead.map((entry) => entry.path),
      ["tier2.tex", "nested"],
    );

    chmodSync(macroRoot, 0o000);
    const unreadableRoot = await httpRequest("GET", "/v1/macros");
    chmodSync(macroRoot, 0o755);
    assert.equal(unreadableRoot.status, 503, unreadableRoot.body);
    assert.equal(
      parseAs(unreadableRoot.body, "AgentErrorResponse").error.code,
      "MACROS_UNAVAILABLE",
    );

    writeFileSync(
      path.join(authoringHome, ".pandoc", "templates", "css", "mathjax-macros.json"),
      '{"ZZ": ',
    );
    const malformed = await httpRequest("GET", "/v1/macros");
    assert.equal(malformed.status, 503, malformed.body);
    assert.equal(parseAs(malformed.body, "AgentErrorResponse").error.code, "MACROS_UNAVAILABLE");
  });

  it("lists only the configured skills subtree and reads any Markdown file through getHelp", async function () {
    const listed = await httpRequest("GET", "/help?resource=skills&action=list");
    assert.equal(listed.status, 200, listed.body);
    const listPayload = parseAs(listed.body, "SkillsListResponse");
    assert.equal(listPayload.root, skillsRoot);
    assert.deepEqual(
      listPayload.entries.map((entry) => [entry.path, entry.kind]),
      [
        ["proofs", "directory"],
        ["SKILL.md", "markdown"],
        ["proofs/nested", "directory"],
        ["proofs/proof-style.md", "markdown"],
        ["proofs/nested/notes.md", "markdown"],
      ],
    );
    assert.equal(
      listPayload.entries.some((entry) => entry.path === "proofs/ignore.txt"),
      false,
    );
    assert.equal(
      listPayload.entries.some((entry) => entry.path === "proofs/outside.md"),
      false,
    );

    const read = await httpRequest(
      "GET",
      "/help?resource=skills&action=read&path=proofs%2Fproof-style.md",
    );
    assert.equal(read.status, 200, read.body);
    const readPayload = parseAs(read.body, "SkillFileResponse");
    assert.equal(readPayload.root, skillsRoot);
    assert.equal(readPayload.path, "proofs/proof-style.md");
    assert.equal(readPayload.content, "# Proof style\n\nPrefer diagrams to prose.\n");
  });

  it("confines skills reads to Markdown files physically below the configured root", async function () {
    const traversal = await httpRequest(
      "GET",
      "/help?resource=skills&action=read&path=..%2Foutside.md",
    );
    assert.equal(traversal.status, 400, traversal.body);
    assert.equal(parseAs(traversal.body, "AgentErrorResponse").error.code, "INVALID_PARAMS");

    const nonMarkdown = await httpRequest(
      "GET",
      "/help?resource=skills&action=read&path=proofs%2Fignore.txt",
    );
    assert.equal(nonMarkdown.status, 400, nonMarkdown.body);
    assert.equal(parseAs(nonMarkdown.body, "AgentErrorResponse").error.code, "INVALID_PARAMS");

    const symlink = await httpRequest(
      "GET",
      "/help?resource=skills&action=read&path=proofs%2Foutside.md",
    );
    assert.equal(symlink.status, 400, symlink.body);
    assert.equal(parseAs(symlink.body, "AgentErrorResponse").error.code, "INVALID_PARAMS");

    writeFileSync(path.join(skillsRoot, "proofs", "latin1.md"), Buffer.from([0x23, 0x20, 0xe9]));
    const invalidUtf8 = await httpRequest(
      "GET",
      "/help?resource=skills&action=read&path=proofs%2Flatin1.md",
    );
    assert.equal(invalidUtf8.status, 400, invalidUtf8.body);
    assert.equal(parseAs(invalidUtf8.body, "AgentErrorResponse").error.code, "INVALID_PARAMS");

    const missing = await httpRequest("GET", "/help?resource=skills&action=read&path=missing.md");
    assert.equal(missing.status, 404, missing.body);
    assert.equal(parseAs(missing.body, "AgentErrorResponse").error.code, "SKILL_NOT_FOUND");

    configuredSkillsDirectory = null;
    const disabled = await httpRequest("GET", "/help?resource=skills&action=list");
    assert.equal(disabled.status, 503, disabled.body);
    assert.equal(parseAs(disabled.body, "AgentErrorResponse").error.code, "SKILLS_NOT_CONFIGURED");
  });

  it("names a skill or a figure that the filesystem refuses to read (#210)", async function () {
    const lockedFolder = path.join(skillsRoot, "proofs", "nested");
    const lockedSkill = path.join(skillsRoot, "proofs", "proof-style.md");
    const lockedFigure = path.join(figuresRoot, "diagrams", "main.tikz");
    chmodSync(lockedFolder, 0o000);
    chmodSync(lockedSkill, 0o000);
    chmodSync(lockedFigure, 0o000);
    const [listed, skillInFolder, skill, figure] = await Promise.all([
      httpRequest("GET", "/help?resource=skills&action=list"),
      httpRequest("GET", "/help?resource=skills&action=read&path=proofs%2Fnested%2Fnotes.md"),
      httpRequest("GET", "/help?resource=skills&action=read&path=proofs%2Fproof-style.md"),
      httpRequest("GET", "/v1/figures?action=read&path=diagrams%2Fmain.tikz"),
    ]);
    chmodSync(lockedFolder, 0o755);
    chmodSync(lockedSkill, 0o644);
    chmodSync(lockedFigure, 0o644);

    assert.equal(listed.status, 200, listed.body);
    const listPayload = parseAs(listed.body, "SkillsListResponse");
    assert.deepEqual(
      listPayload.entries.map((entry) => entry.path),
      ["proofs", "SKILL.md", "proofs/nested", "proofs/proof-style.md"],
    );
    assert.deepEqual(
      listPayload.notListed.map((entry) => entry.path),
      ["proofs/nested"],
    );
    for (const response of [skillInFolder, skill, figure]) {
      assert.equal(response.status, 409, response.body);
      assert.equal(parseAs(response.body, "AgentErrorResponse").error.code, "FILE_UNREADABLE");
    }
  });

  it("lists and reads text and binary files from the configured centralized figures directory", async function () {
    const listed = await httpRequest("GET", "/v1/figures");
    assert.equal(listed.status, 200, listed.body);
    const listPayload = parseAs(listed.body, "FigureListResponse");
    assert.equal(listPayload.root, figuresRoot);
    assert.ok(listPayload.entries.some((entry) => entry.path === "diagrams/main.tikz"));
    assert.ok(listPayload.entries.some((entry) => entry.path === "images/pixel.bin"));

    const text = await httpRequest("GET", "/v1/figures?action=read&path=diagrams%2Fmain.tikz");
    assert.equal(text.status, 200, text.body);
    const textPayload = parseAs(text.body, "FigureFileResponse");
    assert.equal(textPayload.encoding, "utf8");
    assert.match(textPayload.content, /elliptic surface/u);

    const binary = await httpRequest("GET", "/v1/figures?action=read&path=images%2Fpixel.bin");
    assert.equal(binary.status, 200, binary.body);
    const binaryPayload = parseAs(binary.body, "FigureFileResponse");
    assert.equal(binaryPayload.encoding, "base64");
    assert.equal(binaryPayload.content, Buffer.from([0, 255, 1, 254]).toString("base64"));
  });

  it("atomically writes nested UTF-8 and binary figure files through the API", async function () {
    const source = "\\begin{tikzpicture}\n\\node {new figure};\n\\end{tikzpicture}\n";
    const written = await httpRequest("POST", "/v1/figures", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "write",
        path: "new/nested/figure.tikz",
        content: source,
        encoding: "utf8",
      }),
    });
    assert.equal(written.status, 200, written.body);
    parseAs(written.body, "FigureFileResponse");
    assert.equal(
      readFileSync(path.join(figuresRoot, "new", "nested", "figure.tikz"), "utf8"),
      source,
    );

    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const binary = await httpRequest("POST", "/v1/figures", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "write",
        path: "images/generated.bin",
        content: bytes.toString("base64"),
        encoding: "base64",
      }),
    });
    assert.equal(binary.status, 200, binary.body);
    assert.deepEqual(readFileSync(path.join(figuresRoot, "images", "generated.bin")), bytes);
  });

  it("creates only new lowercase .tikz figure source files", async function () {
    const source = "\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}\n";
    const created = await httpRequest("POST", "/v1/figures", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "generated/nested/new-figure.tikz",
        content: source,
      }),
    });
    assert.equal(created.status, 201, created.body);
    const payload = parseAs(created.body, "FigureFileResponse");
    assert.equal(payload.path, "generated/nested/new-figure.tikz");
    assert.equal(payload.encoding, "utf8");
    assert.equal(payload.content, source);
    assert.equal(
      readFileSync(path.join(figuresRoot, "generated", "nested", "new-figure.tikz"), "utf8"),
      source,
    );

    for (const invalidPath of [
      "generated/not-tikz.tikzcd",
      "generated/not-tikz.tex",
      "generated/UPPER.TIKZ",
    ]) {
      const invalid = await httpRequest("POST", "/v1/figures", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: invalidPath, content: source }),
      });
      assert.equal(invalid.status, 400, `${invalidPath}: ${invalid.body}`);
      assert.equal(parseAs(invalid.body, "AgentErrorResponse").error.code, "INVALID_PARAMS");
      assert.equal(existsSync(path.join(figuresRoot, invalidPath)), false);
    }

    const replacement = "\\begin{tikzpicture}\n\\node {replacement};\n\\end{tikzpicture}\n";
    const collision = await httpRequest("POST", "/v1/figures", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "generated/nested/new-figure.tikz",
        content: replacement,
      }),
    });
    assert.equal(collision.status, 409, collision.body);
    assert.equal(parseAs(collision.body, "AgentErrorResponse").error.code, "FIGURE_ALREADY_EXISTS");
    assert.equal(
      readFileSync(path.join(figuresRoot, "generated", "nested", "new-figure.tikz"), "utf8"),
      source,
      "createFigure must never replace an existing figure",
    );
  });

  it("searches figure paths and text contents while refusing traversal outside the configured root", async function () {
    const searched = await httpRequest("GET", "/v1/figures?action=search&query=elliptic");
    assert.equal(searched.status, 200, searched.body);
    const searchPayload = parseAs(searched.body, "FigureSearchResponse");
    assert.ok(
      searchPayload.hits.some(
        (hit) => hit.path === "diagrams/main.tikz" && hit.matchType === "content" && hit.line === 2,
      ),
    );

    const pathSearch = await httpRequest("GET", "/v1/figures?action=search&query=pixel.bin");
    assert.equal(pathSearch.status, 200, pathSearch.body);
    const pathSearchPayload = parseAs(pathSearch.body, "FigureSearchResponse");
    assert.ok(
      pathSearchPayload.hits.some(
        (hit) => hit.path === "images/pixel.bin" && hit.matchType === "path",
      ),
    );

    const traversal = await httpRequest("GET", "/v1/figures?action=read&path=..%2Fescape.tikz");
    assert.equal(traversal.status, 400, traversal.body);
    assert.equal(parseAs(traversal.body, "AgentErrorResponse").error.code, "INVALID_PARAMS");

    const missing = await httpRequest("GET", "/v1/figures?action=read&path=missing.tikz");
    assert.equal(missing.status, 404, missing.body);
    assert.equal(parseAs(missing.body, "AgentErrorResponse").error.code, "FIGURE_NOT_FOUND");
  });

  it("lints focused, open, document, workspace, and all-workspace scopes over authoritative text", async function () {
    const focusedPath = path.join(scratch, "lint-focused.md");
    const otherOpenPath = path.join(scratch, "lint-open.md");
    const closedPath = path.join(scratch, "lint-closed.md");
    const focusedId = await openFile(focusedPath, "$\\DefinitelyMissing$\n\nTODO\n");
    await openFile(otherOpenPath, "A clean open document.\n");
    writeFileSync(closedPath, "???\n", "utf8");

    const windowId = provider.windowKeys()[0];
    const leafId = provider.leafIds(windowId)[0];
    assert.ok(leafId !== undefined);
    assert.equal(await provider.openFile(windowId, leafId, focusedPath), true);

    const focused = await httpRequest("GET", "/v1/lint");
    assert.equal(focused.status, 200, focused.body);
    const focusedPayload = parseAs(focused.body, "LintResponse");
    assert.equal(focusedPayload.scope, "focused");
    assert.deepEqual(
      focusedPayload.documents.map((document) => document.documentId),
      [focusedId],
    );
    assert.ok(
      focusedPayload.documents[0].diagnostics.some(
        (diagnostic) =>
          diagnostic.rule === "tex/unknown-command" &&
          diagnostic.data?.command === "\\DefinitelyMissing",
      ),
      focused.body,
    );
    assert.ok(focusedPayload.documents[0].diagnostics.some((diagnostic) => diagnostic.line >= 1));

    const open = await httpRequest("GET", "/v1/lint?scope=open");
    assert.equal(open.status, 200, open.body);
    const openPayload = parseAs(open.body, "LintResponse");
    assert.ok(openPayload.documents.some((document) => document.path === focusedPath));
    assert.ok(openPayload.documents.some((document) => document.path === otherOpenPath));

    const workspaceFiles = parseAs(
      (
        await httpRequest(
          "GET",
          `/v1/workspaces?workspaceId=${encodeURIComponent(scratch)}&include=files`,
        )
      ).body,
      "WorkspaceFilesResponse",
    );
    const closedId = workspaceFiles.files.find((file) => file.path === closedPath)?.documentId;
    assert.ok(closedId !== undefined);

    const document = await httpRequest(
      "GET",
      `/v1/lint?scope=document&documentId=${encodeURIComponent(closedId)}`,
    );
    assert.equal(document.status, 200, document.body);
    const documentPayload = parseAs(document.body, "LintResponse");
    assert.equal(documentPayload.documents.length, 1);
    assert.equal(documentPayload.documents[0].path, closedPath);
    assert.equal(documentPayload.documents[0].open, false);
    assert.ok(
      documentPayload.documents[0].diagnostics.some(
        (diagnostic) =>
          diagnostic.rule === "document/authorial-residue" && diagnostic.data?.marker === "???",
      ),
    );

    const workspace = await httpRequest(
      "GET",
      `/v1/lint?scope=workspace&workspaceId=${encodeURIComponent(scratch)}`,
    );
    assert.equal(workspace.status, 200, workspace.body);
    const workspacePayload = parseAs(workspace.body, "LintResponse");
    // Every document was linted above, so the workspace reads them all from the cache.
    assert.deepEqual(workspacePayload.pending, []);
    assert.deepEqual(workspacePayload.failed, []);
    assert.equal(workspacePayload.queueStopped, undefined);
    assert.deepEqual(
      new Set(workspacePayload.documents.map((item) => item.path)),
      new Set([focusedPath, otherOpenPath, closedPath]),
    );
    assert.ok(workspacePayload.documents.every((item) => item.current));

    const all = await httpRequest("GET", "/v1/lint?scope=all");
    assert.equal(all.status, 200, all.body);
    const allPayload = parseAs(all.body, "LintResponse");
    assert.deepEqual(
      new Set([...allPayload.documents, ...allPayload.pending].map((item) => item.path)),
      new Set(workspacePayload.documents.map((item) => item.path)),
    );

    const warningsOnly = await httpRequest(
      "GET",
      `/v1/lint?scope=document&documentId=${encodeURIComponent(focusedId)}&minimumSeverity=warning`,
    );
    assert.equal(warningsOnly.status, 200, warningsOnly.body);
    const warningsPayload = parseAs(warningsOnly.body, "LintResponse");
    assert.ok(warningsPayload.documents[0].diagnostics.length > 0);
    assert.ok(
      warningsPayload.documents[0].diagnostics.every(
        (diagnostic) => diagnostic.severity !== "info",
      ),
    );
  });

  it("names each workspace document that Flowmark could not lint, with the kind of the failure", async function () {
    const unlintedPath = path.join(scratch, "lint-unlinted.md");
    writeFileSync(unlintedPath, "???\n", "utf8");
    // No Flowmark process ends in this time.
    flowmarkTimeoutMs = 1;
    const route = `/v1/lint?scope=workspace&workspaceId=${encodeURIComponent(scratch)}`;

    // The first request puts the document into the queue of the linter.
    const queued = await httpRequest("GET", route);
    assert.equal(queued.status, 200, queued.body);
    const deadline = Date.now() + 60_000;
    while (lintDrains === 0) {
      assert.ok(Date.now() < deadline, "the run of the document did not end");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const workspaceFiles = parseAs(
      (
        await httpRequest(
          "GET",
          `/v1/workspaces?workspaceId=${encodeURIComponent(scratch)}&include=files`,
        )
      ).body,
      "WorkspaceFilesResponse",
    );
    const answered = await httpRequest("GET", route);
    assert.equal(answered.status, 200, answered.body);
    const payload = parseAs(answered.body, "LintResponse");
    assert.deepEqual(payload.pending, [], "a document whose run ended is not awaited");
    assert.deepEqual(payload.documents, [], "a failed run is no result of the document");
    assert.deepEqual(
      payload.failed.map((item) => ({
        documentId: item.documentId,
        path: item.path,
        name: item.name,
        kind: item.kind,
      })),
      [
        {
          documentId: workspaceFiles.files.find((file) => file.path === unlintedPath)?.documentId,
          path: unlintedPath,
          name: "lint-unlinted.md",
          kind: "flowmark-timeout",
        },
      ],
      answered.body,
    );
    assert.equal(payload.queueStopped, undefined, "the queue runs");
  });

  it("names a workspace document whose file cannot be read, and answers for the other documents", async function () {
    const readablePath = path.join(scratch, "lint-readable.md");
    const unreadablePath = path.join(scratch, "lint-unreadable.md");
    writeFileSync(readablePath, "# Lattices\n", "utf8");
    writeFileSync(unreadablePath, "# Genera\n", "utf8");
    chmodSync(unreadablePath, 0o000);
    const route = `/v1/lint?scope=workspace&workspaceId=${encodeURIComponent(scratch)}`;

    const answered = await httpRequest("GET", route);
    assert.equal(answered.status, 200, answered.body);
    const payload = parseAs(answered.body, "LintResponse");
    assert.deepEqual(
      payload.failed.map((item) => ({ path: item.path, name: item.name, kind: item.kind })),
      [{ path: unreadablePath, name: "lint-unreadable.md", kind: "unreadable" }],
      answered.body,
    );
    assert.deepEqual(
      [...payload.documents, ...payload.pending].map((item) => item.path),
      [readablePath],
      "the document that can be read is linted or awaited",
    );
  });

  it("validates lint scope parameters instead of silently broadening the requested scope", async function () {
    const missingDocument = await httpRequest("GET", "/v1/lint?scope=document");
    assert.equal(missingDocument.status, 400, missingDocument.body);
    const missingWorkspace = await httpRequest("GET", "/v1/lint?scope=workspace");
    assert.equal(missingWorkspace.status, 400, missingWorkspace.body);
    const unknownWorkspace = await httpRequest(
      "GET",
      `/v1/lint?scope=workspace&workspaceId=${encodeURIComponent(path.join(scratch, "missing"))}`,
    );
    assert.equal(unknownWorkspace.status, 404, unknownWorkspace.body);
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
              export: { cslLibrary: "" },
              tikz: { dataDir: "", figuresDir: "" },
              editor: { lint: { flowmark: { timeoutMs: 60_000 } } },
              agentApi: {
                enabled: true,
                port: lifecyclePort,
                skillsDirectory: null,
              },
            }),
          },
          search: createSearch(),
          documentLint,
          links,
        },
        { homeDirectory: authoringHome, env: TOKEN_ENVIRONMENT },
        undefined,
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
      `Authorization: Bearer ${API_TOKEN}\r\n` +
      "Content-Type: application/json\r\n" +
      "Content-Length: 64\r\n" +
      "\r\n" +
      '{"clientRequestId": "sta';

    it("answers a stalled body with 408 REQUEST_BODY_TIMEOUT and closes the socket", async function () {
      const socket = await connect();
      socket.write(STALLED_REQUEST);
      const response = await readUntilClose(socket);
      assert.match(response, /^HTTP\/1\.1 408 /);
      const body = parseAs(response.slice(response.indexOf("\r\n\r\n") + 4), "AgentErrorResponse");
      assert.equal(body.error.code, "REQUEST_BODY_TIMEOUT");
    });

    it("answers an oversized body with structured 413 and logs the refusal", async function () {
      const logBoundary = await markLogBoundary();
      const body = JSON.stringify({
        clientRequestId: "x".repeat(25 * 1024 * 1024),
      });
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
              ...AUTHORIZED,
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
      assert.equal(parseAs(response.body, "AgentErrorResponse").error.code, "REQUEST_TOO_LARGE");

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
      check.write(
        `GET /v1/ping HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${API_TOKEN}\r\nConnection: close\r\n\r\n`,
      );
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
      parseAs(health.body, "PingResponse");

      const views = await httpRequest("GET", "/v1/views");
      assert.equal(views.status, 200);
      parseAs(views.body, "ViewsResponse");

      const workspaces = await httpRequest("GET", "/v1/workspaces");
      assert.equal(workspaces.status, 200);
      parseAs(workspaces.body, "WorkspacesResponse");
    });

    it("supports consolidated operations with query options", async function () {
      const workspacesSummary = await httpRequest("GET", "/v1/workspaces?include=summary");
      assert.equal(workspacesSummary.status, 200);
      parseAs(workspacesSummary.body, "WorkspacesResponse");

      const figuresList = await httpRequest("GET", "/v1/figures?action=list");
      assert.equal(figuresList.status, 200);
      parseAs(figuresList.body, "FigureListResponse");
    });
  });
});
