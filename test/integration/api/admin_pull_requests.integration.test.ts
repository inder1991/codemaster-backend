/**
 * Integration test for GET /api/admin/pull-requests + listPullRequests against the DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise.
 *
 * Seeds an installation → repository → gh_user (author) → 3 PRs (distinct opened_at) plus a second
 * installation's PR, and exercises: opened_at-DESC keyset ordering, the batched author_login resolve, the
 * state filter, tenancy isolation, next_cursor pagination, and the route role guard.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { listPullRequests } from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");

const INST = "c1c1c1c1-1111-2222-3333-444444444444";
const INST_OTHER = "c2c2c2c2-1111-2222-3333-444444444444";
const REPO = "c3c3c3c3-1111-2222-3333-444444444444";
const REPO_OTHER = "c4c4c4c4-1111-2222-3333-444444444444";
const GHU = "c5c5c5c5-1111-2222-3333-444444444444";
const P1 = "bbbb0001-1111-2222-3333-444444444444";
const P2 = "bbbb0002-1111-2222-3333-444444444444";
const P3 = "bbbb0003-1111-2222-3333-444444444444";
const P_OTHER = "bbbb0004-1111-2222-3333-444444444444";
const SHA = "b".repeat(40);

let pool: Pool;
let db: Kysely<unknown>;

async function seedPr(
  id: string,
  inst: string,
  repo: string,
  author: string | null,
  prNumber: number,
  ghPrId: number,
  state: string,
  openedAt: string,
): Promise<void> {
  await sql`INSERT INTO core.pull_requests
              (pr_id, installation_id, repository_id, github_pull_request_id, pr_number, author_gh_user_id,
               state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
            VALUES (${id}, ${inst}, ${repo}, ${ghPrId}, ${prNumber}, ${author},
                    ${state}, ${"PR " + String(prNumber)}, 'main', ${SHA}, 'feat', ${SHA}, ${openedAt})`.execute(db);
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.pull_requests WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
  await sql`DELETE FROM core.gh_users WHERE gh_user_id = ${GHU}`.execute(db);
  await sql`DELETE FROM core.repositories WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  for (const [inst, repo, gh] of [
    [INST, REPO, 950000010],
    [INST_OTHER, REPO_OTHER, 950000020],
  ] as const) {
    await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
              VALUES (${inst}, ${gh}, ${"itest-pr-" + String(gh)}, 'Organization') ON CONFLICT (installation_id) DO NOTHING`.execute(db);
    await sql`INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch)
              VALUES (${repo}, ${inst}, ${gh + 1}, ${"org/repo" + String(gh)}, 'main')`.execute(db);
  }
  await sql`INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type)
            VALUES (${GHU}, 950000099, 'prauthor', 'User')`.execute(db);
  await seedPr(P1, INST, REPO, GHU, 1, 960000001, "open", "2026-06-07T12:00:01.000Z");
  await seedPr(P2, INST, REPO, GHU, 2, 960000002, "open", "2026-06-07T12:00:02.000Z");
  await seedPr(P3, INST, REPO, GHU, 3, 960000003, "merged", "2026-06-07T12:00:03.000Z");
  await seedPr(P_OTHER, INST_OTHER, REPO_OTHER, GHU, 1, 960000004, "open", "2026-06-07T12:00:09.000Z");
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function mintCookie(role: Role, installationId: string): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role,
    auth_source: "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: installationId,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describeDb("admin pull-requests (disposable :5434)", () => {
  it("listPullRequests: opened_at DESC, author_login resolved, state filter, tenancy isolation", async () => {
    const mine = await listPullRequests(db, { installationId: INST, limit: 50 });
    expect(mine.map((p) => p.pr_id)).toEqual([P3, P2, P1]); // opened_at DESC
    expect(mine.every((p) => p.author_login === "prauthor")).toBe(true);
    expect(mine[0]?.state).toBe("merged");
    expect(mine[0]?.opened_at).toBe("2026-06-07T12:00:03.000Z");

    const merged = await listPullRequests(db, { installationId: INST, state: "merged", limit: 50 });
    expect(merged.map((p) => p.pr_id)).toEqual([P3]);

    // INST_OTHER's PR (null author) never leaks into INST's page.
    expect(mine.find((p) => p.pr_id === P_OTHER)).toBeUndefined();
  });

  it("GET /api/admin/pull-requests — keyset pagination via next_cursor", async () => {
    const app = await makeApp();
    const page1 = await app.inject({
      method: "GET",
      url: "/api/admin/pull-requests?limit=2",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_operator", INST) },
    });
    expect(page1.statusCode).toBe(200);
    const b1 = page1.json<{ rows: Array<{ pr_id: string }>; next_cursor: Record<string, string> | null }>();
    expect(b1.rows.map((r) => r.pr_id)).toEqual([P3, P2]);
    expect(b1.next_cursor).not.toBeNull();

    const c = b1.next_cursor!;
    const page2 = await app.inject({
      method: "GET",
      url: `/api/admin/pull-requests?limit=2&cursor_opened_at=${encodeURIComponent(String(c.cursor_opened_at))}&cursor_pr_id=${String(c.cursor_pr_id)}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_operator", INST) },
    });
    const b2 = page2.json<{ rows: Array<{ pr_id: string }>; next_cursor: Record<string, string> | null }>();
    expect(b2.rows.map((r) => r.pr_id)).toEqual([P1]);
    expect(b2.next_cursor).toBeNull();
    await app.close();
  });

  it("GET /api/admin/pull-requests — 401 without cookie, 403 for a reader", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/admin/pull-requests" })).statusCode).toBe(401);
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/pull-requests",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader", INST) },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
});
