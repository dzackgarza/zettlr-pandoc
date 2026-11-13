/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL tests of directory metadata that cannot be used
 * CVM-Role:        TESTING
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     A workspace holds folders whose settings file or Quarto
 *                  manifest cannot be read or parsed, and a folder that
 *                  refuses its content. The FSAL indexes the workspace,
 *                  lists each folder with the cause, and keeps each file as
 *                  the author left it. These tests run the real FSAL and
 *                  its real watcher over a directory on disk.
 *
 * END HEADER
 */

import "./headless-electron-harness.cjs";
import { strict as assert } from "node:assert";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type FSAL from "source/app/service-providers/fsal";
import type { FSALEventPayload } from "source/app/service-providers/fsal";
import { DirectorySettingsUnreadableError } from "source/app/service-providers/fsal/fsal-directory";
import type { DirDescriptor } from "source/types/common/fsal";
import { bootFsal } from "./fsal-seam";
import { invokeMain } from "./main-ipc";

/** A settings file with the conflict markers of an unfinished git merge. */
const CONFLICTED_SETTINGS = [
  "<<<<<<< HEAD",
  '{"sorting":"name-down","icon":"book","color":"blue"}',
  "=======",
  '{"sorting":"time-up","icon":"book","color":"red"}',
  ">>>>>>> theirs",
  "",
].join("\n");

const BOOK_MANIFEST = [
  "project:",
  "  type: book",
  "book:",
  "  title: Genera of lattices",
  "  chapters:",
  "    - genus.md",
  "",
].join("\n");

const WEBSITE_MANIFEST = ["project:", "  type: website", "website:", "  title: Notes", ""].join(
  "\n",
);

/** The sources and the files of the problems of a directory. */
function problemsOf(descriptor: DirDescriptor): string[][] {
  return descriptor.metadataProblems.map((problem) => [problem.source, problem.path]);
}

describe("FSAL: directory metadata that cannot be used", function () {
  let root: string;
  let fsal: FSAL;
  const published: FSALEventPayload[] = [];

  let conflicted: string;
  let unreadableSettings: string;
  let website: string;
  let brokenManifest: string;
  let bookWithoutChapters: string;
  let boundToWebsite: string;
  let boundToNothing: string;
  let locked: string;
  let folders: string[];

  /** The descriptor that the FSAL reads from disk for a folder. */
  async function directory(directoryPath: string): Promise<DirDescriptor> {
    const descriptor = await fsal.getDescriptorFor(directoryPath, false);
    assert.equal(descriptor.type, "directory", `${directoryPath} is listed as a folder`);
    return descriptor as DirDescriptor;
  }

  /** A folder of the workspace with one note in it. */
  async function folder(name: string): Promise<string> {
    const folderPath = path.join(root, name);
    await mkdir(folderPath);
    await writeFile(path.join(folderPath, "genus.md"), "# Genus\n\nTwo forms of one genus.\n");
    return folderPath;
  }

  /** A folder that is bound to the manifest `.book/_quarto.yml` in it. */
  async function boundFolder(name: string, manifest: string | null): Promise<string> {
    const folderPath = await folder(name);
    await mkdir(path.join(folderPath, ".book"));
    const manifestPath = path.join(folderPath, ".book", "_quarto.yml");
    // The application writes the binding itself, for a manifest of a book.
    await writeFile(manifestPath, BOOK_MANIFEST.replace("genus.md", "../genus.md"));
    const bound = await fsal.bindQuartoManifest(
      await directory(folderPath),
      path.join(".book", "_quarto.yml"),
    );
    assert.equal(bound.kind, "bound");
    if (manifest === null) {
      await rm(manifestPath);
    } else {
      await writeFile(manifestPath, manifest);
    }
    return folderPath;
  }

  before(async function () {
    root = await mkdtemp(path.join(tmpdir(), "zettlr-fsal-directory-metadata-"));
    await writeFile(path.join(root, "note.md"), "# Lattices\n\nAn even unimodular lattice.\n");

    conflicted = await folder("conflicted");
    await writeFile(path.join(conflicted, ".ztr-directory"), CONFLICTED_SETTINGS);

    website = await folder("website");
    await writeFile(path.join(website, "_quarto.yml"), WEBSITE_MANIFEST);

    brokenManifest = await folder("broken-manifest");
    await writeFile(path.join(brokenManifest, "_quarto.yml"), "project: [type: book\n");

    bookWithoutChapters = await folder("book-without-chapters");
    await writeFile(
      path.join(bookWithoutChapters, "_quarto.yml"),
      "project:\n  type: book\nbook:\n  title: Genera of lattices\n",
    );

    unreadableSettings = await folder("unreadable-settings");
    locked = await folder("locked");

    fsal = await bootFsal(root);
    fsal.on("fsal-events", (events) => published.push(...events));

    // The application writes these settings files itself.
    await fsal.changeSorting(await directory(unreadableSettings), "name-down");
    await chmod(path.join(unreadableSettings, ".ztr-directory"), 0o000);
    boundToWebsite = await boundFolder("bound-to-website", WEBSITE_MANIFEST);
    boundToNothing = await boundFolder("bound-to-nothing", null);
    await chmod(locked, 0o000);

    folders = [
      conflicted,
      unreadableSettings,
      website,
      brokenManifest,
      bookWithoutChapters,
      boundToWebsite,
      boundToNothing,
      locked,
    ];
  });

  after(async function () {
    await fsal.shutdown();
    await chmod(locked, 0o700);
    await chmod(path.join(unreadableSettings, ".ztr-directory"), 0o600);
    await rm(root, { recursive: true, force: true });
  });

  it("indexes the workspace that holds the folders", async function () {
    await fsal.reindexFiles();
    const note = await fsal.getDescriptorFor(path.join(root, "note.md"));
    assert.equal(note.type === "file" ? note.firstHeading : null, "Lattices");
  });

  it("lists every folder among the paths of the workspace", async function () {
    const listing = await fsal.readDirectoryRecursively(root);
    const listed = new Set(listing.paths);
    assert.deepEqual(
      folders.filter((folderPath) => !listed.has(folderPath)),
      [],
      "each folder is a path of the workspace",
    );
    assert.deepEqual(
      listing.notListed.map((folder) => folder.path),
      [locked],
      "the listing names the folder whose content it does not hold",
    );
  });

  it("answers the descriptors of every path that a window asks for", async function () {
    const descriptors = await invokeMain("fsal", { command: "get-descriptor", payload: folders });
    assert.ok(Array.isArray(descriptors), "a list of paths is answered with a list of descriptors");
    assert.deepEqual(
      descriptors.map((descriptor) => [descriptor.type, descriptor.path]),
      folders.map((folderPath) => ["directory", folderPath]),
    );
  });

  it("keeps a settings file that it cannot parse, and names the file", async function () {
    const settingsFile = path.join(conflicted, ".ztr-directory");
    const descriptor = await directory(conflicted);
    assert.equal(await readFile(settingsFile, "utf8"), CONFLICTED_SETTINGS);
    assert.deepEqual(problemsOf(descriptor), [["settings", settingsFile]]);
    assert.equal(descriptor.settings.sorting, "name-up", "the folder has the default settings");
  });

  it("keeps a settings file that it may not read, and names the file", async function () {
    const settingsFile = path.join(unreadableSettings, ".ztr-directory");
    const descriptor = await directory(unreadableSettings);
    assert.ok((await lstat(settingsFile)).isFile(), "the settings file is on disk");
    assert.deepEqual(problemsOf(descriptor), [["settings", settingsFile]]);
  });

  it("refuses a change of settings that it could not read", async function () {
    const settingsFile = path.join(conflicted, ".ztr-directory");
    await assert.rejects(
      fsal.changeSorting(await directory(conflicted), "time-down"),
      DirectorySettingsUnreadableError,
    );
    await assert.rejects(
      fsal.setDirectorySetting(await directory(conflicted), { icon: null }),
      DirectorySettingsUnreadableError,
    );
    assert.equal(await readFile(settingsFile, "utf8"), CONFLICTED_SETTINGS);
  });

  it("lists a folder with the manifest of a Quarto website as a plain folder", async function () {
    const descriptor = await directory(website);
    assert.equal(descriptor.settings.project, null);
    assert.deepEqual(problemsOf(descriptor), []);
  });

  it("names a manifest that is not YAML", async function () {
    const descriptor = await directory(brokenManifest);
    assert.equal(descriptor.settings.project, null);
    assert.deepEqual(problemsOf(descriptor), [
      ["manifest", path.join(brokenManifest, "_quarto.yml")],
    ]);
  });

  it("names the manifest of a book that has no chapters", async function () {
    const descriptor = await directory(bookWithoutChapters);
    assert.equal(descriptor.settings.project, null);
    assert.deepEqual(problemsOf(descriptor), [
      ["manifest", path.join(bookWithoutChapters, "_quarto.yml")],
    ]);
  });

  it("names the manifest of a binding that is not the manifest of a book", async function () {
    const descriptor = await directory(boundToWebsite);
    assert.equal(descriptor.settings.project, null);
    assert.equal(descriptor.settings.quartoManifest, path.join(".book", "_quarto.yml"));
    assert.deepEqual(problemsOf(descriptor), [
      ["manifest", path.join(boundToWebsite, ".book", "_quarto.yml")],
    ]);
  });

  it("names the manifest of a binding that is gone", async function () {
    const descriptor = await directory(boundToNothing);
    assert.equal(descriptor.settings.project, null);
    assert.equal(descriptor.settings.quartoManifest, path.join(".book", "_quarto.yml"));
    assert.deepEqual(problemsOf(descriptor), [
      ["manifest", path.join(boundToNothing, ".book", "_quarto.yml")],
    ]);
  });

  it("lists a folder that refuses its content, with the cause", async function () {
    const descriptor = await directory(locked);
    assert.equal(descriptor.dirNotFoundFlag, undefined, "the folder is on disk");
    assert.deepEqual(problemsOf(descriptor), [["directory", locked]]);
  });

  it("reads the manifest of a folder again when the manifest changes", async function () {
    const manifest = path.join(brokenManifest, "_quarto.yml");
    const book = (): DirDescriptor | undefined =>
      published
        .filter((payload) => payload.event === "change" && "descriptor" in payload)
        .map((payload) => ("descriptor" in payload ? payload.descriptor : undefined))
        .find(
          (descriptor): descriptor is DirDescriptor =>
            descriptor?.type === "directory" &&
            descriptor.path === brokenManifest &&
            descriptor.settings.project !== null,
        );

    // The watcher reports nothing before its first scan ends, so the write
    // repeats until the FSAL publishes the folder.
    const deadline = Date.now() + 20_000;
    let writes = 0;
    while (book() === undefined && Date.now() < deadline) {
      writes += 1;
      await writeFile(manifest, `${BOOK_MANIFEST}# Write ${writes}\n`);
      await sleep(250);
    }
    const descriptor = book();
    assert.ok(descriptor !== undefined, "the FSAL must publish the folder with its book");
    assert.deepEqual(problemsOf(descriptor), []);
    assert.deepEqual(descriptor.settings.project?.files, ["genus.md"]);
  });
});

describe("FSAL: the listing of a missing workspace", function () {
  let parent: string;
  let fsal: FSAL | undefined;

  beforeEach(async function () {
    parent = await mkdtemp(path.join(tmpdir(), "zettlr-fsal-missing-workspace-"));
  });

  afterEach(async function () {
    await fsal?.shutdown();
    fsal = undefined;
    await chmod(parent, 0o700);
    await rm(parent, { recursive: true, force: true });
  });

  it("lists no path of a workspace whose rules file it cannot read", async function () {
    const root = path.join(parent, "notes");
    await mkdir(root);
    await writeFile(path.join(root, "genus.md"), "# Genus\n");
    await writeFile(path.join(root, ".zettlrignore"), "drafts/\n");
    await chmod(path.join(root, ".zettlrignore"), 0o000);
    fsal = await bootFsal(root);

    const listing = await fsal.readDirectoryRecursively(root);
    assert.deepEqual(listing.paths, [root], "the rules that hide paths are not known");
    assert.deepEqual(
      listing.notListed.map((folder) => folder.path),
      [root],
    );
    await chmod(path.join(root, ".zettlrignore"), 0o600);
  });

  it("names a workspace whose folder the filesystem does not let it examine", async function () {
    const root = path.join(parent, "notes");
    await mkdir(root);
    await writeFile(path.join(root, "genus.md"), "# Genus\n");
    // Without search permission on the parent the root cannot be examined.
    await chmod(parent, 0o600);
    fsal = await bootFsal(root);

    const listing = await fsal.readDirectoryRecursively(root);
    assert.deepEqual(listing.paths, [root]);
    assert.deepEqual(
      listing.notListed.map((folder) => folder.path),
      [root],
    );
  });
});
