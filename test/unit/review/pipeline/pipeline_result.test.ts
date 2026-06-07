// Unit test for ReviewPipelineResult + makeReviewPipelineResult (pipeline_result.ts). Asserts the frozen
// Python dataclass defaults for the three trailing defaulted fields (review_finding_ids=()/[],
// arbitration_intents=()/[], arbitration_result=None/null) and that construction wires every required
// field through unchanged — the orchestrate() return envelope.
import { describe, it, expect } from "vitest";

import {
  makeReviewPipelineResult,
  type ReviewPipelineResult,
  type ReviewPipelineResultRequired,
} from "#backend/review/pipeline/pipeline_result.js";
import { WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";

// A minimal required-field set: every Python non-defaulted field, with the | None sub-contract fields
// left null (the orchestrator's "no aggregated set yet" / "no walkthrough produced" shape).
const requiredAllNull: ReviewPipelineResultRequired = {
  status: "accepted",
  headSha: "0".repeat(40),
  findingsCount: 0,
  walkthrough: null,
  aggregated: null,
  fileRouting: null,
  staticAnalysis: null,
  carryForward: null,
  classifierFailureRatio: 0.0,
  degradationNotes: [],
};

describe("makeReviewPipelineResult — Python dataclass trailing-field defaults", () => {
  it("applies review_finding_ids=()/arbitration_intents=()/arbitration_result=None → []/[]/null", () => {
    const r = makeReviewPipelineResult(requiredAllNull);
    expect(r.reviewFindingIds).toEqual([]);
    expect(r.arbitrationIntents).toEqual([]);
    expect(r.arbitrationResult).toBeNull();
  });

  it("wires every required field through unchanged", () => {
    const r = makeReviewPipelineResult(requiredAllNull);
    expect(r.status).toBe("accepted");
    expect(r.headSha).toBe("0".repeat(40));
    expect(r.findingsCount).toBe(0);
    expect(r.walkthrough).toBeNull();
    expect(r.aggregated).toBeNull();
    expect(r.fileRouting).toBeNull();
    expect(r.staticAnalysis).toBeNull();
    expect(r.carryForward).toBeNull();
    expect(r.classifierFailureRatio).toBe(0.0);
    expect(r.degradationNotes).toEqual([]);
  });

  it("preserves a bare-float classifier_failure_ratio (sandbox-internal, not a JSON wire field)", () => {
    // Python float; below the _CLASSIFIER_FAILURE_THRESHOLD (0.10). Stays a bare JS number — no
    // canonical-JSON float-string coercion (it never crosses an activity boundary through this type).
    const r = makeReviewPipelineResult({ ...requiredAllNull, classifierFailureRatio: 0.0625 });
    expect(r.classifierFailureRatio).toBeCloseTo(0.0625);
    expect(typeof r.classifierFailureRatio).toBe("number");
  });
});

describe("makeReviewPipelineResult — overriding the three defaulted fields (by-keyword equivalent)", () => {
  it("threads review_finding_ids (UUID wire-form string array) through", () => {
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const r = makeReviewPipelineResult(requiredAllNull, { reviewFindingIds: ids });
    expect(r.reviewFindingIds).toEqual(ids);
    // The other two defaults remain at their dataclass defaults.
    expect(r.arbitrationIntents).toEqual([]);
    expect(r.arbitrationResult).toBeNull();
  });

  it("threads arbitration_intents (ArbitrationIntentV1 contract instances) through", () => {
    const intent = ArbitrationIntentV1.parse({
      target_finding_id: "33333333-3333-4333-8333-333333333333",
      confidence: 0.75,
      reason: "duplicate of a Tier-2 finding on the same line",
    });
    const r = makeReviewPipelineResult(requiredAllNull, { arbitrationIntents: [intent] });
    expect(r.arbitrationIntents).toEqual([intent]);
    expect(r.reviewFindingIds).toEqual([]);
    expect(r.arbitrationResult).toBeNull();
  });

  it("threads arbitration_result (Stage-5 ArbitrationResult forward-decl: unknown) through", () => {
    // Until Stage 5 ports the arbitration layer, ArbitrationResult is `unknown`; the envelope only
    // stashes it for the walkthrough-footer renderer. A non-null sentinel proves the slot is preserved.
    const sentinel = { decisions: [], rejected_intents: [] };
    const r = makeReviewPipelineResult(requiredAllNull, { arbitrationResult: sentinel });
    expect(r.arbitrationResult).toBe(sentinel);
  });

  it("an explicit null arbitration_result override is the same as omitting it", () => {
    const r = makeReviewPipelineResult(requiredAllNull, { arbitrationResult: null });
    expect(r.arbitrationResult).toBeNull();
  });
});

describe("makeReviewPipelineResult — populated sub-contract fields", () => {
  it("carries WalkthroughV1 + AggregatedFindingsV1 instances through unchanged", () => {
    const walkthrough = WalkthroughV1.parse({ tldr: "reviewed 1 file" });
    const aggregated = AggregatedFindingsV1.parse({
      findings: [],
      dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
      policy_revision: 0,
    });
    const r = makeReviewPipelineResult({
      ...requiredAllNull,
      status: "accepted",
      findingsCount: 0,
      walkthrough,
      aggregated,
    });
    expect(r.walkthrough).toBe(walkthrough);
    expect(r.aggregated).toBe(aggregated);
  });

  it("every field is always present (exactOptionalPropertyTypes / frozen-dataclass shape)", () => {
    const r: ReviewPipelineResult = makeReviewPipelineResult(requiredAllNull);
    const keys = Object.keys(r).sort();
    expect(keys).toEqual(
      [
        "aggregated",
        "arbitrationIntents",
        "arbitrationResult",
        "carryForward",
        "classifierFailureRatio",
        "degradationNotes",
        "fileRouting",
        "findingsCount",
        "headSha",
        "reviewFindingIds",
        "staticAnalysis",
        "status",
        "walkthrough",
      ].sort(),
    );
  });
});
