// LIVE integration test for PostgresConfluenceRetrieval against a DISPOSABLE Postgres (NO embedder).
//
// Proves the REAL pgvector confluence query end-to-end (NO stub), asserting the load-bearing WHERE-clause
// behavior of the frozen Python adapter:
//   1. APPROVAL-DRIFT safeguard — a `default`-labeled chunk with NO active approval is NOT returned;
//      a `default`-labeled chunk WITH an active (non-revoked) approval IS returned; a `default`-labeled
//      chunk whose approval is REVOKED is NOT returned (LEFT JOIN ... revoked_at IS NULL).
//   2. NON-DEFAULT content needs no approval — a `topic:*`-labeled chunk is returned regardless.
//   3. SKIP-HYGIENE — quarantined / superseded / soft-deleted chunks are excluded.
//   4. LABEL OVERLAP — a chunk whose labels don't intersect the effective_labels is excluded
//      (and the empty-labels short-circuit returns [] before any DB call).
//   5. pgvector ORDERING — results come back by cosine similarity DESC (nearest first).
//
// GATING: runs ONLY when CODEMASTER_PG_CORE_DSN is set (describeDb) — the disposable PG at
//   postgresql://postgres:postgres@localhost:5434/codemaster, NEVER the in-cluster DB.
//
// NO EMBEDDER: vectors are SEEDED deterministically (a single hot dimension per chunk), so cosine
// ordering is fully controlled without a live embedding service.
//
// ISOLATION: a UNIQUE space_key per test run; every seeded row is cleaned up by space_key in afterAll.

import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresConfluenceRetrieval } from "#backend/adapters/postgres_confluence_retrieval.js";

import { disposeAllPools, tenantKysely } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const DIM = 1024;
// A unique space_key namespaces every seeded row for this run; cleanup deletes by it.
const SPACE_KEY = `IT-${randomUUID().slice(0, 8)}`;

let db: Kysely<unknown>;

beforeAll(() => {
  if (INTEGRATION_DSN) {
    db = tenantKysely<unknown>(INTEGRATION_DSN);
  }
});

afterAll(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${SPACE_KEY}`.execute(db);
    await sql`DELETE FROM core.confluence_page_approvals WHERE space_key = ${SPACE_KEY}`.execute(db);
    await disposeAllPools();
  }
});

/** A 1024-dim unit vector hot in one dimension; closeness to the query controls cosine rank. */
function hotVector(dim: number): ReadonlyArray<number> {
  const v = new Array<number>(DIM).fill(0);
  v[dim] = 1;
  return v;
}

/** pgvector text literal "[f1,...]" for the vector(1024) column. */
function toPgVectorLiteral(vec: ReadonlyArray<number>): string {
  return `[${vec.map((x) => String(x)).join(",")}]`;
}

type SeedChunk = {
  pageId: string;
  labels: ReadonlyArray<string>;
  hotDim: number;
  defaultApproval?: boolean; // present iff labels include 'default'
  quarantined?: boolean;
  supersededAt?: string | null;
  deletedAt?: string | null;
};

/** Insert one confluence_chunks row. `default`-labeled rows MUST carry default_approval (biconditional). */
async function seedChunk(c: SeedChunk): Promise<string> {
  const chunkId = randomUUID();
  const vecLit = toPgVectorLiteral(hotVector(c.hotDim));
  const labelsLit = sql`${[...c.labels]}::text[]`;
  const isDefault = c.labels.includes("default");
  const defaultApproval = isDefault ? sql`'{"scope":"universal"}'::jsonb` : sql`NULL`;
  const quarantined = c.quarantined ?? false;
  const quarantineReasons = quarantined ? sql`ARRAY['injection']::text[]` : sql`ARRAY[]::text[]`;
  await sql`
    INSERT INTO core.confluence_chunks
      (chunk_id, space_key, page_id, page_title, version, chunk_index, chunk_text,
       content_sha256, labels, default_approval, quarantined, quarantine_reasons,
       superseded_at, deleted_at, embedding)
    VALUES
      (${chunkId}, ${SPACE_KEY}, ${c.pageId}, ${"Page " + c.pageId}, 1, 0, ${"body " + c.pageId},
       ${"0".repeat(64)}, ${labelsLit}, ${defaultApproval}, ${quarantined}, ${quarantineReasons},
       ${c.supersededAt ?? null}, ${c.deletedAt ?? null}, ${vecLit}::vector)
  `.execute(db);
  return chunkId;
}

/** Insert an active (or revoked) approval row for a default page. */
async function seedApproval(pageId: string, opts: { revoked?: boolean } = {}): Promise<void> {
  const revokedAt = opts.revoked ? sql`now()` : sql`NULL`;
  const revokedBy = opts.revoked ? sql`'ops@example.com'` : sql`NULL`;
  await sql`
    INSERT INTO core.confluence_page_approvals
      (approval_id, space_key, page_id, approver_email, approved_at_utc,
       approval_artifact_url, scope_justification, default_scope, revoked_at, revoked_by)
    VALUES
      (${randomUUID()}, ${SPACE_KEY}, ${pageId}, 'approver@example.com', now(),
       'https://artifact', 'justified', 'universal', ${revokedAt}, ${revokedBy})
  `.execute(db);
}

describeDb("PostgresConfluenceRetrieval against disposable PG (seeded vectors)", () => {
  beforeAll(async () => {
    if (!INTEGRATION_DSN) return;
    // Effective labels for the query: {default, topic:security}.
    // page-approved-default : default-labeled, has ACTIVE approval        → returned
    await seedChunk({ pageId: "p-approved", labels: ["default", "topic:security"], hotDim: 0 });
    await seedApproval("p-approved");
    // page-unapproved-default : default-labeled, NO approval row          → NOT returned (drift)
    await seedChunk({ pageId: "p-unapproved", labels: ["default", "topic:security"], hotDim: 1 });
    // page-revoked-default : default-labeled, REVOKED approval            → NOT returned
    await seedChunk({ pageId: "p-revoked", labels: ["default", "topic:security"], hotDim: 2 });
    await seedApproval("p-revoked", { revoked: true });
    // page-topic : non-default labels, no approval needed                 → returned
    await seedChunk({ pageId: "p-topic", labels: ["topic:security"], hotDim: 3 });
    // page-quarantined : non-default, quarantined                         → excluded
    await seedChunk({ pageId: "p-quar", labels: ["topic:security"], hotDim: 4, quarantined: true });
    // page-superseded : non-default, superseded_at set                    → excluded
    await seedChunk({ pageId: "p-super", labels: ["topic:security"], hotDim: 5, supersededAt: new Date().toISOString() });
    // page-deleted : non-default, deleted_at set                          → excluded
    await seedChunk({ pageId: "p-del", labels: ["topic:security"], hotDim: 6, deletedAt: new Date().toISOString() });
    // page-other-label : labels don't overlap effective_labels            → excluded by overlap filter
    await seedChunk({ pageId: "p-other", labels: ["lang:python"], hotDim: 7 });
  });

  const adapter = (): PostgresConfluenceRetrieval => new PostgresConfluenceRetrieval({ db });
  const EFFECTIVE = new Set(["default", "topic:security"]);

  it("approval-drift: approved default returned, unapproved + revoked default excluded", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    // Query nearest the approved page (hotDim 0).
    const rows = await adapter().search({
      queryEmbedding: hotVector(0),
      topK: 50,
      effectiveLabels: EFFECTIVE,
    });
    const pageIds = new Set(rows.map((r) => r.page_id));
    expect(pageIds.has("p-approved")).toBe(true);
    expect(pageIds.has("p-unapproved")).toBe(false); // approval-drift safeguard
    expect(pageIds.has("p-revoked")).toBe(false); // revoked approval = no active approval
  });

  it("non-default content needs no approval (topic page returned)", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    const rows = await adapter().search({ queryEmbedding: hotVector(3), topK: 50, effectiveLabels: EFFECTIVE });
    expect(rows.some((r) => r.page_id === "p-topic")).toBe(true);
  });

  it("skip-hygiene: quarantined / superseded / deleted chunks excluded", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    const rows = await adapter().search({ queryEmbedding: hotVector(0), topK: 50, effectiveLabels: EFFECTIVE });
    const pageIds = new Set(rows.map((r) => r.page_id));
    expect(pageIds.has("p-quar")).toBe(false);
    expect(pageIds.has("p-super")).toBe(false);
    expect(pageIds.has("p-del")).toBe(false);
  });

  it("label-overlap: a chunk with no overlapping label is excluded", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    const rows = await adapter().search({ queryEmbedding: hotVector(7), topK: 50, effectiveLabels: EFFECTIVE });
    // p-other has lang:python only — does NOT overlap {default, topic:security}.
    expect(rows.some((r) => r.page_id === "p-other")).toBe(false);
  });

  it("returns exactly the 2 visible pages (p-approved, p-topic) for the effective label set", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    const rows = await adapter().search({ queryEmbedding: hotVector(0), topK: 50, effectiveLabels: EFFECTIVE });
    expect(new Set(rows.map((r) => r.page_id))).toEqual(new Set(["p-approved", "p-topic"]));
  });

  it("orders by cosine similarity DESC (nearest hot-dim first) and maps the row fields", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    // Query exactly at the approved page's hot dim → it must rank first; score ≈ 1.0.
    const rows = await adapter().search({ queryEmbedding: hotVector(0), topK: 50, effectiveLabels: EFFECTIVE });
    expect(rows.length).toBe(2);
    const first = rows[0]!;
    expect(first.page_id).toBe("p-approved");
    expect(first.source).toBe("confluence");
    expect(first.space_key).toBe(SPACE_KEY);
    expect(first.version).toBe(1);
    expect(first.labels).toContain("topic:security");
    expect(first.match_specificity_score).toBe(0);
    expect(first.score).toBeGreaterThan(0.99); // identical vector → similarity ≈ 1
    expect(first.age_days).toBeGreaterThanOrEqual(0);
    // scores are non-increasing.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1]!.score).toBeGreaterThanOrEqual(rows[i]!.score);
    }
  });

  it("empty effective_labels short-circuits to [] (no overlap with any chunk)", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    const rows = await adapter().search({ queryEmbedding: hotVector(0), topK: 50, effectiveLabels: new Set() });
    expect(rows).toEqual([]);
  });
});

// ── EmbedderCache Phase-A / Phase-C dispatch (the chunk_embeddings JOIN paths) ─────────────────────
// The EmbedderCache SEAM is NOT yet ported to TS (FOLLOW-UP-embedder-cache), but the adapter accepts a
// structural fake so the Phase-A/Phase-C SQL (1:1 with the frozen Python `_SEARCH_SQL_PHASE_A/C`) is
// DB-verified here. Seeds a dedicated generation + `core.chunk_embeddings` rows whose vector differs
// from the legacy `cc.embedding` column, proving Phase C reads the chunk_embeddings vector (INNER JOIN
// on generation_id) and Phase A reads it via COALESCE.

/** A fake EmbedderCache pinned to a given mode + generation. */
function fakeCache(mode: "fallback" | "generation_only", generationId: number): {
  getRetrievalMode(): "fallback" | "generation_only";
  getActiveGeneration(): number;
} {
  return { getRetrievalMode: () => mode, getActiveGeneration: () => generationId };
}

describeDb("PostgresConfluenceRetrieval EmbedderCache Phase-A / Phase-C dispatch", () => {
  const GEN_SPACE = `IT-GEN-${randomUUID().slice(0, 8)}`;
  let generationId = 0;

  beforeAll(async () => {
    if (!INTEGRATION_DSN) return;
    // A dedicated generation row (state='active').
    const gen = await sql<{ generation_id: string }>`
      INSERT INTO core.embedding_generations
        (state, model_name, embedding_dimension, chunker_version, preprocessing_version,
         normalization_version, backfill_started_at, backfill_completed_at, activated_at)
      VALUES ('active', ${"mxbai-it-" + GEN_SPACE}, ${DIM}, 'c1', 'p1', 'n1', now(), now(), now())
      RETURNING generation_id
    `.execute(db);
    generationId = Number(gen.rows[0]!.generation_id);

    // One non-default chunk whose LEGACY cc.embedding is hot at dim 100, but whose chunk_embeddings
    // vector (under this generation) is hot at dim 200. A query at dim 200 should match ONLY via the
    // chunk_embeddings vector.
    const chunkId = randomUUID();
    const legacyVec = toPgVectorLiteral(hotVector(100));
    const genVec = toPgVectorLiteral(hotVector(200));
    await sql`
      INSERT INTO core.confluence_chunks
        (chunk_id, space_key, page_id, page_title, version, chunk_index, chunk_text,
         content_sha256, labels, quarantined, quarantine_reasons, embedding)
      VALUES
        (${chunkId}, ${GEN_SPACE}, 'p-gen', 'P', 1, 0, 'b', ${"0".repeat(64)},
         ${sql`ARRAY['topic:security']::text[]`}, false, ${sql`ARRAY[]::text[]`}, ${legacyVec}::vector)
    `.execute(db);
    await sql`
      INSERT INTO core.chunk_embeddings
        (chunk_table, chunk_id, generation_id, embedding_model_name, embedding, content_sha256)
      VALUES
        ('confluence_chunks', ${chunkId}, ${String(generationId)}::bigint, 'mxbai', ${genVec}::vector, ${"0".repeat(64)})
    `.execute(db);
  });

  afterAll(async () => {
    if (!INTEGRATION_DSN) return;
    await sql`DELETE FROM core.chunk_embeddings WHERE generation_id = ${String(generationId)}::bigint`.execute(db);
    await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${GEN_SPACE}`.execute(db);
    await sql`DELETE FROM core.embedding_generations WHERE generation_id = ${String(generationId)}::bigint`.execute(db);
  });

  const EFFECTIVE = new Set(["topic:security"]);

  it("Phase C (generation_only): reads the chunk_embeddings vector via INNER JOIN on generation_id", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    const adapter = new PostgresConfluenceRetrieval({ db, embedderCache: fakeCache("generation_only", generationId) });
    // Query at the chunk_embeddings hot dim (200) → high similarity via the generation vector.
    const rows = await adapter.search({ queryEmbedding: hotVector(200), topK: 50, effectiveLabels: EFFECTIVE });
    const hit = rows.find((r) => r.page_id === "p-gen");
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(0.99);
  });

  it("Phase C excludes a chunk that has NO chunk_embeddings row for the active generation", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    // A different (non-existent) generation → INNER JOIN yields nothing.
    const adapter = new PostgresConfluenceRetrieval({
      db,
      embedderCache: fakeCache("generation_only", generationId + 999_999),
    });
    const rows = await adapter.search({ queryEmbedding: hotVector(200), topK: 50, effectiveLabels: EFFECTIVE });
    expect(rows.some((r) => r.page_id === "p-gen")).toBe(false);
  });

  it("Phase A (fallback): COALESCE prefers the chunk_embeddings vector when present", async ({ skip }) => {
    if (!INTEGRATION_DSN) skip();
    const adapter = new PostgresConfluenceRetrieval({ db, embedderCache: fakeCache("fallback", generationId) });
    // Query at the chunk_embeddings hot dim (200): COALESCE(ce.embedding, cc.embedding) picks ce → high sim.
    const rows = await adapter.search({ queryEmbedding: hotVector(200), topK: 50, effectiveLabels: EFFECTIVE });
    const hit = rows.find((r) => r.page_id === "p-gen");
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThan(0.99);
  });
});
