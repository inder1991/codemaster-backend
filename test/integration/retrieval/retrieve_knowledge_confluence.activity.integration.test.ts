// LIVE integration test for the RetrieveKnowledgeActivity Sub-spec B T12 confluence/HYBRID path against a
// DISPOSABLE Postgres (NO embedder — deterministic seeded vectors + a query_vector_override).
//
// This proves the ACTIVITY-LEVEL wiring (distinct from the hybrid_retriever composition test): the
// activity's `_shouldUseHybrid` gate + `computeEffectiveLabels` + the WIRED HybridRetriever (over the REAL
// PostgresConfluenceRetrieval adapter + in-memory BM25/ANN stubs + an IdentityRerankPort) compose end-to-end
// and the activity returns a RetrieveKnowledgeResultV1 carrying BOTH the repo chunk AND the real confluence
// rows. It is the integration safety-net for THIS task's wiring (the activity hybrid path + the
// orchestrator's confluence-context inputs):
//
//   1. All five gate fields present (include_confluence ∧ pr_context ∧ yaml_config ∧ platform labels ∧
//      query_vector_override) → the activity runs `_retrieveWithConfluence` → the adapter runs a REAL
//      pgvector query → confluence rows merge with the BM25/ANN repo chunk → unwrapped to bare
//      KnowledgeChunkV1 items.
//   2. effective_labels is computed from the PRContext (a .py changed file → lang:python detected) ∩ the
//      platform ceiling ∩ the yaml include/exclude, so the lang:python confluence row is admitted.
//   3. A `lang:python` confluence chunk surfaces in the result.items with source="confluence".
//   4. The legacy fallback: drop `include_confluence` (false) → the activity takes the BM25+ANN+RRF path,
//      so NO confluence row appears.
//
// GATING: runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb) — the disposable PG at
//   postgresql://postgres:postgres@localhost:5434/codemaster, NEVER the in-cluster DB.
//
// NO EMBEDDER: confluence vectors are SEEDED deterministically (one hot dimension per chunk) + the activity
// receives a `query_vector_override`, so the pgvector ordering is fully controlled. The BM25/ANN sides are
// in-memory stubs (their own ports have dedicated integration tests).
//
// ISOLATION: a UNIQUE space_key per run; every seeded confluence row is cleaned up by space_key in afterAll.

import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RetrieveKnowledgeActivity } from "#backend/activities/retrieve_knowledge.activity.js";
import { PostgresConfluenceRetrieval } from "#backend/adapters/postgres_confluence_retrieval.js";
import type { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import type { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";
import { HybridRetriever } from "#backend/retrieval/hybrid_retriever.js";
import { IdentityRerankPort, LlmRerank } from "#backend/retrieval/llm_rerank.js";

import { disposeAllPools, tenantKysely } from "#platform/db/database.js";

import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import type {
  KnowledgeChunkV1,
  KnowledgeQueryV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";
import { PRContext } from "#contracts/pr_context.v1.js";
import type { RetrieveKnowledgeInputV1 } from "#contracts/retrieve_knowledge.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const DIM = 1024;
const SPACE_KEY = `IT-ACT-${randomUUID().slice(0, 8)}`;
const INSTALLATION_ID = randomUUID();
const REPO_ID = randomUUID();

let db: Kysely<unknown>;

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  db = tenantKysely<unknown>(INTEGRATION_DSN);
  // A lang:python confluence chunk hot at dim 0 (non-default label → no approval row required).
  await seedChunk({ pageId: "p-py", labels: ["lang:python"], hotDim: 0 });
});

afterAll(async () => {
  if (!INTEGRATION_DSN) return;
  await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${SPACE_KEY}`.execute(db);
  await disposeAllPools();
});

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

/** Build the activity with a wired HybridRetriever over the REAL confluence adapter + repo stubs. */
function buildActivity(repoItems: ReadonlyArray<ScoredKnowledgeChunkV1>): RetrieveKnowledgeActivity {
  const bm25 = new StubRetriever(repoItems) as unknown as Bm25Retriever;
  const ann = new StubRetriever(repoItems) as unknown as AnnRetriever;
  const hybrid = new HybridRetriever({
    bm25,
    ann,
    rerank: new LlmRerank({ port: new IdentityRerankPort() }),
    confluence: new PostgresConfluenceRetrieval({ db }),
  });
  return new RetrieveKnowledgeActivity({
    bm25Retriever: bm25,
    annRetriever: ann,
    hybridRetriever: hybrid,
  });
}

// A PRContext with one .py changed file → the LanguageDetector emits lang:python (so effective_labels
// admits the seeded lang:python confluence chunk through the platform ceiling).
const PR_CTX = PRContext.parse({
  pr_id: randomUUID(),
  head_sha: "a".repeat(40),
  repo_default_branch: "main",
  changed_files: [{ path: "services/api/handler.py", additions: 12, deletions: 1 }],
});
const YAML_CFG = CodemasterConfigV1.parse({});
const PLATFORM_LABELS = ["default", "lang:python", "topic:security_policy"];

function input(overrides: Partial<RetrieveKnowledgeInputV1>): RetrieveKnowledgeInputV1 {
  return {
    schema_version: 1,
    installation_id: INSTALLATION_ID,
    repo_id: REPO_ID,
    query: "services/api/handler.py review",
    top_k: 5,
    query_vector_override: [...hotVector(0)],
    include_confluence: true,
    pr_context: PR_CTX,
    yaml_config: YAML_CFG,
    platform_exposed_labels: PLATFORM_LABELS,
    ...overrides,
  };
}

describeDb("RetrieveKnowledgeActivity — confluence/HYBRID path over the REAL adapter (disposable PG)", () => {
  it("activates the hybrid path and returns repo + REAL confluence chunks unwrapped to KnowledgeChunkV1", async ({
    skip,
  }) => {
    if (!INTEGRATION_DSN) skip();
    const repo = repoChunk("services/api/handler.py");
    const repoItem: ScoredKnowledgeChunkV1 = { schema_version: 1, chunk: repo, score: 0.9, stage: "bm25" };
    const activity = buildActivity([repoItem]);

    const result = await activity.retrieveKnowledge(input({}));

    const sources = new Set(result.items.map((c) => c.source));
    expect(sources.has("repo_knowledge")).toBe(true);
    expect(sources.has("confluence")).toBe(true);
    // The seeded lang:python confluence page surfaced (effective_labels admitted lang:python).
    const confPath = `confluence/${SPACE_KEY}/p-py`;
    expect(result.items.some((c) => c.relative_path === confPath)).toBe(true);
    expect(result.retrieval_degraded).toBe(false);
  });

  it("legacy fallback: include_confluence=false → BM25+ANN+RRF only, NO confluence row in the result", async ({
    skip,
  }) => {
    if (!INTEGRATION_DSN) skip();
    const repo = repoChunk("services/api/handler.py");
    const repoItem: ScoredKnowledgeChunkV1 = { schema_version: 1, chunk: repo, score: 0.9, stage: "bm25" };
    const activity = buildActivity([repoItem]);

    const result = await activity.retrieveKnowledge(input({ include_confluence: false }));

    expect(result.items.every((c) => c.source === "repo_knowledge")).toBe(true);
    expect(result.items.some((c) => c.relative_path.startsWith("confluence/"))).toBe(false);
  });

  it("legacy fallback: query_vector_override=null → gate fails → BM25+ANN+RRF only", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    const repo = repoChunk("services/api/handler.py");
    const repoItem: ScoredKnowledgeChunkV1 = { schema_version: 1, chunk: repo, score: 0.9, stage: "bm25" };
    const activity = buildActivity([repoItem]);

    const result = await activity.retrieveKnowledge(input({ query_vector_override: null }));

    expect(result.items.every((c) => c.source === "repo_knowledge")).toBe(true);
  });
});
