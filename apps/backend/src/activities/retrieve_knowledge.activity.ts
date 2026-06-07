// RetrieveKnowledgeActivity — port of the frozen Python
// vendor/codemaster-py/codemaster/activities/retrieve_knowledge.py::RetrieveKnowledgeActivity
// (Sprint 26 / PR-2 follow-up + the Sub-spec B T12 confluence/hybrid extension).
//
// Composition (legacy path — the Python default when `hybrid_retriever is None`):
//   BM25 + ANN run in parallel under `Promise.all` (the TS analogue of `asyncio.gather`); RRF fuses to
//   `input.top_k`. Both retrievers over-fetch `PRE_FUSION_TOP_K` candidates so RRF has enough material
//   to fuse. Degradation on either side flows into the result envelope's `retrieval_degraded` flag.
//   The legacy path does NOT rerank.
//
// Composition (Sub-spec B T12 path, when `_shouldUseHybrid` holds — confluence/hybrid retrieval):
//   HybridRetriever composes BM25 + ANN + Confluence per spec §3.5, applies reserve_priority_floors +
//   merge_sources + LLM rerank, returns the wrapped chunks. The activity then unwraps to bare
//   KnowledgeChunkV1 items so the existing ReviewContextV1 type shape is preserved. The hybrid branch
//   fires iff ALL FIVE preconditions hold AND a hybrid retriever is wired:
//     include_confluence=true ∧ pr_context ∧ yaml_config ∧ platform_exposed_labels (non-empty) ∧
//     query_vector_override (non-null).
//   None of those is the legacy default, so a caller that does not thread the confluence-supporting
//   fields runs the legacy fusion unchanged (back-compat).
//
// ── DEFERRED (faithful to the Python, surfaced as FOLLOW-UPs for the verifier) ──────────────────────
//   - The production LLM-backed reranker is OWNER-PROVIDED (FOLLOW-UP-production-reranker). The frozen
//     Python ships only an `IdentityRerankPort` no-op; the wiring (retrievers.ts) constructs the
//     HybridRetriever with `LlmRerank({ port: new IdentityRerankPort() })` to match.
//   - The EmbedderCache seam (Phase-A/Phase-C generation dispatch) is unported
//     (FOLLOW-UP-embedder-cache); PostgresConfluenceRetrieval falls back to the legacy direct query.
//   - `get_platform_config()` (the `default_pool_token_reservation_pct` runtime knob,
//     codemaster.runtime.platform_config_cache) is unported (FOLLOW-UP-platform-config-cache-port). The
//     Python reads it with a fail-open fallback to the in-code DEFAULT 0.15; the TS port uses the
//     KnowledgeQueryV1 contract default (0.15) directly — byte-identical to the Python fallback an
//     unconfigured cache yields. Wiring the cache later only changes the value when an operator tunes it.
//
// ── OTel span ──
// The Python wraps the BM25+ANN+RRF composition in the `retrieval.hybrid_retrieve` OTel span. That
// observability module is not ported yet, so this port keeps the composition intact but omits the
// (absent) span — exactly as the sibling AnnRetriever / Bm25Retriever ports omit their histograms.

import { computeEffectiveLabels } from "#backend/retrieval/effective_labels.js";
import { PRE_FUSION_TOP_K } from "#backend/retrieval/constants.js";
import { rrfCombine } from "#backend/retrieval/rrf.js";

import type { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import type { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";
import type { HybridRetriever } from "#backend/retrieval/hybrid_retriever.js";
import { LlmBackedRerankPort, type RerankLlmCacheLike } from "#backend/retrieval/llm_backed_rerank.js";
import { LlmRerank } from "#backend/retrieval/llm_rerank.js";
import type { KnowledgeChunkV1, KnowledgeQueryV1 } from "#contracts/knowledge_chunks.v1.js";
import type {
  RetrieveKnowledgeInputV1,
  RetrieveKnowledgeResultV1,
} from "#contracts/retrieve_knowledge.v1.js";

export type RetrieveKnowledgeActivityOptions = {
  bm25Retriever: Bm25Retriever;
  annRetriever: AnnRetriever;
  topK?: number;
  /**
   * Optional {@link HybridRetriever} (Sub-spec B T12). When supplied AND {@link RetrieveKnowledgeActivity}
   * receives all five confluence-supporting fields, the activity uses the hybrid (BM25 + ANN + Confluence
   * + floors + rerank) composition. When omitted (the legacy wiring), the activity always runs the legacy
   * BM25 + ANN + RRF fusion (1:1 with the Python `hybrid_retriever=None` default).
   */
  hybridRetriever?: HybridRetriever;
  /**
   * Optional rerank LLM cache (E). When wired AND `CODEMASTER_LLM_RERANK_ENABLED=true`, the activity builds
   * a per-invocation {@link LlmBackedRerankPort} (carrying the query's installation_id for cost attribution)
   * and passes it to the hybrid retriever, REPLACING the static IdentityRerankPort no-op. Omitted or
   * flag-off → identity rerank (1:1 with the frozen Python, which ships only the no-op).
   */
  rerankCache?: RerankLlmCacheLike;
};

/** Read the `CODEMASTER_LLM_RERANK_ENABLED` rollout flag (default OFF) — operator-flippable, replay-safe. */
function rerankEnabled(): boolean {
  return (process.env.CODEMASTER_LLM_RERANK_ENABLED ?? "false").toLowerCase() === "true";
}

/**
 * Build the per-invocation LLM-backed rerank override (E): a {@link LlmRerank} wrapping a
 * {@link LlmBackedRerankPort} keyed to `installationId`, but ONLY when the flag is on AND a cache is wired.
 * Returns `undefined` otherwise, so the {@link HybridRetriever} falls back to its static IdentityRerankPort
 * no-op (1:1 with Python). Exported for unit testing the flag-gated construction.
 */
export function buildRerankOverride(args: {
  enabled: boolean;
  cache: RerankLlmCacheLike | undefined;
  installationId: string;
}): LlmRerank | undefined {
  if (!args.enabled || args.cache === undefined) {
    return undefined;
  }
  return new LlmRerank({
    port: new LlmBackedRerankPort({ cache: args.cache, installationId: args.installationId }),
  });
}

/**
 * Bound-method holder for `retrieve_knowledge_activity` (legacy BM25 + ANN + RRF OR the Sub-spec B T12
 * confluence/hybrid path).
 *
 * `topK` is the per-chunk retrieval result cap (default 5, 1:1 with the Python `top_k=5`); the input's
 * `top_k` overrides it per call. The hybrid/Confluence branch is taken only when `hybridRetriever` is
 * wired AND `_shouldUseHybrid` holds (all five preconditions); otherwise the legacy fusion runs.
 */
export class RetrieveKnowledgeActivity {
  private readonly bm25: Bm25Retriever;
  private readonly ann: AnnRetriever;
  private readonly topK: number;
  private readonly hybrid: HybridRetriever | undefined;
  private readonly rerankCache: RerankLlmCacheLike | undefined;

  public constructor({
    bm25Retriever,
    annRetriever,
    topK = 5,
    hybridRetriever,
    rerankCache,
  }: RetrieveKnowledgeActivityOptions) {
    this.bm25 = bm25Retriever;
    this.ann = annRetriever;
    this.topK = topK;
    this.hybrid = hybridRetriever;
    this.rerankCache = rerankCache;
  }

  /**
   * The Sub-spec B T12 hybrid path is taken iff ALL preconditions hold (1:1 with the Python
   * `_should_use_hybrid`):
   *   1. a hybrid retriever is wired,
   *   2. `include_confluence` is true,
   *   3. `pr_context` is non-null,
   *   4. `yaml_config` is non-null,
   *   5. `platform_exposed_labels` is non-empty,
   *   6. `query_vector_override` is non-null.
   */
  private shouldUseHybrid(input: RetrieveKnowledgeInputV1): boolean {
    if (this.hybrid === undefined) {
      return false;
    }
    if (!input.include_confluence) {
      return false;
    }
    if (input.pr_context === null) {
      return false;
    }
    if (input.yaml_config === null) {
      return false;
    }
    if (input.platform_exposed_labels.length === 0) {
      return false;
    }
    if (input.query_vector_override === null) {
      return false;
    }
    return true;
  }

  /**
   * Run BM25 + ANN + RRF (legacy) or HybridRetriever (Sub-spec B T12 path when `_shouldUseHybrid` holds).
   *
   * Both retrievers run in parallel under `Promise.all` (the TS analogue of `asyncio.gather`) so the
   * activity wall-clock is `max(bm25_latency, ann_latency)`, not the sum. Degradation on either side flows
   * into the result envelope's `retrieval_degraded` flag.
   *
   * The caller-supplied `query_vector_override` is threaded through the {@link KnowledgeQueryV1} contract —
   * when set, AnnRetriever skips its own embed RPC (R-11). The BM25 side ignores it (lexical search has no
   * vector input).
   */
  public async retrieveKnowledge(
    input: RetrieveKnowledgeInputV1,
  ): Promise<RetrieveKnowledgeResultV1> {
    // Sub-spec B T12 path — uses HybridRetriever with Confluence composition. effective_labels are computed
    // there (replay-safe; pure function over PRContext + yaml_config + platform set).
    if (this.shouldUseHybrid(input)) {
      return this.retrieveWithConfluence(input);
    }

    // R-11: thread query_vector_override through the wide (pre-fusion) query so AnnRetriever can skip
    // its embed RPC. Both retrievers over-fetch PRE_FUSION_TOP_K candidates; RRF then cuts to top_k.
    const wideQuery: KnowledgeQueryV1 = {
      schema_version: 2,
      query: input.query,
      installation_id: input.installation_id,
      repo_id: input.repo_id,
      top_k: PRE_FUSION_TOP_K,
      query_vector_override: input.query_vector_override,
      include_confluence: false,
      effective_labels: [],
      default_pool_token_reservation_pct: 0.15,
    };

    // asyncio.gather → Promise.all: both sides run concurrently.
    const [bm25Result, annResult] = await Promise.all([
      this.bm25.retrieve(wideQuery),
      this.ann.retrieve(wideQuery),
    ]);

    const fused = rrfCombine([bm25Result, annResult], { topK: input.top_k });

    // Unwrap the fused ScoredKnowledgeChunkV1 items back to bare KnowledgeChunkV1 (the
    // RetrieveKnowledgeResultV1 type shape; the workflow body consumes bare chunks).
    const items: Array<KnowledgeChunkV1> = fused.items.map((item) => item.chunk);
    const degraded = fused.degraded;
    // rrfCombine.degradation_reason is already capped at 200 AND the result contract enforces
    // max_length=200; no double-trim (R-47).
    const reason = degraded ? fused.degradation_reason : "";

    return {
      schema_version: 1,
      items,
      retrieval_degraded: degraded,
      degradation_reason: reason,
    };
  }

  /**
   * Sub-spec B T12 path: use HybridRetriever with Confluence (1:1 with the Python
   * `_retrieve_with_confluence`).
   *
   * The caller has satisfied `_shouldUseHybrid`: all inputs are non-null. The activity computes
   * effective_labels via T9 ({@link computeEffectiveLabels}), builds a {@link KnowledgeQueryV1} with
   * include_confluence=true, invokes HybridRetriever, and unwraps the scored chunks back to bare
   * KnowledgeChunkV1 (preserving the ReviewContext type shape).
   */
  private async retrieveWithConfluence(
    input: RetrieveKnowledgeInputV1,
  ): Promise<RetrieveKnowledgeResultV1> {
    // narrowed by shouldUseHybrid; assert defensively for the type-narrower (mypy analogue).
    const { pr_context, yaml_config, query_vector_override } = input;
    if (
      pr_context === null ||
      yaml_config === null ||
      query_vector_override === null ||
      this.hybrid === undefined
    ) {
      throw new Error("confluence gating invariant violated");
    }

    const [effectiveLabels] = computeEffectiveLabels({
      prContext: pr_context,
      yamlConfig: yaml_config,
      platformExposedLabels: new Set(input.platform_exposed_labels),
    });

    // FOLLOW-UP-platform-config-cache-port: the Python reads `default_pool_token_reservation_pct` from
    // codemaster.runtime.platform_config_cache.get_platform_config() with a fail-open fallback to the
    // in-code DEFAULT (0.15). That cache is unported; the KnowledgeQueryV1 contract default IS 0.15, which
    // is byte-identical to the Python fallback an unconfigured cache yields. Wiring the cache later only
    // changes the value when an operator tunes the platform_config row.
    const query: KnowledgeQueryV1 = {
      schema_version: 2,
      query: input.query,
      installation_id: input.installation_id,
      repo_id: input.repo_id,
      top_k: input.top_k,
      query_vector_override,
      include_confluence: true,
      effective_labels: [...effectiveLabels],
      default_pool_token_reservation_pct: 0.15,
    };

    // E: per-invocation LLM rerank override (flag-gated; carries the query's installation_id). Undefined
    // when off → the hybrid retriever's static IdentityRerankPort no-op runs (1:1 with Python).
    const rerankOverride = buildRerankOverride({
      enabled: rerankEnabled(),
      cache: this.rerankCache,
      installationId: query.installation_id,
    });
    const result = await this.hybrid.retrieve(query, rerankOverride);

    const items: Array<KnowledgeChunkV1> = result.items.map((item) => item.chunk);
    return {
      schema_version: 1,
      items,
      retrieval_degraded: result.degraded,
      degradation_reason: result.degradation_reason,
    };
  }
}
