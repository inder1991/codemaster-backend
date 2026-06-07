/**
 * Integration test for GET /api/admin/cost-caps + buildCostCapsPage against the DISPOSABLE Postgres
 * (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS else.
 * Platform-scope; assembles 4 reads + the EOD spend projection.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { buildCostCapsPage } from "#backend/api/admin/cost_caps_read.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z"); // 12:00 UTC → 43200s elapsed → projection ×2
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const OV_INST = "4a4a4a4a-1111-2222-3333-444444444444";
const USER = "4b4b4b4b-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.cost_cap_settings WHERE scope IN ('global', 'per_org_default')`.execute(db);
  await sql`DELETE FROM core.cost_cap_overrides WHERE installation_id = ${OV_INST}`.execute(db);
  await sql`DELETE FROM core.cost_cap_pending_changes WHERE requested_by_user_id = ${USER}`.execute(db);
  await sql`DELETE FROM telemetry.cost_daily WHERE today = '2026-06-07' AND scope = 'global'`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await sql`INSERT INTO core.cost_cap_settings (scope, cap_cents, updated_at, updated_by_user_id)
            VALUES ('global', 1000000, '2026-06-01T00:00:00Z', ${USER}),
                   ('per_org_default', 500000, '2026-06-02T00:00:00Z', ${USER})`.execute(db);
  await sql`INSERT INTO core.cost_cap_overrides (installation_id, cap_cents, expires_at, updated_by_user_id)
            VALUES (${OV_INST}, 300000, NULL, ${USER})`.execute(db);
  await sql`INSERT INTO core.cost_cap_pending_changes (target_kind, new_cap_cents, requested_by_user_id, state)
            VALUES ('global', 1200000, ${USER}, 'pending')`.execute(db);
  await sql`INSERT INTO telemetry.cost_daily (today, scope, daily_total_cents, cap_cents)
            VALUES ('2026-06-07', 'global', 12345, 1000000)`.execute(db);
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

describeDb("admin cost-caps (disposable :5434)", () => {
  it("buildCostCapsPage: settings (more-recent updated_at), overrides, pending, spend + projection", async () => {
    const page = await buildCostCapsPage(db, NOW);
    expect(page.settings.global_cap_cents).toBe(1000000);
    expect(page.settings.per_org_default_cap_cents).toBe(500000);
    expect(page.settings.hard_ceiling_cents).toBe(5000000);
    expect(page.settings.updated_at).toBe("2026-06-02T00:00:00.000Z"); // per_org row is newer
    expect(page.overrides.find((o) => o.installation_id === OV_INST)?.cap_cents).toBe(300000);
    expect(page.overrides.find((o) => o.installation_id === OV_INST)?.installation_name).toContain("installation:");
    expect(page.pending_changes.some((c) => c.new_cap_cents === 1200000)).toBe(true);
    expect(page.todays_spend_global_cents).toBe(12345);
    expect(page.todays_projected_global_cents).toBe(24690); // 12345 / (43200/86400) = ×2
  });

  it("GET /api/admin/cost-caps — 200 for platform_owner, 403 for reader", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/cost-caps",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ settings: { global_cap_cents: number } }>().settings.global_cap_cents).toBe(1000000);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/cost-caps", cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") } })).statusCode,
    ).toBe(403);
    await app.close();
  });
});
