/**
 * Integration test for GET /api/admin/reviews + searchReviews against the DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise.
 *
 * Seeds two reviews under one installation/repo:
 *   A — full chain (pull_requests + COMPLETED review_run + 2 non-suppressed findings) → state 'complete',
 *       severity_max 'blocker', finding_count 2, completed_at set.
 *   B — only a pull_request_reviews row (no run/PR/findings) → state 'queued', pr_title 'PR #n',
 *       severity_max null, finding_count 0.
 * Exercises the CTE mapping, the COALESCE/null paths, the state/repo/org filters, page/size + total, authz.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { searchReviews } from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");

const INST = "d1d1d1d1-1111-2222-3333-444444444444";
const ORG = "itest-reviews-org";
const REPO_UUID = "d2d2d2d2-1111-2222-3333-444444444444";
const GHREPO = 970000001;
const GHU = "d3d3d3d3-1111-2222-3333-444444444444";
const PR_A = "d4d4d4d4-1111-2222-3333-444444444444"; // pull_requests.pr_id for review A
const REVIEW_A = "d5d5d5d5-1111-2222-3333-444444444444";
const REVIEW_B = "d6d6d6d6-1111-2222-3333-444444444444";
const RUN_A = "d7d7d7d7-1111-2222-3333-444444444444";
const SHA = "d".repeat(40);

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.review_runs WHERE review_id IN (${REVIEW_A}, ${REVIEW_B})`.execute(db);
  await sql`DELETE FROM core.review_findings WHERE installation_id = ${INST}`.execute(db);
  await sql`DELETE FROM core.pull_request_reviews WHERE review_id IN (${REVIEW_A}, ${REVIEW_B})`.execute(db);
  await sql`DELETE FROM core.pull_requests WHERE installation_id = ${INST}`.execute(db);
  await sql`DELETE FROM core.gh_users WHERE gh_user_id = ${GHU}`.execute(db);
  await sql`DELETE FROM core.repositories WHERE installation_id = ${INST}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${INST}`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
            VALUES (${INST}, ${GHREPO}, ${ORG}, 'Organization') ON CONFLICT (installation_id) DO NOTHING`.execute(db);
  await sql`INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch)
            VALUES (${REPO_UUID}, ${INST}, ${GHREPO}, 'acme/widgets', 'main')`.execute(db);
  await sql`INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type)
            VALUES (${GHU}, 970000099, 'rauthor', 'User')`.execute(db);
  // Review A — full chain.
  await sql`INSERT INTO core.pull_requests
              (pr_id, installation_id, repository_id, github_pull_request_id, pr_number, author_gh_user_id,
               state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
            VALUES (${PR_A}, ${INST}, ${REPO_UUID}, 970001001, 7, ${GHU}, 'open', 'Add widgets',
                    'main', ${SHA}, 'feat', ${SHA}, ${NOW})`.execute(db);
  // current_run_id ⇄ review_runs.review_id is a circular FK — insert the review row first (run NULL),
  // then the run, then point current_run_id at it.
  await sql`INSERT INTO core.pull_request_reviews
              (review_id, provider, repo_id, pr_number, provider_pr_id, created_at)
            VALUES (${REVIEW_A}, 'github', ${GHREPO}, 7, 'gh-7', '2026-06-07T12:10:00.000Z')`.execute(db);
  await sql`INSERT INTO core.review_runs
              (run_id, review_id, trigger_type, lifecycle_state, started_at, completed_at)
            VALUES (${RUN_A}, ${REVIEW_A}, 'pr_opened', 'COMPLETED', '2026-06-07T12:00:00.000Z', '2026-06-07T12:05:00.000Z')`.execute(db);
  await sql`UPDATE core.pull_request_reviews SET current_run_id = ${RUN_A} WHERE review_id = ${REVIEW_A}`.execute(db);
  for (const [fid, sev] of [
    ["d8d8d8d8-1111-2222-3333-444444444444", "blocker"],
    ["d9d9d9d9-1111-2222-3333-444444444444", "issue"],
  ] as const) {
    await sql`INSERT INTO core.review_findings
                (review_finding_id, installation_id, pr_id, file_path, start_line, end_line, severity,
                 category, title, body, confidence, suppression_state)
              VALUES (${fid}, ${INST}, ${PR_A}, 'a.ts', 1, 2, ${sev}, 'bug', 'T', 'B', 0.9, 'NONE')`.execute(db);
  }
  // Review B — only a pull_request_reviews row (no run / PR / findings) → 'queued', null severity.
  await sql`INSERT INTO core.pull_request_reviews
              (review_id, provider, repo_id, pr_number, provider_pr_id, created_at)
            VALUES (${REVIEW_B}, 'github', ${GHREPO}, 8, 'gh-8', '2026-06-07T12:08:00.000Z')`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function mintCookie(role: Role): string {
  // Scope to INST (not platform-view) so the route sees ONLY this test's 2 reviews on the shared :5434.
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role,
    auth_source: "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: INST,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describeDb("admin reviews (disposable :5434)", () => {
  it("searchReviews: maps state/severity/finding_count, COALESCEs title, returns total", async () => {
    const { items, total } = await searchReviews(db, { installationId: INST, page: 1, size: 50 });
    expect(total).toBe(2);
    // ordered by pull_request_reviews.created_at DESC → A (12:10) before B (12:08)
    const a = items.find((i) => i.review_id === REVIEW_A);
    const b = items.find((i) => i.review_id === REVIEW_B);
    expect(a).toMatchObject({
      repo: "acme/widgets",
      pr_number: 7,
      pr_title: "Add widgets",
      state: "complete",
      severity_max: "blocker",
      finding_count: 2,
    });
    expect(a?.completed_at).toBe("2026-06-07T12:05:00.000Z");
    expect(b).toMatchObject({
      pr_number: 8,
      pr_title: "PR #8", // COALESCE fallback (no pull_requests row)
      state: "queued",
      severity_max: null,
      finding_count: 0,
    });
  });

  it("searchReviews: state filter ('complete' → A only; unknown → empty); org filter", async () => {
    expect((await searchReviews(db, { installationId: INST, state: "complete", page: 1, size: 50 })).items
      .map((i) => i.review_id)).toEqual([REVIEW_A]);
    // FAITHFUL-PORT quirk: the 'queued' filter matches lifecycle_state='PENDING' rows, which EXCLUDES
    // null-run reviews like B (B *displays* as 'queued' via the CASE, but has no PENDING run) — same as Python.
    expect((await searchReviews(db, { installationId: INST, state: "queued", page: 1, size: 50 })).items)
      .toEqual([]);
    expect((await searchReviews(db, { installationId: INST, state: "bogus", page: 1, size: 50 })).total).toBe(0);
    expect((await searchReviews(db, { installationId: INST, org: ORG, page: 1, size: 50 })).total).toBe(2);
    expect((await searchReviews(db, { installationId: INST, org: "nope", page: 1, size: 50 })).total).toBe(0);
  });

  it("searchReviews: repo filter + page/size", async () => {
    expect((await searchReviews(db, { installationId: INST, repo: "widgets", page: 1, size: 50 })).total).toBe(2);
    const page1 = await searchReviews(db, { installationId: INST, page: 1, size: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.total).toBe(2); // window COUNT reflects the full set
  });

  it("GET /api/admin/reviews — 200 for platform_operator, 401/403 guards", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/reviews?size=10",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_operator") },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<{ items: Array<unknown>; total: number; page: number; size: number }>();
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.size).toBe(10);

    expect((await app.inject({ method: "GET", url: "/api/admin/reviews" })).statusCode).toBe(401);
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/reviews",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
});
