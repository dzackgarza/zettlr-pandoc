import { strict as assert } from "assert";
import type {
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
} satisfies DirDescriptor;

describe("file filters of the file manager", function () {
  it("builds the Ctrl+Shift+P cache from every listed file of any type", function () {
    const cache = buildFilePickerCache([markdown, yaml, latex, pdf, directory]);

    assert.deepEqual(cache.paths, [markdown.path, yaml.path, latex.path, pdf.path]);
    assert.equal(cache.pathSet.has(directory.path), false);
  });

  it("edits the rules on the File Manager page of Preferences only through the file filter dialog", function () {
    const fields = getFileManagerFields({ fileNameDisplay: "filename" }).flatMap(
      (fieldset) => fieldset.fields,
    );
    const models = fields.flatMap((field) => ("model" in field ? [field.model] : []));
    const labels = fields.flatMap((field) => (field.type === "button" ? [field.label] : []));

    assert.ok(!models.includes("fileManager.ignoreRules"));
    assert.ok(labels.includes("Edit file filters…"));
  });
});
