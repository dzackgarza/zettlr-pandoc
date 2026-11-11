import { strict as assert } from "assert";
import { DEFAULT_FILE_FILTER_INCLUDE } from "source/app/service-providers/config/get-config-template";
import {
  createIgnoreFilter,
  EVERY_FILE_TYPE,
  type FileTypeVisibility,
} from "source/common/util/ignore-rules";
import type {
  AnyDescriptor,
  CodeFileDescriptor,
  DirDescriptor,
  MDFileDescriptor,
  OtherFileDescriptor,
} from "source/types/common/fsal";
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
  metadataProblems: [],
} satisfies DirDescriptor;

/** Whether the one filter lists a descriptor below the workspace root "/notes". */
function listedBy(fileTypes: FileTypeVisibility): (descriptor: AnyDescriptor) => boolean {
  const filter = createIgnoreFilter({
    globalRules: [],
    workspaceRules: new Map([["/notes", ""]]),
    showIgnored: false,
    fileTypes,
  });
  return (descriptor) => !filter.hides(descriptor.path, descriptor.type === "directory");
}

describe("file type filter", function () {
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

  it("lists only files with an included extension, and every folder", function () {
    const listed = listedBy({ ...EVERY_FILE_TYPE, include: [".md", ".yaml"] });

    assert.equal(listed(markdown), true);
    assert.equal(listed(yaml), true);
    assert.equal(listed(latex), false);
    assert.equal(listed(pdf), false);
    assert.equal(listed({ ...directory, path: "/notes/sub" }), true);
  });

  it("lists every file type that its type setting allows when Include is empty", function () {
    assert.equal(listedBy(EVERY_FILE_TYPE)(latex), true);
    assert.equal(listedBy(EVERY_FILE_TYPE)(pdf), true);
    assert.equal(listedBy({ ...EVERY_FILE_TYPE, pdf: false })(pdf), false);
  });

  it("lists a dot path only when dot files are on, a file below a dot folder included", function () {
    const dotFile = { ...markdown, path: "/notes/.hidden.md" };
    const belowDotFolder = { ...markdown, path: "/notes/.git-notes/theorem.md" };
    const off = listedBy({ ...EVERY_FILE_TYPE, dotFiles: false });
    assert.equal(off(dotFile), false);
    assert.equal(off(belowDotFolder), false);
    assert.equal(listedBy(EVERY_FILE_TYPE)(belowDotFolder), true);
  });

  it("lists an unknown file type only with an extension in attachmentExtensions", function () {
    const archive = { ...pdf, path: "/notes/data.zip", ext: ".zip" };
    assert.equal(listedBy(EVERY_FILE_TYPE)(archive), false);
    assert.equal(listedBy({ ...EVERY_FILE_TYPE, attachmentExtensions: [".zip"] })(archive), true);
  });

  it("builds the Ctrl+Shift+P cache from every file the FSAL lists", function () {
    const cache = buildFilePickerCache([markdown, yaml, latex, pdf, directory]);

    assert.deepEqual(cache.paths, [markdown.path, yaml.path, latex.path, pdf.path]);
    assert.equal(cache.pathSet.has(directory.path), false);
  });

  it("edits the file filters on the File Manager page of Preferences only through the file filter window", function () {
    const fields = getFileManagerFields({ fileNameDisplay: "filename" }).flatMap(
      (fieldset) => fieldset.fields,
    );
    const models = fields.flatMap((field) => ("model" in field ? [field.model] : []));
    const labels = fields.flatMap((field) => (field.type === "button" ? [field.label] : []));

    for (const model of [
      "fileManager.filters.include",
      "fileManager.ignoreRules",
      "fileManager.showIgnored",
    ]) {
      assert.ok(!models.includes(model), `${model} has no second editor in Preferences`);
    }
    assert.ok(labels.includes("Edit file filters…"));
  });
});
