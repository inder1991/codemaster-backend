import { z } from "zod";

// Zod port of codemaster/activities/delete_review_placeholder.py::DeleteReviewPlaceholderInput
// (frozen Python, Phase 1 PR-1c).
//
// Single typed positional input for the `delete_review_placeholder_activity` Temporal activity (CLAUDE.md
// invariant 11 / ADR-0047 — exactly one positional Pydantic/Zod-model argument per activity). The
// workflow body invokes the cleanup unconditionally after `post_review_results_activity` lands the real
// review; if no placeholder was posted, no marker matches and the activity no-ops.
//
// Field shape is IDENTICAL to PostReviewPlaceholderInput (the two activities share the same coordinates),
// but the contract is kept as a DISTINCT model — 1:1 with the Python, where the two `BaseModel`s are
// separate classes so a future divergence on either side does not silently couple them.
//
// schema_version GOTCHA: Python `schema_version: Literal[1] = 1` → z.literal(1).default(1). UUID GOTCHA:
// uuid.UUID → z.string().uuid() (lowercase). pr_number GOTCHA: bare Python `int` (no `ge=1`) →
// z.number().int() with NO lower bound. ConfigDict(extra="forbid") → .strict().
export const DeleteReviewPlaceholderInput = z
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

export type DeleteReviewPlaceholderInput = z.infer<typeof DeleteReviewPlaceholderInput>;
