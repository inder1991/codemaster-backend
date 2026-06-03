import { z } from "zod";

import { ManifestSnapshot } from "./pr_context.v1.js";

// Zod port of contracts/fetch_manifest_snapshots/v1.py (frozen Python). Parity-validated in
// fetch_manifest_snapshots.v1.parity.test.ts.
//
// SHA-scoped (NOT pr_number-scoped) I/O contracts for `fetch_manifest_snapshots_activity`.
//
// Source models ported (every public one):
//  - FetchManifestSnapshotsInputV1  (ConfigDict extra=forbid, frozen) → .strict()
//  - FetchManifestSnapshotsOutputV1 (ConfigDict extra=forbid, frozen) → .strict()
//
// CROSS-CONTRACT IMPORT: `ManifestSnapshot` comes from the nested parent package
// `contracts.retrieval.pr_context.v1`, ported under `pr_context.v1.ts`. Imported as a sibling Zod
// schema — never redefined here.
//
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// `schema_version: int = 1` is a plain int default (NOT a Literal), so z.number().int().default(1)
// — z.literal(1) would wrongly reject schema_version=2. UUID fields dump lowercased (mode="json");
// payloads spell them lowercase so Pydantic's lowercasing matches Zod's pass-through.

// FetchManifestSnapshotsInputV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const FetchManifestSnapshotsInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    // installation_id: uuid.UUID — internal tenant FK; required.
    installation_id: z.string().uuid(),
    // github_installation_id: int = Field(ge=0) — GitHub-API id.
    github_installation_id: z.number().int().gte(0),
    // repository_id: uuid.UUID — internal repositories FK; required.
    repository_id: z.string().uuid(),
    gh_owner: z.string().min(1).max(255),
    gh_repo_name: z.string().min(1).max(255),
    // head_sha: str = Field(min_length=40, max_length=40) — full 40-char git SHA.
    head_sha: z.string().min(40).max(40),
    // candidate_paths: tuple[str, ...] = Field(default=(), max_length=5000)
    candidate_paths: z.array(z.string()).max(5000).default([]),
  })
  .strict();
export type FetchManifestSnapshotsInputV1 = z.infer<typeof FetchManifestSnapshotsInputV1>;

// FetchManifestSnapshotsOutputV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const FetchManifestSnapshotsOutputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    // manifests: tuple[ManifestSnapshot, ...] = Field(default=(), max_length=50) — matches the
    // PRContext.manifests cap. Nested ManifestSnapshot imported from pr_context.v1.
    manifests: z.array(ManifestSnapshot).max(50).default([]),
  })
  .strict();
export type FetchManifestSnapshotsOutputV1 = z.infer<typeof FetchManifestSnapshotsOutputV1>;
