/**
 * Integration test for GET /api/admin/knowledge/proposals + listProposalsPage against the DISPOSABLE
 * Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS else.
 *
 * Tenant-scoped pending-approval queue with in-memory keyset pagination (DESC by created_at, proposal_id).
 * Exercises: state='pending_approval' filter, tenancy isolation, the repo LEFT JOIN (nullable), keyset
 * paging, and the wire shape that OMITS `state`.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { listProposalsPage } from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "9b000000-0000-0000-0000-000000000001";
const OTHER = "9b000000-0000-0000-0000-000000000002";
const REPO = "9b000000-0000-0000-0000-000000000003";
const U1 = "9b000000-0000-0000-0000-000000000004";
const P1 = "9b000000-0000-0000-0000-00000000000a";
const P2 = "9b000000-0000-0000-0000-00000000000b";
const P3 = "9b000000-0000-0000-0000-00000000000c";
const P_APPROVED = "9b000000-0000-0000-0000-00000000000d";
const P_OTHER = "9b000000-0000-0000-0000-00000000000e";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.learning_proposals WHERE installation_id IN (${INST}, ${OTHER})`.execute(db);
  await sql`DELETE FROM core.repositories WHERE repository_id = ${REPO}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id IN (${INST}, ${OTHER})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  for (const [inst, gh] of [
    [INST, 989000001],
    [OTHER, 989000002],
  ] as const) {
    await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
              VALUES (${inst}, ${gh}, ${"itest-prop-" + String(gh)}, 'Organization')`.execute(db);
  }
  await sql`INSERT INTO core.repositories (repository_id, installation_id, github_repo_id, full_name, default_branch)
            VALUES (${REPO}, ${INST}, 989000010, 'org/repo', 'main')`.execute(db);
  for (const [id, inst, repoId, ts, state, title] of [
    [P1, INST, REPO, "2026-06-01T00:00:00Z", "pending_approval", "P1"],
    [P2, INST, null, "2026-06-02T00:00:00Z", "pending_approval", "P2"],
    [P3, INST, null, "2026-06-03T00:00:00Z", "pending_approval", "P3"],
    [P_APPROVED, INST, null, "2026-06-04T00:00:00Z", "approved", "PA"], // excluded: not pending
    [P_OTHER, OTHER, null, "2026-06-05T00:00:00Z", "pending_approval", "PO"], // excluded: other tenant
  ] as const) {
    await sql`INSERT INTO core.learning_proposals
                (proposal_id, installation_id, repo_id, title, body, proposed_by_user_id, state, created_at)
              VALUES (${id}, ${inst}, ${repoId}, ${title}, ${"body-" + title}, ${U1}, ${state}, ${ts})`.execute(db);
  }
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
    auth_source: "local",
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

describeDb("admin knowledge/proposals (disposable :5434)", () => {
  it("listProposalsPage: pending-only, tenant-scoped, DESC by created_at, repo LEFT JOIN", async () => {
    const { rows } = await listProposalsPage(db, INST, null, 200);
    expect(rows.map((r) => r.proposal_id)).toEqual([P3, P2, P1]); // created_at DESC; pending only; INST only
    const p1 = rows.find((r) => r.proposal_id === P1)!;
    expect(p1.repo).toBe("org/repo");
    expect(p1.body_markdown).toBe("body-P1");
    expect(p1.proposed_by_user_id).toBe(U1);
    expect(rows.find((r) => r.proposal_id === P2)!.repo).toBeNull(); // no repo_id → LEFT JOIN null
    expect("state" in (rows[0] as object)).toBe(false); // wire shape omits state
  });

  it("listProposalsPage: keyset pagination across two pages", async () => {
    const first = await listProposalsPage(db, INST, null, 2);
    expect(first.rows.map((r) => r.proposal_id)).toEqual([P3, P2]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listProposalsPage(db, INST, first.nextCursor, 2);
    expect(second.rows.map((r) => r.proposal_id)).toEqual([P1]);
    expect(second.nextCursor).toBeNull();
  });

  it("route: 200 for reader (tenant-scoped), 400 on a malformed cursor", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/knowledge/proposals",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader", INST) },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ rows: Array<unknown> }>().rows).toHaveLength(3);
    const bad = await app.inject({
      method: "GET",
      url: "/api/admin/knowledge/proposals?cursor=%%%not-base64%%%",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader", INST) },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
