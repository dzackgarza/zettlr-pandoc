# 9. Responsiveness contracts

The cost of a typed character, a caret move and a filesystem event must not
follow the length of the document or the size of the workspace (#132). These
rules keep that property. The measurement harness and the safe launch command
of an isolated instance are in the first comment of #132.

- **Decorations from syntax nodes** go through `incrementalNodeDecorations`
  (`packages/pandoc-editor/src/util/incremental-node-decorations.ts`). A
  transaction computes again only the top-level blocks that the parser made
  again and the ranges that the selection left or entered. `renderBlockWidgets`
  (`renderers/base-renderer.ts`) is built on it. The field has one rule for
  each cause of a change:
  - The tree changed. The Markdown parser keeps the node object of each
    top-level block that it did not parse again, so a block with the same
    node object has the same decorations. The field computes again the ranges
    between those blocks. The anonymous nodes that balance a long list of
    blocks are made again for each parse, so they are no blocks. The list of
    blocks of a tree is made once and lives as long as the tree.
  - A transaction changed a range whose decorations depend on more than their
    own nodes (the selection, a pending review change). The source names the
    ranges that changed (`changedReach`), not each such range, and the field
    computes them again, one position wider on each side, with the
    decorations that touch them.
  - Another state value that the source reads changed. The source reports it
    through `inputsChanged`, and the field computes each decoration again; a
    value that it does not report leaves stale widgets. The document, the
    tree and the selection are no such values.

  `decorate(state, from, to)` gives the decorations of the nodes that touch
  the range; the field keeps those that belong to it. A decoration that only
  meets a region at one end belongs to the block on that side; an empty
  decoration at such an end is what is left of a deleted block and belongs to
  the region (`inRegion`). A decoration that the field computes again and
  that is equal to the old one keeps the old object, so the element of a
  widget belongs to one widget object until another widget takes its place.
- **A widget holds no document position.** The field keeps a widget outside a
  changed block, so a stored position goes stale. A handler reads the position
  from `view.posAtDOM`. The `eq` of a widget compares what the widget shows.
  The widget decorations of `base-renderer.ts` have `Prec.high`, so a widget
  owns the whole source of its node and `view.posAtDOM` gives the start of
  that source. A replacement of lower precedence that starts at the same
  position (the hidden `$` code mark of an equation) is not drawn.
- **An inline widget states how it stays on its row.** The view puts an
  image of no width (`cm-widgetBuffer`) on each side of a widget, and a
  browser can end a row beside an image. A widget of `base-renderer.ts`
  therefore has the property `rowJoin` (`RowJoinedWidget`): `"box"` for one
  box that no row end divides (an inline equation, a wikilink chip), `"text"`
  for text with row ends of its own (a citation, a cluster of reference
  chips), `null` for a widget that fills its row (display math). The renderer
  puts a mark (`cm-row-join`) over a joined widget and the character that
  touches it on each side; no row ends in the mark, and a space is never in
  it. The mark is inclusive: a mark that is not inclusive does not hold a
  widget that starts or ends at its edge. A pill inside a widget with text
  around it goes into an element with `ATOMIC_INLINE_JOINT_CLASS`. A widget
  without `rowJoin` (an image, a task marker) is not joined. Proof:
  `e2e/inline-widget-line-breaks.spec.ts`.
- **The badges of a definition have room in the flow of its line.** The
  reference badges are an overlay (`render-reference-definitions.ts`). The
  layer puts an anchor, a widget without text, at the end of each line of a
  definition in the viewport. It gives the anchor the size of the badge
  groups of that line and puts the groups on it. An anchor without room after
  the text goes to a row of its own, so no badge covers text. A badge group
  takes at most the width of its line: a group that does not fit after
  another starts a new row on the anchor, and a long key breaks in its
  badge. A widget that replaces the line of a definition (the header of a fenced div) puts
  `referenceBadgeAnchor(view)` in its DOM and calls
  `referenceBadgeAnchorsRemoved(dom)` in its `destroy`; the layer uses that
  anchor. A line whose end another renderer replaced has no anchor: its
  badges are after the end of the line, kept inside the layer, so they add no
  horizontal scroll. Proof: `e2e/titled-fenced-divs.spec.ts`,
  `test/editor-reference-badges.spec.ts`.
- **An equal value causes no transaction.** `setWorkspaceReferences`,
  `setWikilinkResolutions`, `setCompletionDatabase`, the collaboration session
  store and `modeSwitcher` (`renderers/index.ts`) dispatch or reconfigure only
  for a changed value. A `Compartment.reconfigure` makes the view draw its
  content again. `configField` keeps its object for a configuration update
  with equal values, so a renderer can compare the field by identity in
  `inputsChanged`.
- **A change of one collaboration session costs work for its document only.**
  The window store (`pinia/document-collaboration-store.ts`) holds each
  session as the object that the main process sent: the map of sessions is
  shallow (`shallowReactive`), each session is raw (`markRaw`), and a new
  state replaces the session through `setSession`. No code changes a stored
  session in place, and no watcher is deep. A value that the store derives
  from a session (the cards, the review rows) is made one time for one
  session object. A session whose annotation set is equal to the shown one
  keeps the shown `annotations` object, so the editor watches that object by
  identity. The Annotations view reads the workspace state again only when
  its list of paths has a new member or lost one (#126). Proof:
  `test/annotations-sidebar.spec.ts`,
  `test/annotations-panel-animation.spec.ts`.
- **A review with many chunks costs work for the chunks that change.**
  The review field (`plugins/review-chunks.ts`) keeps each chunk in a
  range set by its extent with its decorations. A typed character maps the
  chunks that it touches and moves the others; a broadcast of the
  installed review is the effect `reviewChunksBroadcast`, not a
  reconfigure, and a suggestion that it does not change keeps its
  decorations and its control. The field states what a transaction changed
  (`delta`, and `changed` of `PreviewSuppression`); the chunk controls and
  `incrementalNodeDecorations` (`changedReach`) compute only that again. A
  new consumer of the review state reads the delta; it does not walk
  `getReviewChunks` for each transaction. The provider still maps each
  suggestion for each pushed update, and a broadcast still compares the
  text of the document with the working text. Proof:
  `test/editor-review-chunk-cost.spec.ts`.
- **The editor takes one new width for one slide of a side pane.** A side
  pane of the main window slides for 180 ms. `paneSlide`
  (`win-main/util/pane-slide.ts`) gives the panes their final sizes in one
  step and plays the slide as an animation of `flex-grow` from the old sizes.
  For the time of the slide the frame of the editor (`.editor-frame`) has
  the width of the end state and is anchored to the side that does not move,
  so the document wraps one time. On an open, the part of the editor pane
  that the side pane did not reach yet is empty; on a close, the editor pane
  clips its frame. A new pane that
  slides beside the editor goes through `paneSlide`; no CSS transition
  changes the width of the editor. Proof: `e2e/pane-slide.spec.ts`.
- **An editor in a background tab receives no workspace transaction.** It
  reads the workspace state, the citation data and the completion databases
  when its tab becomes active (`refreshActiveEditorAuxiliaryState` in
  `MainEditor.vue`).
- **Citations are drawn again when the citation database changed.**
  `render-citations.ts` counts those changes (`citationDatabaseChanged`); a
  citation widget carries the count it was drawn at, and `syncCitationData`
  draws the citations of an editor again when the count moved. The identity of
  the `metadata` configuration object is not a signal: it changes with each
  configuration update.
- **No `ipcRenderer.sendSync` in the path of a transaction.**
- **FSAL events are batches.** FSAL publishes `fsal-events`: the events of
  50 ms in one array, to the main-process listeners and to the windows. A
  consumer does its work once for each batch and broadcasts only a changed
  value.
- **A file that the watcher reported as changed is read again.** chokidar
  reports one `change` of a path in 50 ms and drops the others
  (`FSWatcher._emit`), so a second write of a file in that time has no event
  of its own. The FSAL reads the modification time of each changed file
  100 ms after the change (`recheckAfterChangeWindow`) and handles a file
  that has another modification time as a new change. A failed workspace
  edit writes a file and writes its old text back at once. Proof:
  `test/fsal-watcher-events.spec.ts`.
- **One parse of one document version in the main process.** `markdownToAST`
  (`markdown-utils/index.ts`) keeps the ASTs of the texts it parsed last. The
  AST is shared: a reader must not change it. The cache key holds the link
  format. Editor code passes the tree that the editor has
  (`markdownToAST(text, tree)`), as the spellcheck context does.
- **Pandoc reads one citation candidate once.**
  `references/pandoc-citations.ts` keeps the reading of each candidate source;
  an edit that changes no citation starts no Pandoc process.
- **One probe of an external tool in a session** (`probeTool`, [§25](external-tools.md);
  `flowmarkToolPython`).
- **Background processes wait for a pause in the editor.** The lint queue
  (`DocumentLintProvider.work`) starts no Flowmark run until the document
  authority had no editor update for one second
  (`DocumentManager.lastEditorInputAt`, `INPUT_IDLE_MS`). A run that started
  goes to its end. The lint of the active document is not in the queue and
  does not wait. New background work that starts processes while the author
  can type waits on the same time. Proof:
  `test/document-lint-idle-gate.spec.ts`.
- **One load of a citation database.** `CiteprocProvider` shares the load that
  runs for a database path between concurrent requests.
- **`@codemirror/collab` is patched**
  (`patches/@codemirror%2Fcollab@6.1.1.patch`): a local update holds no
  transaction. Without the patch the `origin` of each unconfirmed update keeps
  one transaction and two editor states alive for each typed character. A
  version update of the package must keep the patch until the package has the
  change.
