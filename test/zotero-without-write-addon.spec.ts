/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Zotero that answers without the local-write-api add-on (#210)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Zotero's local HTTP server answers a route that no
 *                  endpoint serves with HTTP 404, Content-Type text/plain and
 *                  the body "No endpoint found" (Zotero 7, captured from the
 *                  running Zotero). Without the add-on, POST /write gets that
 *                  answer. The Zotero operations of the agent API that need
 *                  the add-on then answer ZOTERO_UNAVAILABLE (503): Zotero
 *                  runs, and the add-on that the operation needs does not.
 *
 * END HEADER
 */

// The harness must load before any provider module: the provider graph
// imports 'electron' at module scope.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";
import ZoteroLibrary from "source/app/service-providers/agent-api/zotero-library";
import CiteprocProvider from "source/app/service-providers/citeproc";
import LogProvider from "source/app/service-providers/log";
import { DATABASE_LOADER_THREAD } from "./citeproc-loader-thread";

describe("Zotero without the local-write-api add-on (#210)", function () {
  let citeproc: CiteprocProvider;
  let zotero: ZoteroLibrary;
  let zoteroServer: http.Server;
  const writeRequests: string[] = [];

  before(async function () {
    citeproc = new CiteprocProvider(
      new LogProvider(),
      {
        on: () => {},
        get: () => ({
          appLang: "en-US",
          export: {
            cslLibrary: "",
            cslStyle: path.resolve("static", "csl-styles", "chicago-author-date.csl"),
          },
        }),
      },
      path.resolve("static", "csl-locales"),
      DATABASE_LOADER_THREAD,
    );
    await citeproc.boot();
    zoteroServer = http.createServer((req, res) => {
      writeRequests.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(404, {
        "X-Zotero-Version": "7.0.15",
        "X-Zotero-Connector-API-Version": "3",
        "Content-Type": "text/plain",
      });
      res.end("No endpoint found");
    });
    await new Promise<void>((resolve) => zoteroServer.listen(0, "127.0.0.1", resolve));
    zotero = new ZoteroLibrary(
      citeproc,
      `http://127.0.0.1:${(zoteroServer.address() as AddressInfo).port}`,
    );
  });

  after(async function () {
    zoteroServer.close();
    await citeproc.shutdown();
  });

  it("answers ZOTERO_UNAVAILABLE for an identifier import", async function () {
    const result = await zotero.importIdentifier({ identifier: "arXiv:1512.03385" });
    assert.ok(!result.ok);
    assert.equal(result.status, 503);
    assert.equal(result.code, "ZOTERO_UNAVAILABLE");
    assert.equal(writeRequests.at(-1), "POST /write");
  });

  it("answers ZOTERO_UNAVAILABLE for a URL import", async function () {
    const result = await zotero.importUrl({ url: "https://arxiv.org/abs/1512.03385" });
    assert.ok(!result.ok);
    assert.equal(result.status, 503);
    assert.equal(result.code, "ZOTERO_UNAVAILABLE");
  });

  it("answers ZOTERO_UNAVAILABLE for the extractions of an item", async function () {
    const result = await zotero.extractions("ABCD2345");
    assert.ok(!result.ok);
    assert.equal(result.status, 503);
    assert.equal(result.code, "ZOTERO_UNAVAILABLE");
  });
});
