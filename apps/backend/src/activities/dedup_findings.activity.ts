/**
 * `dedupFindings` activity — Temporal-activity port of the frozen Python `dedup_linter_with_llm`
 * (vendor/codemaster-py/codemaster/analysis/dedup_with_llm.py, Sprint 9 / S9.2.3).
 *
 * ## Why an ACTIVITY (the sandbox boundary — ADR-0065/0066)
 *
 * `dedup_linter_with_llm` combines linter-derived + LLM-derived findings and dedupes them in two stages:
 *
 *   combined      = linter_findings + llm_findings
 *   after_exact   = aggregateExact(combined)                 — PURE (no I/O)
 *   after_semantic, skipped = await aggregateSemantic(after_exact, embedder)   — EMBEDS over the network
 *
 * The semantic stage calls `embedder.embed(...)` — the platform Qwen / OpenAI-compat consumer — which is
 * a NETWORK round-trip. The orchestrator + workflow body run inside the Temporal V8 workflow sandbox,
 * which is deterministic + network/crypto/clock-FREE (ADR-0065/0066). A network call there is forbidden.
 * Therefore the dedup MUST be a Temporal activity (this module) that holds the live {@link EmbeddingsPort}
 * and runs in the NORMAL Node activity runtime; the orchestrator DISPATCHES it via the typed activity
 * port instead of calling the embedder inline.
 *
 * The Python source confirms this same boundary: the workflow body calls
 * `orchestrate_review_pipeline(embedder=None, ...)` (review_pull_request.py:3385 — *"bound-method activity
 * has its own embedder"*), so the workflow-side `dedup_linter_with_llm` ran the fail-open exact-only path,
 * and the REAL embedder lived in the activity runtime. The TS port keeps that boundary intact: the live
 * embedder is the holder's constructor collaborator, never threaded into the workflow body.
 *
 * ## Fail-open behaviour (faithful to the Python)
 *
 * The Python is fail-open on embedder failure: `aggregate_semantic` catches `EmbeddingsError` (and any
 * unexpected throw) and returns the input unchanged with `semantic_skipped=True`; `dedup_linter_with_llm`
 * then logs a WARN ("semantic stage skipped; exact-match dedupe still applied") and returns the
 * exact-deduped findings. This port preserves that EXACTLY — the catch lives in the shared
 * `aggregateSemantic` seam (aggregation_semantic.ts), so an embedder outage degrades to exact-only dedup
 * rather than failing the activity. The `semantic_skipped` flag (logged-only in Python) is surfaced on
 * the {@link DedupedFindingsV1} envelope so the workflow body can record the degradation outcome.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047
 *
 * The Python `dedup_linter_with_llm` is NOT itself an `@activity.defn` (it is called inline in the
 * orchestrator) and takes THREE keyword args (`linter_findings`, `llm_findings`, `embedder`). Promoting
 * it to an activity requires a single positional Pydantic-style envelope: the two finding tuples become
 * {@link DedupFindingsInputV1} fields; the embedder is the holder's constructor collaborator (a live
 * network client, never on the wire). The single-positional-input invariant is satisfied.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * This runs in the NORMAL Node activity runtime — NOT the workflow V8-isolate sandbox. The exact-dedup
 * stage is pure; the semantic stage performs the network embed. No clock, no random, no DB.
 *
 * ## Workflow-phase wiring boundary
 *
 * FOLLOW-UP-dedup-findings-orchestrator-wiring: the orchestrator (orchestrator.ts) is OWNED by the
 * Workflow phase and is NOT touched here. When that phase wires Step 6, it adds a `dedupFindings` typed
 * port to ReviewActivityPorts and dispatches this activity between fan-out (Step 5) and aggregate
 * (Step 7), replacing the Python's inline `dedup_linter_with_llm` call. This module exports the
 * registered activity + its bound-method holder + the pure core only; build_activities wires the holder.
 */

import { aggregateExact } from "#backend/review/aggregation.js";
import { aggregateSemantic } from "#backend/review/aggregation_semantic.js";

import type { EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import type { DedupFindingsInputV1, DedupedFindingsV1 } from "#contracts/dedup_findings.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

/**
 * The `dedup_linter_with_llm` core, ported EXACTLY (early-return short-circuits + 2-stage dedup):
 *
 *   if linter.length === 0 && llm.length === 0      → return ([], false)        (Python `return ()`)
 *   if linter.length === 0                          → return (llm, false)        (Python `return llm_findings`)
 *   if llm.length === 0                             → return (linter, false)     (Python `return linter_findings`)
 *   combined         = linter + llm                                              (linter FIRST — order matters)
 *   afterExact       = aggregateExact(combined)
 *   afterSemantic, semanticSkipped = await aggregateSemantic(afterExact, embedder)
 *   return (afterSemantic, semanticSkipped)
 *
 * The COMBINED ORDER is parity-significant: `aggregateExact` preserves first-occurrence ordering, so the
 * linter findings win title/severity ties (the linter's stable rule_id stays in the title — deterministic
 * + maintainer-friendly, per the Python docstring).
 *
 * Returns `[findings, semanticSkipped]` so the activity wrapper can surface the skip flag on the output
 * envelope. `semanticSkipped` is `false` on the three early-return short-circuits (the Python returns
 * before ever consulting the embedder; nothing degraded), and on the ≥2 path it is whatever
 * `aggregateSemantic` reports (true iff the embedder failed / returned a wrong vector count).
 *
 * The Python's WARN log on the skip is preserved as the caller's observable `semantic_skipped` field — we
 * deliberately do NOT emit a stray console log here (the activity wrapper / workflow body owns structured
 * observability; a bare log would diverge from the platform's stage-outcome contract).
 *
 * Exported so the Tier-1 parity oracle can drive the same logic the activity runs (mirrors the frozen
 * Python exporting `dedup_linter_with_llm`). The `embedder` is optional: a real {@link EmbeddingsPort}
 * runs the cosine-merge; `undefined` takes the fail-open no-embed path (the Python `embedder=None`
 * workflow-side seam) — which is exactly how the parity oracle forces the deterministic path, the same
 * technique the aggregate semantic-skip parity test uses.
 */
export async function doDedupLinterWithLlm(
  linterFindings: ReadonlyArray<ReviewFindingV1>,
  llmFindings: ReadonlyArray<ReviewFindingV1>,
  embedder?: EmbeddingsPort,
): Promise<[Array<ReviewFindingV1>, boolean]> {
  // Python: `if not linter_findings and not llm_findings: return ()`.
  if (linterFindings.length === 0 && llmFindings.length === 0) {
    return [[], false];
  }
  // Python: `if not linter_findings: return llm_findings`.
  if (linterFindings.length === 0) {
    return [[...llmFindings], false];
  }
  // Python: `if not llm_findings: return linter_findings`.
  if (llmFindings.length === 0) {
    return [[...linterFindings], false];
  }

  // Python: `combined = linter_findings + llm_findings` — linter FIRST (first-occurrence tie-break).
  const combined = [...linterFindings, ...llmFindings];
  // Python: `after_exact = aggregate_exact(combined)`.
  const afterExact = aggregateExact(combined);
  // Python: `after_semantic, semantic_skipped = await aggregate_semantic(after_exact, embedder=embedder)`.
  const [afterSemantic, semanticSkipped] = await aggregateSemantic(afterExact, embedder);
  return [afterSemantic, semanticSkipped];
}

/**
 * Bound-method holder for the `dedup_findings` activity — the 1:1 analogue of the frozen Python
 * bound-method-holder activities (`AggregateFindingsActivity(embedder=…)`, `EmbedQueryActivity(…)`). The
 * worker composition root constructs it with the resolved platform {@link EmbeddingsPort} and registers
 * its `dedupFindings` bound method, so the semantic stage runs the REAL Qwen cosine-merge:
 *
 *     const dedup = new DedupFindingsActivity({ embedder: resolveEmbeddingsConsumer(...) });
 *     const activities = { ...others, dedupFindings: dedup.dedupFindings };
 *
 * `dedupFindings` is an arrow property so it stays bound when destructured into the activities map
 * (Temporal registers the function value directly, losing `this`).
 */
export class DedupFindingsActivity {
  private readonly embedder: EmbeddingsPort;

  public constructor({ embedder }: { embedder: EmbeddingsPort }) {
    this.embedder = embedder;
  }

  /**
   * The registered activity: dedupe `input.linter_findings` + `input.llm_findings` via the
   * exact-then-semantic chain (real embedder) and return the {@link DedupedFindingsV1} envelope.
   *
   * Fail-open: an embedder failure degrades to exact-only dedup (`semantic_skipped=true`) rather than
   * throwing — faithful to the Python, whose `aggregate_semantic` catches the embedder error.
   */
  public readonly dedupFindings = async (
    input: DedupFindingsInputV1,
  ): Promise<DedupedFindingsV1> => {
    const [findings, semanticSkipped] = await doDedupLinterWithLlm(
      input.linter_findings,
      input.llm_findings,
      this.embedder,
    );
    return {
      schema_version: input.schema_version,
      findings,
      semantic_skipped: semanticSkipped,
    };
  };
}
