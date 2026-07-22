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

The required companion PR is [pandoc-config#5](https://github.com/dzackgarza/pandoc-config/pull/5) (draft): ordered multi-file `compile-pandoc-project`, `pandoc-crossref` in the project filter chain, and the explicit-ID/`@thm:`-family theorem filter bridge, with the legacy single-file surface proven byte-stable. This PR cannot become ready or merge until the cross-repository proof passes against that branch.

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

- [x] Commit a constellation of faithful red proofs through the sanctioned red-commit path before production implementation. — 7 Red-Proof #1 commits (7e3494aa5, 9ca7e35b7, 515858f5f, 5ed9d44a5, 153af2fbf, 60afe7988, 7d130a07e, 68c1d3eaf, 00c47cba4), each gate-verified red on assertions before its green.
- [x] Parse supported explicit attributes and labels with exact ranges, including colon-bearing IDs and malformed nearby syntax. — extract-references + subfigure + escaped-quote/near-miss specs; real-pandoc AST oracle over three fixture files.
- [x] Reconcile saved FSAL snapshots and complete live-buffer replacements across save, edit, rename, move, deletion, and stale events. — fsal-reference-snapshots, reference-index-overlay (incl. file-move, stale events, generation guards), production live-buffer reporter.
- [x] Preserve existing bibliography citation sourcing, insertion, rendering, and citeproc behavior while adding label completion. — byte-identity differential over the citation trigger matrix (options + applied docs, function identity included); pure-bib chip parity guards.
- [x] Prove workspace completion and navigation across current-Project, omitted-file, another-Project, and standalone states. — project-reference-status matrix + completion gating + append-and-continue wire proof + hover status scenes.
- [x] Prove reference chips, definition badges, hover excerpts, quick help, Mod-P, reverse lookup, and diagnostics in the real editor. — headless EditorView specs + Electron probes + inspected captures for every surface.
- [x] Prove edit-first click, Mod-click navigation, tab reuse/opening, per-pane Back/Forward restoration, and footnote history. — click-listeners/probe trio, tab-manager + documents-provider join specs, footnote parity guards.
- [x] Prove previewed atomic workspace rename, dirty-buffer preservation, collision and concurrency abort, and undo. — compute-reference-edits + rename-atomicity (disk-fenced abort-all, temp-debris asserted) + preview dialog probe + production undo route lock.
- [x] Pass ordered Project inputs through every app export profile and the linked pandoc-config pipeline. — export-ordered-inputs/export-quoted-inputs argv proofs (shell:false), cross-repo recipe green against pandoc-config#5.
- [x] Prove externally owned numbering and links through representative supported output profiles without introducing GUI numbering. — inspected PDFs with native cleveref numbering, preserved citation text, suppressed-form bare numbers; GUI renders identity only (no-number assertions). Batched limit: shell harnesses exercise one LaTeX profile (issue #5).
- [x] Route every test, lint, build, Electron, Playwright, Pandoc, and capture workflow through guarded `just` recipes. — test-references / test-reference-ui / test-pandoc-config-integration / capture-* recipes, all guard-first.
- [x] Hard-bail browser-capable recipes before process creation when a dev server is active; never use `xdg-open` or the user's running browser. — assert-dev-server-stopped.py fronts every such recipe; zero xdg-open.
- [x] Capture and inspect all required visual states with one controlled application instance. — completion, resolved/missing/duplicate/outside-Project, collapsed/expanded hover, Mod-P, citing-locations, creation dialog, rename preview, navigation controls, nested divs: all captured and inspected (defects found visually were fixed and re-captured).
- [x] Read and disposition every review and CI feedback surface before marking the PR ready. — `.pr/REVIEW_LOG.md`: three-reviewer adversarial round, every finding dispositioned with commit anchors or batched with evidence (issues #4, #5; pandoc-config#6).

# Current blockers

None. All issue #1 workstreams are implemented red-first and proven; the companion PR pandoc-config#5 is integrated and cross-repo-proven; the full commit gate stands at 727 passing / 0 failing; all contract-named visual states are captured and inspected; the independent three-reviewer adversarial round is fully dispositioned in `.pr/REVIEW_LOG.md`. Follow-up work is tracked publicly: QC wiring (#4), review debt batch (#5), companion style gap (pandoc-config#6).

# Review focus

Review this draft against issue #1 before implementation begins:

- Does the claim preserve the product model expressed in the decision answers?
- Does any checklist item reintroduce GUI numbering, profile-specific semantic emulation, generated-target analysis, citation redesign, or heuristic author-intent repair?
- Are any issue #1 acceptance behaviors missing from the claimed delivery boundary or proof obligations?
- Would the proposed proof still pass on a plausibly broken editor, unsafe browser harness, or inconsistent export path?
