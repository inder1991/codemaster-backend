import { z } from "zod";

import { AggregatedFindingsV1 } from "./aggregated_findings.v1.js";
import { LinkedIssueV1, PrMetaV1 } from "./walkthrough.v1.js";

// NEW typed-input envelope introduced DURING the Python→TS port — there is NO Python Pydantic
// counterpart to diff against. The frozen Python `WalkthroughActivities.generate_walkthrough`
// (vendor/codemaster-py/codemaster/review/walkthrough_activity.py) dispatches with FOUR positional
// arguments — `(pr_meta, aggregated, linked_issues=(), suggested_reviewers=())` — which violates
// CLAUDE.md invariant 11 / ADR-0047 ("every Temporal activity takes EXACTLY ONE positional argument
// typed as a Pydantic v2 BaseModel"). The TS port CLOSES that violation: the activity's single
// positional input is this `GenerateWalkthroughInputV1` envelope. This mirrors the sibling
// `AggregateFindingsInputV1` envelope (which closed the same invariant-11 violation for the 2-arg
// aggregate_findings dispatch).
//
// Because there is no Python contract for this envelope, the parity test only covers round-trip /
// validation (accepts a valid envelope; `.strict()` rejects unknown keys) — there is no
// source-of-truth to byte-diff against. The constituent shapes (PrMetaV1, AggregatedFindingsV1,
// LinkedIssueV1) ARE parity-validated against the frozen Python in their own suites.
//
// Field-for-field mirror of the frozen Python positional argument list:
//   * pr_meta              → PrMetaV1               (required; positional arg 1)
//   * aggregated           → AggregatedFindingsV1   (required; positional arg 2)
//   * linked_issues        → tuple[LinkedIssueV1,…] = () → z.array(LinkedIssueV1).default([])
//   * suggested_reviewers  → tuple[str, …]         = () → z.array(z.string()).default([])
//
// `suggested_reviewers` carries the same max-10 bound the WalkthroughV1 output contract enforces on
// the field this tuple is copied into (WalkthroughV1.suggested_reviewers max_length=10), so an
// over-long input tuple is rejected at the envelope rather than at the propagation copy. Likewise
// `linked_issues` carries the WalkthroughV1.linked_issues max-20 bound.

export const GenerateWalkthroughInputV1 = z
  .object({
    // Python `int = 1` schema_version default → z.number().int().default(1) (NOT z.literal(1): a
    // literal would false-reject a future schema_version=2 wire payload). Mirrors the
    // aggregate_findings.v1 envelope's schema_version handling.
    schema_version: z.number().int().default(1),
    pr_meta: PrMetaV1,
    aggregated: AggregatedFindingsV1,
    linked_issues: z.array(LinkedIssueV1).max(20).default([]),
    suggested_reviewers: z.array(z.string()).max(10).default([]),
  })
  .strict();
export type GenerateWalkthroughInputV1 = z.infer<typeof GenerateWalkthroughInputV1>;
