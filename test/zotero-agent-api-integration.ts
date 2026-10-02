/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Live proof of the Zotero operations of the agent API (#142)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives ZoteroLibrary against the running Zotero with the
 *                  local-write-api add-on (3.4.0 or later) and Better BibTeX,
 *                  and against the REAL main citation database: the Better
 *                  BibTeX auto-export that the Zettlr-Pandoc configuration
 *                  names. Run it with `just test-zotero-integration`. When
 *                  Zotero is not running, every request answers
 *                  ZOTERO_UNAVAILABLE and the tests fail.
 *
 *                  The owned behavior proven here: an import returns the key
 *                  that Zotero stored, waits until the citation database has
 *                  it, maps the add-on's remediation, and passes the caller's
 *                  fallback metadata through to a citable item tagged for
 *                  review. Items the tests create are trashed afterwards.
 *
 * END HEADER
 */

// The harness must load before any provider module: the provider graph
// imports 'electron' at module scope.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import crypto from "crypto";
import { readFileSync } from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import ZoteroLibrary from "source/app/service-providers/agent-api/zotero-library";
import CiteprocProvider from "source/app/service-providers/citeproc";
import LogProvider from "source/app/service-providers/log";

const ZOTERO = "http://127.0.0.1:23119";
const CHICAGO_STYLE = path.resolve("static", "csl-styles", "chicago-author-date.csl");
const MAIN_LIBRARY = (
  JSON.parse(
    readFileSync(path.join(os.homedir(), ".config", "Zettlr-Pandoc", "config.json"), "utf8"),
  ) as {
    export: { cslLibrary: string };
  }
).export.cslLibrary;

async function zoteroItem(itemKey: string): Promise<{ citationKey: string; title: string }> {
  const response = await fetch(`${ZOTERO}/api/users/0/items/${itemKey}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { data: { citationKey: string; title: string } }).data;
}

/** A CSL title without the case-protection spans that Better BibTeX braces become. */
function cslTitle(citeproc: CiteprocProvider, citationKey: string): string {
  const title = citeproc.getItem("main", citationKey)?.title;
  if (typeof title !== "string")
    throw new Error(`The main library has no title for ${citationKey}`);
  return title.replace(/<span class="nocase">|<\/span>/g, "");
}

describe("Zotero operations of the agent API against live Zotero (#142)", function () {
  this.timeout(240000);

  const uid = crypto.randomBytes(4).toString("hex");
  const createdItemKeys: string[] = [];
  let citeproc: CiteprocProvider;
  let zotero: ZoteroLibrary;
  let pageServer: http.Server;
  let pageOrigin: string;

  before(async function () {
    citeproc = new CiteprocProvider(
      new LogProvider(),
      {
        on: () => {},
        get: () => ({
          appLang: "en-US",
          export: { cslLibrary: MAIN_LIBRARY, cslStyle: CHICAGO_STYLE },
        }),
      },
      {
        showErrorMessage: (title: string, message: string) => {
          throw new Error(`${title}: ${message}`);
        },
      },
    );
    await citeproc.boot();
    zotero = new ZoteroLibrary(citeproc);
    // A page with no metadata and no identifier: no method of Zotero can name the work.
    pageServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><title>Nothing here</title></head><body><p>notes</p></body></html>',
      );
    });
    await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
    pageOrigin = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}`;
  });

  after(async function () {
    pageServer.close();
    for (const itemKey of createdItemKeys) {
      const response = await fetch(`${ZOTERO}/write`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "trash_item", item_key: itemKey }),
      });
      assert.equal(response.status, 200, `cleanup of ${itemKey}: ${await response.text()}`);
    }
    await citeproc.shutdown();
  });

  it("imports an arXiv identifier as an item whose key the citation database has", async function () {
    const result = await zotero.importIdentifier({ identifier: "arXiv:1512.03385" });
    assert.ok(result.ok, JSON.stringify(result));
    createdItemKeys.push(...result.body.items.map((item) => item.itemKey));
    assert.equal(result.body.items.length, 1);
    const [item] = result.body.items;
    const stored = await zoteroItem(item.itemKey);
    assert.equal(item.citationKey, stored.citationKey);
    assert.equal(stored.title, "Deep Residual Learning for Image Recognition");
    assert.equal(item.citable, true);
    assert.equal(cslTitle(citeproc, item.citationKey), stored.title);
  });

  it("answers an unidentified page with remediation, and saves it from fallback metadata", async function () {
    const url = `${pageOrigin}/fallback-${uid}`;
    const refused = await zotero.importUrl({ url });
    assert.ok(!refused.ok);
    assert.equal(refused.status, 422);
    assert.equal(refused.code, "ZOTERO_SOURCE_NOT_IDENTIFIED");
    assert.ok(refused.remediation?.alternativeSources.some((source) => source.name === "arXiv"));

    // Better BibTeX title-cases an English title; a title-cased one is exported unchanged.
    const title = `Fallback Item ${uid.toUpperCase()}`;
    const saved = await zotero.importUrl({
      url,
      fallbackMetadata: {
        title,
        creators: [{ firstName: "Ada", lastName: "Fallbackauthor" }],
        year: "2019",
      },
    });
    assert.ok(saved.ok, JSON.stringify(saved));
    createdItemKeys.push(saved.body.item.itemKey);
    assert.equal(saved.body.method, "caller_metadata");
    assert.equal(saved.body.existing, false);
    assert.equal(saved.body.item.citable, true);
    assert.equal(cslTitle(citeproc, saved.body.item.citationKey), title);

    const found = await zotero.search(title, 5);
    assert.ok(found.ok, JSON.stringify(found));
    assert.deepEqual(
      found.body.items.map((item) => ({
        itemKey: item.itemKey,
        citationKey: item.citationKey,
        creators: item.creators,
        date: item.date,
        url: item.url,
        unresolved: item.tags.includes("metadata:unresolved"),
        citable: item.citable,
      })),
      [
        {
          itemKey: saved.body.item.itemKey,
          citationKey: saved.body.item.citationKey,
          creators: [{ creatorType: "author", firstName: "Ada", lastName: "Fallbackauthor" }],
          date: "2019",
          url,
          unresolved: true,
          citable: true,
        },
      ],
    );
  });
});
