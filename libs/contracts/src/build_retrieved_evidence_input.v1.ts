import { z } from "zod";

import { AnalysisFindingV1 } from "./analysis_findings.v1.js";
import { DiffChunkV1 } from "./diff_chunking.v1.js";
import { KnowledgeChunkV1 } from "./knowledge_chunks.v1.js";
import { PRTopologyEntryV1 } from "./pr_topology.v1.js";
import { ToolStatusV1 } from "./tool_status.v1.js";

// build_retrieved_evidence_input.v1 — the typed single-positional envelope for the
// `buildRetrievedEvidence` activity (the Temporal-activity port of the frozen Python
// `codemaster/review/evidence_producer.py::build_retrieved_evidence`, the v10 provenance-backed
// evidence manifest producer).
//
// ── Why this is an ACTIVITY (the sandbox boundary) ──
// The frozen Python `build_retrieved_evidence` is called INLINE in the workflow body
// (review_pull_request.py:1813) because Python's `mint_evidence_id` is pure stdlib hashlib/uuid —
// permitted in the Python Temporal sandbox. The TS port CANNOT do that: the ported `mintEvidenceId`
// (retrieved_evidence.v1.ts) mints via `node:crypto.createHash("sha1"/"sha256")`, and `node:crypto`
// is RESTRICTED inside the Temporal workflow V8-isolate sandbox (deterministic + I/O-free to preserve
// replay — same restriction that makes citation_validate / dedup_findings activities). Wrapping the
// producer in an activity moves the crypto-minting work to the NORMAL Node activity runtime where
// `node:crypto` is unrestricted. The workflow body DISPATCHES this activity per chunk instead of
// minting ev_ids inline.
//
// REPLAY-SAFETY is preserved despite the move: `mintEvidenceId` is a deterministic UUIDv5
// (content-addressable over source_type + sha256(parts)); the activity has NO wall-clock / RNG / DB /
// network. Every replay of the same per-chunk inputs mints bit-identical ev_ids, so the activity's
// output is stable across Temporal history replays (the activity-result is recorded in history, but
// the determinism property also holds independent of caching).
//
// ── NEW typed-input envelope introduced DURING the port (CLAUDE.md invariant 11 / ADR-0047) ──
// The frozen Python `build_retrieved_evidence` takes FIVE keyword arguments (`chunk`,
// `retrieved_knowledge`, `tier1_findings`, `tool_statuses`, `pr_topology_manifest`) plus `max_entries`.
// Temporal activities are single-positional, so the TS port COLLAPSES those into this one envelope
// (consistent with the sibling citation_validate_input.v1 / static_analysis_input.v1 /
// dedup_findings.v1 envelopes that closed the other multi-positional dispatches). There is therefore
// NO Python Pydantic counterpart for the ENVELOPE itself to byte-diff against; its parity coverage is
// round-trip + validation only. The producer CORE behaviour (the emitted RetrievedEvidenceV1 tuple —
// same entries, same ev_ids, same priority-cap drop order) IS byte-diffed against the frozen Python in
// the parity test.
//
// Field mapping (Python keyword → envelope field):
//  - `chunk: DiffChunkV1` → `chunk: DiffChunkV1` (REQUIRED, no default — the chunk_body entry is ALWAYS
//    emitted; the LLM is reviewing this chunk). Reuses the already-ported DiffChunkV1 (NOT redefined).
//  - `retrieved_knowledge: tuple[KnowledgeChunkV1, ...] = ()` → `z.array(KnowledgeChunkV1).default([])`.
//    Tuples serialize to JSON arrays. INPUT ORDER is preserved (the producer iterates in order).
//  - `tier1_findings: tuple[AnalysisFindingV1, ...] = ()` → `z.array(AnalysisFindingV1).default([])`.
//  - `tool_statuses: tuple[ToolStatusV1, ...] = ()` → `z.array(ToolStatusV1).default([])`. The producer
//    passes each entry's sequence index into the mint key (R-21 collision-disambiguation), so input
//    ORDER is load-bearing for ev_id stability.
//  - `pr_topology_manifest: tuple[PRTopologyEntryV1, ...] = ()` → `z.array(PRTopologyEntryV1).default([])`.
//  - `max_entries: int = 100` → `max_entries: z.number().int().gte(0).default(100)`. The hard cap on the
//    output tuple length (drops lowest-priority entries first). Default 100 matches the producer's
//    `_DEFAULT_ENTRY_CAP` AND `ReviewContextV1.retrieved_evidence` max_length, so the activity output
//    never overflows the contract that carries it.
//  - `schema_version: int = 1` → `z.number().int().default(1)` (NOT z.literal(1): a literal would
//    false-reject a future schema_version=2 wire payload). Mirrors the sibling envelopes.

export const BuildRetrievedEvidenceInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    chunk: DiffChunkV1,
    retrieved_knowledge: z.array(KnowledgeChunkV1).default([]),
    tier1_findings: z.array(AnalysisFindingV1).default([]),
    tool_statuses: z.array(ToolStatusV1).default([]),
    pr_topology_manifest: z.array(PRTopologyEntryV1).default([]),
    // Hard cap on output tuple length; drops lowest-priority entries first. Matches the Python
    // _DEFAULT_ENTRY_CAP (100) and ReviewContextV1.retrieved_evidence max_length.
    max_entries: z.number().int().gte(0).default(100),
  })
  .strict();
export type BuildRetrievedEvidenceInputV1 = z.infer<typeof BuildRetrievedEvidenceInputV1>;
