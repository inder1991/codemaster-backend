// LlmRerank — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/llm_rerank.py (Sprint 10 / S10.3.5).
//
// A small LLM (Claude Haiku in production) re-scores the RRF-fused candidates for relevance to the
// query, then we keep the top 5. Two seams:
//
//   - {@link LlmRerankerPort} — the production wraps an LLM call (a tight prompt asking for one float per
//     candidate). Tests inject deterministic stubs. The production Bedrock-backed reranker model is
//     OWNER-PROVIDED and DEFERRED — tracked as FOLLOW-UP-production-reranker (and the legacy
//     FOLLOW-UP-retrieve-knowledge-llm-rerank). The frozen Python ships only the {@link IdentityRerankPort}
//     no-op (the BedrockRerank impl was deferred per the program plan §B-2 "v1 retrieval ships without
//     rerank"); this port mirrors that exactly. When the owner wires the LLM-backed port, it consumes the
//     ported LlmClientCache (`forRole(...)` → `invokeModel(...)`) and an Ollama test double in CI.
//   - {@link LlmRerankUnavailableError} — the typed error the port raises when the rerank LLM is
//     unreachable / rate-limited. {@link LlmRerank.apply} catches it and falls back to "first top_k from
//     the input list" with degraded=true so the review still ships, just without the rerank polish.
//
// The output is a {@link RetrievedKnowledgeV1} with stage="rerank" — a uniform shape so downstream code
// (the prompt builder) doesn't care whether the rerank actually ran or fell back.

import type {
  KnowledgeChunkV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";

/**
 * Locked top-K for the rerank pass. Five chunks is enough context for the model to reason about the
 * change without diluting attention, and small enough to keep prompt tokens under the cost ceiling.
 * 1:1 with the Python `RERANK_TOP_K: Final = 5`.
 */
export const RERANK_TOP_K = 5;

/** Max length of the composed degradation_reason (Python `[:200]`; the contract also caps at 200). */
const DEGRADATION_REASON_MAX = 200;

/**
 * Raised by the port when the rerank LLM is unreachable (Python `LlmRerankUnavailableError`).
 * {@link LlmRerank.apply} catches it and falls back to the input order.
 */
export class LlmRerankUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LlmRerankUnavailableError";
  }
}

/**
 * Score each candidate's relevance to the query (Python `LlmRerankerPort` Protocol). Returns one float
 * per candidate, in the same order. Raises {@link LlmRerankUnavailableError} when the upstream service
 * is not available.
 */
export type LlmRerankerPort = {
  rerank(args: {
    query: string;
    candidates: ReadonlyArray<KnowledgeChunkV1>;
  }): Promise<ReadonlyArray<number>>;
};

/**
 * No-op {@link LlmRerankerPort} — returns a constant score per candidate, preserving the input order
 * (1:1 with the Python `IdentityRerankPort`).
 *
 * Lets {@link HybridRetriever} be composed by callers that don't yet have an LLM-backed rerank port (the
 * production reranker is OWNER-PROVIDED + DEFERRED — FOLLOW-UP-production-reranker). Constructing
 * `new LlmRerank({ port: new IdentityRerankPort() })` yields a HybridRetriever whose retrieve runs
 * BM25 + ANN + RRF + no-op rerank — semantically "BM25 + ANN + RRF" while keeping the canonical
 * composition shape. Returns score=1.0 for every candidate so the rerank pass is a structural no-op
 * (the already-ranked RRF/merge order survives unchanged because the sort is stable).
 */
export class IdentityRerankPort implements LlmRerankerPort {
  public async rerank(args: {
    query: string;
    candidates: ReadonlyArray<KnowledgeChunkV1>;
  }): Promise<ReadonlyArray<number>> {
    void args.query; // present to match the port; unused.
    return args.candidates.map(() => 1);
  }
}

/**
 * Return the input candidates capped at {@link RERANK_TOP_K} with stage rewritten to "rerank" so the
 * output shape is uniform (1:1 with the Python `_fallback`).
 */
function fallback(candidates: RetrievedKnowledgeV1, reason: string): RetrievedKnowledgeV1 {
  const items: Array<ScoredKnowledgeChunkV1> = candidates.items
    .slice(0, RERANK_TOP_K)
    .map((item) => ({ schema_version: 1, chunk: item.chunk, score: item.score, stage: "rerank" }));
  const upstream = candidates.degradation_reason;
  const composed = (upstream ? `${reason}; ${upstream}` : reason).slice(0, DEGRADATION_REASON_MAX);
  return {
    schema_version: 1,
    items,
    degraded: true,
    degradation_reason: composed,
    starvation_tiers: [],
    source_counts: {},
  };
}

/** Apply an LLM rerank pass over RRF-fused candidates (1:1 with the Python `LlmRerank`). */
export class LlmRerank {
  private readonly port: LlmRerankerPort;

  public constructor(args: { port: LlmRerankerPort }) {
    this.port = args.port;
  }

  public async apply(args: {
    query: string;
    candidates: RetrievedKnowledgeV1;
  }): Promise<RetrievedKnowledgeV1> {
    const { query, candidates } = args;
    if (candidates.items.length === 0) {
      return {
        schema_version: 1,
        items: [],
        degraded: candidates.degraded,
        degradation_reason: candidates.degradation_reason,
        starvation_tiers: [],
        source_counts: {},
      };
    }

    const chunks: ReadonlyArray<KnowledgeChunkV1> = candidates.items.map((item) => item.chunk);

    let scores: ReadonlyArray<number>;
    try {
      scores = await this.port.rerank({ query, candidates: chunks });
    } catch (e) {
      if (e instanceof LlmRerankUnavailableError) {
        // Structured-log substitute for the Python `_LOG.warning` (observability module not ported).
        console.warn(
          JSON.stringify({ event: "llm_rerank_upstream_unavailable", error: e.message }),
        );
        return fallback(candidates, "rerank LLM unavailable");
      }
      throw e;
    }

    if (scores.length !== chunks.length) {
      console.error(
        JSON.stringify({
          event: "llm_rerank_score_count_mismatch",
          got_scores: scores.length,
          expected: chunks.length,
        }),
      );
      return fallback(candidates, "rerank score-count mismatch");
    }

    // Stable sort by score DESC. JS Array.prototype.sort is stable (ES2019+); Python's list.sort is
    // stable too — so ties preserve the pre-rerank order on both sides.
    const scored: Array<ScoredKnowledgeChunkV1> = chunks.map((chunk, i) => ({
      schema_version: 1,
      chunk,
      score: scores[i]!,
      stage: "rerank",
    }));
    scored.sort((a, b) => b.score - a.score);
    const items = scored.slice(0, RERANK_TOP_K);
    return {
      schema_version: 1,
      items,
      degraded: candidates.degraded,
      degradation_reason: candidates.degradation_reason,
      starvation_tiers: [],
      source_counts: {},
    };
  }
}
