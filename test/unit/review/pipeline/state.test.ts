// Unit test for ReviewWorkflowState + the capture types (state.ts). Asserts the closure-box ports start at
// the Python dataclass/box defaults (None/() → null/[], CodemasterConfigV1() defaults) and that the typed
// fields are independently assignable — the explicit, testable transitions finding 4 calls for.
import { describe, it, expect } from "vitest";

import {
  ReviewWorkflowState,
  makePostReviewCapture,
  makeArbitrationCapture,
} from "#backend/review/pipeline/state.js";
import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";

describe("makePostReviewCapture — _PostReviewCapture() defaults", () => {
  it("starts at the Python dataclass defaults (None/() → null/[])", () => {
    const c = makePostReviewCapture();
    expect(c.reviewId).toBeNull();
    expect(c.commentIds).toEqual([]);
    expect(c.postedReviewPrId).toBeNull();
    expect(c.keptFindingIndices).toEqual([]);
    expect(c.publicationOutcome).toBeNull();
    expect(c.degradationNotes).toEqual([]);
    expect(c.droppedClassifications).toEqual([]);
  });
});

describe("makeArbitrationCapture — _ArbitrationCapture() defaults", () => {
  it("starts at the Python dataclass defaults (None/() → null/[])", () => {
    const c = makeArbitrationCapture();
    expect(c.result).toBeNull();
    expect(c.toolStatuses).toEqual([]);
  });
});

describe("ReviewWorkflowState — the seven closure boxes as one typed object", () => {
  it("initializes all boxes to their Python defaults", () => {
    const s = new ReviewWorkflowState();
    expect(s.policyBundles.size).toBe(0); // {}
    expect(s.queryVectorCache.size).toBe(0); // {}
    expect(s.degradation.notes).toEqual([]); // deduped note list
    expect(s.repoConfig).toEqual(CodemasterConfigV1.parse({})); // [CodemasterConfigV1()]
    expect(s.inlinePostFilterMetadata).toBeUndefined(); // [] box, unset until R-23 populates
    expect(s.postedReview).toEqual(makePostReviewCapture()); // _PostReviewCapture()
    expect(s.arbitration).toEqual(makeArbitrationCapture()); // _ArbitrationCapture()
    expect(s.persistedFindingIds).toEqual([]); // []
  });

  it("repoConfig is an independently assignable field (box → field; finding 4)", () => {
    const s = new ReviewWorkflowState();
    const overridden = CodemasterConfigV1.parse({ enabled: false, severity_min: "blocker" });
    s.repoConfig = overridden;
    expect(s.repoConfig.enabled).toBe(false);
    expect(s.repoConfig.severity_min).toBe("blocker");
  });

  it("queryVectorCache is keyed by chunk path (finding 10) and survives per-path caching", () => {
    const s = new ReviewWorkflowState();
    s.queryVectorCache.set("src/a.ts", [0.1, 0.2, 0.3]);
    expect(s.queryVectorCache.get("src/a.ts")).toEqual([0.1, 0.2, 0.3]);
    expect(s.queryVectorCache.has("src/b.ts")).toBe(false);
  });

  it("degradation collector composes through the state object", () => {
    const s = new ReviewWorkflowState();
    s.degradation.add("persist_findings_failed");
    s.degradation.add("persist_findings_failed"); // dedup
    expect(s.degradation.compose(null)).toBe("pipeline degraded: persist_findings_failed");
  });

  it("postedReview is mutably re-assignable after orchestrate() returns (capture slot)", () => {
    const s = new ReviewWorkflowState();
    s.postedReview = {
      ...makePostReviewCapture(),
      reviewId: 42,
      commentIds: [1, 2, 3],
      publicationOutcome: "inline_posted",
    };
    expect(s.postedReview.reviewId).toBe(42);
    expect(s.postedReview.commentIds).toEqual([1, 2, 3]);
  });
});
