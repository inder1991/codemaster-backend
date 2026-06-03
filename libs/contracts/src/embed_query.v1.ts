import { z } from "zod";

// Zod port of contracts/embed_query/v1.py (frozen Python). Parity-validated in
// embed_query.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - CURRENT_SCHEMA_VERSION (module-level Final[int])    → CURRENT_SCHEMA_VERSION
//  - EmbedQueryInputV1  (ConfigDict extra=forbid, frozen) → .strict()
//  - EmbedQueryResultV1 (ConfigDict extra=forbid, frozen) → .strict()
//
// NOTE on `vector`: the Python contract types it as `tuple[float, ...]` (bare floats).
// Pydantic `model_dump(mode="json")` preserves the float type, so e.g. `2.0` serializes
// as `2.0` whereas a JS number `2` serializes as `2`. The repo canonicalizer
// (test/parity/canonical.ts) therefore REJECTS bare floats and cannot reach byte-equal
// canonical JSON on the vector field — see the parity test for how the vector column is
// excluded from the canonical diff and instead asserted structurally (length + numeric).
//
// `schema_version` is a plain `int` (default 1), NOT a literal: z.number().int().default(1)
// so a future schema_version=2 is not false-rejected.

export const CURRENT_SCHEMA_VERSION = 1;

// EmbedQueryInputV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const EmbedQueryInputV1 = z
  .object({
    schema_version: z.number().int().default(CURRENT_SCHEMA_VERSION),
    query: z.string().min(1).max(8000),
  })
  .strict();
export type EmbedQueryInputV1 = z.infer<typeof EmbedQueryInputV1>;

// EmbedQueryResultV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// `vector` is tuple[float, ...] with min_length=1 → z.array(z.number()).min(1).
export const EmbedQueryResultV1 = z
  .object({
    schema_version: z.number().int().default(CURRENT_SCHEMA_VERSION),
    vector: z.array(z.number()).min(1),
  })
  .strict();
export type EmbedQueryResultV1 = z.infer<typeof EmbedQueryResultV1>;
