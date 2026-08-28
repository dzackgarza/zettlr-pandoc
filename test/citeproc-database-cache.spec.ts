/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Citeproc database parse-cache boundary tests
 * CVM-Role:        Test
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     Drives the production database loader against a real
 *                  .bib file and a real cache directory. The claim under
 *                  proof: an unchanged database is served from the cached
 *                  parse (boot does not re-pay the BibLaTeX conversion),
 *                  while an edited database re-parses and re-stamps. The
 *                  planted-cache case is what separates "returned the same
 *                  data" from "actually read the cache".
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { loadDatabase } from "source/app/service-providers/citeproc/util/database-loader";
import { sha256Text } from "source/common/util/sha256";

const NIKULIN_ENTRY = `@article{Nik80,
  author = {Nikulin, V. V.},
  title = {Integral symmetric bilinear forms and some of their applications},
  year = {1980},
  journaltitle = {Mathematics of the USSR-Izvestiya},
}
`;

const COBLE_ENTRY = `@article{Cob19,
  author = {Coble, Arthur B.},
  title = {The ten nodes of the rational sextic and of the Cayley symmetroid},
  year = {1919},
  journaltitle = {American Journal of Mathematics},
}
`;

describe("Citeproc database parse cache", function () {
  let directory: string;
  let databasePath: string;
  let cacheDir: string;

  beforeEach(function () {
    directory = mkdtempSync(path.join(os.tmpdir(), "zettlr-bib-cache-"));
    databasePath = path.join(directory, "references.bib");
    cacheDir = path.join(directory, "citeproc-cache");
    writeFileSync(databasePath, NIKULIN_ENTRY);
  });

  afterEach(function () {
    rmSync(directory, { recursive: true, force: true });
  });

  function cacheFileContent (): { version: number, sourceSha256: string, cslData: Record<string, unknown> } {
    const entries = readdirSync(cacheDir);
    assert.equal(entries.length, 1, "exactly one cache file per database");
    return JSON.parse(readFileSync(path.join(cacheDir, entries[0]), "utf8")) as {
      version: number, sourceSha256: string, cslData: Record<string, unknown>
    };
  }

  it("parses a bib database and stamps the cache with the source hash", async function () {
    const record = await loadDatabase(databasePath, undefined, cacheDir);

    assert.equal(record.type, "biblatex");
    assert.ok("Nik80" in record.cslData, "the real entry must be parsed");
    const cached = cacheFileContent();
    assert.equal(cached.sourceSha256, sha256Text(NIKULIN_ENTRY));
    assert.ok("Nik80" in cached.cslData, "the cache carries the finished parse");
  });

  it("serves an unchanged database from the cache instead of re-parsing", async function () {
    await loadDatabase(databasePath, undefined, cacheDir);

    // Plant a marker in the cache while keeping its stamp valid. The next
    // load returning the marker is what proves the cache is the read path —
    // a loader that silently re-parsed would return Nik80 and still pass any
    // equality check against the first result.
    const entries = readdirSync(cacheDir);
    const cachePath = path.join(cacheDir, entries[0]);
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { cslData: unknown };
    cached.cslData = { planted: { id: "planted", type: "article" } };
    writeFileSync(cachePath, JSON.stringify(cached));

    const record = await loadDatabase(databasePath, undefined, cacheDir);
    assert.deepEqual(Object.keys(record.cslData), ["planted"]);
    assert.equal(record.path, databasePath, "the record's path is the live argument, never the cache's");
  });

  it("re-parses and re-stamps when the database content changes", async function () {
    await loadDatabase(databasePath, undefined, cacheDir);

    const updated = NIKULIN_ENTRY + "\n" + COBLE_ENTRY;
    writeFileSync(databasePath, updated);
    const record = await loadDatabase(databasePath, undefined, cacheDir);

    assert.ok("Nik80" in record.cslData && "Cob19" in record.cslData, "the edited database is re-parsed in full");
    assert.equal(cacheFileContent().sourceSha256, sha256Text(updated), "the cache is re-stamped for the new content");
  });

  it("re-parses over an unreadable cache file rather than failing the load", async function () {
    await loadDatabase(databasePath, undefined, cacheDir);
    const entries = readdirSync(cacheDir);
    writeFileSync(path.join(cacheDir, entries[0]), "{ not json");

    const record = await loadDatabase(databasePath, undefined, cacheDir);
    assert.ok("Nik80" in record.cslData, "a corrupt cache is a miss, not a failure");
  });
});
