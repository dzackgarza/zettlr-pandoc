/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Agent HTTP API cross-process E2E certification
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:          GNU GPL v3
 *
 * Description:     Spawns the agent HTTP server in a separate OS process and drives
 *                  the OpenAPI endpoints over the real loopback socket. This is the
 *                  certification boundary a remote CLI (or a Cloudflare tunnel client)
 *                  would cross: requests originate from a different process and PID.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import http from "http";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { createPatch } from "diff";
import { once } from "events";

/**
 * The slices of the responses this suite reads. JSON.parse hands back `any`,
 * which spreads through every expression it touches and costs the assertions
 * their type checking; naming the two shapes is what keeps a renamed field a
 * compile error here rather than an undefined at runtime.
 */
interface DocumentListBody {
  documents: Array<{ path: string; documentId: string }>;
}

interface ContentBody {
  content: string;
  snapshot: string;
}

interface ServerReady {
  port: number;
  docPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReady(message: unknown): ServerReady {
  assert.ok(isRecord(message), "server readiness event must be an object");
  assert.equal(message.event, "e2e-server-ready");
  assert.ok(
    typeof message.port === "number" && Number.isInteger(message.port),
    "server readiness port must be an integer",
  );
  if (typeof message.docPath !== "string") {
    assert.fail("server readiness document path must be a string");
  }
  return {
    port: message.port,
    docPath: message.docPath,
  };
}

describe("Agent HTTP API cross-process E2E", function () {
  this.timeout(30000);

  let child: ChildProcess | undefined;
  let httpPort: number | undefined;
  let docPath: string | undefined;
  let serverStdout = "";
  let serverStderr = "";

  function serverDiagnostics(): string {
    return `server stdout:\n${serverStdout}\nserver stderr:\n${serverStderr}`;
  }

  function httpRequest(
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
    assert.ok(httpPort !== undefined, "server port must be known");
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: httpPort,
          path: pathname,
          method,
          headers: options.headers ?? {},
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

  before(async function () {
    const serverScript = path.join(__dirname, "agent-http-api-e2e-server.ts");
    child = spawn(
      "node",
      [
        "--import",
        "tsx",
        "--require",
        path.join(__dirname, "headless-electron-harness.cjs"),
        serverScript,
      ],
      {
        cwd: path.join(__dirname, ".."),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );

    assert.ok(child.stdout !== null);
    assert.ok(child.stderr !== null);
    child.stdout.on("data", (chunk: Buffer) => {
      serverStdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      serverStderr += chunk.toString("utf8");
    });

    const ready = await new Promise<ServerReady>((resolve, reject) => {
      assert.ok(child !== undefined);
      child.once("error", reject);
      child.once("exit", (code) => {
        reject(
          new Error(
            `E2E server exited before readiness with code ${String(code)}.\n${serverDiagnostics()}`,
          ),
        );
      });
      child.once("message", (message: unknown) => {
        try {
          resolve(parseReady(message));
        } catch (error) {
          reject(error);
        }
      });
    });

    httpPort = ready.port;
    docPath = ready.docPath;
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

  it("serves /v1/ping to a separate process over loopback", async function () {
    const response = await httpRequest("GET", "/v1/ping");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.protocolVersion !== undefined);
    assert.ok(body.instanceId !== undefined);
  });

  it("lists the pre-opened document from a separate process", async function () {
    const response = await httpRequest("GET", "/v1/documents");
    assert.equal(response.status, 200);
    const body = JSON.parse(response.body) as DocumentListBody;
    assert.ok(
      body.documents.some((d) => d.path === docPath),
      `expected ${docPath} in ${JSON.stringify(body.documents)}`,
    );
  });

  it("reads live document content from a separate process", async function () {
    const listResponse = await httpRequest("GET", "/v1/documents");
    const listBody = JSON.parse(listResponse.body) as DocumentListBody;
    const doc = listBody.documents.find((d) => d.path === docPath);
    assert.ok(doc !== undefined);

    const contentResponse = await httpRequest(
      "GET",
      `/v1/documents/${doc.documentId}/content`,
    );
    assert.equal(contentResponse.status, 200);
    const contentBody = JSON.parse(contentResponse.body) as ContentBody;
    assert.ok(contentBody.content.includes("Original content"));
    assert.ok(contentBody.snapshot !== undefined);
  });

  it("submits and clears a proposal from a separate process", async function () {
    const listResponse = await httpRequest("GET", "/v1/documents");
    const listBody = JSON.parse(listResponse.body) as DocumentListBody;
    const doc = listBody.documents.find((d) => d.path === docPath);
    assert.ok(doc !== undefined);

    const contentResponse = await httpRequest(
      "GET",
      `/v1/documents/${doc.documentId}/content`,
    );
    assert.equal(
      contentResponse.status,
      200,
      `read content failed: ${contentResponse.body}`,
    );
    const contentBody = JSON.parse(contentResponse.body) as ContentBody;
    const snapshot = contentBody.snapshot;
    assert.ok(snapshot !== undefined, "content response must include snapshot");
    const eTag = contentResponse.headers.etag as string;
    assert.ok(eTag !== undefined, "content response must include ETag header");

    const originalText = contentBody.content;
    const proposedText = originalText.replace(
      "Original content",
      "Updated content",
    );
    const patch = createPatch("document", originalText, proposedText, "", "", {
      context: 3,
    });

    const submitResponse = await httpRequest(
      "POST",
      `/v1/documents/${doc.documentId}/proposals`,
      {
        body: JSON.stringify({
          description: "cross-process proposal",
          snapshot,
          patch,
          patchFormat: "unified-diff",
          clientRequestId: `e2e-${Date.now()}`,
        }),
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
    assert.equal(
      submitResponse.status,
      200,
      `submit proposal failed: ${submitResponse.body}`,
    );
    const submitBody = JSON.parse(submitResponse.body);
    assert.ok(submitBody.reviewId !== undefined);

    const clearResponse = await httpRequest(
      "POST",
      `/v1/reviews/${submitBody.reviewId}/clear`,
      {
        body: JSON.stringify({ reason: "certification complete" }),
        headers: { "Content-Type": "application/json" },
      },
    );
    assert.equal(
      clearResponse.status,
      200,
      `clear failed: ${clearResponse.body}`,
    );
  });
});
