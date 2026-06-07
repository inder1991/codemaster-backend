/**
 * Integration test for the retrieval-trace inspector reads against the DISPOSABLE Postgres (localhost:5434
 * — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS else.
 *
 *   GET /api/admin/retrieval-traces            — list from the v_retrieval_traces_recent materialized view
 *   GET /api/admin/retrieval-traces/{trace_id} — full RetrievalTraceV2 JSONB (404 if absent)
 *
 * The matview is created WITH NO DATA; the test seeds core.retrieval_traces then REFRESHes it.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import {
  getRetrievalTrace,
  listRetrievalTraces,
} from "#backend/api/admin/retrieval_traces_read.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const T_STARV = "8a8a8a8a-1111-2222-3333-444444444444";
const T_NORMAL = "8b8b8b8b-1111-2222-3333-444444444444";
const ABSENT = "8c8c8c8c-1111-2222-3333-444444444444";
const REVIEW = "8d8d8d8d-1111-2222-3333-444444444444";
const PR = "8e8e8e8e-1111-2222-3333-444444444444";
const CHUNK = "8f8f8f8f-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

function makeTrace(traceId: string, starvation: boolean): Record<string, unknown> {
  return {
    schema_version: 2,
    trace_id: traceId,
    review_id: REVIEW,
    pr_id: PR,
    captured_at: "2026-06-07T12:00:00+00:00",
    taxonomy_version: 3,
    pipeline_version: 2,
    detectors: [],
    effective_labels: ["lang:python", "security"], // count 2
    platform_exposed_labels_count: 2,
    repo_include_attempts_filtered: ["owner/repo"], // count 1
    stage1: { schema_version: 1, candidates_in: 10, candidates_out: 5, per_label_cap_applied: false },
    stage2: { schema_version: 1, per_tier_quotas: {}, tier_pool_size: 5 },
    stage3: {
      schema_version: 2,
      track_a_default: {
        schema_version: 2,
        selection_basis: "default",
        selected_chunk_ids: [],
        dropped_chunk_ids: [],
        selected_chunks_detail: [
          {
            schema_version: 1,
            chunk_id: CHUNK,
            priority_tier: "SECURITY_POLICY",
            match_specificity_score: 5,
            matched_labels: ["security"],
            emitting_detectors: [],
          },
        ],
        dropped_chunks_detail: [],
      },
      track_b_non_default: {
        schema_version: 2,
        selection_basis: "non-default",
        selected_chunk_ids: [],
        dropped_chunk_ids: [],
        selected_chunks_detail: [],
        dropped_chunks_detail: [],
      },
      starvation_observed: starvation,
      starvation_tiers: [],
      lambda_mmr: 0.7,
    },
    token_accounting: {
      schema_version: 1,
      budget_total: 1000,
      default_pool_used: 100,
      non_default_pool_used: 50,
      remaining: 850,
      reserved_floors_consumed: {},
    },
  };
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.retrieval_traces WHERE trace_id IN (${T_STARV}, ${T_NORMAL})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  for (const [tid, starv] of [
    [T_STARV, true],
    [T_NORMAL, false],
  ] as const) {
    await sql`INSERT INTO core.retrieval_traces
                (trace_id, review_id, pr_id, captured_at, taxonomy_version, pipeline_version, trace)
              VALUES (${tid}, ${REVIEW}, ${PR}, now(), 3, 2, CAST(${JSON.stringify(makeTrace(tid, starv))} AS jsonb))`.execute(
      db,
    );
  }
  // The materialized view is created WITH NO DATA — populate it so the list read returns rows.
  await sql`REFRESH MATERIALIZED VIEW core.v_retrieval_traces_recent`.execute(db);
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

describeDb("admin retrieval-traces (disposable :5434)", () => {
  it("listRetrievalTraces: flattened matview entry, starvation filter, offset next_cursor", async () => {
    const all = await listRetrievalTraces(db, { offset: 0, pageSize: 200, starvationOnly: false });
    const starv = all.rows.find((r) => r.trace_id === T_STARV)!;
    expect(starv.starvation_observed).toBe(true);
    expect(starv.trace_schema_version).toBe(2);
    expect(starv.taxonomy_version).toBe(3);
    expect(starv.pipeline_version).toBe(2);
    expect(starv.effective_labels_count).toBe(2);
    expect(starv.repo_include_attempts_filtered_count).toBe(1);
    expect(starv.selected_chunks_count).toBe(1); // track_a has 1 detail
    expect(starv.dropped_chunks_count).toBe(0);
    expect(starv.budget_total).toBe(1000);
    expect(starv.budget_remaining).toBe(850);
    expect(all.rows.some((r) => r.trace_id === T_NORMAL)).toBe(true);

    const filtered = await listRetrievalTraces(db, { offset: 0, pageSize: 200, starvationOnly: true });
    expect(filtered.rows.some((r) => r.trace_id === T_STARV)).toBe(true);
    expect(filtered.rows.some((r) => r.trace_id === T_NORMAL)).toBe(false); // starvation filter excludes it

    const onePage = await listRetrievalTraces(db, { offset: 0, pageSize: 1, starvationOnly: false });
    expect(onePage.rows).toHaveLength(1);
    expect(onePage.nextCursor).toBe("1"); // full page → String(offset + page_size)
  });

  it("getRetrievalTrace: full JSONB by id, null when absent", async () => {
    const t = await getRetrievalTrace(db, T_STARV);
    expect(t?.trace_id).toBe(T_STARV);
    expect(t?.stage3.starvation_observed).toBe(true);
    expect(t?.token_accounting.budget_total).toBe(1000);
    expect(await getRetrievalTrace(db, ABSENT)).toBeNull();
  });

  it("routes: list (200 owner / 403 reader); detail (200 / 404 / 422)", async () => {
    const app = await makeApp();
    const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
    expect((await app.inject({ method: "GET", url: "/api/admin/retrieval-traces", cookies: owner })).statusCode).toBe(
      200,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/admin/retrieval-traces?starvation_only=true",
          cookies: owner,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/admin/retrieval-traces",
          cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
        })
      ).statusCode,
    ).toBe(403);
    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/retrieval-traces/${T_STARV}`,
      cookies: owner,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ trace_id: string }>().trace_id).toBe(T_STARV);
    const missing = await app.inject({
      method: "GET",
      url: `/api/admin/retrieval-traces/${ABSENT}`,
      cookies: owner,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ detail: { code: string } }>().detail.code).toBe("trace_not_found");
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/retrieval-traces/not-a-uuid", cookies: owner })).statusCode,
    ).toBe(422);
    await app.close();
  });
});
