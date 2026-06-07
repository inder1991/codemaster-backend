// Retriever wiring — port of the frozen Python
// vendor/codemaster-py/codemaster/wiring/retrievers.py (Sprint 26 / B-2 stage 6; R-31 single-call DI
// factory). Wires the LEGACY (BM25 + ANN + RRF) path AND the Sub-spec B T12 confluence/hybrid path.
//
// ── HYBRID / CONFLUENCE wiring (1:1 with the Python `build_retrieve_knowledge_activity`) ──────────
// The frozen Python `build_retrieve_knowledge_activity` wires a `HybridRetriever` (BM25 + ANN +
// PostgresConfluenceRetrieval + an IdentityRerankPort no-op rerank) so the activity's hybrid branch
// fires when the workflow body dispatches with `include_confluence=True` + the supporting fields. This
// TS factory wires the SAME composition: it constructs `PostgresConfluenceRetrieval` over the shared
// core pool + a `HybridRetriever` (sharing the SAME Bm25Retriever / AnnRetriever instances the legacy
// path uses, plus an `LlmRerank({ port: new IdentityRerankPort() })`) and threads it onto the activity.
// The activity still runs the legacy fusion unless ALL five confluence-supporting fields are present
// (the `_shouldUseHybrid` gate), so a legacy dispatch (include_confluence=false) is byte-identical.
//   - FOLLOW-UP-retrieve-knowledge-llm-rerank / FOLLOW-UP-production-reranker — the production
//     Bedrock-backed reranker is OWNER-PROVIDED; until it lands the IdentityRerankPort no-op is wired
//     (matching the frozen Python, which ships only the identity no-op).
//   - FOLLOW-UP-embedder-cache — PostgresConfluenceRetrieval accepts an EmbedderCache for the
//     Phase-A/Phase-C generation dispatch; that cache is unported, so the adapter runs the legacy direct
//     query (`embedderCache=null`). Same posture as the AnnRetriever embedder-cache deferral below.
//
// ── DSN gate (DIVERGES from the Python; documented for the verifier) ─────────────────────────────
// The Python `build_bm25_port` / `build_ann_port` fall back to EMPTY InMemory*Port test doubles when
// `CODEMASTER_PG_CORE_DSN` is unset, emitting a WARN log + a `record_retrieval_degraded` counter. That
// observability module is NOT ported to TS yet, and the rest of this TS codebase resolves the shared
// ADR-0062 pool fail-loud (e.g. allocate_workspace.activity.ts::resolveDb). So this wiring is FAIL-LOUD
// on an unset DSN rather than silently building empty in-memory ports — the InMemory*Port doubles are
// test-only and are NEVER wired on the shipped path. A caller that wants the in-memory ports for a unit
// loop constructs them directly in the test file.
//
// ── Shared pool (ADR-0062) ──────────────────────────────────────────────────────────────────────
// Both ports share ONE Kysely over the process-wide pool via `tenantKysely(dsn)` (the central seam),
// matching the Python R-43 "share one core session_factory across both ports".

import { RetrieveKnowledgeActivity } from "#backend/activities/retrieve_knowledge.activity.js";
import { PostgresConfluenceRetrieval } from "#backend/adapters/postgres_confluence_retrieval.js";
import { type EmbeddingsPort } from "#backend/adapters/embeddings_port.js";
import { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import { type AnnPort, PostgresAnnPort } from "#backend/retrieval/ann_port.js";
import { type Bm25Port, PostgresBm25Port } from "#backend/retrieval/bm25_port.js";
import { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";
import type { ConfluenceRetrievalPort } from "#backend/retrieval/confluence_source.js";
import { HybridRetriever } from "#backend/retrieval/hybrid_retriever.js";
import { IdentityRerankPort, LlmRerank } from "#backend/retrieval/llm_rerank.js";
import type { RerankLlmCacheLike } from "#backend/retrieval/llm_backed_rerank.js";

import { tenantKysely } from "#platform/db/database.js";

/** Resolve the shared ADR-0062 Kysely from `CODEMASTER_PG_CORE_DSN` (fail-loud on unset; see header). */
function resolveCoreDb(): ReturnType<typeof tenantKysely<unknown>> {
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; cannot wire the production BM25 / ANN retriever ports. " +
        "Set it to the core Postgres DSN. (The in-memory ports are test-only and are never wired here.)",
    );
  }
  return tenantKysely<unknown>(dsn);
}

/**
 * Return the production {@link Bm25Port} ({@link PostgresBm25Port} over the shared core pool).
 * Fail-loud when `CODEMASTER_PG_CORE_DSN` is unset (see the header divergence note).
 */
export function buildBm25Port(): Bm25Port {
  return new PostgresBm25Port({ db: resolveCoreDb() });
}

/**
 * Return the production {@link AnnPort} ({@link PostgresAnnPort} over the shared core pool).
 * Fail-loud when `CODEMASTER_PG_CORE_DSN` is unset (see the header divergence note).
 *
 * The Python threads an optional `embedder_cache` into PostgresAnnPort for the Phase-A/Phase-C SELECT
 * dispatch; that EmbedderCache is `None` in the current composition AND the TS PostgresAnnPort ports
 * only the `_sql_no_cache` branch, so there is no `embedderCache` parameter here (DEFERRED with the
 * cache itself).
 */
export function buildAnnPort(): AnnPort {
  return new PostgresAnnPort({ db: resolveCoreDb() });
}

/**
 * Return the production {@link ConfluenceRetrievalPort} ({@link PostgresConfluenceRetrieval} over the
 * shared core pool). Fail-loud when `CODEMASTER_PG_CORE_DSN` is unset (see the header divergence note).
 *
 * The confluence corpus is PLATFORM-SHARED (migration 0063 dropped `installation_id`) — the adapter does
 * NO `installation_id` filter; the by-design cross-tenant access posture lives on the adapter's
 * `// tenant:exempt` raw-SQL markers (the frozen Python's `@privileged_path` + `cross_tenant_audit`).
 *
 * FOLLOW-UP-embedder-cache: the Python threads an optional EmbedderCache into the adapter for the
 * Phase-A/Phase-C generation dispatch; that cache is `None` in the current composition AND unported, so
 * no `embedderCache` is passed here (the adapter runs the legacy direct query) — same posture as
 * {@link buildAnnPort}.
 */
export function buildConfluencePort(): ConfluenceRetrievalPort {
  return new PostgresConfluenceRetrieval({ db: resolveCoreDb() });
}

export type BuildRetrieveKnowledgeActivityOptions = {
  /** The production {@link EmbeddingsPort} (resolved by `resolveEmbeddingsConsumer`). */
  embedder: EmbeddingsPort;
  /** Embed model name passed to AnnRetriever (1:1 with the Python `model_name` default). */
  modelName?: string;
  /** Per-chunk retrieval result cap (1:1 with the Python `top_k=5`). */
  topK?: number;
  /**
   * Optional rerank LLM cache (E). Threaded to {@link RetrieveKnowledgeActivity}; when wired AND
   * `CODEMASTER_LLM_RERANK_ENABLED=true`, the activity builds a per-invocation LLM-backed reranker instead
   * of the static IdentityRerankPort no-op. Omitted → identity rerank (1:1 with Python).
   */
  rerankCache?: RerankLlmCacheLike;
};

/**
 * Single-call DI factory for the {@link RetrieveKnowledgeActivity} (1:1 with the Python
 * `build_retrieve_knowledge_activity`, including the Sub-spec B T12 hybrid/Confluence wiring).
 *
 * Composes {@link Bm25Retriever} (over {@link buildBm25Port}) + {@link AnnRetriever} (over
 * {@link buildAnnPort} + the injected embedder), then wires a {@link HybridRetriever} over the SAME two
 * retriever instances + a {@link PostgresConfluenceRetrieval} (over {@link buildConfluencePort}) + an
 * {@link LlmRerank} backed by the {@link IdentityRerankPort} no-op (FOLLOW-UP-production-reranker). The
 * activity runs the hybrid path only when the workflow body dispatches with the five confluence-supporting
 * fields (the `_shouldUseHybrid` gate); a legacy dispatch falls through to the BM25+ANN+RRF fusion. The
 * worker registers `holder.retrieveKnowledge` as the `retrieve_knowledge_activity` Temporal activity.
 */
export function buildRetrieveKnowledgeActivity({
  embedder,
  modelName = "qwen3-embed-0.6b",
  topK = 5,
  rerankCache,
}: BuildRetrieveKnowledgeActivityOptions): RetrieveKnowledgeActivity {
  const bm25Retriever = new Bm25Retriever({ port: buildBm25Port() });
  const annRetriever = new AnnRetriever({
    port: buildAnnPort(),
    embeddings: embedder,
    modelName,
  });
  // Sub-spec B T12 — the hybrid retriever shares the SAME BM25 / ANN instances (1:1 with the Python R-43
  // "share one core session_factory across both ports"). The IdentityRerankPort is the no-op the frozen
  // Python ships until the owner provides the Bedrock-backed reranker (FOLLOW-UP-production-reranker).
  const hybridRetriever = new HybridRetriever({
    bm25: bm25Retriever,
    ann: annRetriever,
    rerank: new LlmRerank({ port: new IdentityRerankPort() }),
    confluence: buildConfluencePort(),
  });
  return new RetrieveKnowledgeActivity({
    bm25Retriever,
    annRetriever,
    topK,
    hybridRetriever,
    // exactOptionalPropertyTypes: only pass the key when defined (never an explicit `undefined`).
    ...(rerankCache !== undefined ? { rerankCache } : {}),
  });
}
