import { strict as assert } from "assert";
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
  firstSentence: null,
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

describe("the file name search of the file manager", function () {
  it("matches the query against files of every type", function () {
    const matching = matchQuery("theorem", false, false);

    assert.equal(matching(markdown), true);
    assert.equal(matching(latex), true);
    assert.equal(matching(yaml), false);
  });
});
