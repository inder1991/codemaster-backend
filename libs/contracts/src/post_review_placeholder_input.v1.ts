import { z } from "zod";

// Zod port of codemaster/activities/post_review_placeholder.py::PostReviewPlaceholderInput
// (frozen Python, Phase 1 PR-1c).
//
// Single typed positional input for the `post_review_placeholder_activity` Temporal activity (CLAUDE.md
// invariant 11 / ADR-0047 — exactly one positional Pydantic/Zod-model argument per activity). The
// workflow body constructs this immediately after the gate accepts the PR, before the heavy
// clone/classify/chunk/review work, so engineers see life on the PR within ~5s of webhook receipt.
//
// schema_version GOTCHA: Python `schema_version: Literal[1] = 1` (Literal, not bare int) → only the
// value 1 is accepted, default 1. z.literal(1).default(1) reproduces both the constraint and the
// default. ConfigDict(extra="forbid") → .strict().
//
// UUID GOTCHA: Python uuid.UUID → z.string().uuid(). UUIDs are spelled lowercase in fixtures so
// Pydantic's lowercasing-on-dump matches Zod's pass-through.
//
// pr_number GOTCHA: the Python field is a BARE `int` (no `ge=1` constraint, unlike PostReviewInputV1's
// `pr_number: int (ge=1)`); the 1:1 port therefore uses z.number().int() WITHOUT a lower bound.
export const PostReviewPlaceholderInput = z
  .object({
    schema_version: z.literal(1).default(1),
    pr_id: z.string().uuid(),
    run_id: z.string().uuid(),
    review_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    owner: z.string(),
    repo_name: z.string(),
    pr_number: z.number().int(),
  })
  .strict();

export type PostReviewPlaceholderInput = z.infer<typeof PostReviewPlaceholderInput>;
