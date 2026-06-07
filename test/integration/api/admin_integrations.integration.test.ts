/**
 * Integration test for GET /api/admin/integrations (in-memory keyset pagination) against the DISPOSABLE
 * Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS else.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { listIntegrationsPage } from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const I1 = "2a000001-1111-2222-3333-444444444444";
const I2 = "2a000002-1111-2222-3333-444444444444";
const I3 = "2a000003-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.integrations WHERE integration_id IN (${I1}, ${I2}, ${I3})`.execute(db);
}

async function seedIntegration(id: string, createdAt: string, spaceKey: string): Promise<void> {
  await sql`INSERT INTO core.integrations (integration_id, kind, config_json, trust_tier, created_at, updated_at)
            VALUES (${id}, 'confluence_space', CAST(${JSON.stringify({ space_key: spaceKey })} AS jsonb),
                    'semi', ${createdAt}, ${createdAt})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await seedIntegration(I1, "2026-06-07T12:00:01.000Z", "ALPHA");
  await seedIntegration(I2, "2026-06-07T12:00:02.000Z", "BETA");
  await seedIntegration(I3, "2026-06-07T12:00:03.000Z", "GAMMA");
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

describeDb("admin integrations (disposable :5434)", () => {
  it("listIntegrationsPage: created_at-DESC keyset, config_json is a raw string, cursor paginates", async () => {
    // core.integrations is PLATFORM-SHARED (no installation_id) so concurrent integrations tests (e.g.
    // admin_integrations_delete) coexist in the same table — assert only over THIS test's own rows.
    const MINE = new Set([I1, I2, I3]);
    const mine = (ids: Array<string>): Array<string> => ids.filter((id) => MINE.has(id));

    // Full list: own rows surface newest-first (created_at DESC); config_json comes back as a raw string.
    const all = await listIntegrationsPage(db, null, 500);
    expect(mine(all.rows.map((r) => r.integration_id))).toEqual([I3, I2, I1]);
    const i3 = all.rows.find((r) => r.integration_id === I3);
    expect(typeof i3?.config_json).toBe("string");
    expect(i3?.config_json).toContain("GAMMA");

    // Cursor paginates with no gaps/dupes: page through the whole table (size 2) and assert this test's
    // rows surface exactly once each, in created_at DESC order, and that pagination terminates.
    const seen: Array<string> = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 5000; guard++) {
      const page: Awaited<ReturnType<typeof listIntegrationsPage>> = await listIntegrationsPage(db, cursor, 2);
      seen.push(...page.rows.map((r) => r.integration_id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(mine(seen)).toEqual([I3, I2, I1]);
  });

  it("GET /api/admin/integrations — 200, bad cursor → 400, authz", async () => {
    const app = await makeApp();
    const reader = { [SESSION_COOKIE_NAME]: mintCookie("reader") };
    const ok = await app.inject({ method: "GET", url: "/api/admin/integrations?size=2", cookies: reader });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ rows: Array<{ integration_id: string }>; next_cursor: string | null }>().rows).toHaveLength(2);

    expect(
      (await app.inject({ method: "GET", url: "/api/admin/integrations?cursor=%21%21bad", cookies: reader })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/integrations", cookies: { [SESSION_COOKIE_NAME]: mintCookie("org_owner") } })).statusCode,
    ).toBe(403);
    await app.close();
  });
});
