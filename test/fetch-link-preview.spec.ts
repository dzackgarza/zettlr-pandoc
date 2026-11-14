/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Link preview requests
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The preview of a link reads the headers of the address
 *                  first. An HTML page gives its title and its description.
 *                  An address of another content type gives no preview, and
 *                  the request ends before the server sent the body.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchLinkPreview } from "source/common/util/fetch-link-preview";

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Lattices of rank two</title>
    <meta name="description" content="A page about lattices.">
    <meta name="og:image" content="https://example.org/lattice.png">
  </head>
  <body></body>
</html>`;

/** The size of the file whose body the preview must not download. */
const FILE_BYTES = 64 * 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024);

describe("The preview of a link", function () {
  let server: Server;
  let origin: string;
  /** Resolves with the bytes that the server sent when the file request ended. */
  let fileRequestEnded: Promise<{ sentBytes: number; complete: boolean }>;

  /** Sends the file in chunks until the client goes away or the file ends. */
  function sendFile(response: ServerResponse): Promise<{ sentBytes: number; complete: boolean }> {
    return new Promise((resolve) => {
      let sentBytes = 0;
      const timer = setInterval(() => {
        sentBytes += CHUNK.length;
        response.write(CHUNK);
        if (sentBytes >= FILE_BYTES) {
          response.end();
        }
      }, 5);
      response.on("close", () => {
        clearInterval(timer);
        resolve({ sentBytes, complete: response.writableFinished });
      });
    });
  }

  beforeEach(async function () {
    server = createServer((request, response) => {
      if (request.url === "/page") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGE);
        return;
      }
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(FILE_BYTES),
      });
      fileRequestEnded = sendFile(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async function () {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("has the title, the description and the image of an HTML page", async function () {
    assert.deepEqual(await fetchLinkPreview(`${origin}/page`), {
      title: "Lattices of rank two",
      summary: "A page about lattices.",
      image: "https://example.org/lattice.png",
    });
  });

  it("refuses another content type and does not download the body", async function () {
    const unhandledRejections: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", record);
    try {
      await assert.rejects(fetchLinkPreview(`${origin}/file`), {
        message: "Unsupported content type",
      });
      const { sentBytes, complete } = await fileRequestEnded;
      assert.equal(complete, false, "the request ended before the end of the file");
      assert.ok(sentBytes < FILE_BYTES, `the server sent ${sentBytes} of ${FILE_BYTES} bytes`);
      // A rejection of the ended request arrives in a later task.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(unhandledRejections, []);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});
