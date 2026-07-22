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

### Reviewer B — code quality (pending)

### Reviewer C — proof quality (pending)
