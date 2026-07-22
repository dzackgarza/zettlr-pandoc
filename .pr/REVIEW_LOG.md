# Review feedback disposition ledger

Record each actionable top-level comment, review, inline thread, or CI finding here before acting on it. For each item: source, exact claim, disposition, required change, status, addressing commit. Do not mark an accepted item addressed before its remediation is committed.

## Independent adversarial review — round 1 (2026-07-22)

Three fresh-context reviewers (contract-completion, code-quality/anti-slop, proof-quality) ran against the full branch diff and companion PR before ready-marking, per the PR contract. Findings and dispositions:

### Reviewer A — contract completion (verdict: INCOMPLETE)

| # | Claim | Disposition | Status |
|---|---|---|---|
| A1 | Subfigure/wrapping crossref forms absent (`::: {#fig:group}` wrapping divs never extracted); oracle fixtures avoid the form, masking the gap — quantifier narrowing | Accepted — current-PR work (contract names wrapping/subfigure forms explicitly) | addressed — ad2749749 (subfigure/wrapping extraction, new fixture + oracle coverage) |
| A2 | Help not searchable; completion and Mod-P links to help missing (US-06 requires all three entry points) | Accepted — current-PR work | addressed — ad2749749 (help filter, completion info-panel link, overlay open-help) |
| A3 | Mod-P lacks current-Project-first ranking with marked others (US-16) | Accepted — current-PR work | addressed — ad2749749 (Project-first partition + status pills) |
| A4 | Rename preview UI absent: yes/no popup then immediate commit; US-17/IS-12 require the affected-occurrence preview | Accepted — current-PR work | addressed — ad2749749 (RenameReferencePreviewDialog + capture, defects fixed visually) |
| A5 | Rename undo implemented and proven at the command level but unreachable by a user (no renderer caller) | Accepted — current-PR work | addressed — ad2749749 (toast Undo action on the production route; wire-route lock spec) |
| A6 | Visual-proof list incomplete: no completion capture, no rename-preview capture, no nav-controls capture; inspection evidence not referenced from the PR | Accepted — current-PR work (captures + inspection notes; rename-preview capture depends on A4) | addressed — ad2749749 + 19c0ab7b0 (rename-preview capture; three recipes repaired and swept) |
| A7 | Review lifecycle not started | Superseded in part — this ledger and round 1 ARE the lifecycle; every finding dispositioned with commit anchors, remediations landed, final gate 727/0, claim map republished | addressed |
| A8 | Alt-Left/Alt-Right "configurable" defaults have no configuration surface | Accepted with modified remediation — minimal config surface consistent with the app's existing config template; no bespoke shortcut framework | addressed — ad2749749 (navigation-shortcuts single authority, real-keydown proof) |
| A9 | PR body "Current blockers" stale (predates phases 3b–8) | Accepted — final republish at the completion gate | addressed at gate |

Reviewer A confirmed: no contract-exclusion violations (no GUI numbering, no Pandoc-on-type, no citation redesign, no fallbacks, no bespoke matcher); red/green pairs exist for every phase; core proofs re-run independently green (168 unit / 31 probe / cross-repo).

### Reviewer B — code quality (anti-slop / reviewing-llm-code lenses)

| # | Claim | Disposition | Status |
|---|---|---|---|
| B1 | MUST-FIX: companion lua Cite handler rebuilds \cref from ids only — authored prefix/suffix/locators and SuppressAuthor silently discarded on documented syntax; no fixture exercises the shapes | Accepted — remediated red-first in pandoc-config dd939b7 (red) + 13a6259 (green): prefixes/suffixes render as native inlines around \cref; [-@thm:k] maps to bare \ref (cleveref has no author); PDF visually verified | addressed |
| B2 | New shell:true single-quote interpolations scale to N+2 per export; quotes in titles/filenames break tokenization; spec covers spaces but not quotes | Accepted with remediation = shell:false argv array (deletes the whole class) | addressed — 19c0ab7b0 (shell:false raw argv; quoted-input red-first spec) |
| B3 | at-symbols duplicates the family display-name authority | Accepted — mechanical dedup | addressed — 19c0ab7b0 |
| B4 | extract-references duplicates referenceFamilyOf from a module it already imports | Accepted — mechanical dedup | addressed — 19c0ab7b0 |
| B5 | CROSSREF_FAMILIES vs PANDOC_CROSSREF_PREFIXES glued by canary not derivation; two predicates with divergent empty-slug semantics used in one file | Accepted — derive one from the other; reconcile predicates deliberately | addressed — 19c0ab7b0 (quick-reference owns the family set; predicates reconciled + documented) |
| B6 | reference-lint duplicates the id-token locator with fail-loud downgraded to fail-silent; re-parses previewSource (a display excerpt) for the mismatch diagnostic | Accepted — share the locator; carry classes on the definition | addressed — 19c0ab7b0 (shared fail-loud locator; classes carried on definitions) |
| B7 | Rename proof lives on a provider ipc route production never uses; undo protocol has no production caller (overlaps A5) | Accepted — wire user-reachable undo + unify or justify the wire route; proof must ride the production path | addressed — 19c0ab7b0 (unused provider ipc rename surface removed; proof rides production chain) |
| B8 | Error contract contradicted by siblings: navigation/live-buffer/append-and-continue/menu-rename failures are log-only while the contract forbids exactly that | Accepted — route the named sites through the recoverable boundary | addressed — 19c0ab7b0 (run-recoverably boundary; four sites routed) |
| B9 | Test-accommodation guards in production (getCitationCallback probe, window.ipc guard comment, production-dead render-citations branch) | Accepted with modified remediation — fix harnesses to provide the globals/field where honest, delete guards; keep any branch only with a production justification | addressed — 19c0ab7b0 (guards deleted, harnesses provisioned; textual branch proven reachable and pinned — claim partially REJECTED with evidence) |
| B10 | "Legacy single-file surface byte-stable" laundered: the shared Cite handler changes legacy output for @thm: citations; baseline fixture avoids the trigger | Accepted — pandoc-config 33b3968: legacy-path theorem-cref behavior blessed by a dedicated test step; byte-stability claim narrowed to the attribute-style sample; PR #5 body republished with the corrected wording | addressed |
| B11 | Cross-repo prefix registries and default template name duplicated without drift canaries | Accepted — pandoc-config 7c45e47 (15-prefix drift canary naming the zettlr authority) + aebbc61 (''/'-' template sentinel mapping to the recipe-owned DEFAULT_TEMPLATE); zettlr's recipe-exporter duplicate default removed in the quality remediation | addressed (companion half) |
| B12–B23 | Debt notes (isFile fork, dead control flow in append-plan affordance, unused runner code field, stale JSDoc/phase comments, hand-enumerated spec list, source-text help spec, stringly crossref_mode, silent unknown-ipc, placeholder snapshot default, lua labeling asymmetry, class-registry overlap) | Cheap ones folded into remediation (13, 16, 21 — 19c0ab7b0); remainder batched with evidence to https://github.com/dzackgarza/zettlr-pandoc/issues/5 | addressed |

### Reviewer C — proof quality (test-guidelines admissibility + fresh capture sweep)

Headline verdict: no fabricated proofs, no behavior mocking, no vacuous passes in the completion differential, rename atomicity, or Pandoc oracle — each excludes the specific broken implementation it claims to. Findings:

| # | Claim | Disposition | Status |
|---|---|---|---|
| C1 | preflight() boot integration of the crossref gate unproven (deleting the call would pass every spec) | Accepted — boot-gate spec | addressed — 19c0ab7b0 (boot gate proven discriminating by red-revert) |
| C2 | Renderer Vue glue (reporter instantiation, referencesUpdate feed, overlay mount) has no owning spec | Accepted with modified remediation — highest-risk joins now specced honestly (documents-provider join, append-continuation wire, boot gate — 19c0ab7b0; rename flow + undo route — ad2749749); remaining Vue relay glue documented as residual risk, not laundered | addressed with documented residual |
| C3 | capture-pandoc-divs / -chips / -hover lack --no-sandbox and hard-fail as committed | Accepted — recipe fix | addressed — 19c0ab7b0 |
| C4 | Contract-named captures missing: completion popup, expanded hover, duplicate/outside-Project chip states, rename preview, navigation controls; two receipt-frames carry no visual information | Accepted — completed in ad2749749 (rename preview) + 8b3b1ea54 (completion popup, expanded hover, duplicate/outside-Project states, navigation controls; receipt frames replaced with honest state change or deleted with rationale) | addressed |
| C5 | Subfigure/wrapping forms have zero coverage (= A1) | Accepted (tracked as A1) | addressed — tracked as A1 — ad2749749 |
| C6 | documents-provider navigation join (targetRange/sourceLocation/stamping/tab reuse) unspecced | Accepted — provider-layer spec via harness | addressed — 19c0ab7b0 |
| C7 | Cross-repo script's `grep -q 'Ols04'` passes even if citeproc breaks | Accepted — assert the strong \autocite form | addressed — 19c0ab7b0 |
| C8 | Escaped/structurally-malformed attribute cases, file-move index case, keymap-routing assertion missing | Accepted — cheap spec additions | addressed — 19c0ab7b0 (escaped-quote parsing was a real defect, fixed red-first) |
| C9 | Oracle covers 2 of 5 fixture files; dispatcher replicated in differential; recorder single-spawn blindness; conflicted-path temp-debris unasserted; second export profile unexercised | Accepted as debt-batch — https://github.com/dzackgarza/zettlr-pandoc/issues/5 | addressed (batched) |
