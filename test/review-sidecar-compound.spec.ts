/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Compound suggestion persistence
 * CVM-Role:        TESTING
 * License:         GNU GPL v3
 *
 * Description:     A proposal whose character diff falls into several parts is
 *                  kept as one suggestion, so that suggestion deletes in one
 *                  place and inserts in another. It has to survive the round
 *                  trip through the sidecar store, which is what persists a
 *                  review across a save and a reopen.
 *
 * END HEADER
 */

import { strict as assert } from "assert";
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";
import { createPatch } from "diff";
import {
  proposalRequestFingerprint,
  reviewSidecar,
} from "source/app/service-providers/documents/review-diff-store";
import { ReviewSidecarStore } from "source/app/service-providers/documents/review-sidecar-store";
import {
  isTransitionError,
  prepareProposalSubmission,
} from "source/app/service-providers/documents/review-transitions";
import { sha256Text } from "source/common/util/sha256";

const DOCUMENT_ID = "doc-compound";
const DOCUMENT_PATH = "/home/user/reviewed-document.md";

// The phrase pair from e2e/review-diff-save-gate.spec.ts: the character diff
// between them is an insertion followed by a separate deletion.
const BASELINE = "# Review gate\n\nA simple normal crossings divisor bounds the fibre.\n";
const PROPOSED = "# Review gate\n\nA SNC divisor bounds the fibre.\n";

describe("Review sidecar persists compound suggestions", function () {
  it("writes a suggestion that both deletes and inserts", async function () {
    const plan = prepareProposalSubmission({
      review: undefined,
      documentId: DOCUMENT_ID,
      documentPath: DOCUMENT_PATH,
      workingText: BASELINE,
      diskSha256: sha256Text(BASELINE),
      claims: [
        {
          patch: createPatch(DOCUMENT_PATH, BASELINE, PROPOSED, "", "", { context: 3 }),
          description: "Shorten the phrase",
        },
      ],
      clientRequestId: "compound-1",
      requestFingerprint: proposalRequestFingerprint({
        documentId: DOCUMENT_ID,
        baselineSha256: sha256Text(BASELINE),
        expectedReviewGeneration: 0,
        claims: [],
      }),
    });
    assert.ok(!isTransitionError(plan), "the proposal must apply to its baseline");
    const review = plan.nextReview;
    assert.ok(review !== undefined);

    const suggestion = review.suggestions[0];
    assert.equal(suggestion.kind, "substitution");
    assert.ok(
      suggestion.anchors.some((anchor) => anchor.from < anchor.to) &&
        suggestion.anchors.some((anchor) => anchor.from === anchor.to),
      "this change owns inserted text and carries a seam where text was removed",
    );

    const directory = mkdtempSync(path.join(os.tmpdir(), "zettlr-sidecar-compound-"));
    const store = new ReviewSidecarStore(directory);
    await store.write(reviewSidecar(review, plan.nextWorkingText));

    const restored = await store.read(DOCUMENT_PATH);
    assert.ok(restored !== undefined, "the sidecar must be readable back");
    assert.deepEqual(restored.suggestions[0].anchors, suggestion.anchors);
    assert.equal(restored.suggestions[0].removedText, suggestion.removedText);
  });
});
