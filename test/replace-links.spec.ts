import { ChangeSet, Text } from "@codemirror/state";
import { type PathMove, retargetLinks } from "@common/util/replace-links";
import { type WikilinkDocument, WikilinkIndex } from "@common/util/wikilink-resolution";
import { strictEqual } from "assert";

/**
 * The text after the retargeting replacements, applied as a workspace edit
 * applies them. `files` are the files on disk after the move.
 */
function retargeted(
  markdown: string,
  sourcePath: string,
  move: PathMove,
  before: WikilinkIndex,
  after: WikilinkIndex,
  files: string[] = [],
): string {
  const replacements = retargetLinks(
    markdown,
    sourcePath,
    move,
    before,
    after,
    "link|title",
    (filePath) => files.includes(filePath),
  );
  const changes = ChangeSet.of(
    replacements.map(({ from, to, text }) => ({ from, to, insert: text })),
    markdown.length,
  );
  return changes.apply(Text.of(markdown.split("\n"))).toString();
}

const root = "/ws";
const sourcePath = `${root}/programs/source.md`;

function document(relativePath: string, extra: Partial<WikilinkDocument> = {}): WikilinkDocument {
  return { path: `${root}/${relativePath}`, root, id: "", title: undefined, aliases: [], ...extra };
}

describe("Link retargeting after a rename", function () {
  const others = [document("programs/source.md"), document("elsewhere/zettelkasten-luhmann.md")];
  const before = new WikilinkIndex([
    ...others,
    document("notes/zettelkasten.md", { id: "20240101120000", aliases: ["ZK"] }),
  ]);
  const after = new WikilinkIndex([
    ...others,
    document("notes/luhmann-zettelkasten.md", { id: "20240101120000", aliases: ["ZK"] }),
  ]);
  const move = {
    from: `${root}/notes/zettelkasten.md`,
    to: `${root}/notes/luhmann-zettelkasten.md`,
  };

  it("gives every link that named the old path the new written form, keeping heading and label", function () {
    const markdown = [
      "See [[zettelkasten]], [[Zettelkasten.md|the method]] and [[notes/zettelkasten#Origins|origins]].",
      "A relative link: [[../notes/zettelkasten.md]].",
      "",
    ].join("\n");
    strictEqual(
      retargeted(markdown, sourcePath, move, before, after),
      [
        "See [[luhmann-zettelkasten]], [[luhmann-zettelkasten|the method]] and [[luhmann-zettelkasten#Origins|origins]].",
        "A relative link: [[luhmann-zettelkasten]].",
        "",
      ].join("\n"),
    );
  });

  it("keeps links by ID or alias, and links to other documents", function () {
    const markdown =
      "By ID [[20240101120000]], by alias [[ZK]], and another [[zettelkasten-luhmann]].\n";
    strictEqual(retargeted(markdown, sourcePath, move, before, after), markdown);
  });
});

describe("Link retargeting after a directory rename", function () {
  const unmoved = [document("index.md"), document("deep/x/lemma.md"), document("notes/basis.md")];
  const before = new WikilinkIndex([
    ...unmoved,
    document("other/lemma.md"),
    document("other/chain.md"),
  ]);
  const after = new WikilinkIndex([...unmoved, document("x/lemma.md"), document("x/chain.md")]);
  const move = { from: `${root}/other`, to: `${root}/x` };

  it("retargets a name the rename gave to another document, and a relative link into the directory", function () {
    const markdown = "Lemma [[x/lemma]], chain [[./other/chain.md#Step]], basis [[basis]].\n";
    strictEqual(
      retargeted(markdown, `${root}/index.md`, move, before, after),
      "Lemma [[deep/x/lemma]], chain [[chain#Step]], basis [[basis]].\n",
    );
  });

  it("retargets a relative link out of the renamed directory, read from its old location", function () {
    const markdown = "Basis [[../notes/basis.md]], sibling [[./lemma.md]].\n";
    strictEqual(
      retargeted(
        markdown,
        `${root}/other/chain.md`,
        { from: `${root}/other`, to: `${root}/x/sub` },
        before,
        new WikilinkIndex([...unmoved, document("x/sub/lemma.md"), document("x/sub/chain.md")]),
      ),
      "Basis [[basis]], sibling [[./lemma.md]].\n",
    );
  });
});

describe("Markdown link and image retargeting after a move", function () {
  const empty = new WikilinkIndex([]);
  const move = { from: `${root}/programs/chain.md`, to: `${root}/archive/2026/chain.md` };
  const files = [
    `${root}/archive/2026/chain.md`,
    `${root}/programs/plot.png`,
    `${root}/notes/basis.md`,
  ];

  it("keeps a link to the moved file relative, with its ./ and its fragment", function () {
    strictEqual(
      retargeted(
        "Read [the chain](./programs/chain.md#second-step) and [the basis](notes/basis.md).\n",
        `${root}/index.md`,
        move,
        empty,
        empty,
        files,
      ),
      "Read [the chain](./archive/2026/chain.md#second-step) and [the basis](notes/basis.md).\n",
    );
  });

  it("keeps the relative links of the moved file reaching their files", function () {
    strictEqual(
      retargeted(
        'See [basis](../notes/basis.md) and ![a plot](plot.png "Plot").\n',
        `${root}/programs/chain.md`,
        move,
        empty,
        empty,
        files,
      ),
      'See [basis](../../notes/basis.md) and ![a plot](../../programs/plot.png "Plot").\n',
    );
  });

  it("keeps the angle brackets and the percent-encoding of a path with a space", function () {
    const rename = { from: `${root}/notes/the plan.md`, to: `${root}/notes/the outline.md` };
    strictEqual(
      retargeted(
        "[a](<notes/the plan.md>), [b](notes/the%20plan.md?x=1)\n",
        `${root}/index.md`,
        rename,
        empty,
        empty,
        [rename.to],
      ),
      "[a](<notes/the outline.md>), [b](notes/the%20outline.md?x=1)\n",
    );
  });

  it("leaves a URL with a scheme, an anchor and a link to no file as written", function () {
    const markdown =
      "[web](https://example.com/programs/chain.md), [top](#index), [none](./programs/nothing.md)\n";
    strictEqual(retargeted(markdown, `${root}/index.md`, move, empty, empty, files), markdown);
  });

  it("retargets an absolute path as an absolute path", function () {
    strictEqual(
      retargeted(`[c](${root}/programs/chain.md)\n`, `${root}/index.md`, move, empty, empty, files),
      `[c](${root}/archive/2026/chain.md)\n`,
    );
  });
});
