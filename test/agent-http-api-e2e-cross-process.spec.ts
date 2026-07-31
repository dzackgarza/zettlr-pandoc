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
import { spawn } from "child_process";
import path from "path";
import { createPatch } from "diff";

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

describe("Agent HTTP API cross-process E2E", function () {
  this.timeout(30000);

  let child: ReturnType<typeof spawn> | undefined;
  let httpPort: number | undefined;
  let docPath: string | undefined;

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
        // The child inherits this process's environment, and a developer whose
        // ~/.envrc carries a real token would hand the server one — after
        // which every request below, none of which authenticate, is refused.
        // The unauthenticated loopback posture is what this suite exercises.
        env: (() => {
          const inherited = { ...process.env };
          delete inherited.ZETTLR_AGENT_API_TOKEN;
          return inherited;
        })(),
      },
    );

    const readyLine = await new Promise<string>((resolve, reject) => {
      assert.ok(child !== undefined);
      let buffer = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const match = buffer.match(
          /E2E_SERVER_READY port=(\d+) docPath=([^\s]+) scratch=([^\s]+)/,
        );
        if (match !== null) {
          resolve(match[0]);
        }
      });

      child.on("exit", (code) => {
        reject(new Error(`E2E server exited early with code ${code}`));
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        // Surface fatal errors quickly.
        const text = chunk.toString("utf8");
        if (text.includes("E2E server failed")) {
          reject(new Error(text));
        }
      });
    });

    const match = readyLine.match(
      /E2E_SERVER_READY port=(\d+) docPath=([^\s]+) scratch=([^\s]+)/,
    );
    assert.ok(match !== null, "ready line must contain port and docPath");
    httpPort = parseInt(match[1], 10);
    docPath = match[2];
  });

  after(function (done) {
    if (child === undefined || child.killed) {
      done();
      return;
    }

    let settled = false;
    function finish() {
      if (!settled) {
        settled = true;
        done();
      }
    }

    child.on("exit", finish);
    child.send("shutdown");
    setTimeout(() => {
      if (child !== undefined && !child.killed) {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        if (child !== undefined && !child.killed) {
          child.kill("SIGKILL");
        }
        finish();
      }, 1000);
    }, 1000);
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
