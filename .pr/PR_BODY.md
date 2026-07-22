# Claim

Implement the complete workspace-resolved Pandoc reference authoring workflow specified by issue #1.

Closes #1.

Milestone: [Usable for basic Pandoc-based work](https://github.com/dzackgarza/zettlr-pandoc/milestone/1)

Canonical contract and rationale:

- [Issue #1 implementation contract](https://github.com/dzackgarza/zettlr-pandoc/issues/1)
- [User-observable acceptance stories](https://github.com/dzackgarza/zettlr-pandoc/issues/1#issuecomment-5041669222)
- [Product-intent and scope stories](https://github.com/dzackgarza/zettlr-pandoc/issues/1#issuecomment-5041693241)

This draft locks the claim before implementation. No checklist item below is complete merely because the contract files exist.

# Delivery boundary

This PR owns the complete Zettlr-Pandoc side of issue #1:

- workspace-wide saved and live definition-and-occurrence indexing;
- the combined citation-preserving `@` completion surface;
- supported pandoc-crossref and theorem-div label extraction;
- rendered reference and definition presentation, hover preview, diagnostics, and quick help;
- Project-membership status and mechanical append actions;
- Mod-P definition search and definition-local reverse lookup;
- edit-first click behavior, Mod-click navigation, and per-pane Back/Forward history;
- workspace Find References and safe rename;
- ordered Project inputs for every export profile;
- preflight and recoverable-error behavior;
- guarded real-boundary regression and visual proof.

A required companion `pandoc-config` PR will update the authoritative `compile-pandoc` contract and theorem/reference export pipeline. This PR cannot become ready or merge until that companion PR is linked here and the cross-repository proof passes.

# Product boundaries

- The workspace is the authoring/discovery namespace; Project membership is publishability status.
- The launch dialect is explicit Markdown-native pandoc-crossref labels plus the fixed theorem-div prefix registry.
- Existing bibliography citation behavior remains unchanged.
- Existing footnote behavior is preserved and only integrated with the shared navigation history and modifier navigation.
- The GUI resolves authored identity and locations; export tools and templates exclusively own numbering.
- Authoring never runs Pandoc or pandoc-crossref on typing or save.
- Automatic heading IDs, arbitrary label families, raw LaTeX references, filter-created targets, generated/build-only targets, and mixed-provider rendering are outside the launch contract.
- Diagnostics explain source contradictions without guessing author intent or fabricating targets.
- GUI resolution warnings never block a valid custom export.

# Acceptance and proof obligations

- [ ] Commit a constellation of faithful red proofs through the sanctioned red-commit path before production implementation.
- [ ] Parse supported explicit attributes and labels with exact ranges, including colon-bearing IDs and malformed nearby syntax.
- [ ] Reconcile saved FSAL snapshots and complete live-buffer replacements across save, edit, rename, move, deletion, and stale events.
- [ ] Preserve existing bibliography citation sourcing, insertion, rendering, and citeproc behavior while adding label completion.
- [ ] Prove workspace completion and navigation across current-Project, omitted-file, another-Project, and standalone states.
- [ ] Prove reference chips, definition badges, hover excerpts, quick help, Mod-P, reverse lookup, and diagnostics in the real editor.
- [ ] Prove edit-first click, Mod-click navigation, tab reuse/opening, per-pane Back/Forward restoration, and footnote history.
- [ ] Prove previewed atomic workspace rename, dirty-buffer preservation, collision and concurrency abort, and undo.
- [ ] Pass ordered Project inputs through every app export profile and the linked `pandoc-config` pipeline.
- [ ] Prove externally owned numbering and links through representative supported output profiles without introducing GUI numbering.
- [ ] Route every test, lint, build, Electron, Playwright, Pandoc, and capture workflow through guarded `just` recipes.
- [ ] Hard-bail browser-capable recipes before process creation when a dev server is active; never use `xdg-open` or the user's running browser.
- [ ] Capture and inspect all required visual states with one controlled application instance.
- [ ] Read and disposition every review and CI feedback surface before marking the PR ready.

# Current blockers

- The required companion `pandoc-config` PR has not yet been opened.
- The red proof constellation has not yet been committed.
- Implementation and evidence are unstarted.

# Review focus

Review this draft against issue #1 before implementation begins:

- Does the claim preserve the product model expressed in the decision answers?
- Does any checklist item reintroduce GUI numbering, profile-specific semantic emulation, generated-target analysis, citation redesign, or heuristic author-intent repair?
- Are any issue #1 acceptance behaviors missing from the claimed delivery boundary or proof obligations?
- Would the proposed proof still pass on a plausibly broken editor, unsafe browser harness, or inconsistent export path?
