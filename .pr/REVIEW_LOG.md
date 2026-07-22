# Review feedback disposition ledger

Record each actionable top-level comment, review, inline thread, or CI finding here before acting on it. For each item: source, exact claim, disposition, required change, status, addressing commit. Do not mark an accepted item addressed before its remediation is committed.

## Independent adversarial review — round 1 (2026-07-22)

Three fresh-context reviewers (contract-completion, code-quality/anti-slop, proof-quality) ran against the full branch diff and companion PR before ready-marking, per the PR contract. Findings and dispositions:

### Reviewer A — contract completion (verdict: INCOMPLETE)

| # | Claim | Disposition | Status |
|---|---|---|---|
| A1 | Subfigure/wrapping crossref forms absent (`::: {#fig:group}` wrapping divs never extracted); oracle fixtures avoid the form, masking the gap — quantifier narrowing | Accepted — current-PR work (contract names wrapping/subfigure forms explicitly) | open |
| A2 | Help not searchable; completion and Mod-P links to help missing (US-06 requires all three entry points) | Accepted — current-PR work | open |
| A3 | Mod-P lacks current-Project-first ranking with marked others (US-16) | Accepted — current-PR work | open |
| A4 | Rename preview UI absent: yes/no popup then immediate commit; US-17/IS-12 require the affected-occurrence preview | Accepted — current-PR work | open |
| A5 | Rename undo implemented and proven at the command level but unreachable by a user (no renderer caller) | Accepted — current-PR work | open |
| A6 | Visual-proof list incomplete: no completion capture, no rename-preview capture, no nav-controls capture; inspection evidence not referenced from the PR | Accepted — current-PR work (captures + inspection notes; rename-preview capture depends on A4) | open |
| A7 | Review lifecycle not started | Superseded in part — this ledger and round 1 ARE the lifecycle; remains open until dispositions close and the PR-required review loop completes | open |
| A8 | Alt-Left/Alt-Right "configurable" defaults have no configuration surface | Accepted with modified remediation — minimal config surface consistent with the app's existing config template; no bespoke shortcut framework | open |
| A9 | PR body "Current blockers" stale (predates phases 3b–8) | Accepted — refresh at completion-gate republish (was refreshed once mid-stream; final refresh after remediation) | open |

Reviewer A confirmed: no contract-exclusion violations (no GUI numbering, no Pandoc-on-type, no citation redesign, no fallbacks, no bespoke matcher); red/green pairs exist for every phase; core proofs re-run independently green (168 unit / 31 probe / cross-repo).

### Reviewer B — code quality (anti-slop / reviewing-llm-code lenses)

| # | Claim | Disposition | Status |
|---|---|---|---|
| B1 | MUST-FIX: companion lua Cite handler rebuilds \cref from ids only — authored prefix/suffix/locators and SuppressAuthor silently discarded on documented syntax; no fixture exercises the shapes | Accepted — current-PR (export correctness gate); companion-repo remediation with red fixture | open |
| B2 | New shell:true single-quote interpolations scale to N+2 per export; quotes in titles/filenames break tokenization; spec covers spaces but not quotes | Accepted with remediation = shell:false argv array (deletes the whole class) | open |
| B3 | at-symbols duplicates the family display-name authority | Accepted — mechanical dedup | open |
| B4 | extract-references duplicates referenceFamilyOf from a module it already imports | Accepted — mechanical dedup | open |
| B5 | CROSSREF_FAMILIES vs PANDOC_CROSSREF_PREFIXES glued by canary not derivation; two predicates with divergent empty-slug semantics used in one file | Accepted — derive one from the other; reconcile predicates deliberately | open |
| B6 | reference-lint duplicates the id-token locator with fail-loud downgraded to fail-silent; re-parses previewSource (a display excerpt) for the mismatch diagnostic | Accepted — share the locator; carry classes on the definition | open |
| B7 | Rename proof lives on a provider ipc route production never uses; undo protocol has no production caller (overlaps A5) | Accepted — wire user-reachable undo + unify or justify the wire route; proof must ride the production path | open |
| B8 | Error contract contradicted by siblings: navigation/live-buffer/append-and-continue/menu-rename failures are log-only while the contract forbids exactly that | Accepted — route the named sites through the recoverable boundary | open |
| B9 | Test-accommodation guards in production (getCitationCallback probe, window.ipc guard comment, production-dead render-citations branch) | Accepted with modified remediation — fix harnesses to provide the globals/field where honest, delete guards; keep any branch only with a production justification | open |
| B10 | "Legacy single-file surface byte-stable" laundered: the shared Cite handler changes legacy output for @thm: citations; baseline fixture avoids the trigger | Accepted — extend baseline with a theorem citation, bless the intended new behavior explicitly, and narrow the written claim to what the test proves | open |
| B11 | Cross-repo prefix registries and default template name duplicated without drift canaries | Accepted — add registry-equality assertion to the cross-repo proof; sentinel template default owned by the recipe | open |
| B12–B23 | Debt notes (isFile fork, dead control flow in append-plan affordance, unused runner code field, stale JSDoc/phase comments, hand-enumerated spec list, source-text help spec, stringly crossref_mode, silent unknown-ipc, placeholder snapshot default, lua labeling asymmetry, class-registry overlap) | Cheap ones folded into remediation (13, 16, 21); remainder batched to a debt issue at the gate | open |

### Reviewer C — proof quality (test-guidelines admissibility + fresh capture sweep)

Headline verdict: no fabricated proofs, no behavior mocking, no vacuous passes in the completion differential, rename atomicity, or Pandoc oracle — each excludes the specific broken implementation it claims to. Findings:

| # | Claim | Disposition | Status |
|---|---|---|---|
| C1 | preflight() boot integration of the crossref gate unproven (deleting the call would pass every spec) | Accepted — boot-gate spec | open |
| C2 | Renderer Vue glue (reporter instantiation, referencesUpdate feed, overlay mount) has no owning spec | Accepted with modified remediation — cover the highest-risk joins via probes where honest; residual glue risk documented rather than laundered through fake Vue harnesses | open |
| C3 | capture-pandoc-divs / -chips / -hover lack --no-sandbox and hard-fail as committed | Accepted — recipe fix | open |
| C4 | Contract-named captures missing: completion popup, expanded hover, duplicate/outside-Project chip states, rename preview, navigation controls; two receipt-frames carry no visual information | Accepted — captures land with the behavioral remediations | open |
| C5 | Subfigure/wrapping forms have zero coverage (= A1) | Accepted (tracked as A1) | open |
| C6 | documents-provider navigation join (targetRange/sourceLocation/stamping/tab reuse) unspecced | Accepted — provider-layer spec via harness | open |
| C7 | Cross-repo script's `grep -q 'Ols04'` passes even if citeproc breaks | Accepted — assert the strong \autocite form | open |
| C8 | Escaped/structurally-malformed attribute cases, file-move index case, keymap-routing assertion missing | Accepted — cheap spec additions | open |
| C9 | Oracle covers 2 of 5 fixture files; dispatcher replicated in differential; recorder single-spawn blindness; conflicted-path temp-debris unasserted; second export profile unexercised | Accepted as debt-batch (low-severity, documented limits) unless trivially foldable | open |
