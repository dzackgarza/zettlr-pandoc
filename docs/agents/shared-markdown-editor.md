# Shared Markdown editor

`packages/pandoc-editor` owns the reusable CodeMirror presentation and Pandoc parser.
Both Zettlr and math-flashcards consume its `markdownEditor` factory. The package
imports no application modules. Hosts supply math conversion, preview configuration,
and ranges that must remain source text. Zettlr adds document-specific renderers
through its renderer collection. See `packages/pandoc-editor/README.md`.

A fenced div that the author did not close goes to the end of its
container, as Pandoc reads it. It is a state of the document: its source
stays visible, Flowmark reports it (`pandoc/unclosed-fenced-div`), and the
renderer records no application error for it (`divIsUnclosed`,
`common/pandoc-util/pandoc-div-model.ts`). Proof:
`test/editor-pandoc-div-widget.spec.ts`.

A click on a rendered widget selects its source through
`selectRenderedSourceRange` or `placeCursorFromRenderedPoint`
(`renderers/reveal-rendered-source.ts`; `clickAndSelect` calls the first). A
Shift-click keeps the anchor of the selection and moves the head over the
source of the widget, as in text; a Shift-click on a task checkbox does not
toggle the task. A new widget that handles a click calls one of the two
functions on the `mousedown` of the primary button, not on `click`: the
default mousedown puts the caret at the edge of the widget, the renderer then
shows the source, and the click of a button that a person holds arrives at
that source text (#131). Proof: `e2e/shift-click-widgets.spec.ts`.

**The syntax tree can end before the document does.** The parser works for
a set time after a change and goes on in the background, so on a machine
under load the tree of a state is shorter than its text, and the rest
arrives in a later update that changes no text. A decoration that is made
from the tree follows the tree:

- A view plugin or a layer that reads `syntaxTree` or
  `visitVisibleSyntaxNodes` has `syntaxTreeChanged(update)`
  (`packages/pandoc-editor/src/util/visible-syntax-nodes.ts`) in the
  condition of its update, beside `docChanged` and `viewportChanged`.
  Without it the decorations of the shorter tree stay until the next
  keystroke.
- A state field that keeps decorations per block leaves the text after
  `tree.length` as it is; it is not known yet, and it is not changed
  (`incrementalNodeDecorations`). A field that takes it as changed removes
  each widget below a typed character and makes it again.
- That field also keeps the blocks that it knew after `tree.length`,
  mapped through the change (`blocksAfterShortTree`). The tree that
  reaches the end reuses those blocks of the earlier full tree; a field
  that knows only the blocks of the short tree decorates the whole rest
  of the document again. A known block that the change touches, or that
  a region of the transaction meets, is left out: the field could not
  decorate it, so the later tree decorates it.

Proof: `test/editor-incremental-rendering.spec.ts`. `withParserTimePassed`
of that file sets the clock of the parser, so the parser stops after one
step; "... when the parser is behind after each edit" compares an edited
editor with a new one for each renderer of the production set, and a new
renderer is covered by it. A spec that counts the work of an edit makes
the edit in the first 3000 characters of a state without a view: a nested
parser (the TeX of an `InlineCode`) skips the text outside the viewport of
the parse, which a state without a view does not move, and the full parse
of `ensureSyntaxTree` then makes the edited block again.

**What the editor closes itself, because CodeMirror does not.**

- A reload of a document (`loadDocument` with a document already loaded)
  closes the list of completions and each hover before it replaces the
  state. `setState` keeps a measurement that a plugin of the old state asked
  for, and that measurement places a tooltip of the old text in the new
  text ("Invalid position").
- `closeHoverOutsideEditor` (`tooltips/close-hover-outside-editor.ts`) closes
  a hover that opens while the pointer is not over the editor. The content
  of a hover can arrive after the pointer left; CodeMirror drops a waiting
  hover when the pointer moves away inside the editor and not when it
  leaves the editor. A tooltip is inside the element of the editor; a
  tooltip parent outside it would need a place in this plugin. Proof:
  `test/editor-hover-outside.spec.ts`.
