# Claim

Implement the granular accept/reject review interface specified by issue #34.

## GitHub Tracking

- Target issue set: #34
- Milestone: none assigned
- Closes on merge: Closes #34
- References only: none

# Delivery Boundary

This PR owns the Zettlr-Pandoc side of document-diff review:

- a `review-diff` CLI route that accepts a target document and a unified patch;
- strict parsing and validation for a single text-file proposition;
- optional SHA-256 baseline fencing before a review session starts;
- a CodeMirror 6 unified diff review view for Markdown documents;
- per-chunk accept/reject controls backed by CodeMirror merge chunks;
- unresolved-chunk state tracked by the document provider;
- save refusal while chunks remain unresolved;
- save refusal when the on-disk document has drifted from the review baseline;
- focused tests and rendered screenshots for the review UI.

# Product Boundaries

- This is not a Git repository review feature.
- This does not support multi-file, binary, rename, copy, create, delete, mode-change, or directory patches.
- The app reviews one already-supported Markdown/code text document at a time.
- Accepting a chunk keeps the proposed text for that chunk.
- Rejecting a chunk restores the baseline text for that chunk.
- The document provider remains the authority for dirty state and final disk writes.
- Unsupported inputs fail before opening or modifying the target document.

# Acceptance and Proof Obligations

- [x] #34: Baseline plus valid multi-chunk proposition opens review mode; accepting the first chunk and rejecting the second saves exactly the expected mixed result. — `test/editor-review-diff.spec.ts` drives the real merge controls; `test/review-diff-save-gate.spec.ts` proves the provider writes the exact mixed buffer once chunks are resolved.
- [x] #34: Baseline plus proposition plus external disk edit before resolution refuses the resolution/write and leaves the external edit intact. — `test/review-diff-save-gate.spec.ts`.
- [x] #34: Malformed or non-applicable patch exits nonzero through the CLI route and does not open or modify the document. — `source/main.ts` preflight exits before the single-instance handoff; `test/review-diff-request.spec.ts`.
- [x] #34: The rendered review interface has visible independently actionable chunks at desktop and narrow widths. — `just capture-review-diff /tmp/zettlr-review-diff-captures`, screenshots inspected.
- [x] #34: The branch uses maintained CodeMirror/jsdiff dependencies and does not introduce a bespoke patch parser. — `@codemirror/merge@^6.12.2`, `diff@^9.0.0`.

# Known External State

Repository QC wiring is already tracked by issue #4 and PR #35. This PR does not claim to repair that project-wide gate.
