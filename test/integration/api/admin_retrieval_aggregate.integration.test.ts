/**
 * Integration test for the retrieval-aggregate reads against the DISPOSABLE Postgres (localhost:5434 —
 * NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS else.
 *
 *   GET /api/admin/retrieval-aggregates/reviews/{review_id}       — per-review fold (+ 404 / 500 paths)
 *   GET /api/admin/retrieval-aggregates/pull-requests/{pr_id}     — per-PR review summaries
 *
 * Seeds a full graph: gh_user → installation → repository → pull_requests → pull_request_reviews →
 * review_runs → retrieval_traces. Exercises the single-pass fold, the pgr_chain_mismatch 500 path, and
 * the not-found 404.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { getByReview, listByPr } from "#backend/api/admin/retrieval_aggregate_read.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const GHU = "9a000000-0000-0000-0000-000000000001";
const GHREPO = 988000010; // distinct global-unique range (siblings use 94x–97x) for parallel-run isolation
const INSTALL = "9a000000-0000-0000-0000-000000000002";
const REPO = "9a000000-0000-0000-0000-000000000003";
const PR = "9a000000-0000-0000-0000-000000000004";
const PR2 = "9a000000-0000-0000-0000-000000000005";
const REVIEW = "9a000000-0000-0000-0000-000000000006";
const REVIEW_BAD = "9a000000-0000-0000-0000-000000000007";
const RUN = "9a000000-0000-0000-0000-000000000008";
const ABSENT = "9a000000-0000-0000-0000-0000000000ff";
const T1 = "9a000000-0000-0000-0000-00000000000a";
const T2 = "9a000000-0000-0000-0000-00000000000b";
const T_BAD = "9a000000-0000-0000-0000-00000000000c";
const CHUNK = "9a000000-0000-0000-0000-00000000000d";
// pull_requests.head_sha is character(40) (fixed-width, space-padded) — seed full 40-char SHAs so the
// value round-trips exactly (the padding affects the Python read identically; this is faithful).
const SHA_PR = "abc123".padEnd(40, "0");
const SHA_PR2 = "def456".padEnd(40, "0");

let pool: Pool;
let db: Kysely<unknown>;

function makeTrace(traceId: string, prId: string, capturedAt: string, starvation: boolean): unknown {
  return {
    schema_version: 2,
    trace_id: traceId,
    review_id: REVIEW,
    pr_id: prId,
    captured_at: capturedAt,
    taxonomy_version: 3,
    pipeline_version: 2,
    detectors: [],
    effective_labels: ["lang:python", "security"],
    platform_exposed_labels_count: 2,
    repo_include_attempts_filtered: [],
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
            default_scope: "security_only",
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
  await sql`DELETE FROM core.retrieval_traces WHERE trace_id IN (${T1}, ${T2}, ${T_BAD})`.execute(db);
  await sql`DELETE FROM core.review_runs WHERE run_id = ${RUN}`.execute(db);
  await sql`DELETE FROM core.pull_request_reviews WHERE review_id IN (${REVIEW}, ${REVIEW_BAD})`.execute(db);
  await sql`DELETE FROM core.pull_requests WHERE pr_id IN (${PR}, ${PR2})`.execute(db);
  await sql`DELETE FROM core.repositories WHERE repository_id = ${REPO}`.execute(db);
  await sql`DELETE FROM core.gh_users WHERE gh_user_id = ${GHU}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${INSTALL}`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await sql`INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type)
            VALUES (${GHU}, 988000099, 'aggauthor', 'User')`.execute(db);
  await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
            VALUES (${INSTALL}, 988000001, 'itest-agg', 'Organization')`.execute(db);
  await sql`INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch)
            VALUES (${REPO}, ${INSTALL}, ${GHREPO}, 'org/repo', 'main')`.execute(db);
  for (const [prId, num, sha] of [
    [PR, 42, SHA_PR],
    [PR2, 43, SHA_PR2],
  ] as const) {
    await sql`INSERT INTO core.pull_requests
                (pr_id, installation_id, repository_id, github_pull_request_id, pr_number, author_gh_user_id,
                 state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
              VALUES (${prId}, ${INSTALL}, ${REPO}, ${988000000 + num}, ${num}, ${GHU},
                      'open', ${"PR " + String(num)}, 'main', ${sha}, 'feat', ${sha}, now())`.execute(db);
  }
  // pull_request_reviews: REVIEW chain MATCHES (repo_id=GHREPO, pr_number=42); REVIEW_BAD MISMATCHES
  // (pr_number=999 ≠ PR2.pr_number=43) to drive the pgr_chain_mismatch 500.
  await sql`INSERT INTO core.pull_request_reviews (review_id, provider, repo_id, pr_number, provider_pr_id)
            VALUES (${REVIEW}, 'github', ${GHREPO}, 42, 'gh-42'),
                   (${REVIEW_BAD}, 'github', ${GHREPO}, 999, 'gh-bad')`.execute(db);
  // ck_review_runs_completed_at_present: COMPLETED ⇒ completed_at NOT NULL (biconditional).
  await sql`INSERT INTO core.review_runs (run_id, review_id, trigger_type, lifecycle_state, completed_at)
            VALUES (${RUN}, ${REVIEW}, 'pr_opened', 'COMPLETED', now())`.execute(db);
  await sql`UPDATE core.pull_request_reviews SET current_run_id = ${RUN} WHERE review_id = ${REVIEW}`.execute(db);
  // REVIEW traces (PR): T1 starvation, T2 not. REVIEW_BAD trace (PR2): minimal — never parsed (500 fires first).
  await sql`INSERT INTO core.retrieval_traces (trace_id, review_id, pr_id, captured_at, taxonomy_version, pipeline_version, trace)
            VALUES (${T1}, ${REVIEW}, ${PR}, '2026-06-01T00:00:00Z', 3, 2, CAST(${JSON.stringify(makeTrace(T1, PR, "2026-06-01T00:00:00+00:00", true))} AS jsonb)),
                   (${T2}, ${REVIEW}, ${PR}, '2026-06-02T00:00:00Z', 3, 2, CAST(${JSON.stringify(makeTrace(T2, PR, "2026-06-02T00:00:00+00:00", false))} AS jsonb))`.execute(
    db,
  );
  await sql`INSERT INTO core.retrieval_traces (trace_id, review_id, pr_id, captured_at, taxonomy_version, pipeline_version, trace)
            VALUES (${T_BAD}, ${REVIEW_BAD}, ${PR2}, now(), 3, 2, CAST(${JSON.stringify({ schema_version: 2 })} AS jsonb))`.execute(
    db,
  );
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

describeDb("admin retrieval-aggregates (disposable :5434)", () => {
  it("getByReview: single-pass fold over the two traces + metadata snapshot", async () => {
    const agg = await getByReview(db, REVIEW);
    expect(agg.total_trace_count).toBe(2);
    expect(agg.returned_trace_count).toBe(2);
    expect(agg.parsed_trace_count).toBe(2);
    expect(agg.invalid_trace_count).toBe(0);
    expect(agg.trace_count_truncated).toBe(false);
    expect(agg.pr_id).toBe(PR);
    expect(agg.pr_number).toBe(42);
    expect(agg.installation_id).toBe(INSTALL);
    expect(agg.repository_id).toBe(REPO);
    expect(agg.repo_full_name).toBe("org/repo");
    expect(agg.pr_current_head_sha).toBe(SHA_PR);
    expect(agg.latest_run_id).toBe(RUN);
    expect(agg.latest_run_lifecycle_state).toBe("COMPLETED");
    expect(agg.latest_run_terminal_reason).toBeNull(); // not CANCELLED
    expect(agg.superseded_run_count).toBe(0);
    expect(agg.lineage_warning).toBeNull();
    expect(agg.lineage_confidence).toBe("mixed_run_possible");
    expect(agg.aggregation_scope).toBe("review_scoped");
    expect(agg.starvation_any).toBe(true);
    expect(agg.starvation_trace_count).toBe(1);
    expect(agg.effective_labels_union).toEqual(["lang:python", "security"]);
    expect(agg.pipeline_versions_seen).toEqual([2]);
    expect(agg.taxonomy_versions_seen).toEqual([3]);
    expect(agg.version_drift_detected).toBe(false);
    expect(agg.top_spaces_retrieved).toEqual(["security_only"]);
    expect(agg.top_labels_retrieved).toEqual(["security"]);
    expect(agg.earliest_captured_at?.startsWith("2026-06-01")).toBe(true);
    expect(agg.latest_captured_at?.startsWith("2026-06-02")).toBe(true);
  });

  it("listByPr: per-review summary for the PR (only REVIEW has traces for PR)", async () => {
    const page = await listByPr(db, PR);
    expect(page.pr_id).toBe(PR);
    expect(page.pr_number).toBe(42);
    expect(page.repo_full_name).toBe("org/repo");
    expect(page.total_review_count).toBe(1);
    expect(page.returned_review_count).toBe(1);
    expect(page.review_count_truncated).toBe(false);
    const r = page.reviews[0]!;
    expect(r.review_id).toBe(REVIEW);
    expect(r.trace_count).toBe(2);
    expect(r.starvation_any).toBe(true);
    expect(r.starvation_trace_count).toBe(1);
    expect(r.latest_run_id).toBe(RUN);
    expect(r.latest_run_lifecycle_state).toBe("COMPLETED");
    expect(r.superseded_run_count).toBe(0);
  });

  it("routes: reviews (200 / 404 / 500-mismatch / 403 / 422); pull-requests (200 / 422)", async () => {
    const app = await makeApp();
    const owner = { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") };
    expect(
      (await app.inject({ method: "GET", url: `/api/admin/retrieval-aggregates/reviews/${REVIEW}`, cookies: owner }))
        .statusCode,
    ).toBe(200);
    const nf = await app.inject({
      method: "GET",
      url: `/api/admin/retrieval-aggregates/reviews/${ABSENT}`,
      cookies: owner,
    });
    expect(nf.statusCode).toBe(404);
    expect(nf.json<{ detail: { code: string } }>().detail.code).toBe("review_traces_not_found");
    const bad = await app.inject({
      method: "GET",
      url: `/api/admin/retrieval-aggregates/reviews/${REVIEW_BAD}`,
      cookies: owner,
    });
    expect(bad.statusCode).toBe(500);
    expect(bad.json<{ detail: { kind: string } }>().detail.kind).toBe("pgr_chain_mismatch");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/retrieval-aggregates/reviews/${REVIEW}`,
          cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/retrieval-aggregates/reviews/nope", cookies: owner }))
        .statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: "GET", url: `/api/admin/retrieval-aggregates/pull-requests/${PR}`, cookies: owner }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/retrieval-aggregates/pull-requests/nope", cookies: owner }))
        .statusCode,
    ).toBe(422);
    await app.close();
  });
});
