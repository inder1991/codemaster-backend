// HybridRetriever — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/hybrid_retriever.py (Sprint 10 / S10.4.1; Sub-spec B T11).
//
// Composition root. Wires the retrieval stages into one async `retrieve` call:
//
//     BM25 (lexical)        ┐
//                           ├─→ RRF (rank fusion) ─→ LLM rerank (top-5)
//     ANN  (cosine, dense)  ┘
//
// Both BM25 and ANN run in parallel (`Promise.all`, the TS analogue of `asyncio.gather`) so the hot path
// takes max(latency_bm25, latency_ann) instead of the sum. The RRF + rerank passes are pure / cheap and
// run in sequence.
//
// ── Sub-spec B T11 confluence extension ────────────────────────────────────────────────────────────
// When ALL FOUR enabling conditions hold — `query.include_confluence` is true AND a
// {@link ConfluenceRetrievalPort} is wired in the constructor AND `query.effective_labels` is non-empty
// AND `query.query_vector_override` is set (caller pre-embedded) — a parallel Confluence task joins the
// fan-out:
//
//     BM25 (lexical)        ┐
//     ANN  (cosine, dense)  ├─→ RRF → mergeSources → reservePriorityFloors → rerank → combine
//     Confluence (pgvector) ┘
//
// When any of the four conditions is false the new path is SKIPPED and the legacy three-stage flow runs
// unchanged. The exact composition ORDER on the confluence path mirrors the frozen Python verbatim:
//   1. rrfCombine(bm25, ann)                                   → fused
//   2. wrap confluence chunks as ScoredKnowledgeChunkV1        → confluenceScored
//   3. mergeSources(knowledgeChunks=fused.items, confluence=…) → merged + sourceCounts (dedup)
//   4. reservePriorityFloors(merged)                           → floor (security/ADR slots) BEFORE rerank
//   5. rerank.apply(merged minus floor picks)                  → reranked
//   6. floor.selected (priority slots) ++ reranked.items, cap at top_k
//
// ── Cross-tenant posture ───────────────────────────────────────────────────────────────────────────
// The confluence corpus is PLATFORM-SHARED (migration 0063 dropped `installation_id`). The retriever
// does NO SQL itself — it consumes the {@link ConfluenceRetrievalPort} interface; the production adapter
// (`PostgresConfluenceRetrieval`, sibling task) carries the `@privilegedPath` + `crossTenantAudit`
// escape + the raw-SQL tenant-exempt marker. The `installation_id` + `repo_id` carried on the wrapped
// chunk keep it greppable by tenancy even though the underlying corpus is platform-shared.
//
// ── Degradation ───────────────────────────────────────────────────────────────────────────────────
// If the ANN side returns degraded=true (embed service down) RRF still emits results from BM25; the
// rerank pass receives degraded=true and propagates it. Confluence retrieval is best-effort — if it
// returns empty OR FAILS, the BM25+ANN path produces results as usual and `degraded=true` is surfaced
// with reason `confluence_retrieval_failed`. NOTE: this is a deliberate DIVERGENCE from frozen Python,
// whose bare `asyncio.gather(bm25, ann, confluence)` propagates a confluence exception and fails the
// whole retrieval — the Python docstring claims best-effort-on-failure but the reference code never
// delivered it. See the `.catch` isolation in `retrieve`.
//
// ── OTel span ─────────────────────────────────────────────────────────────────────────────────────
// The Python wraps the whole call in the locked `retrieval.hybrid_retrieve` span. That observability
// module is not ported yet, so this port keeps the composition intact but omits the (absent) span —
// exactly as the sibling AnnRetriever / Bm25Retriever ports omit their histograms.

import type { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import type { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";
import {
  type ConfluenceRetrievalPort,
  type ConfluenceRetrievedChunk,
  mergeSources,
} from "#backend/retrieval/confluence_source.js";
import { PRE_FUSION_TOP_K } from "#backend/retrieval/constants.js";
import { reservePriorityFloors } from "#backend/retrieval/floors.js";
import type { LlmRerank } from "#backend/retrieval/llm_rerank.js";
import { PRIORITY_TIER_NAME } from "#backend/retrieval/precedence.js";
import { rrfCombine } from "#backend/retrieval/rrf.js";

import type {
  KnowledgeChunkV1,
  KnowledgeQueryV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";

// Single-sourced over-fetch / pre-rerank width (1:1 with the Python `_PRE_RERANK_TOP_K`, aliased from
// the shared `PRE_FUSION_TOP_K` constant).
const PRE_RERANK_TOP_K = PRE_FUSION_TOP_K;

// Default token budget passed to reservePriorityFloors. The spec's three-stage pipeline computes a real
// budget at the activity layer; this is the in-call default for the composition (1:1 with the Python
// `_DEFAULT_TOKEN_BUDGET = 32_000`).
const DEFAULT_TOKEN_BUDGET = 32_000;

/**
 * Wrap a {@link ConfluenceRetrievedChunk} in the homogeneous {@link ScoredKnowledgeChunkV1} envelope used
 * downstream (1:1 with the Python `_confluence_to_scored`).
 *
 * `installationId` + `repoId` are carried from the query so the chunk is greppable by tenancy even
 * though the underlying confluence corpus is platform-shared.
 */
export function confluenceToScored(
  c: ConfluenceRetrievedChunk,
  args: { installationId: string; repoId: string },
): ScoredKnowledgeChunkV1 {
  const chunk: KnowledgeChunkV1 = {
    schema_version: 2,
    chunk_id: c.chunk_id,
    installation_id: args.installationId,
    repo_id: args.repoId,
    relative_path: `confluence/${c.space_key}/${c.page_id}`,
    chunk_index: 0,
    heading_path: [],
    body: c.chunk_text,
    doc_kind: "other",
    doc_status: "active",
    source: "confluence",
    space_key: c.space_key,
    page_id: c.page_id,
    page_version: c.version,
    labels: [...c.labels],
    match_specificity_score: c.match_specificity_score,
    age_days: c.age_days,
  };
  return { schema_version: 1, chunk, score: c.score, stage: "ann" };
}

export type HybridRetrieverOptions = {
  bm25: Bm25Retriever;
  ann: AnnRetriever;
  rerank: LlmRerank;
  /** Optional Confluence parallel task (Sub-spec B T11). Omitted → legacy BM25+ANN+RRF flow. */
  confluence?: ConfluenceRetrievalPort;
};

/** Compose BM25 + ANN + RRF + LLM rerank into one call, optionally with a parallel Confluence task. */
export class HybridRetriever {
  private readonly bm25: Bm25Retriever;
  private readonly ann: AnnRetriever;
  private readonly rerank: LlmRerank;
  private readonly confluence: ConfluenceRetrievalPort | undefined;

  public constructor({ bm25, ann, rerank, confluence }: HybridRetrieverOptions) {
    this.bm25 = bm25;
    this.ann = ann;
    this.rerank = rerank;
    this.confluence = confluence;
  }

  /** All four gating conditions per Sub-spec B T11 (1:1 with `_should_compose_confluence`). */
  private shouldComposeConfluence(query: KnowledgeQueryV1): boolean {
    if (this.confluence === undefined) {
      return false;
    }
    if (!query.include_confluence) {
      return false;
    }
    if (query.effective_labels.length === 0) {
      return false;
    }
    if (query.query_vector_override === null) {
      // Caller forgot to pre-embed; AnnRetriever still embeds internally for the repo-knowledge side,
      // but we can't share that vector here. Skip confluence this turn.
      console.warn(
        JSON.stringify({
          event: "confluence_retrieval_skipped",
          reason: "no_query_vector_override",
          installation_id: query.installation_id,
        }),
      );
      return false;
    }
    return true;
  }

  public async retrieve(
    query: KnowledgeQueryV1,
    rerankOverride?: LlmRerank,
  ): Promise<RetrievedKnowledgeV1> {
    // Per-call rerank override (E): the activity may construct a per-invocation LlmBackedRerankPort
    // carrying the query's installation_id; when supplied it REPLACES the static factory reranker for
    // this call. Default (undefined) keeps the constructor-wired reranker (IdentityRerankPort no-op).
    const rerank = rerankOverride ?? this.rerank;
    // Over-fetch each side so RRF has material to fuse.
    const wideQuery: KnowledgeQueryV1 = { ...query, top_k: PRE_RERANK_TOP_K };
    const composeConfluence = this.shouldComposeConfluence(query);

    if (!composeConfluence) {
      // Legacy fast path — byte-identical to pre-Sub-spec-B behavior.
      const [bm25Result, annResult] = await Promise.all([
        this.bm25.retrieve(wideQuery),
        this.ann.retrieve(wideQuery),
      ]);
      const fused = rrfCombine([bm25Result, annResult], { topK: PRE_RERANK_TOP_K });
      return rerank.apply({ query: query.query, candidates: fused });
    }

    // Sub-spec B path: parallel confluence + merge + floors.
    // shouldComposeConfluence already narrowed these to defined / non-null.
    const confluencePort = this.confluence;
    const queryVec = query.query_vector_override;
    if (confluencePort === undefined || queryVec === null) {
      // Defensive — the gate above already guarantees both are present.
      throw new Error("confluence gating invariant violated");
    }

    // Confluence is best-effort: isolate its failure so a Confluence outage degrades to repo-only context
    // instead of failing the whole retrieval. DIVERGENCE from frozen Python, whose bare
    // `asyncio.gather(bm25, ann, confluence)` fails-ALL on a Confluence exception — the docstring's
    // "best-effort … if it fails … BM25+ANN produces results as usual" intent was never delivered in the
    // reference code. bm25/ann stay core (their failures still propagate via Promise.all); only the
    // confluence task is caught (the `.catch` converts a rejection into [] + a degraded flag).
    let confluenceDegraded = false;
    const confluencePromise = confluencePort
      .search({
        queryEmbedding: queryVec,
        topK: PRE_RERANK_TOP_K,
        effectiveLabels: new Set(query.effective_labels),
      })
      .catch((e: unknown): ReadonlyArray<ConfluenceRetrievedChunk> => {
        confluenceDegraded = true;
        console.warn(
          JSON.stringify({
            event: "confluence_retrieval_failed",
            reason: e instanceof Error ? e.message : String(e),
            installation_id: query.installation_id,
          }),
        );
        return [];
      });

    const [bm25Result, annResult, confluenceResult] = await Promise.all([
      this.bm25.retrieve(wideQuery),
      this.ann.retrieve(wideQuery),
      confluencePromise,
    ]);

    const fused = rrfCombine([bm25Result, annResult], { topK: PRE_RERANK_TOP_K });

    // Wrap confluence chunks in the homogeneous envelope before merge / floor / rerank so the downstream
    // type contracts hold.
    const confluenceScored: Array<ScoredKnowledgeChunkV1> = confluenceResult.map((c) =>
      confluenceToScored(c, {
        installationId: query.installation_id,
        repoId: query.repo_id,
      }),
    );

    // mergeSources types `confluenceChunks: Iterable<ConfluenceRetrievedChunk>`, but the Python passes
    // the already-WRAPPED ScoredKnowledgeChunkV1 envelopes here (`# type: ignore[arg-type]`) — merge only
    // reads the `chunk_text` attr via a structural getter, so the wrapped envelopes (whose text lives at
    // `.chunk.body`, NOT `.chunk_text`) simply never near-dup-match, exactly as in the frozen Python.
    const [mergedObjects, sourceCounts] = mergeSources({
      repoChunks: [],
      knowledgeChunks: fused.items,
      confluenceChunks: confluenceScored as unknown as ReadonlyArray<ConfluenceRetrievedChunk>,
    });
    // mergeSources returns Array<unknown>; narrow back to ScoredKnowledgeChunkV1 since the only sources
    // we fed in (fused.items + the wrapped confluence chunks) are ScoredKnowledgeChunkV1.
    const merged: Array<ScoredKnowledgeChunkV1> = mergedObjects.filter(isScoredKnowledgeChunk);

    // Reserve high-authority floors (security/ADR) BEFORE rerank consumes budget. token_budget is the
    // in-call default; an activity-level caller can pre-compute a real budget per spec §3.5.
    const floor = reservePriorityFloors(merged, { tokenBudget: DEFAULT_TOKEN_BUDGET });
    // Identity dedup (the Python `{id(s) for s in floor.selected}`) so we don't double-include floor
    // picks in the rerank input. JS object identity via a Set is the analogue of CPython `id()`.
    const floorSet = new Set<unknown>(floor.selected);
    const remaining: Array<ScoredKnowledgeChunkV1> = merged.filter((s) => !floorSet.has(s));

    const rerankInput: RetrievedKnowledgeV1 = {
      schema_version: 1,
      items: remaining,
      degraded: false,
      degradation_reason: "",
      starvation_tiers: [],
      source_counts: {},
    };
    const reranked = await rerank.apply({ query: query.query, candidates: rerankInput });

    // Floor selections take priority slots; reranked fills the rest up to top_k.
    const floorSelected: Array<ScoredKnowledgeChunkV1> = floor.selected.filter(isScoredKnowledgeChunk);
    const finalItems: Array<ScoredKnowledgeChunkV1> = [...floorSelected, ...reranked.items].slice(
      0,
      query.top_k,
    );

    // Fold the confluence-outage signal into the degraded surface so the prompt builder's "retrieval may
    // be partial" note fires when Confluence failed even though BM25/ANN succeeded.
    const degradationReasons: Array<string> = [];
    if (reranked.degraded && reranked.degradation_reason !== "") {
      degradationReasons.push(reranked.degradation_reason);
    }
    if (confluenceDegraded) {
      degradationReasons.push("confluence_retrieval_failed");
    }

    return {
      schema_version: 1,
      items: finalItems,
      degraded: reranked.degraded || confluenceDegraded,
      degradation_reason: degradationReasons.join("; ").slice(0, 200),
      starvation_tiers: floor.starvationTiers.map((t) => PRIORITY_TIER_NAME[t]),
      source_counts: {
        repo: sourceCounts.repo,
        knowledge: sourceCounts.knowledge,
        confluence: sourceCounts.confluence,
        deduped: sourceCounts.deduped,
      },
    };
  }
}

/** Narrow a merged `unknown` back to {@link ScoredKnowledgeChunkV1} (Python `isinstance` filter). */
function isScoredKnowledgeChunk(m: unknown): m is ScoredKnowledgeChunkV1 {
  return (
    m !== null &&
    typeof m === "object" &&
    "chunk" in m &&
    "score" in m &&
    "stage" in m
  );
}
