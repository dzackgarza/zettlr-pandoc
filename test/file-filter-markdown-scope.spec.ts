import { strict as assert } from "assert";
import { defaultKeybindings } from "source/app/service-providers/menu/shortcuts";
import type { CodeFileDescriptor, MDFileDescriptor } from "source/types/common/fsal";
import matchQuery from "source/win-main/file-manager/util/match-query";

const markdown: MDFileDescriptor = {
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
};

const latex: CodeFileDescriptor = {
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
};

const yaml: CodeFileDescriptor = {
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
};

describe("Ctrl+Shift+P file picker", function () {
  it("keeps Ctrl+Shift+P/Cmd+Shift+P as the file-picker shortcut", function () {
    assert.deepEqual(defaultKeybindings["filter-files"], {
      key: "Ctrl-Shift-p",
      mac: "Cmd-Shift-p",
    });
  });

  it("matches the query against files of every type", function () {
    const matching = matchQuery("theorem", false, false);

    assert.equal(matching(markdown), true);
    assert.equal(matching(latex), true);
    assert.equal(matching(yaml), false);
  });
});
