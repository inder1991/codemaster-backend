/**
 * Integration test for the notification-rules admin reads (list + detail) against the DISPOSABLE Postgres
 * (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise.
 * Platform-scope (no installation filtering); JSONB filters/recipients; recipient discriminated union.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import {
  getNotificationRule,
  listNotificationRules,
} from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const RULE_A = "1b1b1b1b-1111-2222-3333-444444444444";
const RULE_B = "1c1c1c1c-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.notification_rules WHERE rule_id IN (${RULE_A}, ${RULE_B})`.execute(db);
}

async function seedRule(id: string, name: string, recipients: unknown): Promise<void> {
  await sql`INSERT INTO core.notification_rules (rule_id, name, trigger_event, filters, recipients, state)
            VALUES (${id}, ${name}, 'review.completed', CAST(${JSON.stringify({ severity: "high" })} AS jsonb),
                    CAST(${JSON.stringify(recipients)} AS jsonb), 'active')`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await seedRule(RULE_A, "itest-rule-aaa", [{ schema_version: 1, type: "slack", channel: "#ops" }]);
  await seedRule(RULE_B, "itest-rule-bbb", [
    { schema_version: 1, type: "email", address: "ops@example.com" },
    { schema_version: 1, type: "jira", project_key: "OPS", issue_type: "Bug" },
  ]);
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

describeDb("admin notification-rules (disposable :5434)", () => {
  it("listNotificationRules: ordered by name; JSONB filters + recipient union parsed", async () => {
    const mine = (await listNotificationRules(db)).filter((r) =>
      String((r as { name: string }).name).startsWith("itest-rule-"),
    );
    expect(mine.map((r) => (r as { rule_id: string }).rule_id)).toEqual([RULE_A, RULE_B]);
    const a = mine[0] as { filters: { severity: string }; recipients: Array<{ type: string }> };
    expect(a.filters.severity).toBe("high");
    expect(a.recipients[0]?.type).toBe("slack");
  });

  it("getNotificationRule: by id, and null for an unknown id", async () => {
    expect((await getNotificationRule(db, RULE_B) as { name: string }).name).toBe("itest-rule-bbb");
    expect(await getNotificationRule(db, "ffffffff-ffff-ffff-ffff-ffffffffffff")).toBeNull();
  });

  it("routes: list 200 + installation_id param 422; detail 200/422/404; authz", async () => {
    const app = await makeApp();
    const op = { [SESSION_COOKIE_NAME]: mintCookie("platform_operator") };

    const list = await app.inject({ method: "GET", url: "/api/admin/notification-rules", cookies: op });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ rules: Array<{ rule_id: string }> }>().rules.map((r) => r.rule_id)).toEqual(
      expect.arrayContaining([RULE_A, RULE_B]),
    );

    expect(
      (await app.inject({ method: "GET", url: "/api/admin/notification-rules?installation_id=x", cookies: op })).statusCode,
    ).toBe(422);
    expect((await app.inject({ method: "GET", url: `/api/admin/notification-rules/${RULE_A}`, cookies: op })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/admin/notification-rules/not-a-uuid", cookies: op })).statusCode).toBe(422);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/notification-rules/ffffffff-ffff-ffff-ffff-ffffffffffff", cookies: op })).statusCode,
    ).toBe(404);
    // reader is NOT in the allow-set for notification rules
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/notification-rules", cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") } })).statusCode,
    ).toBe(403);
    await app.close();
  });
});
