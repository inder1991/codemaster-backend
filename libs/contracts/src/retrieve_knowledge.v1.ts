import { z } from "zod";

import { CodemasterConfigV1 } from "./codemaster_config.v1.js";
import { KnowledgeChunkV1 } from "./knowledge_chunks.v1.js";
import { PRContext } from "./pr_context.v1.js";

// Zod port of contracts/retrieve_knowledge/v1.py (frozen Python). Parity-validated in
// retrieve_knowledge.v1.parity.test.ts.
//
// Wire-contract between the review_pull_request workflow body and the per-chunk
// RetrieveKnowledgeActivity (Sprint 26 / PR-2 follow-up; Sub-spec B T12 Confluence extension).
//
// Source models / constants ported (every public one):
//  - CURRENT_SCHEMA_VERSION      (module-level Final[int])      → CURRENT_SCHEMA_VERSION
//  - RetrieveKnowledgeInputV1    (ConfigDict extra=forbid, frozen) → .strict()
//  - RetrieveKnowledgeResultV1   (ConfigDict extra=forbid, frozen) → .strict()
//
// Cross-contract refs imported from already-ported sibling Zod schemas (never redefined):
//  - CodemasterConfigV1 ← from contracts.codemaster_config.v1   → ./codemaster_config.v1.js
//  - KnowledgeChunkV1   ← from contracts.knowledge_chunks.v1     → ./knowledge_chunks.v1.js
//  - PRContext          ← from contracts.retrieval.pr_context.v1 → ./pr_context.v1.js
//
// `schema_version` is a plain Python `int` (= CURRENT_SCHEMA_VERSION = 1), NOT a Literal:
// z.number().int().default(1) so a future schema_version bump is not false-rejected (matching the
// knowledge_chunks / pr_context ports).
//
// BARE-FLOAT-bearing fields (cannot byte-round-trip through the repo canonicalizer, which REJECTS
// bare floats — test/parity/canonical.ts):
//  - RetrieveKnowledgeInputV1.query_vector_override : tuple[float, ...] | None
//  - RetrieveKnowledgeResultV1.items[*].age_days    : nested KnowledgeChunkV1 float (default 0.0)
// The parity test strips these (incl. nested) before the canonical diff and asserts them
// structurally + range-rejects them separately.
//
// FROZENSET: RetrieveKnowledgeInputV1.platform_exposed_labels is a Python frozenset[str];
// model_dump(mode="json") emits a list in nondeterministic hash order, so the parity test uses
// ≤1-element values (order-invariant) for byte-equal compare. The Python field has no max_length,
// so no .max() here.

// Module-level Final[int] in Python.
export const CURRENT_SCHEMA_VERSION = 1 as const;

// RetrieveKnowledgeInputV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const RetrieveKnowledgeInputV1 = z
  .object({
    schema_version: z.number().int().default(CURRENT_SCHEMA_VERSION),
    installation_id: z.string().uuid(),
    repo_id: z.string().uuid(),
    query: z.string().min(1).max(8000),
    top_k: z.number().int().gte(1).lte(20).default(5),
    // tuple[float, ...] | None = None. BARE-FLOAT-bearing — stripped in the parity canonical diff.
    query_vector_override: z.array(z.number()).nullable().default(null),
    // ── Sub-spec B T12 additive fields (all defaulted; back-compat) ──────────
    include_confluence: z.boolean().default(false),
    // PRContext | None = None — nested already-ported sibling schema.
    pr_context: PRContext.nullable().default(null),
    // CodemasterConfigV1 | None = None — nested already-ported sibling schema.
    yaml_config: CodemasterConfigV1.nullable().default(null),
    // frozenset[str] = default_factory=frozenset → z.array(...).default([]) (order-invariant payloads
    // in the parity test). No max_length on the Python field, so no .max() here.
    platform_exposed_labels: z.array(z.string()).default([]),
  })
  .strict();
export type RetrieveKnowledgeInputV1 = z.infer<typeof RetrieveKnowledgeInputV1>;

// RetrieveKnowledgeResultV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const RetrieveKnowledgeResultV1 = z
  .object({
    schema_version: z.number().int().default(CURRENT_SCHEMA_VERSION),
    // tuple[KnowledgeChunkV1, ...] = default_factory=tuple. Nested chunks carry a bare-float
    // age_days that is stripped in the parity canonical diff.
    items: z.array(KnowledgeChunkV1).default([]),
    retrieval_degraded: z.boolean().default(false),
    degradation_reason: z.string().max(200).default(""),
  })
  .strict();
export type RetrieveKnowledgeResultV1 = z.infer<typeof RetrieveKnowledgeResultV1>;
