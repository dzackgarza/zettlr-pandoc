import { strict as assert } from "assert";
import { existsSync, promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  CentralFiguresDirectoryNotFoundError,
  listCentralFigures,
  readCentralFigure,
  resolveCentralFiguresDirectory,
  searchCentralFigures,
  writeCentralFigure,
} from "source/app/util/central-figures-store";

describe("central figures directory resolution", function () {
  it("uses explicit configuration before environment and canonical fallback", function () {
    const home = path.join(path.sep, "home", "author");
    const configured = path.join(path.sep, "srv", "figures");
    const environment = path.join(path.sep, "env", "figures");
    assert.equal(
      resolveCentralFiguresDirectory(configured, home, { FIGURES_SOURCE_DIR: environment }),
      configured,
    );
  });

  it("uses FIGURES_SOURCE_DIR when no explicit figures directory is configured", function () {
    const home = path.join(path.sep, "home", "author");
    const environment = path.join(path.sep, "env", "figures");
    assert.equal(
      resolveCentralFiguresDirectory("", home, { FIGURES_SOURCE_DIR: environment }),
      environment,
    );
  });

  it("falls back to the canonical ~/.pandoc/figures tree", function () {
    const home = path.join(path.sep, "home", "author");
    assert.equal(
      resolveCentralFiguresDirectory("", home, {}),
      path.join(home, ".pandoc", "figures"),
    );
  });
});

describe("the central figures directory as a store (#210)", function () {
  let root: string;

  beforeEach(async function () {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "zettlr-figures-"));
    await fs.mkdir(path.join(root, "diagrams"));
    await fs.writeFile(path.join(root, "diagrams", "cone.tikz"), "\\draw (0,0) -- (1,1); % cone\n");
  });

  afterEach(async function () {
    for (const folder of ["locked", "diagrams"]) {
      const folderPath = path.join(root, folder);
      if (existsSync(folderPath)) await fs.chmod(folderPath, 0o755);
    }
    await fs.rm(root, { recursive: true });
  });

  it("refuses to write a figure without write permission and keeps its bytes", async function () {
    const figure = path.join(root, "diagrams", "cone.tikz");
    await fs.chmod(figure, 0o444);
    await assert.rejects(
      writeCentralFigure(root, "diagrams/cone.tikz", "\\draw (0,0) circle (1);\n", "utf8"),
      (error: NodeJS.ErrnoException) => error.code === "EACCES",
    );
    assert.equal(await fs.readFile(figure, "utf8"), "\\draw (0,0) -- (1,1); % cone\n");
  });

  it("writes a figure with a second name into the one file that both names are", async function () {
    const figure = path.join(root, "diagrams", "cone.tikz");
    const otherName = path.join(root, "cone-link.tikz");
    await fs.link(figure, otherName);
    await writeCentralFigure(root, "diagrams/cone.tikz", "\\draw (0,0) circle (1);\n", "utf8");
    assert.equal(await fs.readFile(otherName, "utf8"), "\\draw (0,0) circle (1);\n");
    assert.equal((await fs.stat(figure)).ino, (await fs.stat(otherName)).ino);
  });

  it("keeps the mode of a figure that a write replaces", async function () {
    const figure = path.join(root, "diagrams", "cone.tikz");
    await fs.chmod(figure, 0o600);
    await writeCentralFigure(root, "diagrams/cone.tikz", "\\draw (0,0) circle (1);\n", "utf8");
    assert.equal((await fs.stat(figure)).mode & 0o777, 0o600);
  });

  it("names a figures directory that does not exist for a list, a search and a read", async function () {
    const absent = path.join(root, "no-such-figures");
    await assert.rejects(listCentralFigures(absent), CentralFiguresDirectoryNotFoundError);
    await assert.rejects(
      searchCentralFigures(absent, "cone"),
      CentralFiguresDirectoryNotFoundError,
    );
    await assert.rejects(
      readCentralFigure(absent, "diagrams/cone.tikz"),
      CentralFiguresDirectoryNotFoundError,
    );
  });

  it("lists the other figures and names a folder that it cannot read", async function () {
    await fs.mkdir(path.join(root, "locked"));
    await fs.writeFile(path.join(root, "locked", "hidden.tikz"), "% cone\n");
    await fs.chmod(path.join(root, "locked"), 0o000);
    const listing = await listCentralFigures(root);
    assert.deepEqual(
      listing.entries.map((entry) => entry.path),
      ["diagrams", "locked", "diagrams/cone.tikz"],
    );
    assert.deepEqual(
      listing.notListed?.map((entry) => entry.path),
      ["locked"],
    );
  });

  it("searches the other figures and names a figure that it cannot read", async function () {
    await fs.writeFile(path.join(root, "diagrams", "locked.tikz"), "% cone\n");
    await fs.chmod(path.join(root, "diagrams", "locked.tikz"), 0o000);
    const result = await searchCentralFigures(root, "cone");
    assert.deepEqual(
      result.hits.map((hit) => `${hit.matchType}:${hit.path}`),
      ["path:diagrams/cone.tikz", "content:diagrams/cone.tikz"],
    );
    assert.deepEqual(
      result.notSearched?.map((entry) => entry.path),
      ["diagrams/locked.tikz"],
    );
  });
});
