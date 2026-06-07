/**
 * `buildRetrievedEvidence` activity — Temporal-activity port of the frozen Python
 * `build_retrieved_evidence` (vendor/codemaster-py/codemaster/review/evidence_producer.py, v10 R-12 —
 * the provenance-backed evidence manifest producer).
 *
 * ## What it does (1:1 with the frozen Python)
 *
 * Assembles the per-chunk `Array<RetrievedEvidenceV1>` the LLM is permitted to cite via
 * `ReviewFindingV1.evidence_refs`, from the per-chunk inputs the workflow body has already resolved:
 *
 *   1. chunk_body          — ALWAYS exactly 1 entry (the chunk under review; primary grounding).
 *   2. retrieved_knowledge — 1 entry per KnowledgeChunkV1 (BM25+ANN+RRF retrieval).
 *   3. tier1_finding       — 1 entry per AnalysisFindingV1 (ruff / eslint / gitleaks / …).
 *   4. pr_topology         — 1 entry per PRTopologyEntryV1 (v8 chunk-locality manifest).
 *   5. tool_status         — 1 entry per ToolStatusV1 (per-tool execution outcome).
 *
 * Entries are emitted in PRIORITY ORDER (the numbered order above — EVIDENCE_PRIORITY in
 * retrieved_evidence.v1) and the output is sliced to `max_entries` (default 100), which drops the
 * LOWEST-priority entries first (tool_status → pr_topology → tier1_finding → retrieved_knowledge →
 * chunk_body). In practice chunk_body is the single guaranteed-present entry and everything else
 * competes for the remaining ≤99 slots.
 *
 * ## Why this is an ACTIVITY (the sandbox boundary)
 *
 * The frozen Python `build_retrieved_evidence` is called INLINE in the workflow body
 * (review_pull_request.py:1813) — Python's `mint_evidence_id` is pure stdlib hashlib/uuid, permitted in
 * the Python Temporal sandbox. The TS port CANNOT do that: the ported `mintEvidenceId`
 * (retrieved_evidence.v1.ts) mints via `node:crypto.createHash`, and `node:crypto` is RESTRICTED inside
 * the Temporal workflow V8-isolate sandbox (deterministic + I/O-free to preserve replay — the same
 * restriction that makes citation_validate / dedup_findings activities). Wrapping the producer in an
 * activity moves the crypto-minting work to the NORMAL Node activity runtime where `node:crypto` is
 * unrestricted. The orchestrator DISPATCHES this activity per chunk instead of minting ev_ids inline.
 *
 * ## Replay-safety (preserved despite the move)
 *
 * `mintEvidenceId` is a deterministic UUIDv5 (content-addressable over `source_type + sha256(parts)`);
 * this producer performs NO wall-clock / RNG / DB / network operations. Every call over the same
 * per-chunk inputs mints bit-identical ev_ids → the output is stable across Temporal history replays.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047
 *
 * The Python takes FIVE keyword args (`chunk`, `retrieved_knowledge`, `tier1_findings`, `tool_statuses`,
 * `pr_topology_manifest`) + `max_entries`. Promoting it to a single-positional activity collapses those
 * into the {@link BuildRetrievedEvidenceInputV1} envelope. The single-positional-input invariant holds.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Runs in the NORMAL Node activity runtime — NOT the workflow V8-isolate sandbox. The only side-effect
 * is the crypto hash inside `mintEvidenceId`. No clock, no random, no DB, no network.
 *
 * ## Workflow-phase wiring boundary
 *
 * FOLLOW-UP-build-retrieved-evidence-orchestrator-wiring: the worker registry / build_activities /
 * activity_ports / orchestrator are OWNED by the Workflow phase and are NOT touched here. That phase
 * binds this activity into the `activities` map and dispatches it per chunk (between knowledge-retrieval
 * and the bedrock_review_chunk call), replacing the Python's inline `build_retrieved_evidence` call.
 * This module exports the registered activity function + the pure core (so the parity oracle can drive
 * the same logic the activity runs, mirroring the frozen Python exporting `build_retrieved_evidence`).
 */

import {
  mintEvidenceId,
  RetrievedEvidenceV1,
} from "#contracts/retrieved_evidence.v1.js";

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import type { BuildRetrievedEvidenceInputV1 } from "#contracts/build_retrieved_evidence_input.v1.js";
import type { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import type { KnowledgeChunkV1 } from "#contracts/knowledge_chunks.v1.js";
import type { PRTopologyEntryV1 } from "#contracts/pr_topology.v1.js";
import type { ToolStatusV1 } from "#contracts/tool_status.v1.js";

// Matches RetrievedEvidenceV1.excerpt max_length (the prompt renderer applies its own per-entry
// truncation on top of this). 1:1 with the Python `chunk.body[:2000]` / message slicing.
const EXCERPT_CAP = 2000;

// Matches the Python `_DEFAULT_ENTRY_CAP` AND ReviewContextV1.retrieved_evidence max_length — the hard
// cap on the output array length when the input envelope omits `max_entries`.
export const DEFAULT_ENTRY_CAP = 100;

/**
 * One evidence entry for the chunk under review (ALWAYS emitted). Port of `_chunk_body_evidence`.
 *
 * Excerpt capped at 2000 chars (RetrievedEvidenceV1.excerpt max_length). The empty-body fallback
 * `(empty <chunk_kind>)` matches the Python f-string exactly: `chunk_kind` is a plain Literal on both
 * sides, so the rendered text is identical (e.g. `(empty hunk)`).
 */
function chunkBodyEvidence(chunk: DiffChunkV1): RetrievedEvidenceV1 {
  return RetrievedEvidenceV1.parse({
    evidence_id: mintEvidenceId("chunk_body", chunk.chunk_id),
    source_type: "chunk_body",
    chunk_id: chunk.chunk_id,
    path: chunk.path,
    excerpt: chunk.body ? chunk.body.slice(0, EXCERPT_CAP) : `(empty ${chunk.chunk_kind})`,
  });
}

/**
 * One evidence entry per retrieved knowledge chunk. Port of `_knowledge_evidence` (incl. R-20 empty-body
 * fallback). `doc_kind` is a Python StrEnum whose `.value` is the wire string; the TS contract field IS
 * already that string, so `(empty <doc_kind> knowledge chunk)` renders identically.
 */
function knowledgeEvidence(k: KnowledgeChunkV1): RetrievedEvidenceV1 {
  const excerpt = k.body ? k.body.slice(0, EXCERPT_CAP) : `(empty ${k.doc_kind} knowledge chunk)`;
  return RetrievedEvidenceV1.parse({
    evidence_id: mintEvidenceId("retrieved_knowledge", k.chunk_id),
    source_type: "retrieved_knowledge",
    knowledge_chunk_id: k.chunk_id,
    path: k.relative_path,
    excerpt,
  });
}

/** One evidence entry per Tier-1 static-analysis finding. Port of `_tier1_evidence`. */
function tier1Evidence(f: AnalysisFindingV1): RetrievedEvidenceV1 {
  // excerpt: `rule_id: message`, capped to 2000 (rule_id ≤ 200 + message ≤ 2000 + separator).
  const excerpt = `${f.rule_id}: ${f.message}`.slice(0, EXCERPT_CAP);
  return RetrievedEvidenceV1.parse({
    evidence_id: mintEvidenceId("tier1_finding", f.finding_id),
    source_type: "tier1_finding",
    path: f.file,
    excerpt,
  });
}

/**
 * One evidence entry per PR topology manifest entry. Port of `_topology_evidence`.
 * `kind` is a plain Literal on both sides → the excerpt renders identically.
 */
function topologyEvidence(entry: PRTopologyEntryV1): RetrievedEvidenceV1 {
  return RetrievedEvidenceV1.parse({
    evidence_id: mintEvidenceId("pr_topology", entry.chunk_id),
    source_type: "pr_topology",
    chunk_id: entry.chunk_id,
    path: entry.path,
    excerpt: `${entry.kind} ${entry.path}:${entry.start_line}-${entry.end_line}`,
  });
}

/**
 * One evidence entry per Tier-1 tool execution status. Port of `_tool_status_evidence`.
 *
 * Per R-21 the sequence `index` is part of the mint key so two ToolStatusV1 entries sharing
 * `(tool_name, status)` don't collide on ev_id; the rendered excerpt DROPS the index (an opaque
 * sequence number the LLM doesn't need to see). The mint call passes `index` as a number — `mintEvidenceId`
 * stringifies parts with `String(p)`, which reproduces Python's `str(int)` byte-for-byte.
 */
function toolStatusEvidence(s: ToolStatusV1, index: number): RetrievedEvidenceV1 {
  return RetrievedEvidenceV1.parse({
    evidence_id: mintEvidenceId("tool_status", s.tool_name, s.status, index),
    source_type: "tool_status",
    excerpt: `${s.tool_name} ${s.status}`,
  });
}

/**
 * The `build_retrieved_evidence` core, ported EXACTLY (priority assembly + lowest-priority-first cap).
 *
 * Builds per-source-type entries in priority order (chunk_body → retrieved_knowledge → tier1_finding →
 * pr_topology → tool_status), then slices to `maxEntries` so the tail (= lowest priority) is dropped.
 *
 * Exported so the Tier-1 parity oracle can drive the same logic the activity runs (mirrors the frozen
 * Python exporting `build_retrieved_evidence`).
 */
export function buildRetrievedEvidenceEntries(args: {
  readonly chunk: DiffChunkV1;
  readonly retrievedKnowledge?: ReadonlyArray<KnowledgeChunkV1>;
  readonly tier1Findings?: ReadonlyArray<AnalysisFindingV1>;
  readonly toolStatuses?: ReadonlyArray<ToolStatusV1>;
  readonly prTopologyManifest?: ReadonlyArray<PRTopologyEntryV1>;
  readonly maxEntries?: number;
}): Array<RetrievedEvidenceV1> {
  const retrievedKnowledge = args.retrievedKnowledge ?? [];
  const tier1Findings = args.tier1Findings ?? [];
  const toolStatuses = args.toolStatuses ?? [];
  const prTopologyManifest = args.prTopologyManifest ?? [];
  const maxEntries = args.maxEntries ?? DEFAULT_ENTRY_CAP;

  const byPriority: Array<RetrievedEvidenceV1> = [];
  // 1. chunk_body — always exactly 1 entry.
  byPriority.push(chunkBodyEvidence(args.chunk));
  // 2. retrieved_knowledge.
  for (const k of retrievedKnowledge) {
    byPriority.push(knowledgeEvidence(k));
  }
  // 3. tier1_finding.
  for (const f of tier1Findings) {
    byPriority.push(tier1Evidence(f));
  }
  // 4. pr_topology.
  for (const t of prTopologyManifest) {
    byPriority.push(topologyEvidence(t));
  }
  // 5. tool_status. Per R-21 the sequence index is part of the mint key so two ToolStatusV1 entries
  // sharing (tool_name, status) don't collide on ev_id.
  for (const [i, s] of toolStatuses.entries()) {
    byPriority.push(toolStatusEvidence(s, i));
  }

  // Apply the entry cap by slicing (drops the tail = lowest priority).
  return byPriority.slice(0, maxEntries);
}

/**
 * The registered activity: assemble the per-chunk evidence manifest from the typed envelope and return
 * the priority-ordered `Array<RetrievedEvidenceV1>` (length ≤ `input.max_entries`).
 *
 * Stateless (no holder / collaborator) — like {@link citationValidate}, the producer is pure modulo the
 * `mintEvidenceId` crypto hash, so the activity is a thin forwarding wrapper over the exported core.
 */
export async function buildRetrievedEvidence(
  input: BuildRetrievedEvidenceInputV1,
): Promise<Array<RetrievedEvidenceV1>> {
  return buildRetrievedEvidenceEntries({
    chunk: input.chunk,
    retrievedKnowledge: input.retrieved_knowledge,
    tier1Findings: input.tier1_findings,
    toolStatuses: input.tool_statuses,
    prTopologyManifest: input.pr_topology_manifest,
    maxEntries: input.max_entries,
  });
}
