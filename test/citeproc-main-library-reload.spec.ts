/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Reload of a changed main citation library (#143)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     Better BibTeX rewrites its auto-export after each change in
 *                  Zotero. The provider must reload the main library when the
 *                  file changes, wherever the file is: the library of this
 *                  machine is ~/.pandoc/bib/references.bib, below a
 *                  dot-directory. The REAL CiteprocProvider watches a REAL
 *                  .bib file.
 *
 * END HEADER
 */

// The harness must load before any provider module: the provider graph
// imports 'electron' at module scope.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import CiteprocProvider from "source/app/service-providers/citeproc";
import LogProvider from "source/app/service-providers/log";

const CHICAGO_STYLE = path.resolve("static", "csl-styles", "chicago-author-date.csl");

const NIKULIN = `@article{Nik80,
  author = {Nikulin, V. V.},
  title = {Integral symmetric bilinear forms and some of their applications},
  year = {1980},
  journaltitle = {Mathematics of the USSR-Izvestiya},
}
`;

const WALL = `@article{Wal62,
  author = {Wall, C. T. C.},
  title = {On the orthogonal groups of unimodular quadratic forms},
  year = {1962},
  journaltitle = {Mathematische Annalen},
}
`;

describe("A changed main citation library", function () {
  let directory: string;
  let libraryPath: string;
  let provider: CiteprocProvider;

  before(async function () {
    directory = mkdtempSync(path.join(os.tmpdir(), "zettlr-citeproc-reload-"));
    mkdirSync(path.join(directory, ".pandoc"));
    libraryPath = path.join(directory, ".pandoc", "references.bib");
    writeFileSync(libraryPath, NIKULIN);
    provider = new CiteprocProvider(
      new LogProvider(),
      {
        on: () => {},
        get: () => ({
          appLang: "en-US",
          export: { cslLibrary: libraryPath, cslStyle: CHICAGO_STYLE },
        }),
      },
      {
        showErrorMessage: (title: string, message: string) => {
          throw new Error(`${title}: ${message}`);
        },
      },
    );
    await provider.boot();
  });

  after(async function () {
    await provider.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });

  it("is reloaded when the library is below a dot-directory", async function () {
    assert.equal(provider.mainLibraryHas("Wal62"), false);
    writeFileSync(libraryPath, NIKULIN + WALL);
    assert.equal(await provider.awaitMainLibraryItem("Wal62", 15000), true);
    assert.equal(
      provider.getItem("main", "Wal62")?.title,
      "On the orthogonal groups of unimodular quadratic forms",
    );
    assert.equal(provider.mainLibraryHas("Nik80"), true);
  });
});
