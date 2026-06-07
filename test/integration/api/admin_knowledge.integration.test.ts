/**
 * Integration test for the knowledge (learnings) admin reads (list + detail) against the DISPOSABLE
 * Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS else.
 * Tenant-scoped; in-memory keyset DESC by (last_fired_at, learning_id) with NULL sorting last; accept_rate
 * computed from accepted/feedback.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import {
  getLearningWithRevisions,
  listLearningsPage,
} from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "3a3a3a3a-1111-2222-3333-444444444444";
const INST_OTHER = "3b3b3b3b-1111-2222-3333-444444444444";
const L1 = "3c000001-1111-2222-3333-444444444444"; // last_fired 12:00:01, accept 3/4
const L2 = "3c000002-1111-2222-3333-444444444444"; // last_fired 12:00:02, accept 0/0
const L3 = "3c000003-1111-2222-3333-444444444444"; // last_fired NULL → sorts last
const L_OTHER = "3c000004-1111-2222-3333-444444444444";
const EDITOR = "3d3d3d3d-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.learnings_revisions WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
  await sql`DELETE FROM core.learnings WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id IN (${INST}, ${INST_OTHER})`.execute(db);
}

async function seedLearning(
  id: string,
  inst: string,
  title: string,
  accepted: number,
  feedback: number,
  lastFired: string | null,
): Promise<void> {
  await sql`INSERT INTO core.learnings
              (learning_id, installation_id, title, body_markdown, accepted_count, feedback_count, fired_count, last_fired_at)
            VALUES (${id}, ${inst}, ${title}, 'body', ${accepted}, ${feedback}, ${feedback}, ${lastFired})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  for (const [inst, gh] of [
    [INST, 980000010],
    [INST_OTHER, 980000020],
  ] as const) {
    await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
              VALUES (${inst}, ${gh}, ${"itest-kn-" + String(gh)}, 'Organization') ON CONFLICT (installation_id) DO NOTHING`.execute(db);
  }
  await seedLearning(L1, INST, "L one", 3, 4, "2026-06-07T12:00:01.000Z");
  await seedLearning(L2, INST, "L two", 0, 0, "2026-06-07T12:00:02.000Z");
  await seedLearning(L3, INST, "L three", 1, 2, null);
  await seedLearning(L_OTHER, INST_OTHER, "other", 1, 1, "2026-06-07T12:00:09.000Z");
  await sql`INSERT INTO core.learnings_revisions (learning_id, installation_id, body_markdown, version, edited_by_user_id, edited_at)
            VALUES (${L1}, ${INST}, 'rev1', 1, ${EDITOR}, '2026-06-07T11:00:00.000Z'),
                   (${L1}, ${INST}, 'rev2', 2, ${EDITOR}, '2026-06-07T11:30:00.000Z')`.execute(db);
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

describeDb("admin knowledge (disposable :5434)", () => {
  it("listLearningsPage: DESC by (last_fired_at, id) NULL-last, accept_rate computed, tenancy-scoped", async () => {
    const { rows } = await listLearningsPage(db, INST, null, 50);
    expect(rows.map((r) => r.learning_id)).toEqual([L2, L1, L3]); // 12:00:02, 12:00:01, null-last
    expect(rows.find((r) => r.learning_id === L1)?.accept_rate).toBe(0.75);
    expect(rows.find((r) => r.learning_id === L2)?.accept_rate).toBe(0); // no feedback
    expect(rows.find((r) => r.learning_id === L_OTHER)).toBeUndefined(); // tenancy
    expect(typeof rows[0]?.fired_count).toBe("number");
  });

  it("getLearningWithRevisions: head + revisions (DESC edited_at), null for unknown / cross-tenant", async () => {
    const detail = await getLearningWithRevisions(db, L1, INST);
    expect(detail?.title).toBe("L one");
    expect(detail?.body_markdown).toBe("body");
    expect(detail?.revisions.map((r) => r.body_markdown)).toEqual(["rev2", "rev1"]); // edited_at DESC
    expect(await getLearningWithRevisions(db, L1, INST_OTHER)).toBeNull(); // cross-tenant
    expect(await getLearningWithRevisions(db, "ffffffff-ffff-ffff-ffff-ffffffffffff", INST)).toBeNull();
  });

  it("routes: list 200; detail 200/404; bad uuid 422; authz", async () => {
    const app = await makeApp();
    const reader = { [SESSION_COOKIE_NAME]: mintCookie("reader", INST) };
    expect((await app.inject({ method: "GET", url: "/api/admin/knowledge", cookies: reader })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/admin/knowledge/${L1}`, cookies: reader })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/admin/knowledge/not-a-uuid", cookies: reader })).statusCode).toBe(422);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/knowledge/ffffffff-ffff-ffff-ffff-ffffffffffff", cookies: reader })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/knowledge", cookies: { [SESSION_COOKIE_NAME]: mintCookie("org_owner", INST) } })).statusCode,
    ).toBe(403);
    await app.close();
  });
});
