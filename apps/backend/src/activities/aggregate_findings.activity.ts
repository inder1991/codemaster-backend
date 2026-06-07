/**
 * `aggregateFindings` activity — Phase-2.1 first core-loop activity port. 1:1 in intent with the frozen
 * Python `@activity.defn aggregate_findings` + `_do_aggregate`
 * (vendor/codemaster-py/codemaster/review/aggregate_activity.py): chain the three aggregation stages
 * (scope-consistency → exact-dedup → semantic-merge → rank+cap) into one entry point and return an
 * `AggregatedFindingsV1` envelope with per-stage statistics.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The frozen Python activity dispatches with TWO positional arguments
 * (`aggregate_findings(findings, policy_revision)`) — the only known live invariant-11 violation
 * (head-of-eng-audit-2 R-14). This port CLOSES that violation: the single positional input is the
 * {@link AggregateFindingsInputV1} envelope (findings + policy_revision + schema_version). There is no
 * Python Pydantic counterpart for the envelope — it is introduced during the port.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. The aggregation core
 * is nonetheless PURE + DETERMINISTIC (no clock, no random, no DB): `_doAggregate` is sandbox-safe by
 * construction, which is why this activity touches no Postgres (the aggregate stage operates entirely on
 * the in-memory findings tuple) and registers no clock/random seam.
 *
 * ## Semantic stage — real Qwen cosine-merge (injected embedder)
 *
 * The pipeline threads an injected {@link EmbeddingsPort} into `aggregateSemantic`. Production wires the
 * resolved platform embedder (Qwen / OpenAI-compat adapter); tests inject a deterministic double. With a
 * real embedder the semantic stage embeds every finding body and greedily merges same-file near-duplicates
 * (cosine ≥ 0.92), so `semantic_merged` is now non-zero. When NO embedder is provided the stage takes the
 * fail-open skip path (`after_semantic = after_exact`, `semantic_merged = 0`), with `semantic_skipped`
 * mirroring the frozen Python's `len < 2 ? false : true` flag. See aggregation_semantic.ts for the merge.
 */

import {
  aggregateExact,
  assertFindingScopeConsistency,
  rankAndCap,
} from "#backend/review/aggregation.js";
import { aggregateSemantic } from "#backend/review/aggregation_semantic.js";

import type { EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import { AggregateFindingsInputV1 } from "#contracts/aggregate_findings.v1.js";
import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

/**
 * The `_do_aggregate` pipeline, ported EXACTLY (stage order + stat accumulation):
 *
 *   input_count    = findings.length
 *   [after_scope]  = assertFindingScopeConsistency(findings)            (drops non-chunk_observed)
 *   after_exact    = aggregateExact(after_scope)
 *   exact_dropped  = after_scope.length - after_exact.length
 *   [after_sem, semantic_skipped] = await aggregateSemantic(after_exact, embedder)
 *   semantic_merged = after_exact.length - after_sem.length             (non-zero when a real merge fires)
 *   [after_cap, capped] = rankAndCap(after_sem)
 *
 * Returns the `AggregatedFindingsV1` envelope. Async because the semantic stage embeds over the network
 * (the Python `_do_aggregate` is likewise `async`). Exported so the Tier-1 parity oracle can drive the
 * same pipeline the activity runs (mirrors the frozen Python exporting `_do_aggregate`). The optional
 * `embedder` is the merge collaborator: a real {@link EmbeddingsPort} runs the cosine-merge; `undefined`
 * takes the fail-open skip path (semantic_merged = 0).
 */
export async function doAggregate(
  findings: ReadonlyArray<ReviewFindingV1>,
  policyRevision: number,
  embedder?: EmbeddingsPort,
): Promise<AggregatedFindingsV1> {
  const inputCount = findings.length;

  // v9-MINIMAL R-3 structural scope-consistency check (drops findings whose scope != chunk_observed).
  const [afterScope] = assertFindingScopeConsistency(findings);

  const afterExact = aggregateExact(afterScope);
  const exactDropped = afterScope.length - afterExact.length;

  // Real embedder → greedy cosine-merge of same-file near-duplicates; no embedder → fail-open skip path.
  const [afterSemantic, semanticSkipped] = await aggregateSemantic(afterExact, embedder);
  const semanticMerged = afterExact.length - afterSemantic.length;

  const [afterCap, capped] = rankAndCap(afterSemantic);

  return {
    schema_version: 1,
    findings: afterCap,
    dedupe_stats: {
      input_count: inputCount,
      exact_dropped: exactDropped,
      semantic_merged: semanticMerged,
      capped,
      semantic_skipped: semanticSkipped,
    },
    policy_revision: policyRevision,
  };
}

/**
 * The registered activity (no-embedder default). Takes the single typed {@link AggregateFindingsInputV1}
 * envelope (invariant 11) and runs {@link doAggregate} over its findings + policy_revision with NO
 * embedder — the fail-open skip path. This is the back-compat module-level registration the worker
 * registry wires today; production threads a real embedder via {@link AggregateFindingsActivity} (the
 * 1:1 analogue of the frozen Python bound-method holder).
 */
export async function aggregateFindings(
  input: AggregateFindingsInputV1,
): Promise<AggregatedFindingsV1> {
  // Parse at the activity boundary: a wrong-shape dispatch throws a clear ZodError here (defense-in-depth).
  const parsed = AggregateFindingsInputV1.parse(input);
  return doAggregate(parsed.findings, parsed.policy_revision);
}

/**
 * Bound-method holder for the aggregate_findings activity — 1:1 with the frozen Python
 * `AggregateFindingsActivity(embedder=...)`. The worker bootstrap constructs it with the resolved
 * platform {@link EmbeddingsPort} and registers its `aggregateFindings` bound method, so the semantic
 * stage runs the REAL Qwen cosine-merge:
 *
 *     const agg = new AggregateFindingsActivity({ embedder: resolveEmbeddingsConsumer(...) });
 *     const activities = { ...others, aggregateFindings: agg.aggregateFindings };
 *
 * The method is an arrow property so it stays bound when destructured into the activities map (Temporal
 * registers the function value directly, losing `this`).
 */
export class AggregateFindingsActivity {
  private readonly embedder: EmbeddingsPort;

  public constructor({ embedder }: { embedder: EmbeddingsPort }) {
    this.embedder = embedder;
  }

  public readonly aggregateFindings = async (
    input: AggregateFindingsInputV1,
  ): Promise<AggregatedFindingsV1> => {
    // Parse at the activity boundary: a wrong-shape dispatch throws a clear ZodError here (defense-in-depth).
    const parsed = AggregateFindingsInputV1.parse(input);
    return doAggregate(parsed.findings, parsed.policy_revision, this.embedder);
  };
}
