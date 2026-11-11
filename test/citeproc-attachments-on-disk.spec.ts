/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Citation attachments on disk
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A library names the attachment files of an entry. A file
 *                  that the library names can be absent: Zotero's BibTeX
 *                  export writes a file name without its braces and doubled
 *                  spaces. The open-attachment command opens the first file
 *                  that the provider gives, so the provider gives only the
 *                  files that are on disk.
 *
 * END HEADER
 */

// The harness must load before any provider module: the provider graph
// imports 'electron' at module scope.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { CiteprocConfig } from "source/app/service-providers/citeproc";
import CiteprocProvider from "source/app/service-providers/citeproc";
import LogProvider from "source/app/service-providers/log";
import { userData } from "./headless-electron-harness.cjs";

const CHICAGO_STYLE = path.resolve("static", "csl-styles", "chicago-author-date.csl");

const LIBRARY = `@article{Nik80,
  author = {Nikulin, V. V.},
  title = {Integral symmetric bilinear forms and some of their applications},
  year = {1980},
  journaltitle = {Mathematics of the USSR-Izvestiya},
  file = {Nikulin 1980 - Integral forms.pdf;Nikulin1980.pdf},
}

@article{Cob19,
  author = {Coble, Arthur B.},
  title = {The ten nodes of the rational sextic and of the Cayley symmetroid},
  year = {1919},
  journaltitle = {American Journal of Mathematics},
  file = {Coble 1919 - The ten nodes.pdf},
}

@book{Dol12,
  author = {Dolgachev, Igor V.},
  title = {Classical algebraic geometry},
  year = {2012},
  publisher = {Cambridge University Press},
}
`;

describe("citation attachments on disk", function () {
  let directory: string;
  let libraryPath: string;
  let provider: CiteprocProvider;

  before(async function () {
    directory = mkdtempSync(path.join(os.tmpdir(), "zettlr-citeproc-attachments-"));
    libraryPath = path.join(directory, "library.bib");
    writeFileSync(libraryPath, LIBRARY);
    // Of the three files that the library names, one is on disk.
    writeFileSync(path.join(directory, "Nikulin1980.pdf"), "%PDF-1.7\n");
    rmSync(path.join(userData, "citeproc-cache"), { recursive: true, force: true });
    const config: CiteprocConfig = {
      on: () => {},
      get: () => ({
        appLang: "en-US",
        export: { cslLibrary: libraryPath, cslStyle: CHICAGO_STYLE },
      }),
    };
    provider = new CiteprocProvider(
      new LogProvider(),
      config,
      { showErrorMessage: () => {} },
      path.resolve("static", "csl-locales"),
    );
    await provider.boot();
  });

  after(async function () {
    await provider.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });

  it("gives the file on disk when the first file that the library names is absent", async function () {
    assert.deepEqual(await provider.getBibTexAttachments(libraryPath, "Nik80"), [
      path.join(directory, "Nikulin1980.pdf"),
    ]);
  });

  it("gives no file when no file that the library names is on disk", async function () {
    assert.deepEqual(await provider.getBibTexAttachments(libraryPath, "Cob19"), []);
  });

  it("reports that the library names no file for an entry with no file field", async function () {
    assert.equal(await provider.getBibTexAttachments(libraryPath, "Dol12"), false);
  });
});
