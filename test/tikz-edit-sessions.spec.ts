/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        TikZ external edit session proofs
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     A diagram that Visual TikZ Editor has open is a range of
 *                  the Markdown document. The editor state follows that range
 *                  through other edits, writes each source that the editor
 *                  saves into it, and refuses a source when the author changed
 *                  the diagram in the document in the meantime.
 *
 * END HEADER
 */

import { strict as assert } from "node:assert";
import { EditorState } from "@codemirror/state";
import {
  beginTikzEditSession,
  endTikzEditSession,
  externalTikzSourceUpdate,
  tikzEditSessionsField,
} from "source/common/modules/markdown-editor/tikz-edit-sessions";

const SQUARE = "\\begin{tikzcd}\nA \\arrow[r] & B\n\\end{tikzcd}";
const TRIANGLE = "\\begin{tikzpicture}\n\\draw (0,0) -- (1,0) -- (0,1) -- cycle;\n\\end{tikzpicture}";
const DOC = `Before.\n\n${SQUARE}\n\nBetween.\n\n${TRIANGLE}\n\nAfter.\n`;

function open(doc: string, sessions: Array<{ id: string; source: string }>): EditorState {
  let state = EditorState.create({ doc, extensions: [tikzEditSessionsField] });
  for (const { id, source } of sessions) {
    const from = doc.indexOf(source);
    state = state.update({
      effects: beginTikzEditSession.of({ id, from, to: from + source.length }),
    }).state;
  }
  return state;
}

function applied(state: EditorState, id: string, source: string): EditorState {
  const update = externalTikzSourceUpdate(state, id, source);
  assert.equal(update.outcome, "applied");
  assert.ok(update.outcome === "applied");
  return state.update(update.transaction).state;
}

describe("TikZ external edit sessions", function () {
  it("writes the saved source of the external editor into the diagram of the session", function () {
    const next = "\\begin{tikzcd}\nA \\arrow[r] \\arrow[d] & B \\\\\nC\n\\end{tikzcd}";
    const state = applied(open(DOC, [{ id: "square", source: SQUARE }]), "square", next);
    assert.equal(state.doc.toString(), DOC.replace(SQUARE, next));
  });

  it("follows the diagram when the author edits the text before it", function () {
    let state = open(DOC, [{ id: "triangle", source: TRIANGLE }]);
    state = state.update({ changes: { from: 0, insert: "# A new heading\n\n" } }).state;
    state = state.update({
      changes: { from: state.doc.toString().indexOf("Between."), insert: "Text right " },
    }).state;
    const next = TRIANGLE.replace("(1,0)", "(2,0)");
    state = applied(state, "triangle", next);
    assert.equal(
      state.doc.toString(),
      `# A new heading\n\n${DOC.replace("Between.", "Text right Between.").replace(TRIANGLE, next)}`,
    );
  });

  it("applies each later save over the previous one", function () {
    let state = open(DOC, [{ id: "square", source: SQUARE }]);
    const first = SQUARE.replace("& B", "& B & C");
    const second = first.replace("A \\arrow[r]", "A \\arrow[r, hook]");
    state = applied(state, "square", first);
    state = applied(state, "square", second);
    assert.equal(state.doc.toString(), DOC.replace(SQUARE, second));
  });

  it("keeps two open diagrams of one document apart", function () {
    let state = open(DOC, [
      { id: "square", source: SQUARE },
      { id: "triangle", source: TRIANGLE },
    ]);
    const longerSquare = SQUARE.replace("& B", "& B \\arrow[r] & C \\arrow[r] & D");
    const nextTriangle = TRIANGLE.replace("cycle", "(1,1) -- cycle");
    state = applied(state, "square", longerSquare);
    state = applied(state, "triangle", nextTriangle);
    assert.equal(
      state.doc.toString(),
      DOC.replace(SQUARE, longerSquare).replace(TRIANGLE, nextTriangle),
    );
  });

  it("refuses a save when the author changed the diagram in the document", function () {
    let state = open(DOC, [{ id: "square", source: SQUARE }]);
    const at = state.doc.toString().indexOf("& B");
    state = state.update({ changes: { from: at, to: at + 3, insert: "& X" } }).state;
    const update = externalTikzSourceUpdate(state, "square", SQUARE.replace("A", "Z"));
    assert.equal(update.outcome, "stale");
    assert.equal(state.doc.toString(), DOC.replace("& B", "& X"));
  });

  it("accepts the save again after the author restored the diagram", function () {
    let state = open(DOC, [{ id: "square", source: SQUARE }]);
    const at = state.doc.toString().indexOf("& B");
    state = state.update({ changes: { from: at, to: at + 3, insert: "& X" } }).state;
    state = state.update({ changes: { from: at, to: at + 3, insert: "& B" } }).state;
    const next = SQUARE.replace("A", "Z");
    assert.equal(applied(state, "square", next).doc.toString(), DOC.replace(SQUARE, next));
  });

  it("makes no transaction for a save that equals the diagram", function () {
    const state = open(DOC, [{ id: "square", source: SQUARE }]);
    assert.equal(externalTikzSourceUpdate(state, "square", SQUARE).outcome, "unchanged");
  });

  it("applies nothing after the session ended", function () {
    let state = open(DOC, [{ id: "square", source: SQUARE }]);
    state = state.update({ effects: endTikzEditSession.of("square") }).state;
    assert.equal(externalTikzSourceUpdate(state, "square", "x").outcome, "closed");
    assert.deepEqual(state.field(tikzEditSessionsField), []);
  });
});
