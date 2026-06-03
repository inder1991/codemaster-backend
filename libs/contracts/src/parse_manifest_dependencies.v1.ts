import { z } from "zod";

import { ManifestSnapshot } from "./pr_context.v1.js";

// Zod port of contracts/parse_manifest_dependencies/v1.py (frozen Python). Parity-validated in
// parse_manifest_dependencies.v1.parity.test.ts.
//
// `parse_manifest_dependencies_activity` I/O contracts (FOLLOW-UP-manifest-dependency-parsing v1).
// Both models are thin wrappers around a tuple of `ManifestSnapshot` — the fetch activity's output
// is the input; the parse activity's output is the same shape with the parsed fields populated.
//
// Source models / enums / constants ported (every public one):
//  - ParseManifestDependenciesInputV1  (ConfigDict extra=forbid, frozen) → .strict()
//  - ParseManifestDependenciesOutputV1 (ConfigDict extra=forbid, frozen) → .strict()
//
// CROSS-CONTRACT: `ManifestSnapshot` is imported from `from contracts.retrieval.pr_context.v1 import
// ManifestSnapshot` in Python — a NESTED parent package. The already-ported Zod schema lives in
// `pr_context.v1.ts`; this module imports it rather than redefining it.
//
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// `schema_version: int = 1` is a plain int default (NOT a Literal), so z.number().int().default(1)
// — z.literal(1) would wrongly reject schema_version=2.

// ParseManifestDependenciesInputV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// manifests: tuple[ManifestSnapshot, ...] = Field(default=(), max_length=50)
export const ParseManifestDependenciesInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    manifests: z.array(ManifestSnapshot).max(50).default([]),
  })
  .strict();
export type ParseManifestDependenciesInputV1 = z.infer<typeof ParseManifestDependenciesInputV1>;

// ParseManifestDependenciesOutputV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// parsed_manifests: tuple[ManifestSnapshot, ...] = Field(default=(), max_length=50)
export const ParseManifestDependenciesOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    parsed_manifests: z.array(ManifestSnapshot).max(50).default([]),
  })
  .strict();
export type ParseManifestDependenciesOutputV1 = z.infer<typeof ParseManifestDependenciesOutputV1>;
