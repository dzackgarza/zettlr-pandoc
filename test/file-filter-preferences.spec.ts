import { strict as assert } from "assert";
import { DEFAULT_FILE_FILTER_INCLUDE } from "source/app/service-providers/config/get-config-template";
import type {
  CodeFileDescriptor,
  DirDescriptor,
  MDFileDescriptor,
  OtherFileDescriptor,
} from "source/types/common/fsal";
import {
  createFileManagerVisibilityFilter,
  type FileManagerVisibilityConfig,
} from "source/win-main/file-manager/util/filter-children";
import { buildFilePickerCache } from "source/win-main/file-manager/util/match-query";
import { getFileManagerFields } from "source/win-preferences/schema/file-manager";

const markdown = {
  path: "/notes/theorem.md",
  dir: "/notes",
  name: "theorem.md",
  type: "file",
  size: 1,
  modtime: 0,
  creationtime: 0,
  ext: ".md",
  id: "",
  tags: [],
  links: [],
  citekeys: [],
  bom: "",
  wordCount: 1,
  charCount: 1,
  firstHeading: "Theorem",
  yamlTitle: undefined,
  aliases: [],
  frontmatter: null,
  linefeed: "\n",
  references: {
    documentPath: "/notes/theorem.md",
    sourceHash: "",
    definitions: [],
    occurrences: [],
  },
} satisfies MDFileDescriptor;

const latex = {
  path: "/notes/theorem.tex",
  dir: "/notes",
  name: "theorem.tex",
  type: "code",
  size: 1,
  modtime: 0,
  creationtime: 0,
  ext: ".tex",
  bom: "",
  linefeed: "\n",
} satisfies CodeFileDescriptor;

const yaml = {
  path: "/notes/project.yaml",
  dir: "/notes",
  name: "project.yaml",
  type: "code",
  size: 1,
  modtime: 0,
  creationtime: 0,
  ext: ".yaml",
  bom: "",
  linefeed: "\n",
} satisfies CodeFileDescriptor;

const pdf = {
  path: "/notes/reference.pdf",
  dir: "/notes",
  name: "reference.pdf",
  type: "other",
  size: 1,
  modtime: 0,
  creationtime: 0,
  ext: ".pdf",
} satisfies OtherFileDescriptor;

const directory = {
  path: "/notes",
  dir: "/",
  name: "notes",
  type: "directory",
  size: 1,
  modtime: 0,
  creationtime: 0,
  settings: {
    sorting: "name-up",
    explorer: {
      displayName: "inherit",
      sortMetadataKey: "zettlr-order_",
      foldersFirst: null,
      projectFilter: "all",
    },
    icon: null,
    project: null,
    color: null,
    quartoManifest: null,
  },
  isGitRepository: false,
} satisfies DirDescriptor;

function visibilityConfig(include: string[]): FileManagerVisibilityConfig {
  return {
    attachmentExtensions: [],
    fileManager: {
      filters: { include },
    },
    files: {
      builtin: { showInFilemanager: true, openWith: "zettlr" },
      images: { showInFilemanager: true, openWith: "system" },
      pdf: { showInFilemanager: true, openWith: "system" },
      msoffice: { showInFilemanager: true, openWith: "system" },
      openOffice: { showInFilemanager: true, openWith: "system" },
      dataFiles: { showInFilemanager: true, openWith: "system" },
      dotFiles: { showInFilemanager: false, openWith: "system" },
    },
  };
}

describe("file type filter of the file manager", function () {
  it("defaults Include to all Markdown extensions", function () {
    assert.deepEqual(DEFAULT_FILE_FILTER_INCLUDE, [
      ".md",
      ".rmd",
      ".qmd",
      ".markdown",
      ".txt",
      ".mdx",
      ".mkd",
    ]);
  });

  it("shows only files with an included extension, and every folder", function () {
    const visible = createFileManagerVisibilityFilter(visibilityConfig([".md", ".yaml"]));

    assert.equal(visible(markdown), true);
    assert.equal(visible(yaml), true);
    assert.equal(visible(latex), false);
    assert.equal(visible(pdf), false);
    assert.equal(visible(directory), true);
  });

  it("builds the Ctrl+Shift+P cache from the exact file-manager-visible set", function () {
    const visible = createFileManagerVisibilityFilter(visibilityConfig([".md", ".yaml"]));
    const cache = buildFilePickerCache([markdown, yaml, latex, pdf, directory], visible);

    assert.deepEqual(cache.paths, [markdown.path, yaml.path]);
    assert.equal(cache.pathSet.has(latex.path), false);
    assert.equal(cache.pathSet.has(directory.path), false);
  });

  it("uses an empty Include list as all file types permitted by File Treatment", function () {
    const visible = createFileManagerVisibilityFilter(visibilityConfig([]));

    assert.equal(visible(markdown), true);
    assert.equal(visible(latex), true);
    assert.equal(visible(yaml), true);
    assert.equal(visible(pdf), true);
    assert.equal(visible(directory), true);
  });

  it("exposes the file types, the ignore rules and the reveal toggle in Preferences → File Manager", function () {
    const models = getFileManagerFields({ fileNameDisplay: "filename" })
      .flatMap((fieldset) => fieldset.fields)
      .flatMap((field) => ("model" in field ? [field.model] : []));

    assert.ok(models.includes("fileManager.filters.include"));
    assert.ok(models.includes("fileManager.ignoreRules"));
    assert.ok(models.includes("fileManager.showIgnored"));
  });
});
