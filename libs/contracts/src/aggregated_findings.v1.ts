import { z } from "zod";

import { ReviewFindingV1 } from "./review_findings.v1.js";

// Zod port of contracts/aggregated_findings/v1.py (frozen Python). Parity-validated in
// aggregated_findings.v1.parity.test.ts.
//
// Output of the `aggregate_findings` activity: the already-deduped, ranked, and capped findings
// tuple plus per-stage statistics so the walkthrough renderer can show "showing N of M" +
// degradation markers.
//
// Source models / enums / constants ported (every public one):
//  - DedupeStatsV1       (ConfigDict extra=forbid, frozen, __contract_internal__) → .strict()
//  - AggregatedFindingsV1(ConfigDict extra=forbid, frozen)                        → .strict()
//
// `findings: tuple[ReviewFindingV1, ...]` imports the already-ported sibling Zod schema
// (./review_findings.v1.js) rather than redefining it. NOTE: ReviewFindingV1 carries a bare
// Python `float` (`confidence`) which cannot byte-round-trip through the canonicalizer — the
// parity test strips that nested column from the canonical diff (see review_findings.v1.ts header
// + the aggregated_findings parity test for the nested-strip helper).

// DedupeStatsV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// `__contract_internal__ = True` is a contract-lint marker (versions move with the parent
// envelope); it has no wire/runtime effect, so there is nothing to mirror on the Zod side.
export const DedupeStatsV1 = z
  .object({
    input_count: z.number().int().gte(0),
    exact_dropped: z.number().int().gte(0),
    semantic_merged: z.number().int().gte(0),
    capped: z.number().int().gte(0),
    semantic_skipped: z.boolean().default(false),
  })
  .strict();
export type DedupeStatsV1 = z.infer<typeof DedupeStatsV1>;

// AggregatedFindingsV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const AggregatedFindingsV1 = z
  .object({
    // Python: schema_version: int = 1. Bare int default → z.number().int().default(1)
    // (NOT z.literal(1) — a literal would false-reject a future schema_version=2 wire payload).
    schema_version: z.number().int().default(1),
    // tuple[ReviewFindingV1, ...] = default_factory=tuple → z.array(...).default([]).
    findings: z.array(ReviewFindingV1).default([]),
    // Required sub-shape (no default).
    dedupe_stats: DedupeStatsV1,
    // Python: policy_revision: int = Field(ge=0). Required (no default).
    policy_revision: z.number().int().gte(0),
  })
  .strict();
export type AggregatedFindingsV1 = z.infer<typeof AggregatedFindingsV1>;
