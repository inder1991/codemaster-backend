import { z } from "zod";

// Zod port of contracts/dropped_classification/v1.py (frozen Python). Parity-validated in
// dropped_classification.v1.parity.test.ts.
//
// Source models / fields ported (every public one):
//  - DroppedClassificationV1 (ConfigDict extra="forbid", frozen=True) → .strict().
//    Fields:
//      - schema_version: int = 1                              → z.number().int().default(1)
//        (a PLAIN int with a default, NOT z.literal(1) — z.literal would wrongly reject
//         schema_version=2 on a future bump).
//      - index: int = Field(ge=0, le=200)                     → z.number().int().gte(0).lte(200)
//      - eligibility_reason: str = Field(min_length=1, max_length=64)
//                                                             → z.string().min(1).max(64)
//
// No float fields, no UUID fields, no enum, no cross-contract dependency, no validators.

// DroppedClassificationV1 — ConfigDict(frozen=True, extra="forbid") → .strict().
export const DroppedClassificationV1 = z
  .object({
    schema_version: z.number().int().default(1),
    index: z.number().int().gte(0).lte(200),
    eligibility_reason: z.string().min(1).max(64),
  })
  .strict();
export type DroppedClassificationV1 = z.infer<typeof DroppedClassificationV1>;
