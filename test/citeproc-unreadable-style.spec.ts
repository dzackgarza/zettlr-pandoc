/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Unreadable citation style specs (#76)
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     `export.cslStyle` names the citation style of the editor.
 *                  When the provider cannot load that file, the app starts,
 *                  each window can read the problem with its path and its
 *                  cause, and no citation is rendered in another style. A
 *                  style that loads again removes the problem, and the
 *                  windows learn that the rendered citations changed.
 *
 * END HEADER
 */

// The harness must load before any provider module: the provider graph
// imports 'electron' at module scope.
import "./headless-electron-harness.cjs";
import { strict as assert } from "assert";
import { BrowserWindow } from "electron";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import os from "os";
import path from "path";
import CiteprocProvider, { CitationStyleError } from "source/app/service-providers/citeproc";
import LogProvider from "source/app/service-providers/log";
import type { CitationResourceProblem } from "source/types/common/citeproc";
import { DATABASE_LOADER_THREAD } from "./citeproc-loader-thread";
import { sentMessagesFor, userData } from "./headless-electron-harness.cjs";
import { invokeMain } from "./main-ipc";

const CHICAGO_STYLE = path.resolve("static", "csl-styles", "chicago-author-date.csl");
const LOCALES = path.resolve("static", "csl-locales");
const PROBLEMS_CHANNEL = "citeproc-problems";
const UPDATED_CHANNEL = "citeproc-database-updated";

const LIBRARY = `@article{AW71,
  title = {Degenerate {{Fibers}} and {{Stable Reduction}} of {{Curves}}},
  author = {Artin, M. and Winters, G.},
  year = 1971,
  journal = {Topology},
  volume = {10},
  pages = {373--383},
}
`;

// A style that renders a citation as the year in square brackets.
const YEAR_STYLE = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbib/csl" class="in-text" version="1.0">
  <info>
    <title>Year in brackets</title>
    <id>https://example.org/year-in-brackets</id>
    <updated>2026-01-01T00:00:00+00:00</updated>
  </info>
  <citation>
    <layout prefix="[" suffix="]" delimiter="; ">
      <date variable="issued"><date-part name="year"/></date>
    </layout>
  </citation>
  <bibliography>
    <layout><text variable="title"/></layout>
  </bibliography>
</style>
`;

interface Settings {
  cslLibrary: string;
  cslStyle: string;
}

describe("a citation style that the provider cannot load", function () {
  let directory: string;
  let libraryPath: string;
  let yearStyle: string;
  let missingStyle: string;
  let notAStyle: string;
  let window: BrowserWindow;
  const log = new LogProvider();
  const providers: CiteprocProvider[] = [];

  before(function () {
    directory = mkdtempSync(path.join(os.tmpdir(), "zettlr-citeproc-style-"));
    libraryPath = path.join(directory, "references.bib");
    writeFileSync(libraryPath, LIBRARY);
    yearStyle = path.join(directory, "year.csl");
    writeFileSync(yearStyle, YEAR_STYLE);
    missingStyle = path.join(directory, "unmounted", "journal.csl");
    notAStyle = path.join(directory, "notes.csl");
    writeFileSync(notAStyle, "These are notes, not a citation style.\n");
    rmSync(path.join(userData, "citeproc-cache"), { recursive: true, force: true });
  });

  beforeEach(function () {
    window = new BrowserWindow();
  });

  afterEach(async function () {
    window.close();
    for (const provider of providers.splice(0)) {
      await provider.shutdown();
    }
  });

  after(function () {
    rmSync(directory, { recursive: true, force: true });
  });

  /** A provider on settings that the spec changes as the Preferences window does. */
  function providerWith(settings: Settings): {
    provider: CiteprocProvider;
    set: (option: keyof Settings, value: string) => void;
  } {
    const listeners: Array<(option?: string) => void> = [];
    const provider = new CiteprocProvider(
      log,
      {
        on: (_event, callback) => listeners.push(callback),
        get: () => ({ appLang: "en-US", export: settings }),
      },
      LOCALES,
      DATABASE_LOADER_THREAD,
    );
    providers.push(provider);
    return {
      provider,
      set: (option, value) => {
        settings[option] = value;
        for (const listener of listeners) {
          listener(`export.${option}`);
        }
      },
    };
  }

  /** What a window reads when it asks the provider for its problems. */
  async function problemsReadByAWindow(): Promise<CitationResourceProblem[]> {
    return await invokeMain("citeproc-provider", { command: "get-problems" });
  }

  function broadcasts(channel: string): unknown[][] {
    return sentMessagesFor(window)
      .filter((message) => message[0] === channel)
      .map((message) => message.slice(1));
  }

  async function untilBroadcast(channel: string, count: number): Promise<void> {
    const deadline = Date.now() + 5000;
    while (broadcasts(channel).length < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function readFailure(file: string): Promise<string> {
    const error: Error = await readFile(file, "utf8").then(
      () => new Error(`${file} is readable`),
      (cause: Error) => cause,
    );
    return error.message;
  }

  it("starts, and names the path and the cause to a window that asks", async function () {
    const { provider } = providerWith({ cslLibrary: "", cslStyle: missingStyle });

    await provider.boot();

    assert.deepEqual(await problemsReadByAWindow(), [
      { resource: "style", path: missingStyle, cause: await readFailure(missingStyle) },
    ]);
  });

  it("gives the cite keys of a library, and renders no citation", async function () {
    const { provider } = providerWith({ cslLibrary: "", cslStyle: missingStyle });
    await provider.boot();
    await provider.synchronizeDatabases([libraryPath]);

    assert.deepEqual(
      provider.getItems(libraryPath).map((item) => item.id),
      ["AW71"],
    );
    assert.throws(
      () => provider.getCitation(libraryPath, [{ id: "AW71" }], false),
      CitationStyleError,
    );
    assert.throws(() => provider.makeBibliography(libraryPath, ["AW71"]), CitationStyleError);
  });

  it("tells the windows when a change of the setting names a file that is absent", async function () {
    const { provider, set } = providerWith({ cslLibrary: "", cslStyle: CHICAGO_STYLE });
    await provider.boot();
    await provider.synchronizeDatabases([libraryPath]);
    assert.equal(
      provider.getCitation(libraryPath, [{ id: "AW71" }], false),
      "(Artin and Winters 1971)",
    );

    set("cslStyle", missingStyle);
    await untilBroadcast(PROBLEMS_CHANNEL, 1);

    const problem = {
      resource: "style",
      path: missingStyle,
      cause: await readFailure(missingStyle),
    };
    assert.deepEqual(broadcasts(PROBLEMS_CHANNEL), [[[problem]]]);
    assert.deepEqual(await problemsReadByAWindow(), [problem]);
    // The style of the last setting is not the style of this one.
    assert.throws(
      () => provider.getCitation(libraryPath, [{ id: "AW71" }], false),
      CitationStyleError,
    );
  });

  it("names a file that is not a citation style", async function () {
    const { provider } = providerWith({ cslLibrary: "", cslStyle: notAStyle });
    await provider.boot();
    await provider.synchronizeDatabases([libraryPath]);

    const problems = await problemsReadByAWindow();
    assert.deepEqual(
      problems.map((problem) => [problem.resource, problem.path]),
      [["style", notAStyle]],
    );
    assert.throws(
      () => provider.getCitation(libraryPath, [{ id: "AW71" }], false),
      CitationStyleError,
    );
  });

  it("renders in the style of the setting when the setting names a style again", async function () {
    const { provider, set } = providerWith({ cslLibrary: "", cslStyle: missingStyle });
    await provider.boot();
    await provider.synchronizeDatabases([libraryPath]);
    const updatesBefore = broadcasts(UPDATED_CHANNEL).length;

    set("cslStyle", yearStyle);
    await untilBroadcast(PROBLEMS_CHANNEL, 2);

    // An open window gets the problem of the start, and then its end.
    assert.deepEqual(broadcasts(PROBLEMS_CHANNEL), [
      [[{ resource: "style", path: missingStyle, cause: await readFailure(missingStyle) }]],
      [[]],
    ]);
    assert.deepEqual(await problemsReadByAWindow(), []);
    assert.equal(provider.getCitation(libraryPath, [{ id: "AW71" }], false), "[1971]");
    assert.equal(
      broadcasts(UPDATED_CHANNEL).length,
      updatesBefore + 1,
      "the windows learn that the rendered citations changed",
    );
  });

  it("tells the windows that the rendered citations changed when one style replaces another", async function () {
    const { provider, set } = providerWith({ cslLibrary: "", cslStyle: CHICAGO_STYLE });
    await provider.boot();
    await provider.synchronizeDatabases([libraryPath]);
    const updatesBefore = broadcasts(UPDATED_CHANNEL).length;

    set("cslStyle", yearStyle);
    await untilBroadcast(UPDATED_CHANNEL, updatesBefore + 1);

    assert.equal(broadcasts(UPDATED_CHANNEL).length, updatesBefore + 1);
    assert.equal(provider.getCitation(libraryPath, [{ id: "AW71" }], false), "[1971]");
    assert.deepEqual(broadcasts(PROBLEMS_CHANNEL), []);
    assert.deepEqual(await problemsReadByAWindow(), []);
  });

  it("names a main library that is absent at the start", async function () {
    const missingLibrary = path.join(directory, "unmounted", "references.bib");
    const { provider } = providerWith({ cslLibrary: missingLibrary, cslStyle: CHICAGO_STYLE });

    await provider.boot();
    await provider.loadsEnded();

    const problems = await problemsReadByAWindow();
    assert.deepEqual(
      problems.map((problem) => [problem.resource, problem.path]),
      [["library", missingLibrary]],
    );
  });
});
