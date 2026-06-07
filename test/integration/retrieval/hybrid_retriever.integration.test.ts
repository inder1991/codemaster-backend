// LIVE integration test for the HybridRetriever COMPOSITION against a DISPOSABLE Postgres (NO embedder).
//
// This is the COMPOSITION-level integration (distinct from the adapter's own integration test at
// test/integration/adapters/postgres_confluence_retrieval.integration.test.ts, which proves the
// adapter's WHERE-clause behavior). Here we wire MY HybridRetriever end-to-end with the REAL
// PostgresConfluenceRetrieval adapter over SEEDED confluence rows + deterministic in-memory BM25/ANN
// stubs, and prove the full Sub-spec B T11 pipeline composes against real data:
//
//   1. The confluence gate fires (include_confluence ∧ port ∧ effective_labels ∧ query_vector_override)
//      → the adapter runs a REAL pgvector query → its rows merge with the BM25/ANN repo chunks.
//   2. mergeSources counts each source; source_counts.confluence reflects the real DB rows.
//   3. A `topic:security_policy`-labeled confluence chunk is RESERVED by reservePriorityFloors BEFORE
//      the rerank pass (it appears in the final result, on a priority slot, never via the rerank input).
//   4. The composed final result carries the repo (BM25/ANN) chunk AND the confluence chunk.
//
// GATING: runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb) — the disposable PG at
//   postgresql://postgres:postgres@localhost:5434/codemaster, NEVER the in-cluster DB.
//
// NO EMBEDDER: confluence vectors are SEEDED deterministically (one hot dimension per chunk), so the
// pgvector ordering is fully controlled without a live embedding service. The BM25/ANN sides are
// in-memory stubs (their own ports have dedicated integration tests).
//
// ISOLATION: a UNIQUE space_key per run; every seeded row is cleaned up by space_key in afterAll.

import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresConfluenceRetrieval } from "#backend/adapters/postgres_confluence_retrieval.js";
import type { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import type { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";
import { HybridRetriever } from "#backend/retrieval/hybrid_retriever.js";
import { IdentityRerankPort, LlmRerank, type LlmRerankerPort } from "#backend/retrieval/llm_rerank.js";

import { disposeAllPools, tenantKysely } from "#platform/db/database.js";

import type {
  KnowledgeChunkV1,
  KnowledgeQueryV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const DIM = 1024;
const SPACE_KEY = `IT-HYB-${randomUUID().slice(0, 8)}`;
const INSTALLATION_ID = randomUUID();
const REPO_ID = randomUUID();

let db: Kysely<unknown>;

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  db = tenantKysely<unknown>(INTEGRATION_DSN);

  // A regular confluence chunk (lang:python) hot at dim 0.
  await seedChunk({ pageId: "p-conf", labels: ["lang:python"], hotDim: 0 });
  // A SECURITY_POLICY confluence chunk hot at dim 1 → must be FLOOR-reserved before rerank.
  await seedChunk({ pageId: "p-sec", labels: ["topic:security_policy"], hotDim: 1 });
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${SPACE_KEY}`.execute(db);
  await sql`DELETE FROM core.confluence_page_approvals WHERE space_key = ${SPACE_KEY}`.execute(db);
  await disposeAllPools();
});

/** A 1024-dim unit vector hot in one dimension. */
function hotVector(dim: number): ReadonlyArray<number> {
  const v = new Array<number>(DIM).fill(0);
  v[dim] = 1;
  return v;
}

function toPgVectorLiteral(vec: ReadonlyArray<number>): string {
  return `[${vec.map((x) => String(x)).join(",")}]`;
}

async function seedChunk(c: {
  pageId: string;
  labels: ReadonlyArray<string>;
  hotDim: number;
}): Promise<void> {
  const labelsLit = sql`${[...c.labels]}::text[]`;
  await sql`
    INSERT INTO core.confluence_chunks
      (chunk_id, space_key, page_id, page_title, version, chunk_index, chunk_text,
       content_sha256, labels, quarantined, quarantine_reasons, embedding)
    VALUES
      (${randomUUID()}, ${SPACE_KEY}, ${c.pageId}, ${"Page " + c.pageId}, 1, 0, ${"body " + c.pageId},
       ${"0".repeat(64)}, ${labelsLit}, false, ${sql`ARRAY[]::text[]`},
       ${toPgVectorLiteral(hotVector(c.hotDim))}::vector)
  `.execute(db);
}

// ─── In-memory BM25 / ANN stubs (their ports have their own integration tests) ──────────────────────

function repoChunk(rel: string): KnowledgeChunkV1 {
  return {
    schema_version: 2,
    chunk_id: randomUUID(),
    installation_id: INSTALLATION_ID,
    repo_id: REPO_ID,
    relative_path: rel,
    chunk_index: 0,
    heading_path: [],
    body: `repo body ${rel}`,
    doc_kind: "other",
    doc_status: "active",
    source: "repo_knowledge",
    space_key: null,
    page_id: null,
    page_version: null,
    labels: [],
    match_specificity_score: 0,
    age_days: 0,
  };
}

class StubRetriever {
  public constructor(private readonly items: ReadonlyArray<ScoredKnowledgeChunkV1>) {}
  public async retrieve(_q: KnowledgeQueryV1): Promise<RetrievedKnowledgeV1> {
    void _q;
    return {
      schema_version: 1,
      items: [...this.items],
      degraded: false,
      degradation_reason: "",
      starvation_tiers: [],
      source_counts: {},
    };
  }
}

function query(args: {
  effectiveLabels: ReadonlyArray<string>;
  queryVectorOverride: ReadonlyArray<number>;
  includeConfluence?: boolean;
}): KnowledgeQueryV1 {
  return {
    schema_version: 2,
    query: "find the security policy",
    installation_id: INSTALLATION_ID,
    repo_id: REPO_ID,
    top_k: 10,
    query_vector_override: [...args.queryVectorOverride],
    include_confluence: args.includeConfluence ?? true,
    effective_labels: [...args.effectiveLabels],
    default_pool_token_reservation_pct: 0.15,
  };
}

describeDb("HybridRetriever composition over the REAL confluence adapter (disposable PG)", () => {
  function buildHybrid(rerankPort: LlmRerankerPort, repoItems: ReadonlyArray<ScoredKnowledgeChunkV1>): HybridRetriever {
    return new HybridRetriever({
      bm25: new StubRetriever(repoItems) as unknown as Bm25Retriever,
      ann: new StubRetriever(repoItems) as unknown as AnnRetriever,
      rerank: new LlmRerank({ port: rerankPort }),
      confluence: new PostgresConfluenceRetrieval({ db }),
    });
  }

  it("composes BM25/ANN repo chunks WITH real confluence rows; source_counts reflects the DB", async ({
    skip,
  }) => {
    if (!INTEGRATION_DSN) skip();
    const repo = repoChunk("docs/auth.md");
    const repoItem: ScoredKnowledgeChunkV1 = { schema_version: 1, chunk: repo, score: 0.9, stage: "bm25" };
    const hybrid = buildHybrid(new IdentityRerankPort(), [repoItem]);

    // Query nearest the regular confluence chunk (dim 0); effective labels admit both confluence pages.
    const out = await hybrid.retrieve(
      query({
        effectiveLabels: ["lang:python", "topic:security_policy"],
        queryVectorOverride: hotVector(0),
      }),
    );

    const sources = new Set(out.items.map((i) => i.chunk.source));
    expect(sources.has("repo_knowledge")).toBe(true);
    expect(sources.has("confluence")).toBe(true);
    // Both seeded confluence pages overlap the effective labels → 2 confluence rows merged in.
    expect(out.source_counts.confluence).toBe(2);
    // The single repo chunk (deduped across BM25+ANN by RRF) → one knowledge entry.
    expect(out.source_counts.knowledge).toBe(1);
  });

  it("a real topic:security_policy confluence row is reserved by floors BEFORE the rerank input", async ({
    skip,
  }) => {
    if (!INTEGRATION_DSN) skip();
    // A rerank port that RECORDS exactly which candidates it was handed.
    class RecordingPort implements LlmRerankerPort {
      public seenPaths: ReadonlyArray<string> = [];
      public async rerank(args: {
        query: string;
        candidates: ReadonlyArray<KnowledgeChunkV1>;
      }): Promise<ReadonlyArray<number>> {
        this.seenPaths = args.candidates.map((c) => c.relative_path);
        return args.candidates.map(() => 1);
      }
    }
    const recording = new RecordingPort();
    const repo = repoChunk("docs/plain.md");
    const repoItem: ScoredKnowledgeChunkV1 = { schema_version: 1, chunk: repo, score: 0.9, stage: "bm25" };
    const hybrid = buildHybrid(recording, [repoItem]);

    const out = await hybrid.retrieve(
      query({
        effectiveLabels: ["lang:python", "topic:security_policy"],
        queryVectorOverride: hotVector(1),
      }),
    );

    // The security-policy confluence chunk reached the FINAL result on a floor priority slot.
    const secPath = `confluence/${SPACE_KEY}/p-sec`;
    expect(out.items.some((i) => i.chunk.relative_path === secPath)).toBe(true);
    // ...but it was reserved BEFORE rerank — the rerank input never saw it.
    expect(recording.seenPaths).not.toContain(secPath);
    // The plain repo chunk DID flow through the rerank pass.
    expect(recording.seenPaths).toContain("docs/plain.md");
  });

  it("empty effective_labels → confluence gate skips; only the repo chunk composes", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    const repo = repoChunk("docs/only.md");
    const repoItem: ScoredKnowledgeChunkV1 = { schema_version: 1, chunk: repo, score: 0.9, stage: "bm25" };
    const hybrid = buildHybrid(new IdentityRerankPort(), [repoItem]);

    // No effective labels → shouldComposeConfluence is false → legacy BM25+ANN+RRF+rerank path.
    const out = await hybrid.retrieve(
      query({ effectiveLabels: [], queryVectorOverride: hotVector(0) }),
    );
    expect(out.items.every((i) => i.chunk.source === "repo_knowledge")).toBe(true);
    // Legacy path returns the rerank envelope → source_counts stays {} (no merge ran).
    expect(out.source_counts).toEqual({});
  });
});
