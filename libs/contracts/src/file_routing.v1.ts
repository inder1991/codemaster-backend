import { z } from "zod";

import { FileClassificationV1 } from "./file_classification.v1.js";

// Zod port of contracts/file_routing/v1.py::FileRoutingV1 (frozen Python).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in file_routing.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - FileRoutingV1 (ConfigDict extra=forbid, frozen) — the only public symbol in v1.py.
//    No enums / constants / validators / helper-fns exist in the source module.
//
// Field mapping notes:
//  - `schema_version: int = 1` is a plain int field with default 1 (NOT a Literal — any int is
//    accepted), so it maps to z.number().int().default(1), not z.literal(1) (z.literal would
//    false-reject schema_version=2).
//  - The four `tuple[str, ...] = Field(default_factory=tuple)` fields map to
//    z.array(z.string()).default([]) — tuples serialize to JSON arrays under model_dump(mode="json").
//  - `classifications: tuple[FileClassificationV1, ...] = default_factory=tuple` reuses the already-
//    ported sibling FileClassificationV1 (NOT redefined here).
export const FileRoutingV1 = z
  .object({
    schema_version: z.number().int().default(1),
    review_files: z.array(z.string()).default([]),
    sandbox_files: z.array(z.string()).default([]),
    skip_files: z.array(z.string()).default([]),
    classifications: z.array(FileClassificationV1).default([]),
    classifier_failures: z.array(z.string()).default([]),
  })
  .strict();

export type FileRoutingV1 = z.infer<typeof FileRoutingV1>;
