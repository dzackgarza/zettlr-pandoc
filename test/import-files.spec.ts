/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Tests of the file import
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     An import puts a new file into a folder of the author. It
 *                  replaces no file that the folder has, and it gives each
 *                  file that it did not import a result with the cause.
 *                  These tests run the real importer, the real assets
 *                  provider and the real pandoc over directories on disk.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ZIP from "adm-zip";
import AssetsProvider from "source/app/service-providers/assets";
import makeImport from "source/app/service-providers/commands/importer";
import ConfigProvider from "source/app/service-providers/config";
import type FSAL from "source/app/service-providers/fsal";
import LogProvider from "source/app/service-providers/log";
import type { DirDescriptor } from "source/types/common/fsal";
import { bootFsal } from "./fsal-seam";
import { userData } from "./headless-electron-harness.cjs";
import { unexpectedStoreWriteFailure } from "./store-write-failure";

/** The text of a note that the author wrote in the import folder. */
const AUTHORED = "# Genus\n\nTwo forms of one genus.\n";

/** The text of a note that an import brings. */
const INCOMING = "# Spinor genus\n\nA form of one spinor genus.\n";

/** The bytes of a figure that the author keeps in the import folder. */
const AUTHORED_FIGURE = Buffer.from("the figure of the author");

/** The bytes of a figure that an import brings. */
const INCOMING_FIGURE = Buffer.from("the figure of the bundle");

const HTML_PAGE = [
  "<!doctype html>",
  "<html><head><title>Lattices</title></head>",
  "<body><h1>Even unimodular lattices</h1><p>Rank eight.</p></body></html>",
  "",
].join("\n");

/** The shipped import profiles that the specs use. */
const PROFILES = ["HTML to Markdown.yaml", "Microsoft Word to Markdown.yaml"];

describe("File import", function () {
  let root: string;
  let sources: string;
  let fsal: FSAL;
  let assets: AssetsProvider;
  let target: DirDescriptor;

  /** A TextBundle in the sources directory with one figure. */
  async function textbundle(name: string): Promise<string> {
    const bundle = path.join(sources, `${name}.textbundle`);
    await mkdir(path.join(bundle, "assets"), { recursive: true });
    await writeFile(path.join(bundle, "text.md"), INCOMING);
    await writeFile(path.join(bundle, "info.json"), '{"version":2}\n');
    await writeFile(path.join(bundle, "assets", "figure.png"), INCOMING_FIGURE);
    return bundle;
  }

  /** The result of each file of one import, in the order of the files. */
  async function resultsOf(files: string[]): Promise<string[]> {
    const outcomes = await makeImport(files, target, assets);
    return outcomes.map((outcome) => outcome.result);
  }

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-import-target-"));
    sources = await mkdtemp(path.join(tmpdir(), "zettlr-import-sources-"));

    const defaults = path.join(userData, "defaults");
    await mkdir(defaults, { recursive: true });
    for (const profile of PROFILES) {
      await copyFile(path.resolve("static", "defaults", profile), path.join(defaults, profile));
    }

    const log = new LogProvider();
    assets = new AssetsProvider(
      log,
      new ConfigProvider(log, [path.resolve("static", "lang")], unexpectedStoreWriteFailure),
    );
    fsal = await bootFsal(root);
  });

  beforeEach(async function () {
    for (const entry of await readdir(root)) {
      await rm(path.join(root, entry), { recursive: true });
    }
    for (const entry of await readdir(sources)) {
      await rm(path.join(sources, entry), { recursive: true });
    }
    target = await fsal.getAnyDirectoryDescriptor(root);
  });

  after(async function () {
    await fsal.shutdown();
    await assets.shutdown();
    await rm(root, { recursive: true });
    await rm(sources, { recursive: true });
  });

  it("puts a Markdown file into the folder", async function () {
    const source = path.join(sources, "spinor.markdown");
    await writeFile(source, INCOMING);

    await makeImport([source], target, assets);

    assert.equal(await readFile(path.join(root, "spinor.md"), "utf8"), INCOMING);
  });

  it("keeps a note of the folder that has the name of an imported Markdown file", async function () {
    const source = path.join(sources, "genus.md");
    await writeFile(source, INCOMING);
    await writeFile(path.join(root, "genus.md"), AUTHORED);

    const results = await resultsOf([source]);

    assert.equal(await readFile(path.join(root, "genus.md"), "utf8"), AUTHORED);
    assert.deepEqual(results, ["destination-exists"]);
  });

  it("imports the other files of a list with one refused file", async function () {
    const refused = path.join(sources, "genus.md");
    const imported = path.join(sources, "spinor.md");
    await writeFile(refused, INCOMING);
    await writeFile(imported, INCOMING);
    await writeFile(path.join(root, "genus.md"), AUTHORED);

    const results = await resultsOf([refused, imported]);

    assert.equal(await readFile(path.join(root, "genus.md"), "utf8"), AUTHORED);
    assert.equal(await readFile(path.join(root, "spinor.md"), "utf8"), INCOMING);
    assert.deepEqual(results, ["destination-exists", "imported"]);
  });

  it("keeps a note of the folder that has the name of an imported TextBundle", async function () {
    const bundle = await textbundle("genus");
    await writeFile(path.join(root, "genus.md"), AUTHORED);

    const results = await resultsOf([bundle]);

    assert.equal(await readFile(path.join(root, "genus.md"), "utf8"), AUTHORED);
    assert.deepEqual(await readdir(root), ["genus.md"], "no figure of the refused bundle arrives");
    assert.deepEqual(results, ["destination-exists"]);
  });

  it("keeps a figure of the folder that has the name of a figure of a TextBundle", async function () {
    const bundle = await textbundle("spinor");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "figure.png"), AUTHORED_FIGURE);

    const results = await resultsOf([bundle]);

    assert.deepEqual(await readFile(path.join(root, "assets", "figure.png")), AUTHORED_FIGURE);
    assert.deepEqual(await readdir(root), ["assets"], "no text of the refused bundle arrives");
    assert.deepEqual(results, ["destination-exists"]);
  });

  it("puts the text and the figures of a TextPack into the folder", async function () {
    const bundle = await textbundle("spinor");
    const pack = new ZIP();
    pack.addLocalFolder(bundle, "spinor.textbundle");
    const source = path.join(sources, "spinor.textpack");
    pack.writeZip(source);

    await makeImport([source], target, assets);

    assert.equal(await readFile(path.join(root, "spinor.md"), "utf8"), INCOMING);
    assert.deepEqual(await readFile(path.join(root, "assets", "figure.png")), INCOMING_FIGURE);
  });

  it("puts the Markdown that pandoc makes of an HTML file into the folder", async function () {
    const source = path.join(sources, "lattices.html");
    await writeFile(source, HTML_PAGE);

    await makeImport([source], target, assets);

    assert.equal(
      await readFile(path.join(root, "lattices.md"), "utf8"),
      "# Even unimodular lattices\n\nRank eight.\n",
    );
  });

  it("keeps a note of the folder that has the name of an imported HTML file", async function () {
    const source = path.join(sources, "genus.html");
    await writeFile(source, HTML_PAGE);
    await writeFile(path.join(root, "genus.md"), AUTHORED);

    const results = await resultsOf([source]);

    assert.equal(await readFile(path.join(root, "genus.md"), "utf8"), AUTHORED);
    assert.deepEqual(results, ["destination-exists"]);
  });

  it("gives a file that pandoc cannot read a result and no note", async function () {
    const source = path.join(sources, "thesis.docx");
    await writeFile(source, "These bytes are no Word document.\n");

    const results = await resultsOf([source]);

    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(results, ["conversion-failed"]);
  });

  it("gives a file that is not there a result", async function () {
    const results = await resultsOf([path.join(sources, "removed.md")]);

    assert.deepEqual(results, ["source-missing"]);
  });

  it("gives a file of no known type a result", async function () {
    const source = path.join(sources, "table.xyz");
    await writeFile(source, "1 2 3\n");

    const results = await resultsOf([source]);

    assert.deepEqual(results, ["unknown-format"]);
  });
});
