/**
 * Integration test for GET /api/admin/default-corpus/health + buildDefaultCorpusHealth against the
 * DISPOSABLE Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 * Platform-scope; 2 reads + JSONB-extracted per-scope 24h hit rate.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { buildDefaultCorpusHealth } from "#backend/api/admin/default_corpus_read.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const SPACE = "itest-dc-space";
const TRACE = "5a5a5a5a-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.confluence_chunks WHERE space_key = ${SPACE}`.execute(db);
  await sql`DELETE FROM core.retrieval_traces WHERE trace_id = ${TRACE}`.execute(db);
}

let chunkIdx = 0;
async function seedChunk(scope: string, status: string): Promise<void> {
  await sql`INSERT INTO core.confluence_chunks
              (space_key, page_id, page_title, version, chunk_index, chunk_text, content_sha256, labels,
               default_approval, page_status, token_count)
            VALUES (${SPACE}, 'p1', 'T', 1, ${chunkIdx++}, 'x', ${SPACE + "-" + String(chunkIdx)},
                    ARRAY['default']::text[], CAST(${JSON.stringify({ default_scope: scope })} AS jsonb),
                    ${status}, 100)`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await seedChunk("universal", "active");
  await seedChunk("universal", "active");
  await seedChunk("security_only", "stale");
  // a retrieval trace from the last 24h that retrieved 2 'universal' default chunks
  // schema_version present so this row stays valid in v_retrieval_traces_recent (the matview's
  // trace_schema_version extract is NOT NULL) when a parallel retrieval-traces suite REFRESHes it.
  const trace = { schema_version: 2, stage3: { track_a_default: { selected_chunks_detail: [{ default_scope: "universal" }, { default_scope: "universal" }] } } };
  await sql`INSERT INTO core.retrieval_traces (trace_id, review_id, pr_id, captured_at, taxonomy_version, pipeline_version, trace)
            VALUES (${TRACE}, gen_random_uuid(), gen_random_uuid(), now(), 1, 1, CAST(${JSON.stringify(trace)} AS jsonb))`.execute(db);
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

describeDb("admin default-corpus/health (disposable :5434)", () => {
  it("buildDefaultCorpusHealth: corpus aggregate + per-scope 24h hit rate (clamped)", async () => {
    const h = await buildDefaultCorpusHealth(db, NOW);
    expect(h.captured_at).toBe("2026-06-07T12:00:00.000Z"); // from the injected clock
    expect(h.total_default_chunks).toBe(3);
    expect(h.stale_default_chunks).toBe(1);
    expect(h.total_tokens).toBe(300);
    expect(h.spaces_with_defaults).toBe(1);
    const universal = h.hit_rate_24h_by_scope.find((s) => s.scope === "universal");
    expect(universal?.chunks_in_corpus).toBe(2);
    expect(universal?.chunks_retrieved_24h).toBe(2);
    expect(universal?.hit_rate_24h).toBe(1); // min(2/2, 1)
    const security = h.hit_rate_24h_by_scope.find((s) => s.scope === "security_only");
    expect(security?.chunks_in_corpus).toBe(1);
    expect(security?.hit_rate_24h).toBe(0); // 0 retrieved
  });

  it("GET /api/admin/default-corpus/health — 200 for platform_owner, 403 for reader", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/default-corpus/health",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ total_default_chunks: number }>().total_default_chunks).toBe(3);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/default-corpus/health", cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") } })).statusCode,
    ).toBe(403);
    await app.close();
  });
});
