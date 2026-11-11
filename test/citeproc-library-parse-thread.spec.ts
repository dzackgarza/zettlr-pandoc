/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        The parse of a citation library and the main thread (#138)
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     The parse of a BibLaTeX library of some thousand entries
 *                  takes seconds. Every window waits for the main process, so
 *                  the parse must not stop its event loop: not when the
 *                  setting names a library, not when Better BibTeX writes the
 *                  library again, and not at the start of the provider. No
 *                  open of a document and no start of the documents provider
 *                  waits for a library, and a library that does not load
 *                  stops no other library. The REAL CiteprocProvider reads a
 *                  REAL .bib file of invented entries, each with the fields
 *                  that the BibLaTeX parser reports as unknown (the fields of
 *                  a MathSciNet export).
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
import { monitorEventLoopDelay } from "perf_hooks";
import CiteprocProvider, { type CiteprocConfig } from "source/app/service-providers/citeproc";
import type DocumentManager from "source/app/service-providers/documents";
import LogProvider from "source/app/service-providers/log";
import { setTimeout as sleep } from "timers/promises";
import { bootDocumentManager } from "./documents-provider-seam";
import { bootFsal } from "./fsal-seam";
import { userData } from "./headless-electron-harness.cjs";

const CHICAGO_STYLE = path.resolve("static", "csl-styles", "chicago-author-date.csl");

/** The parse of this many entries takes about a second on one thread. */
const ENTRY_COUNT = 1500;
/** The longest stop of the event loop that #138 accepts, in milliseconds. */
const LONGEST_STOP_MS = 100;

function key(index: number): string {
  return `Inv${String(index).padStart(4, "0")}`;
}

function title(index: number): string {
  return `On the unramified covers of the curve of genus ${index}`;
}

function entry(index: number): string {
  return `@article{${key(index)},
  author = {Author, A. N. and Writer, B.},
  title = {${title(index)}},
  year = {${1950 + (index % 70)}},
  journaltitle = {Journal of Invented Results},
  volume = {${index}},
  pages = {1--${index + 10}},
  mrnumber = {${1000000 + index}},
  zbl = {0001.${String(index).padStart(5, "0")}},
  fjournal = {The Journal of Invented Results},
  mrclass = {14H30},
}

`;
}

function library(count: number): string {
  let text = "";
  for (let index = 1; index <= count; index++) {
    text += entry(index);
  }
  return text;
}

/** A configuration whose library setting a spec can change. */
class Settings implements CiteprocConfig {
  private readonly listeners: Array<(option?: string) => void> = [];

  constructor(private cslLibrary: string) {}

  on(_event: "update", callback: (option?: string) => void): void {
    this.listeners.push(callback);
  }

  get(): ReturnType<CiteprocConfig["get"]> {
    return {
      appLang: "en-US",
      export: { cslLibrary: this.cslLibrary, cslStyle: CHICAGO_STYLE },
    };
  }

  setLibrary(libraryPath: string): void {
    this.cslLibrary = libraryPath;
    for (const listener of this.listeners) {
      listener("export.cslLibrary");
    }
  }
}

/**
 * The longest stop of the event loop, in milliseconds, while `work` runs.
 * The monitor measures the time between two of its samples, so it takes
 * samples before the work starts and after the work ends.
 */
async function longestStopDuring(work: () => Promise<void>): Promise<number> {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  await sleep(100);
  await work();
  await sleep(100);
  delay.disable();
  return delay.max / 1e6;
}

/** Whether the provider has the database now or within `timeoutMs`. */
async function becomesLoaded(
  citeproc: CiteprocProvider,
  databasePath: string,
  timeoutMs: number,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (citeproc.listDatabases().some((database) => database.path === databasePath)) {
      return true;
    }
    await sleep(20);
  }
  return false;
}

describe("The parse of a large citation library (#138)", function () {
  this.timeout(60000);

  let directory: string;
  const providers: CiteprocProvider[] = [];

  function provider(settings: Settings): CiteprocProvider {
    const made = new CiteprocProvider(
      new LogProvider(),
      settings,
      path.resolve("static", "csl-locales"),
    );
    providers.push(made);
    return made;
  }

  before(function () {
    directory = mkdtempSync(path.join(os.tmpdir(), "zettlr-citeproc-parse-thread-"));
  });

  after(async function () {
    for (const made of providers) {
      await made.shutdown();
    }
    rmSync(directory, { recursive: true, force: true });
  });

  describe("in a running provider", function () {
    let libraryPath: string;
    let settings: Settings;
    let citeproc: CiteprocProvider;

    before(async function () {
      libraryPath = path.join(directory, "running.bib");
      writeFileSync(libraryPath, library(ENTRY_COUNT));
      settings = new Settings("");
      citeproc = provider(settings);
      await citeproc.boot();
    });

    it("does not stop the event loop while the library of a new setting loads", async function () {
      const longestStop = await longestStopDuring(async () => {
        settings.setLibrary(libraryPath);
        assert.equal(await citeproc.awaitMainLibraryItem(key(ENTRY_COUNT), 30000), true);
      });

      assert.equal(citeproc.getItems("main").length, ENTRY_COUNT);
      assert.equal(citeproc.getItem("main", key(ENTRY_COUNT))?.title, title(ENTRY_COUNT));
      assert.deepEqual(citeproc.problems(), []);
      assert.ok(
        longestStop < LONGEST_STOP_MS,
        `the event loop stopped for ${Math.round(longestStop)} ms`,
      );
    });

    it("does not stop the event loop while a changed library loads again", async function () {
      // The items of the library before the change stay available until the
      // library after the change is read: a window that draws a citation
      // during the load does not find an empty library.
      const firstItemPresent: boolean[] = [];
      const watch = setInterval(() => {
        firstItemPresent.push(citeproc.mainLibraryHas(key(1)));
      }, 5);

      const longestStop = await longestStopDuring(async () => {
        writeFileSync(libraryPath, library(ENTRY_COUNT + 1));
        assert.equal(await citeproc.awaitMainLibraryItem(key(ENTRY_COUNT + 1), 30000), true);
      });
      clearInterval(watch);

      assert.equal(citeproc.getItems("main").length, ENTRY_COUNT + 1);
      assert.equal(citeproc.getItem("main", key(ENTRY_COUNT + 1))?.title, title(ENTRY_COUNT + 1));
      assert.ok(
        longestStop < LONGEST_STOP_MS,
        `the event loop stopped for ${Math.round(longestStop)} ms`,
      );
      assert.ok(firstItemPresent.length > 100, "the library was read during the whole load");
      assert.deepEqual(
        firstItemPresent.filter((present) => !present),
        [],
        "the library had no item of the text before the change during the load",
      );
    });
  });

  it("does not make the start of the provider wait for the library", async function () {
    const libraryPath = path.join(directory, "start.bib");
    writeFileSync(libraryPath, library(ENTRY_COUNT));
    const citeproc = provider(new Settings(libraryPath));

    await citeproc.boot();
    assert.equal(
      citeproc.mainLibraryHas(key(1)),
      false,
      "the start of the provider ended after the parse of the library",
    );

    assert.equal(await citeproc.awaitMainLibraryItem(key(ENTRY_COUNT), 30000), true);
    assert.equal(citeproc.getItem("main", key(1))?.title, title(1));
    assert.deepEqual(citeproc.problems(), []);
  });

  describe("of the documents", function () {
    let citeproc: CiteprocProvider;

    beforeEach(async function () {
      citeproc = provider(new Settings(""));
      await citeproc.boot();
    });

    it("loads each library that exists when a document names an absent file", async function () {
      const absent = path.join(directory, "absent.bib");
      const present = path.join(directory, "present.bib");
      writeFileSync(present, library(3));

      await citeproc.synchronizeDatabases([absent, present]);

      assert.deepEqual(citeproc.listDatabases(), [{ path: present, type: "biblatex" }]);
      assert.equal(citeproc.getItem(present, key(3))?.title, title(3));
      // The author learns which file did not load.
      assert.deepEqual(
        citeproc.problems().map((problem) => [problem.resource, problem.path]),
        [["bibliography", absent]],
      );

      // No document names the absent file any more.
      await citeproc.synchronizeDatabases([present]);
      assert.deepEqual(citeproc.problems(), []);
    });

    it("keeps the libraries of the last request only", async function () {
      const closed = path.join(directory, "closed.bib");
      const open = path.join(directory, "open.bib");
      writeFileSync(closed, library(ENTRY_COUNT));
      writeFileSync(open, library(3));

      // The document that names the large library closes while it loads.
      const first = citeproc.synchronizeDatabases([closed]);
      const second = citeproc.synchronizeDatabases([open]);
      await Promise.all([first, second]);

      assert.deepEqual(citeproc.listDatabases(), [{ path: open, type: "biblatex" }]);
    });
  });

  describe("in the documents provider", function () {
    let root: string;
    let libraryPath: string;
    let documents: DocumentManager;
    let citeproc: CiteprocProvider;

    beforeEach(async function () {
      root = mkdtempSync(path.join(directory, "workspace-"));
      mkdirSync(path.join(userData, "logs"), { recursive: true });
      rmSync(path.join(userData, "documents.yaml"), { force: true });
      libraryPath = path.join(root, "covers.bib");
      writeFileSync(libraryPath, library(ENTRY_COUNT));
      citeproc = provider(new Settings(""));
      await citeproc.boot();
    });

    afterEach(async function () {
      await documents.shutdown();
    });

    it("does not make the open of a document wait for the library of a loaded document", async function () {
      const cited = path.join(root, "cited.md");
      const other = path.join(root, "other.md");
      writeFileSync(
        cited,
        `---\nbibliography: ${libraryPath}\n---\n\nThe covers [@${key(1)}] exist.\n`,
      );
      writeFileSync(other, "A second document.\n");
      documents = await bootDocumentManager(root, { citeproc });
      const windowId = documents.windowKeys()[0];
      const leafId = documents.leafIds(windowId)[0];
      assert.equal(await documents.openFile(windowId, leafId, cited, true), true);
      // The editor of the tab loads the document.
      await documents.getDocument(cited);

      assert.equal(await documents.openFile(windowId, leafId, other, true), true);
      assert.deepEqual(
        citeproc.listDatabases(),
        [],
        "the open of the second document ended after the parse of the library",
      );

      assert.equal(await becomesLoaded(citeproc, libraryPath, 30000), true);
      assert.equal(citeproc.getItem(libraryPath, key(1))?.title, title(1));
    });

    it("does not make the start wait for the library of a Quarto book", async function () {
      writeFileSync(path.join(root, "index.md"), "# Covers\n");
      writeFileSync(
        path.join(root, "_quarto.yml"),
        "project:\n  type: book\nbook:\n  title: Covers\n  chapters:\n    - index.md\nbibliography:\n  - covers.bib\n",
      );
      const fsal = await bootFsal(root);

      documents = await bootDocumentManager(root, {
        citeproc,
        loadedDescriptors: async () => await fsal.getAllLoadedDescriptors(),
      });
      assert.deepEqual(
        citeproc.listDatabases(),
        [],
        "the start of the documents provider ended after the parse of the library",
      );

      assert.equal(await becomesLoaded(citeproc, libraryPath, 30000), true);
      assert.equal(citeproc.getItem(libraryPath, key(ENTRY_COUNT))?.title, title(ENTRY_COUNT));
      await fsal.shutdown();
    });
  });
});
