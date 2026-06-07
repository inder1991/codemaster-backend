import { z } from "zod";

import { ReviewFindingV1 } from "./review_findings.v1.js";

// dedup_findings.v1 — the typed envelopes for the `dedup_findings` activity (the Temporal-activity port
// of the frozen Python `dedup_linter_with_llm`,
// vendor/codemaster-py/codemaster/analysis/dedup_with_llm.py).
//
// ── Why this is an ACTIVITY (not a workflow-body helper) ──
// `dedup_linter_with_llm` combines linter + LLM findings and dedupes them via the existing
// `aggregate_exact` (pure) + `aggregate_semantic` (EMBEDS over the network) pair. The semantic stage
// calls `embedder.embed(...)` — the platform Qwen consumer — which is a network round-trip. Under
// ADR-0065/0066 anything that networks MUST be a Temporal activity, never inline in the V8 workflow
// sandbox. So this is dispatched as a 1-arg typed-envelope activity that holds the real EmbeddingsPort.
//
// In the frozen Python the WORKFLOW BODY calls `orchestrate_review_pipeline(embedder=None, ...)`
// (review_pull_request.py:3385 — "bound-method activity has its own embedder"), so the workflow-side
// `dedup_linter_with_llm` ran the fail-open exact-only path; the real embedder lived in the activity
// runtime. The TS port keeps the SAME boundary: the embedder lives in the activity, off the sandbox.
//
// ── NEW typed-input envelope introduced DURING the port ──
// The frozen Python `dedup_linter_with_llm` takes THREE keyword arguments
// (`linter_findings: tuple[ReviewFindingV1, ...]`, `llm_findings: tuple[ReviewFindingV1, ...]`,
// `embedder: EmbeddingsPort`) and is NOT itself an `@activity.defn` (it is called inline in the
// orchestrator). Making it an activity requires a single positional Pydantic-style envelope
// (CLAUDE.md invariant 11 / ADR-0047): the two finding tuples become envelope fields; the embedder is
// a CONSTRUCTOR collaborator of the activity holder (never on the wire — it is a live network client,
// not serializable). There is therefore NO Python counterpart to byte-diff the ENVELOPE against; its
// parity coverage is round-trip + validation only (consistent with the sibling aggregate_findings.v1 /
// static_analysis_input.v1 envelopes).

// DedupFindingsInputV1 — the single positional activity input. `.strict()` mirrors the Pydantic
// `extra="forbid"` posture the sibling envelopes use; both finding tuples reuse the already-ported
// ReviewFindingV1 Zod schema rather than redefining the finding shape.
//
// Field mapping (Python keyword → envelope field):
//  - `linter_findings: tuple[ReviewFindingV1, ...]` → `linter_findings: z.array(ReviewFindingV1)`.
//    Tuples serialize to JSON arrays. INPUT ORDER is parity-significant: the Python concatenates
//    `linter_findings + llm_findings` and `aggregate_exact` preserves first-occurrence order, so the
//    linter findings deterministically win title/severity ties (the linter's stable rule_id stays in
//    the title). Defaults to [] (the Python short-circuits the no-linter case to `llm_findings`).
//  - `llm_findings: tuple[ReviewFindingV1, ...]` → `llm_findings: z.array(ReviewFindingV1)`. Defaults
//    to [] (the Python short-circuits the no-llm case to `linter_findings`).
//  - `embedder: EmbeddingsPort` → NOT a field. It is the activity holder's constructor collaborator
//    (the live Qwen/OpenAI-compat client). A network client is never serialized onto a Temporal wire.
//  - `schema_version: int = 1` → z.number().int().default(1) (NOT z.literal(1): a literal would
//    false-reject a future schema_version=2 wire payload). Mirrors the sibling envelopes.

export const DedupFindingsInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    linter_findings: z.array(ReviewFindingV1).default([]),
    llm_findings: z.array(ReviewFindingV1).default([]),
  })
  .strict();
export type DedupFindingsInputV1 = z.infer<typeof DedupFindingsInputV1>;

// DedupedFindingsV1 — the activity output. The frozen Python `dedup_linter_with_llm` returns a bare
// `tuple[ReviewFindingV1, ...]` and LOGS the semantic-skip degradation internally (a WARN line). An
// activity must return a single typed envelope, so the port wraps the findings tuple AND surfaces the
// semantic-skip flag as an INSPECTABLE field instead of only logging it — mirroring how the sibling
// `AggregatedFindingsV1.dedupe_stats.semantic_skipped` exposes the same fail-open signal. The `findings`
// list + ORDER is the parity-significant payload (byte-diffed against the frozen Python tuple).
//
//  - `findings: tuple[ReviewFindingV1, ...]` → z.array(ReviewFindingV1).default([]) (the Python return).
//  - `semantic_skipped: bool` → z.boolean().default(false). True iff the embedder failed (or returned
//    the wrong vector count) and the semantic stage degraded to the exact-only pass-through. The Python
//    surfaces this only via its WARN log + the caller's `dedupe_stats.semantic_skipped`; the envelope
//    makes it a first-class observable so the workflow body can record the degradation outcome.
//  - `schema_version: int = 1` → z.number().int().default(1). Mirrors the sibling output envelopes.

export const DedupedFindingsV1 = z
  .object({
    schema_version: z.number().int().default(1),
    findings: z.array(ReviewFindingV1).default([]),
    semantic_skipped: z.boolean().default(false),
  })
  .strict();
export type DedupedFindingsV1 = z.infer<typeof DedupedFindingsV1>;
