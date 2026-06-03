import { z } from "zod";

import { DiffChunkV1 } from "./diff_chunking.v1.js";
import { ReviewFindingV1 } from "./review_findings.v1.js";

// Zod port of contracts/carry_forward/v1.py::CarryForwardSelectionV1 (frozen Python).
// Output of `select_carry_forward` (S8.4.1b): the carried-vs-to-review partition for an
// incremental review push. Parity-validated in carry_forward.v1.parity.test.ts.
//
// Source models / fields ported (every public one):
//  - CarryForwardSelectionV1 (ConfigDict extra=forbid, frozen) → .strict()
//      - schema_version: int = 1                                → z.number().int().default(1)
//        (Python field is a plain `int` with default 1, NOT Literal[1]; z.literal(1) would
//         FALSELY reject schema_version=2 and break parity. Matches diff_chunking/review_findings.)
//      - carried: tuple[ReviewFindingV1, ...] = default_factory=tuple
//                                                               → z.array(ReviewFindingV1).default([])
//      - to_review: tuple[DiffChunkV1, ...] = default_factory=tuple
//                                                               → z.array(DiffChunkV1).default([])
//      - parent_review_id: uuid.UUID | None = None              → z.string().uuid().nullable().default(null)
//        (Pydantic lowercases the UUID on model_dump(mode="json"); parity payloads use lowercase.)
//
// `carried` elements are ReviewFindingV1, which carries a bare Python `float` (`confidence`).
// The repo canonicalizer (test/parity/canonical.ts) rejects bare floats, so the parity test
// strips `confidence` from each nested finding before the canonical diff — see that test header.
// The sibling Zod schemas (DiffChunkV1, ReviewFindingV1) are IMPORTED, not redefined.
export const CarryForwardSelectionV1 = z
  .object({
    schema_version: z.number().int().default(1),
    carried: z.array(ReviewFindingV1).default([]),
    to_review: z.array(DiffChunkV1).default([]),
    parent_review_id: z.string().uuid().nullable().default(null),
  })
  .strict();

export type CarryForwardSelectionV1 = z.infer<typeof CarryForwardSelectionV1>;
