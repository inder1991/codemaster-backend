// Unit tests for posting.ts — the Step-9 post-review sub-functions (finding 8). Exercises the success
// path (capture population + publication-outcome mapping), the H-2 dropped-state failure path (extract
// details → map dropped indices → rfids → dispatch record_delivery_skipped inline → re-raise), and the
// failure shapes the extractor must narrow (ActivityFailure-wrapped vs direct ApplicationFailure, wrong
// type, missing details).

import { describe, it, expect } from "vitest";

import { ActivityFailure, ApplicationFailure } from "@temporalio/common";

import {
  postReviewResults,
  extractDroppedStateFromPostFailure,
  derivePublicationOutcome,
  renderWalkthroughForPost,
  POST_REVIEW_FAILED_WITH_DROPPED_STATE,
  type PostingLifecycleDeps,
} from "#backend/review/pipeline/posting.js";
import { ReviewWorkflowState } from "#backend/review/pipeline/state.js";

import type { ReviewActivityPorts } from "#backend/review/pipeline/activity_ports.js";
import type { ReviewPipelinePrCtx } from "#backend/review/pipeline/orchestrator.js";
import { PrMetaV1, WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { PostedReviewV1, PublicationOutcome } from "#contracts/posted_review.v1.js";
import type { SkippedInputV1 } from "#contracts/finding_lifecycle_inputs.v1.js";

function uuidFor(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const PR_META: PrMetaV1 = PrMetaV1.parse({
  pr_id: uuidFor(1),
  installation_id: uuidFor(2),
  repo: "acme/widgets",
  pr_title: "Add widget",
  pr_description: "A widget.",
});

const PR: ReviewPipelinePrCtx = {
  prMeta: PR_META,
  headSha: "a".repeat(40),
  runId: uuidFor(4),
  reviewId: uuidFor(5),
  policyRevision: 3,
  prNumber: 42,
  changedLineRanges: { "src/a.ts": [[1, 10]] },
  parentFindings: [],
  parentReviewId: null,
};

const WALK: WalkthroughV1 = WalkthroughV1.parse({ tldr: "all good" });
const AGG: AggregatedFindingsV1 = AggregatedFindingsV1.parse({
  findings: [],
  dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
  policy_revision: 3,
});

/** Minimal ports stub: only `postReview` is exercised here (the other methods throw if called). */
function portsWith(postReview: ReviewActivityPorts["postReview"]): ReviewActivityPorts {
  const notCalled = (): never => {
    throw new Error("unexpected port call");
  };
  return {
    clone: notCalled,
    loadRepoConfig: notCalled,
    computePolicyRules: notCalled,
    classify: notCalled,
    chunkAndRedact: notCalled,
    staticAnalysis: notCalled,
    selectCarryForward: notCalled,
    embedQuery: notCalled,
    retrieveKnowledge: notCalled,
    reviewChunk: notCalled,
    dedupFindings: notCalled,
    aggregate: notCalled,
    persistReviewFindings: notCalled,
    generateWalkthrough: notCalled,
    persistReviewWalkthrough: notCalled,
    postReview,
    postCheckRun: notCalled,
    cleanup: notCalled,
  } as ReviewActivityPorts;
}

describe("renderWalkthroughForPost", () => {
  it("returns the walkthrough tldr unchanged when no arbitration result (Stage-5 footer deferred)", () => {
    const state = new ReviewWorkflowState();
    expect(renderWalkthroughForPost(WALK, state)).toBe("all good");
  });
});

describe("derivePublicationOutcome", () => {
  it("maps INLINE_POSTED → ok, BODY_ONLY_POSTED / DEGRADED_UNPOSTED → fallback", () => {
    const inline = PostedReviewV1.parse({
      review_id: 7,
      inline_comment_count: 0,
      publication_outcome: PublicationOutcome.enum.inline_posted,
    });
    const bodyOnly = PostedReviewV1.parse({
      review_id: 7,
      inline_comment_count: 0,
      publication_outcome: PublicationOutcome.enum.body_only_posted,
    });
    const degraded = PostedReviewV1.parse({
      review_id: null,
      inline_comment_count: 0,
      publication_outcome: PublicationOutcome.enum.degraded_unposted,
    });
    expect(derivePublicationOutcome(inline)).toBe("ok");
    expect(derivePublicationOutcome(bodyOnly)).toBe("fallback");
    expect(derivePublicationOutcome(degraded)).toBe("fallback");
  });
});

describe("postReviewResults — success path", () => {
  it("dispatches postReview, populates state.postedReview from the result", async () => {
    const state = new ReviewWorkflowState();
    const ports = portsWith(async () =>
      PostedReviewV1.parse({
        review_id: 7,
        inline_comment_count: 2,
        publication_outcome: PublicationOutcome.enum.inline_posted,
        comment_ids: [11, 22],
        kept_finding_indices: [0, 1],
      }),
    );
    const deps: PostingLifecycleDeps = { persistedFindingIds: [] };
    const posted = await postReviewResults(ports, state, WALK, AGG, PR, deps);
    expect(posted.review_id).toBe(7);
    expect(state.postedReview.reviewId).toBe(7);
    expect(state.postedReview.commentIds).toEqual([11, 22]);
    expect(state.postedReview.keptFindingIndices).toEqual([0, 1]);
    expect(state.postedReview.postedReviewPrId).toBe(PR_META.pr_id);
    expect(state.postedReview.publicationOutcome).toBe(PublicationOutcome.enum.inline_posted);
  });
});

describe("extractDroppedStateFromPostFailure — failure-shape narrowing", () => {
  const DETAILS = {
    dropped_classifications: [{ index: 0, eligibility_reason: "outside_hunk" }],
    kept_finding_indices: [1],
    posted_review_pr_id: uuidFor(1),
  };

  it("extracts the details from a direct ApplicationFailure of the dropped-state type", () => {
    const err = ApplicationFailure.create({
      message: "github 422",
      type: POST_REVIEW_FAILED_WITH_DROPPED_STATE,
      details: [DETAILS],
    });
    expect(extractDroppedStateFromPostFailure(err)).toEqual(DETAILS);
  });

  it("extracts the details from an ActivityFailure-wrapped ApplicationFailure", () => {
    const app = ApplicationFailure.create({
      message: "github 422",
      type: POST_REVIEW_FAILED_WITH_DROPPED_STATE,
      details: [DETAILS],
    });
    // Construct an ActivityFailure with the ApplicationFailure as cause (the SDK's wrap shape).
    const wrapped = Object.assign(Object.create(ActivityFailure.prototype) as ActivityFailure, {
      cause: app,
      message: "Activity task failed",
    });
    expect(extractDroppedStateFromPostFailure(wrapped)).toEqual(DETAILS);
  });

  it("returns null for an ApplicationFailure of a DIFFERENT type", () => {
    const err = ApplicationFailure.create({ message: "x", type: "SomethingElse", details: [DETAILS] });
    expect(extractDroppedStateFromPostFailure(err)).toBeNull();
  });

  it("returns null for the dropped-state type but EMPTY details", () => {
    const err = ApplicationFailure.create({
      message: "x",
      type: POST_REVIEW_FAILED_WITH_DROPPED_STATE,
      details: [],
    });
    expect(extractDroppedStateFromPostFailure(err)).toBeNull();
  });

  it("returns null for a plain Error", () => {
    expect(extractDroppedStateFromPostFailure(new Error("boom"))).toBeNull();
  });
});

describe("postReviewResults — H-2 dropped-state failure path", () => {
  it("maps dropped indices → rfids, dispatches record_delivery_skipped inline, then re-raises", async () => {
    const state = new ReviewWorkflowState();
    const failure = ApplicationFailure.create({
      message: "github 422 on inline",
      type: POST_REVIEW_FAILED_WITH_DROPPED_STATE,
      details: [
        {
          dropped_classifications: [
            { index: 0, eligibility_reason: "outside_hunk" },
            { index: 2, eligibility_reason: "before_first_hunk" },
          ],
          kept_finding_indices: [1],
          posted_review_pr_id: uuidFor(1),
        },
      ],
    });
    const ports = portsWith(async () => {
      throw failure;
    });
    const skippedDispatches: Array<SkippedInputV1> = [];
    const deps: PostingLifecycleDeps = {
      // 3 persisted rfids; dropped indices 0 + 2 map to rfids[0] + rfids[2].
      persistedFindingIds: [uuidFor(500), uuidFor(501), uuidFor(502)],
      recordDeliverySkipped: async (input) => {
        skippedDispatches.push(input);
        return input.rfids.length;
      },
    };
    await expect(postReviewResults(ports, state, WALK, AGG, PR, deps)).rejects.toBe(failure);
    expect(skippedDispatches.length).toBe(1);
    const dispatched = skippedDispatches[0]!;
    expect(dispatched.rfids).toEqual([uuidFor(500), uuidFor(502)]);
    expect(dispatched.reasons).toEqual(["outside_hunk", "before_first_hunk"]);
    expect(dispatched.posted_review_pr_id).toBe(uuidFor(1));
    expect(dispatched.installation_id).toBe(PR_META.installation_id);
  });

  it("re-raises WITHOUT a skip dispatch when recordDeliverySkipped is not injected", async () => {
    const state = new ReviewWorkflowState();
    const failure = ApplicationFailure.create({
      message: "github 422",
      type: POST_REVIEW_FAILED_WITH_DROPPED_STATE,
      details: [
        {
          dropped_classifications: [{ index: 0, eligibility_reason: "outside_hunk" }],
          kept_finding_indices: [],
          posted_review_pr_id: uuidFor(1),
        },
      ],
    });
    const ports = portsWith(async () => {
      throw failure;
    });
    const deps: PostingLifecycleDeps = { persistedFindingIds: [uuidFor(500)] };
    await expect(postReviewResults(ports, state, WALK, AGG, PR, deps)).rejects.toBe(failure);
  });

  it("re-raises a NON-dropped-state failure unchanged (no skip dispatch attempted)", async () => {
    const state = new ReviewWorkflowState();
    const failure = ApplicationFailure.create({ message: "auth", type: "PostReviewPermissionError" });
    const ports = portsWith(async () => {
      throw failure;
    });
    let skipCalled = false;
    const deps: PostingLifecycleDeps = {
      persistedFindingIds: [uuidFor(500)],
      recordDeliverySkipped: async () => {
        skipCalled = true;
        return 0;
      },
    };
    await expect(postReviewResults(ports, state, WALK, AGG, PR, deps)).rejects.toBe(failure);
    expect(skipCalled).toBe(false);
  });

  it("swallows a skip-dispatch failure and still re-raises the original post-review failure", async () => {
    const state = new ReviewWorkflowState();
    const failure = ApplicationFailure.create({
      message: "github 422",
      type: POST_REVIEW_FAILED_WITH_DROPPED_STATE,
      details: [
        {
          dropped_classifications: [{ index: 0, eligibility_reason: "outside_hunk" }],
          kept_finding_indices: [],
          posted_review_pr_id: uuidFor(1),
        },
      ],
    });
    const ports = portsWith(async () => {
      throw failure;
    });
    const deps: PostingLifecycleDeps = {
      persistedFindingIds: [uuidFor(500)],
      recordDeliverySkipped: async () => {
        throw new Error("skip dispatch boom");
      },
    };
    // The ORIGINAL post-review failure re-raises (not the skip-dispatch error).
    await expect(postReviewResults(ports, state, WALK, AGG, PR, deps)).rejects.toBe(failure);
  });
});
