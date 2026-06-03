import { z } from "zod";

import { ReviewFindingV1 } from "./review_findings.v1.js";

// Zod port of contracts/citation_validation/v1.py (frozen Python). Parity-validated in
// citation_validation.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - DroppedFindingV1            (ConfigDict extra=forbid, frozen; __contract_internal__) → .strict()
//  - CitationValidationResultV1  (ConfigDict extra=forbid, frozen)                        → .strict()
//
// Both models embed the already-ported `ReviewFindingV1` (imported above, NOT redefined).
// `schema_version: int = 1` → z.number().int().default(1) (NOT z.literal — would false-reject 2).
//
// NOTE on the nested `confidence` float: `ReviewFindingV1.confidence` is a bare Python `float`, so
// Pydantic `model_dump(mode="json")` emits e.g. `1.0` while a JS number `1` emits `1`. The repo
// canonicalizer (test/parity/canonical.ts) therefore cannot reach byte-equal canonical JSON on any
// nested finding's confidence column — see the parity test for how the nested confidence columns are
// stripped from the canonical diff (Python-side float-serialization quirk, inherited from
// review_findings.v1).

// DroppedFindingV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// `reason` is bounded 1..500 (R-45 audit 2026-05-22 wire-size bound).
export const DroppedFindingV1 = z
  .object({
    finding: ReviewFindingV1,
    reason: z.string().min(1).max(500),
  })
  .strict();
export type DroppedFindingV1 = z.infer<typeof DroppedFindingV1>;

// CitationValidationResultV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// `surviving`/`dropped` are tuples in Python (tuple[...]) → z.array(...).
export const CitationValidationResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    surviving: z.array(ReviewFindingV1),
    dropped: z.array(DroppedFindingV1),
  })
  .strict();
export type CitationValidationResultV1 = z.infer<typeof CitationValidationResultV1>;
