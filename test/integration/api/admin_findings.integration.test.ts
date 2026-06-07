/**
 * Integration test for GET /api/admin/findings + listFindings against the DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise.
 *
 * Seeds the full FK chain (installation → repository → gh_user → pull_request → review_findings) for two
 * installations and exercises: keyset ordering (created_at DESC), the over-fetch + next_cursor pagination,
 * the severity filter, tenancy isolation, and the route's role guard.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { listFindings } from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");

const INST = "f1f1f1f1-1111-2222-3333-444444444444";
const INST_OTHER = "f2f2f2f2-1111-2222-3333-444444444444";
const REPO = "f3f3f3f3-1111-2222-3333-444444444444";
const GHU = "f4f4f4f4-1111-2222-3333-444444444444";
const PR = "f5f5f5f5-1111-2222-3333-444444444444";
const PR_OTHER = "f6f6f6f6-1111-2222-3333-444444444444";
const REPO_OTHER = "f7f7f7f7-1111-2222-3333-444444444444";
const GHU_OTHER = "f8f8f8f8-1111-2222-3333-444444444444";
// findings (created_at ascending f1<f2<f3 → ORDER created_at DESC returns f3,f2,f1)
const F1 = "aaaa0001-1111-2222-3333-444444444444";
const F2 = "aaaa0002-1111-2222-3333-444444444444";
const F3 = "aaaa0003-1111-2222-3333-444444444444";
const F_OTHER = "aaaa0004-1111-2222-3333-444444444444";
const SHA = "a".repeat(40);

let pool: Pool;
let db: Kysely<unknown>;

async function seedChain(
  inst: string,
  repo: string,
  ghu: string,
  pr: string,
  ghBase: number,
): Promise<void> {
  await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
            VALUES (${inst}, ${ghBase}, ${"itest-find-" + String(ghBase)}, 'Organization') ON CONFLICT (installation_id) DO NOTHING`.execute(db);
  await sql`INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch)
            VALUES (${repo}, ${inst}, ${ghBase + 1}, ${"org/repo" + String(ghBase)}, 'main')`.execute(db);
  await sql`INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type)
            VALUES (${ghu}, ${ghBase + 2}, ${"user" + String(ghBase)}, 'User')`.execute(db);
  await sql`INSERT INTO core.pull_requests
              (pr_id, installation_id, repository_id, github_pull_request_id, pr_number, author_gh_user_id,
               state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
            VALUES (${pr}, ${inst}, ${repo}, ${ghBase + 3}, 1, ${ghu}, 'open', 'PR', 'main', ${SHA}, 'feat', ${SHA}, ${NOW})`.execute(db);
}

async function seedFinding(
  id: string,
  inst: string,
  pr: string,
  severity: string,
  createdAt: string,
): Promise<void> {
  await sql`INSERT INTO core.review_findings
              (review_finding_id, installation_id, pr_id, file_path, start_line, end_line, severity,
               category, title, body, confidence, created_at)
            VALUES (${id}, ${inst}, ${pr}, 'src/a.ts', 1, 2, ${severity}, 'bug', 'T', 'B', 0.900, ${createdAt})`.execute(db);
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.review_findings WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
  await sql`DELETE FROM core.pull_requests WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
  await sql`DELETE FROM core.gh_users WHERE gh_user_id IN (${GHU}, ${GHU_OTHER})`.execute(db);
  await sql`DELETE FROM core.repositories WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await seedChain(INST, REPO, GHU, PR, 940000010);
  await seedChain(INST_OTHER, REPO_OTHER, GHU_OTHER, PR_OTHER, 940000020);
  await seedFinding(F1, INST, PR, "issue", "2026-06-07T12:00:01.000Z");
  await seedFinding(F2, INST, PR, "issue", "2026-06-07T12:00:02.000Z");
  await seedFinding(F3, INST, PR, "blocker", "2026-06-07T12:00:03.000Z");
  await seedFinding(F_OTHER, INST_OTHER, PR_OTHER, "blocker", "2026-06-07T12:00:05.000Z");
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

describeDb("admin findings (disposable :5434)", () => {
  it("listFindings: tenancy-scoped, ordered created_at DESC; severity filter; tenancy isolation", async () => {
    const mine = await listFindings(db, { installationId: INST, limit: 50 });
    expect(mine.map((f) => f.review_finding_id)).toEqual([F3, F2, F1]); // created_at DESC
    expect(mine.every((f) => f.installation_id === INST)).toBe(true);

    const blockers = await listFindings(db, { installationId: INST, severity: "blocker", limit: 50 });
    expect(blockers.map((f) => f.review_finding_id)).toEqual([F3]);

    // INST_OTHER's finding never leaks into INST's results.
    expect(mine.find((f) => f.review_finding_id === F_OTHER)).toBeUndefined();

    // confidence numeric → number; created_at → ISO string.
    expect(mine[0]?.confidence).toBe(0.9);
    expect(mine[0]?.created_at).toBe("2026-06-07T12:00:03.000Z");
  });

  it("GET /api/admin/findings — keyset pagination via next_cursor", async () => {
    const app = await makeApp();
    const page1 = await app.inject({
      method: "GET",
      url: "/api/admin/findings?limit=2",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_operator", INST) },
    });
    expect(page1.statusCode).toBe(200);
    const b1 = page1.json<{ rows: Array<{ review_finding_id: string }>; next_cursor: Record<string, string> | null }>();
    expect(b1.rows.map((r) => r.review_finding_id)).toEqual([F3, F2]);
    expect(b1.next_cursor).not.toBeNull();

    const c = b1.next_cursor!;
    const page2 = await app.inject({
      method: "GET",
      url: `/api/admin/findings?limit=2&cursor_created_at=${encodeURIComponent(String(c.cursor_created_at))}&cursor_finding_id=${String(c.cursor_finding_id)}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_operator", INST) },
    });
    const b2 = page2.json<{ rows: Array<{ review_finding_id: string }>; next_cursor: Record<string, string> | null }>();
    expect(b2.rows.map((r) => r.review_finding_id)).toEqual([F1]);
    expect(b2.next_cursor).toBeNull(); // last page
    await app.close();
  });

  it("GET /api/admin/findings — 401 without cookie, 403 for a reader", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/admin/findings" })).statusCode).toBe(401);
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/findings",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader", INST) },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
});
