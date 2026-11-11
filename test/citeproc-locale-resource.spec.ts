/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Citation locale resource specs
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The citation provider reads its CSL locales from the one
 *                  directory that its owner declares. The directory from
 *                  which the process started decides nothing, and a locale
 *                  that the provider cannot read stops it with the cause.
 *
 * END HEADER
 */

// The harness must load before any provider module: the provider graph
// imports 'electron' at module scope.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import type { CiteprocConfig } from "source/app/service-providers/citeproc";
import CiteprocProvider from "source/app/service-providers/citeproc";
import LogProvider from "source/app/service-providers/log";
import { userData } from "./headless-electron-harness.cjs";

const CHICAGO_STYLE = path.resolve("static", "csl-styles", "chicago-author-date.csl");
const SHIPPED_EN_US = path.resolve("static", "csl-locales", "locales-en-US.xml");

const LIBRARY = `@article{AW71,
  title = {Degenerate {{Fibers}} and {{Stable Reduction}} of {{Curves}}},
  author = {Artin, M. and Winters, G.},
  year = 1971,
  journal = {Topology},
  volume = {10},
  pages = {373--383},
}
`;

function config(appLang: string): CiteprocConfig {
  return {
    on: () => {},
    get: () => ({ appLang, export: { cslLibrary: "", cslStyle: CHICAGO_STYLE } }),
  };
}

describe("citation locale resource", function () {
  let directory: string;
  let libraryPath: string;
  let declaredLocales: string;
  let emptyLocales: string;
  const log = new LogProvider();
  const providers: CiteprocProvider[] = [];

  before(function () {
    directory = mkdtempSync(path.join(os.tmpdir(), "zettlr-citeproc-locale-"));
    libraryPath = path.join(directory, "references.bib");
    writeFileSync(libraryPath, LIBRARY);
    // The declared directory holds one locale, en-US, whose word between two
    // author names is not the word of the locale in this checkout.
    declaredLocales = path.join(directory, "declared");
    mkdirSync(declaredLocales);
    const shipped = readFileSync(SHIPPED_EN_US, "utf8");
    const marked = shipped.replace('<term name="and">and</term>', '<term name="and">et</term>');
    assert.notEqual(marked, shipped);
    writeFileSync(path.join(declaredLocales, "locales-en-US.xml"), marked);
    emptyLocales = path.join(directory, "empty");
    mkdirSync(emptyLocales);
    rmSync(path.join(userData, "citeproc-cache"), { recursive: true, force: true });
  });

  afterEach(async function () {
    for (const provider of providers.splice(0)) {
      await provider.shutdown();
    }
  });

  after(function () {
    rmSync(directory, { recursive: true, force: true });
  });

  function providerWith(appLang: string, localeDirectory: string): CiteprocProvider {
    const provider = new CiteprocProvider(
      log,
      config(appLang),
      { showErrorMessage: () => {} },
      localeDirectory,
    );
    providers.push(provider);
    return provider;
  }

  it("renders with the locale of the declared directory", async function () {
    const provider = providerWith("en-US", declaredLocales);
    await provider.boot();
    await provider.synchronizeDatabases([libraryPath]);

    assert.equal(
      provider.getCitation(libraryPath, [{ id: "AW71" }], false),
      "(Artin et Winters 1971)",
    );
  });

  it("renders a language that the declared directory lacks with its en-US locale", async function () {
    // The checkout has a de-DE locale; the declared directory has none.
    const provider = providerWith("de-DE", declaredLocales);
    await provider.boot();
    await provider.synchronizeDatabases([libraryPath]);

    assert.equal(
      provider.getCitation(libraryPath, [{ id: "AW71" }], false),
      "(Artin et Winters 1971)",
    );
  });

  it("stops with the read failure when the declared directory has no en-US locale", async function () {
    const provider = providerWith("en-US", emptyLocales);

    await assert.rejects(
      provider.boot(),
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" && error.path === path.join(emptyLocales, "locales-en-US.xml"),
    );
  });
});
