/**
 * Integration test for the embedder admin reads against the DISPOSABLE Postgres (localhost:5434 — NEVER
 * the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS else.
 *
 *   GET /api/admin/embedder/state          — runtime singleton + 20 newest generations
 *   GET /api/admin/embedder/coverage       — active_generation + 2 anti-join missing-counts
 *   GET /api/admin/embedder/reembed/status — single generation by id (404 if absent)
 *
 * Exercises: validation_report_json JSONB → ValidationReportV1 parse; _coerce_email_or_none (the
 * 'migration-seed' sentinel → null); the coverage anti-join EXCLUDING already-embedded chunks.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import {
  buildEmbedderCoverage,
  buildEmbedderState,
  getGeneration,
} from "#backend/api/admin/embedder_read.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const G_READY = 99010001; // high ids to avoid colliding with the seeded gen 1
const G_BACKFILL = 99010002;
const CHUNK_MISS = "7a7a7a7a-1111-2222-3333-444444444444";
const CHUNK_COV = "7b7b7b7b-1111-2222-3333-444444444444";
const ZERO_VEC = "[" + Array(1024).fill(0).join(",") + "]";

const REPORT = {
  schema_version: 1,
  sample_size: 4,
  tokenization_drift: { mean: 0.1 },
  norm_distribution_old: { mean: 1.0 },
  norm_distribution_new: { mean: 1.0 },
  truncation_count: 0,
  retrieval_overlap: { at_5: 0.9, at_10: 0.8, fixture_size: 10 },
  warnings: [],
  passed: true,
};

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.chunk_embeddings WHERE chunk_id IN (${CHUNK_MISS}, ${CHUNK_COV})`.execute(db);
  await sql`DELETE FROM core.confluence_chunks WHERE chunk_id IN (${CHUNK_MISS}, ${CHUNK_COV})`.execute(db);
  await sql`DELETE FROM core.embedding_generations WHERE generation_id IN (${G_READY}, ${G_BACKFILL})`.execute(db);
}

async function seedConfluenceChunk(chunkId: string, sha: string, chunkIndex: number): Promise<void> {
  // confluence_chunks_natural_key UNIQUE (page_id, version, chunk_index) is GLOBAL (no space_key) → use a
  // test-unique page_id so this doesn't collide with sibling suites seeding 'p1' under parallel runs.
  await sql`INSERT INTO core.confluence_chunks
              (chunk_id, space_key, page_id, page_title, version, chunk_index, chunk_text, content_sha256)
            VALUES (${chunkId}, 'itest-emb', 'itest-emb-page', 'T', 1, ${chunkIndex}, 'x', ${sha})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  // state_biconditional CHECK: 'ready' ⇒ backfill_completed_at NOT NULL; 'backfilling' ⇒ backfill_started_at
  // NOT NULL AND backfill_completed_at NULL (both with activated_at / retired_at NULL).
  await sql`INSERT INTO core.embedding_generations
              (generation_id, state, model_name, embedding_dimension, chunker_version,
               preprocessing_version, normalization_version, created_by_email,
               backfill_started_at, backfill_completed_at, validation_report_json)
            VALUES (${G_READY}, 'ready', 'test-embed', 1024, 'c1', 'p1', 'n1', 'ops@example.com',
                    '2026-06-01T00:00:00Z', '2026-06-01T01:00:00Z', CAST(${JSON.stringify(REPORT)} AS jsonb)),
                   (${G_BACKFILL}, 'backfilling', 'test-embed-2', 1024, 'c1', 'p1', 'n1', 'migration-seed',
                    '2026-06-02T00:00:00Z', NULL, NULL)`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function mintCookie(role: Role): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role,
    auth_source: "local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: null,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describeDb("admin embedder (disposable :5434)", () => {
  it("buildEmbedderState: singleton + generations, JSONB report parse, email coercion, DESC order", async () => {
    const state = await buildEmbedderState(db);
    expect(state.active_generation).toBe(1);
    expect(state.active_model_name).toBe("qwen3-embed-0.6b");
    expect(state.retrieval_mode).toBe("fallback");
    const ids = state.generations.map((g) => g.generation_id);
    expect(ids.indexOf(G_BACKFILL)).toBeLessThan(ids.indexOf(G_READY)); // generation_id DESC
    const ready = state.generations.find((g) => g.generation_id === G_READY)!;
    expect(ready.state).toBe("ready");
    expect(ready.created_by_email).toBe("ops@example.com");
    expect(ready.validation_report?.sample_size).toBe(4);
    expect(ready.validation_report?.passed).toBe(true);
    const back = state.generations.find((g) => g.generation_id === G_BACKFILL)!;
    expect(back.validation_report).toBeNull(); // no JSONB → null
    expect(back.created_by_email).toBeNull(); // 'migration-seed' → coerced to null (no '@')
  });

  it("getGeneration: by id (200-shape) and missing (null)", async () => {
    const g = await getGeneration(db, G_READY);
    expect(g?.generation_id).toBe(G_READY);
    expect(g?.model_name).toBe("test-embed");
    expect(await getGeneration(db, 99099099)).toBeNull();
  });

  it("buildEmbedderCoverage: anti-join counts the un-embedded chunk, EXCLUDES the embedded one", async () => {
    await seedConfluenceChunk(CHUNK_MISS, "miss-sha", 0); // active, NO embedding under gen 1
    await seedConfluenceChunk(CHUNK_COV, "cov-sha", 1); // active, embedded under gen 1
    await sql`INSERT INTO core.chunk_embeddings
                (chunk_table, chunk_id, generation_id, embedding_model_name, embedding, content_sha256)
              VALUES ('confluence_chunks', ${CHUNK_COV}, 1, 'qwen3-embed-0.6b', CAST(${ZERO_VEC} AS vector), 'cov-sha')`.execute(
      db,
    );
    // Scoped anti-join (same shape as the module's, restricted to MY two chunks) — deterministic under
    // parallel runs where sibling suites mutate confluence_chunks globally.
    const scoped = await sql<{ chunk_id: string }>`
      SELECT c.chunk_id FROM core.confluence_chunks c
      LEFT JOIN core.chunk_embeddings ce
        ON ce.chunk_table = 'confluence_chunks' AND ce.chunk_id = c.chunk_id AND ce.generation_id = 1
      WHERE c.chunk_id IN (${CHUNK_MISS}, ${CHUNK_COV})
        AND c.deleted_at IS NULL AND c.superseded_at IS NULL AND ce.chunk_id IS NULL
    `.execute(db);
    const missingIds = scoped.rows.map((r) => r.chunk_id);
    expect(missingIds).toContain(CHUNK_MISS); // un-embedded → counted as missing
    expect(missingIds).not.toContain(CHUNK_COV); // embedded under gen 1 → EXCLUDED
    // The module's global read: stable invariants only (the count is platform-wide; don't assert an exact
    // delta that a concurrently-seeding sibling suite could perturb). CHUNK_MISS guarantees ≥1.
    const cov = await buildEmbedderCoverage(db);
    expect(cov.active_generation).toBe(1);
    expect(cov.confluence_missing).toBeGreaterThanOrEqual(1);
    expect(cov.total_missing).toBe(cov.confluence_missing + cov.knowledge_missing); // computed-in-app invariant
  });

  it("routes: /state + /coverage (200 owner, 403 reader); /reembed/status (200, 404, 422)", async () => {
    const app = await makeApp();
    const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
    expect((await app.inject({ method: "GET", url: "/api/admin/embedder/state", cookies: owner })).statusCode).toBe(
      200,
    );
    const cov = await app.inject({ method: "GET", url: "/api/admin/embedder/coverage", cookies: owner });
    expect(cov.statusCode).toBe(200);
    expect(cov.json<{ active_generation: number }>().active_generation).toBe(1);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/admin/embedder/state",
          cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/embedder/reembed/status?generation_id=${G_READY}`,
          cookies: owner,
        })
      ).statusCode,
    ).toBe(200);
    const missing = await app.inject({
      method: "GET",
      url: "/api/admin/embedder/reembed/status?generation_id=99099099",
      cookies: owner,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ detail: { error: string } }>().detail.error).toBe("generation_not_found");
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/embedder/reembed/status", cookies: owner })).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/admin/embedder/reembed/status?generation_id=notanint",
          cookies: owner,
        })
      ).statusCode,
    ).toBe(422);
    await app.close();
  });
});
