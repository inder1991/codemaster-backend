import { z } from "zod";

// Zod port of contracts/load_repo_config/v1.py (frozen Python). Parity-validated in
// load_repo_config.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - LoadRepoConfigInputV1 (ConfigDict extra="forbid", frozen=True) → .strict().
//    Frozen input envelope for `load_repo_config_activity` (spec §3.1). Single typed
//    positional Temporal-activity argument (CLAUDE.md invariant 11); JSON-safe by
//    construction (workspace_path is `str`, not Path).
//
// NOTE on `schema_version`: the Python contract types it as a bare `int` defaulting to 1
// (NOT a Literal), so a future v2 envelope can carry schema_version=2 without the v1
// contract false-rejecting it. Modeled as z.number().int().default(1), NOT z.literal(1).

// LoadRepoConfigInputV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const LoadRepoConfigInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    // workspace_path: str = Field(min_length=1). Absolute path to the cloned workspace
    // produced by the clone step earlier in the pipeline.
    workspace_path: z.string().min(1),
  })
  .strict();
export type LoadRepoConfigInputV1 = z.infer<typeof LoadRepoConfigInputV1>;
