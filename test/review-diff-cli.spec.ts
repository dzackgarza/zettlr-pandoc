/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        review-diff CLI submission boundary
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     Issue #34 requires that an external process can submit a
 *                  review proposition through a small documented CLI. This
 *                  drives the shipped script as a separate OS process against
 *                  a real DocumentManager and AgentHTTPProvider. Refusals are
 *                  proved by process status plus unchanged API state; success
 *                  is proved by the focused live document and complete review
 *                  chunk state exposed by the running API.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { spawn, type ChildProcess } from "child_process";
import { createPatch } from "diff";
import { once } from "events";
import { writeFileSync } from "fs";
import http from "http";
import path from "path";

interface ServerReady {
  port: number;
  docPath: string;
  scratch: string;
}

interface ContentBody {
  content: string;
  snapshot: string;
  revision: { version: number; sha256: string };
}

interface ReviewListEntry {
  reviewId: string;
  documentPath: string;
  unresolvedChunks: number;
}

interface ReviewChunk {
  workingText: string;
  descriptions: string[];
  state: string;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface CliFailure {
  code: string;
  status?: number;
}

const TOKEN_ENVIRONMENT_VARIABLE = "ZETTLR_REVIEW_DIFF_TEST_TOKEN";
const TOKEN = "review-diff-test-secret";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${field} must be an object`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    assert.fail(`${field} must be a string`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    assert.fail(`${field} must be an integer`);
  }
  return value;
}

function requiredArray(value: unknown, field: string): unknown[] {
  assert.ok(Array.isArray(value), `${field} must be an array`);
  return value;
}

function parseObject(text: string, boundary: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  return requiredRecord(parsed, boundary);
}

function parseReady(message: unknown): ServerReady {
  const ready = requiredRecord(message, "server readiness event");
  assert.equal(ready.event, "e2e-server-ready");
  return {
    port: requiredInteger(ready.port, "server readiness port"),
    docPath: requiredString(ready.docPath, "server readiness document path"),
    scratch: requiredString(ready.scratch, "server readiness scratch path"),
  };
}

function parseContent(text: string): ContentBody {
  const body = parseObject(text, "document content response");
  const revision = requiredRecord(body.revision, "document revision");
  return {
    content: requiredString(body.content, "document content"),
    snapshot: requiredString(body.snapshot, "document snapshot"),
    revision: {
      version: requiredInteger(revision.version, "document revision version"),
      sha256: requiredString(revision.sha256, "document revision SHA-256"),
    },
  };
}

function parseReviewList(text: string): ReviewListEntry[] {
  const body = parseObject(text, "review list response");
  return requiredArray(body.reviews, "review list").map((entry, index) => {
    const review = requiredRecord(entry, `review ${index}`);
    return {
      reviewId: requiredString(review.reviewId, `review ${index} id`),
      documentPath: requiredString(
        review.documentPath,
        `review ${index} document path`,
      ),
      unresolvedChunks: requiredInteger(
        review.unresolvedChunks,
        `review ${index} unresolved chunks`,
      ),
    };
  });
}

function parseChunks(text: string): ReviewChunk[] {
  const body = parseObject(text, "review chunks response");
  return requiredArray(body.chunks, "review chunks").map((entry, index) => {
    const chunk = requiredRecord(entry, `review chunk ${index}`);
    return {
      workingText: requiredString(
        chunk.workingText,
        `review chunk ${index} working text`,
      ),
      descriptions: requiredArray(
        chunk.descriptions,
        `review chunk ${index} descriptions`,
      ).map((description, descriptionIndex) =>
        requiredString(
          description,
          `review chunk ${index} description ${descriptionIndex}`,
        ),
      ),
      state: requiredString(chunk.state, `review chunk ${index} state`),
    };
  });
}

function parseCliFailure(result: CliResult): CliFailure {
  assert.notEqual(result.code, 0, "the CLI must return a refusal status");
  const body = parseObject(result.stderr, "CLI refusal");
  assert.equal(body.ok, false);
  const error = requiredRecord(body.error, "CLI refusal error");
  const status = error.status;
  const parsedStatus =
    status === undefined
      ? undefined
      : requiredInteger(status, "CLI refusal HTTP status");
  return {
    code: requiredString(error.code, "CLI refusal code"),
    ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
  };
}

/**
 * The token a developer's shell may carry would make the spawned server demand
 * authentication the spawned CLI is not being asked to prove here.
 */
function reviewDiffEnvironment(): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  delete inherited.ZETTLR_AGENT_API_TOKEN;
  inherited[TOKEN_ENVIRONMENT_VARIABLE] = TOKEN;
  return inherited;
}

describe("review-diff CLI submission boundary", function () {
  this.timeout(60000);

  const repositoryRoot = path.join(__dirname, "..");
  const cliPath = path.join(
    repositoryRoot,
    "scripts",
    "desktop",
    "zettlr-pandoc-review-diff",
  );

  let child: ChildProcess | undefined;
  let httpPort: number;
  let docPath: string;
  let scratch: string;
  let serverStdout = "";
  let serverStderr = "";

  function serverDiagnostics(): string {
    return `server stdout:\n${serverStdout}\nserver stderr:\n${serverStderr}`;
  }

  function httpGet(pathname: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: httpPort,
          path: pathname,
          method: "GET",
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString("utf8");
          });
          res.on("end", () => {
            if (res.statusCode === undefined) {
              reject(new Error(`HTTP response for ${pathname} had no status.`));
              return;
            }
            resolve({ status: res.statusCode, body: data });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  /** Run the shipped CLI as its own process and collect everything it said. */
  function runCli(args: string[]): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const cli = spawn("node", [cliPath, ...args], {
        cwd: repositoryRoot,
        env: reviewDiffEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      cli.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      cli.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      cli.on("error", reject);
      cli.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  async function liveDocument(): Promise<ContentBody> {
    const list = await httpGet("/v1/documents");
    assert.equal(list.status, 200, serverDiagnostics());
    const listBody = parseObject(list.body, "document list response");
    const documents = requiredArray(listBody.documents, "document list");
    let documentId: string | undefined;
    for (const [index, entry] of documents.entries()) {
      const document = requiredRecord(entry, `document ${index}`);
      if (requiredString(document.path, `document ${index} path`) === docPath) {
        documentId = requiredString(
          document.documentId,
          `document ${index} id`,
        );
      }
    }
    assert.ok(documentId !== undefined, "the fixture document must be open");
    const content = await httpGet(`/v1/documents/${documentId}/content`);
    assert.equal(content.status, 200, serverDiagnostics());
    return parseContent(content.body);
  }

  async function reviews(): Promise<ReviewListEntry[]> {
    const response = await httpGet("/v1/reviews");
    assert.equal(response.status, 200, serverDiagnostics());
    return parseReviewList(response.body);
  }

  before(async function () {
    const serverScript = path.join(__dirname, "agent-http-api-e2e-server.ts");
    const server = spawn(
      "node",
      [
        "--import",
        "tsx",
        "--require",
        path.join(__dirname, "headless-electron-harness.cjs"),
        serverScript,
      ],
      {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: reviewDiffEnvironment(),
      },
    );
    child = server;
    assert.ok(server.stdout !== null);
    assert.ok(server.stderr !== null);
    server.stdout.on("data", (chunk: Buffer) => {
      serverStdout += chunk.toString("utf8");
    });
    server.stderr.on("data", (chunk: Buffer) => {
      serverStderr += chunk.toString("utf8");
    });

    const ready = await new Promise<ServerReady>((resolve, reject) => {
      server.once("error", reject);
      server.once("exit", (code) => {
        reject(
          new Error(
            `E2E server exited before readiness with code ${String(code)}.\n${serverDiagnostics()}`,
          ),
        );
      });
      server.once("message", (message: unknown) => {
        try {
          resolve(parseReady(message));
        } catch (error) {
          reject(error);
        }
      });
    });

    httpPort = ready.port;
    docPath = ready.docPath;
    scratch = ready.scratch;
  });

  after(async function () {
    const server = child;
    if (server === undefined) {
      return;
    }
    if (server.exitCode !== null) {
      assert.equal(server.exitCode, 0, serverDiagnostics());
      return;
    }
    const exited = once(server, "exit");
    const sent = server.send("shutdown");
    assert.equal(sent, true, "the shutdown event must reach the E2E server");
    const [exitCode] = await exited;
    assert.equal(exitCode, 0, serverDiagnostics());
  });

  it("refuses a malformed patch without creating a review", async function () {
    const patchPath = path.join(scratch, "malformed.diff");
    writeFileSync(patchPath, "this is not a unified diff at all\n", "utf8");

    const result = await runCli([
      "--document",
      docPath,
      "--patch",
      patchPath,
      "--port",
      String(httpPort),
      "--token-environment-variable",
      TOKEN_ENVIRONMENT_VARIABLE,
    ]);

    const failure = parseCliFailure(result);
    assert.equal(failure.code, "PATCH_INVALID");
    assert.equal(failure.status, 400);
    assert.deepEqual(await reviews(), []);
  });

  it("refuses a stale declared baseline without creating a review", async function () {
    const live = await liveDocument();
    const patchPath = path.join(scratch, "stale-baseline.diff");
    writeFileSync(
      patchPath,
      createPatch(
        "document",
        live.content,
        live.content.replace("Original content", "Rebased content"),
        "",
        "",
        { context: 3 },
      ),
      "utf8",
    );

    const result = await runCli([
      "--document",
      docPath,
      "--patch",
      patchPath,
      "--port",
      String(httpPort),
      "--token-environment-variable",
      TOKEN_ENVIRONMENT_VARIABLE,
      "--baseline-sha256",
      "0".repeat(64),
    ]);

    const failure = parseCliFailure(result);
    assert.equal(failure.code, "BASELINE_MISMATCH");
    assert.equal(failure.status, undefined);
    assert.deepEqual(await reviews(), []);
  });

  it("focuses the document and opens every submitted review chunk", async function () {
    const live = await liveDocument();
    const proposed = live.content
      .replace("# E2E certification", "# E2E certification (revised)")
      .replace("Original content.", "Replacement content.");
    assert.notEqual(proposed, live.content, "the proposition must change the fixture");

    const patchPath = path.join(scratch, "proposition.diff");
    writeFileSync(
      patchPath,
      createPatch("document", live.content, proposed, "", "", { context: 0 }),
      "utf8",
    );

    const result = await runCli([
      "--document",
      docPath,
      "--patch",
      patchPath,
      "--description",
      "submitted by the review-diff CLI",
      "--port",
      String(httpPort),
      "--token-environment-variable",
      TOKEN_ENVIRONMENT_VARIABLE,
      "--baseline-sha256",
      live.revision.sha256,
    ]);

    assert.equal(result.code, 0, serverDiagnostics());

    const contextResponse = await httpGet("/v1/context");
    assert.equal(contextResponse.status, 200, serverDiagnostics());
    const context = parseObject(contextResponse.body, "editor context");
    const focusedDocument = requiredRecord(
      context.focusedDocument,
      "focused document",
    );
    assert.equal(
      requiredString(focusedDocument.path, "focused document path"),
      docPath,
    );

    const openReviews = await reviews();
    assert.equal(openReviews.length, 1);
    assert.equal(openReviews[0].documentPath, docPath);
    assert.equal(openReviews[0].unresolvedChunks, 2);

    const chunkResponse = await httpGet(
      `/v1/reviews/${openReviews[0].reviewId}/chunks`,
    );
    assert.equal(chunkResponse.status, 200, serverDiagnostics());
    const chunks = parseChunks(chunkResponse.body);
    assert.equal(chunks.length, 2);
    assert.deepEqual(
      new Set(chunks.map((chunk) => chunk.workingText)),
      new Set(["# E2E certification (revised)", "\nReplacement content."]),
    );
    for (const chunk of chunks) {
      assert.equal(chunk.state, "pending");
      assert.deepEqual(chunk.descriptions, [
        "submitted by the review-diff CLI",
      ]);
    }
  });
});
