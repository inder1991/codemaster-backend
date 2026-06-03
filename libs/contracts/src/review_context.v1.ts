import { z } from "zod";

import { AnalysisFindingV1 } from "./analysis_findings.v1.js";
import { CodemasterConfigV1, PathInstructionV1 } from "./codemaster_config.v1.js";
import { DiffChunkV1 } from "./diff_chunking.v1.js";
import { KnowledgeChunkV1 } from "./knowledge_chunks.v1.js";
import { ManifestSnapshot } from "./pr_context.v1.js";
import { PRTopologyEntryV1 } from "./pr_topology.v1.js";
import { ResolvedGuidanceBundleV1 } from "./resolved_guidance.v1.js";
import { RetrievedEvidenceV1 } from "./retrieved_evidence.v1.js";
import { ConsumerHitV1, RemovedOrChangedSymbolV1 } from "./symbol_graph.v1.js";
import { ReviewFindingV1 } from "./review_findings.v1.js";
import { ToolStatusV1 } from "./tool_status.v1.js";

// Zod port of contracts/review_context/v1.py::ReviewContextV1 (frozen Python — the LARGEST contract,
// ~11 cross-contract deps). Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a
// TS-side concern, not wire). Parity-validated in review_context.v1.parity.test.ts.
//
// `ReviewContextV1` is the frozen input envelope for the bedrock_review_chunk activity. It carries the
// tenant + PR identity, the chunk under review, the policy revision, prior findings, matched per-glob
// path instructions, retrieved knowledge, retrieval-degradation state, the budget-enforcement flag,
// per-chunk policy bundle, symbol-graph consumer-impact context, Tier-1 linter findings + tool
// statuses, provenance-backed evidence, the PR-topology manifest, and project-manifest snapshots.
//
// CROSS-CONTRACT DEPENDENCIES (each imports the already-ported sibling Zod schema; nothing redefined):
//  - DiffChunkV1                ← ./diff_chunking.v1.js
//  - ReviewFindingV1            ← ./review_findings.v1.js     (Field default ())
//  - PathInstructionV1          ← ./codemaster_config.v1.js   (matched_path_instructions, default ())
//  - CodemasterConfigV1         ← ./codemaster_config.v1.js   (repo_config, shared frozen default)
//  - KnowledgeChunkV1           ← ./knowledge_chunks.v1.js    (retrieved_knowledge, default ())
//  - ResolvedGuidanceBundleV1   ← ./resolved_guidance.v1.js   (applicable_policy, default None)
//  - RemovedOrChangedSymbolV1   ← ./symbol_graph.v1.js        (removed_or_changed_symbols, default ())
//  - ConsumerHitV1              ← ./symbol_graph.v1.js        (consumer_hits, default ())
//  - AnalysisFindingV1          ← ./analysis_findings.v1.js   (tier1_findings, default ())
//  - ToolStatusV1               ← ./tool_status.v1.js         (tool_statuses, default ())
//  - RetrievedEvidenceV1        ← ./retrieved_evidence.v1.js  (retrieved_evidence, default (), max 100)
//  - PRTopologyEntryV1          ← ./pr_topology.v1.js         (pr_topology_manifest, default (), max 200)
//  - ManifestSnapshot           ← ./pr_context.v1.js (contracts.retrieval.pr_context) (manifests, max 50)
//
// NOTE on `schema_version`: the Python field is a plain `int` defaulting to 1 (NOT Literal[1]), so a
// future schema_version=2 envelope is accepted + re-emitted → z.number().int().default(1).
//
// NOTE on `repo_config` default: Python `Field(default=CodemasterConfigV1())` is a shared frozen
// default instance. The Zod default mirrors the fully-defaulted dump shape so an omitted `repo_config`
// dumps identically to Python (CodemasterConfigV1.parse({}) reproduces every nested default).
//
// NOTE on `applicable_policy`: Python `ResolvedGuidanceBundleV1 | None = None` → .nullable().default(null)
// (Pydantic dumps the absent field as explicit null, so the Zod default injects null too).
//
// BARE-FLOAT COLUMNS (cannot byte-round-trip through the repo canonicalizer, which REJECTS bare floats):
//  - prior_findings[*].confidence                          (ReviewFindingV1 bare float)
//  - retrieved_knowledge[*].age_days                       (KnowledgeChunkV1 bare float, default 0.0)
// These live INSIDE nested deps; the parity test strips them (recursively) before the canonical diff
// and asserts the surrounding structure separately — same pattern as knowledge_chunks.v1.parity.test.ts.
// ReviewContextV1 ITSELF declares no bare-float scalar field.
export const ReviewContextV1 = z
  .object({
    schema_version: z.number().int().default(1),
    pr_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    repo: z.string().min(1).max(200),
    pr_title: z.string().max(500),
    pr_description: z.string().max(10_000),
    chunk: DiffChunkV1,
    policy_revision: z.number().int().gte(0),
    // tuple[ReviewFindingV1, ...] = default_factory=tuple → z.array(...).default([]).
    prior_findings: z.array(ReviewFindingV1).default([]),
    // tuple[PathInstructionV1, ...] = default_factory=tuple.
    matched_path_instructions: z.array(PathInstructionV1).default([]),
    // Shared frozen default instance CodemasterConfigV1() → fully-defaulted nested default.
    repo_config: CodemasterConfigV1.default(() => CodemasterConfigV1.parse({})),
    // tuple[KnowledgeChunkV1, ...] = default_factory=tuple.
    retrieved_knowledge: z.array(KnowledgeChunkV1).default([]),
    retrieval_degraded: z.boolean().default(false),
    retrieval_degradation_reason: z.string().max(200).default(""),
    budget_enforcement: z.boolean().default(false),
    // ResolvedGuidanceBundleV1 | None = None → .nullable().default(null).
    applicable_policy: ResolvedGuidanceBundleV1.nullable().default(null),
    // tuple[RemovedOrChangedSymbolV1, ...] = default_factory=tuple.
    removed_or_changed_symbols: z.array(RemovedOrChangedSymbolV1).default([]),
    // tuple[ConsumerHitV1, ...] = default_factory=tuple.
    consumer_hits: z.array(ConsumerHitV1).default([]),
    consumer_hits_truncated: z.boolean().default(false),
    // tuple[AnalysisFindingV1, ...] = default_factory=tuple.
    tier1_findings: z.array(AnalysisFindingV1).default([]),
    // tuple[ToolStatusV1, ...] = default_factory=tuple.
    tool_statuses: z.array(ToolStatusV1).default([]),
    // tuple[RetrievedEvidenceV1, ...] = Field(default_factory=tuple, max_length=100).
    retrieved_evidence: z.array(RetrievedEvidenceV1).max(100).default([]),
    // tuple[PRTopologyEntryV1, ...] = Field(default_factory=tuple, max_length=200).
    pr_topology_manifest: z.array(PRTopologyEntryV1).max(200).default([]),
    // tuple[ManifestSnapshot, ...] = Field(default=(), max_length=50).
    manifests: z.array(ManifestSnapshot).max(50).default([]),
  })
  .strict();

export type ReviewContextV1 = z.infer<typeof ReviewContextV1>;
