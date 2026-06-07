import { z } from "zod";

import { ReviewFindingV1 } from "./review_findings.v1.js";

// Contract for the carry-forward parent-findings loader (#6 — ENHANCEMENT beyond the frozen Python,
// which passed parent_findings=() / parent_review_id=None at the orchestrate() call). The deep-dive
// (2026-06-06) established that NO schema migration is needed: review_finding_id is content-addressed
// (uuid5 of pr_id|file|lines|severity|title) + ON CONFLICT DO NOTHING, so core.review_findings already
// holds ONE content-deduplicated row per logical finding per PR. "The previous review's findings" is
// therefore just "the findings currently LIVE on this PR" — the rows delivered (inline_delivered /
// body_only_fallback) + not suppressed. The loader runs BEFORE the current run persists, so the table
// holds exactly the prior accumulated state. review_id is per-PR (one review lifecycle; runs are
// per-sync), so parent_review_id = the current review_id (pure provenance in select_carry_forward).
//
// Gated default-OFF behind the workflow-body CARRY_FORWARD_V2_WITH_DB flag until the EXPLAIN/A-B
// validation the Python S22.DM.18 deferral required is done.

export const LoadParentReviewFindingsInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    installation_id: z.string().uuid().transform((s) => s.toLowerCase()),
    pr_id: z.string().uuid().transform((s) => s.toLowerCase()),
    // The PR's review-lifecycle id (per-PR). Stamped onto the result as parent_review_id (provenance).
    review_id: z.string().uuid().transform((s) => s.toLowerCase()),
  })
  .strict();
export type LoadParentReviewFindingsInputV1 = z.infer<typeof LoadParentReviewFindingsInputV1>;

export const LoadParentReviewFindingsResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    // null when there are no live parent findings (clean first review) — keeps the selector's None path.
    parent_review_id: z.string().uuid().nullable().default(null),
    parent_findings: z.array(ReviewFindingV1).default([]),
  })
  .strict();
export type LoadParentReviewFindingsResultV1 = z.infer<typeof LoadParentReviewFindingsResultV1>;
