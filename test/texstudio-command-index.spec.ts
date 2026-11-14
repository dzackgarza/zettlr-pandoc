import { strict as assert } from "node:assert";
import { rm } from "fs/promises";
import path from "path";
import { lintDocumentText } from "source/app/util/document-lint";
import { buildTexCommandAuthority } from "source/common/util/texstudio-command-index";
import { flowmarkTexVocabulary, type TexVocabularyHome } from "./flowmark-tex-vocabulary-fixture";

const bs = String.fromCharCode(92);

// Commands of the TeX core, of amsmath, of mathtools, of the amsart class,
// and of no package
const WITNESSES = ["section", "operatorname", "xmapsto", "MRhref", "notAnyCommand"].map(
  (name) => bs + name,
);

/** The witnesses that Flowmark's `tex/unknown-command` reports in a document. */
async function flaggedByFlowmark(home: TexVocabularyHome, preamble: string): Promise<Set<string>> {
  const text = preamble + WITNESSES.map((command) => "$" + command + "{a}$").join(" ") + "\n";
  const outcome = await lintDocumentText(text, path.join(home.home, "doc.md"), home.context);
  assert.ok(outcome.complete, outcome.failure?.message);
  return new Set(
    outcome.diagnostics
      .filter((diagnostic) => diagnostic.rule === "tex/unknown-command")
      .map((diagnostic) => text.slice(diagnostic.from, diagnostic.to)),
  );
}

// The command `tex-command-vocabulary` answers the index and the packages that
// Flowmark's `tex/unknown-command` reads; the completion offers the commands
// that the rule accepts (#118).
describe("the TeX vocabulary of Flowmark", function () {
  this.timeout(120_000);

  let bare: TexVocabularyHome;
  let withMathtools: TexVocabularyHome;

  before(async function () {
    bare = await flowmarkTexVocabulary("base.tex", bs + "newcommand{" + bs + "ZZ}{x}\n");
    withMathtools = await flowmarkTexVocabulary("base.sty", bs + "RequirePackage{mathtools}\n");
  });

  after(async function () {
    await rm(bare.home, { recursive: true, force: true });
    await rm(withMathtools.home, { recursive: true, force: true });
  });

  it("is the TeXstudio corpus that Flowmark pins", function () {
    assert.equal(bare.vocabulary.index.schema, 1);
    assert.equal(bare.vocabulary.index.source.commit, "263f2615005cdbe5c24d4ee9a7c5746f731e25ac");
  });

  it("loads the packages that a central macro source requires, with their closure", function () {
    assert.ok(!bare.vocabulary.packages.includes("mathtools"));
    for (const name of ["mathtools", "amsmath", "amsopn"]) {
      assert.ok(withMathtools.vocabulary.packages.includes(name), name);
    }
  });

  for (const [title, preamble, roots] of [
    ["a document that loads nothing", "", []],
    [
      "a document of the class amsart",
      "`" + bs + "documentclass{amsart}`{=latex}\n\n",
      ["class-amsart"],
    ],
  ] as const) {
    it(`accepts the commands that tex/unknown-command accepts, in ${title}`, async function () {
      for (const home of [bare, withMathtools]) {
        const active = buildTexCommandAuthority(home.vocabulary, roots).activeCommands;
        assert.deepEqual(
          await flaggedByFlowmark(home, preamble),
          new Set(WITNESSES.filter((command) => !active.has(command))),
        );
      }
    });
  }
});
