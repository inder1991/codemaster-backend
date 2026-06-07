/**
 * Integration test for POST /api/admin/taxonomy/suggestions against the DISPOSABLE Postgres (localhost:5434
 * — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set. platform_owner/super_admin; pure DB
 * insert (no audit, no Temporal); label/proposed/rationale pattern validation → 422.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.taxonomy_suggestions WHERE label LIKE 'unrecognized:itest%'`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function cookie(role: Role): Record<string, string> {
  return {
    [SESSION_COOKIE_NAME]: issueCookie({
      user_id: "00000000-0000-0000-0000-0000000000aa",
      email: "u@x",
      role,
      auth_source: "local",
      ldap_groups: [],
      now: NOW,
      signing_key: SIGNING_KEY,
      installation_id: null,
    }),
  };
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

const URL = "/api/admin/taxonomy/suggestions";
const VALID = {
  label: "unrecognized:itestlabel",
  proposed_canonical_label: "lang:cobol",
  rationale: "this is a twenty-plus character rationale for the test",
  suggester_email: "ops@example.com",
};

describeDb("admin taxonomy suggestions write (disposable :5434)", () => {
  it("201 (persists + mints id/queued_at); anonymous ok; 422 bad patterns; 403 reader", async () => {
    const app = await makeApp();
    const ok = await app.inject({ method: "POST", url: URL, cookies: cookie("platform_owner"), payload: VALID });
    expect(ok.statusCode).toBe(201);
    const body = ok.json<{ suggestion_id: string; queued_at: string }>();
    expect(body.suggestion_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.queued_at).toBe("2026-06-07T12:00:00.000Z"); // injected clock
    const row = await sql<{ proposed_canonical_label: string }>`SELECT proposed_canonical_label FROM core.taxonomy_suggestions WHERE suggestion_id = ${body.suggestion_id}`.execute(db);
    expect(row.rows[0]!.proposed_canonical_label).toBe("lang:cobol");

    // anonymous (no suggester_email) → 201
    expect(
      (await app.inject({ method: "POST", url: URL, cookies: cookie("super_admin"), payload: { ...VALID, label: "unrecognized:itestanon", suggester_email: null } })).statusCode,
    ).toBe(201);

    // bad label pattern → 422
    expect((await app.inject({ method: "POST", url: URL, cookies: cookie("platform_owner"), payload: { ...VALID, label: "notunrecognized:x" } })).statusCode).toBe(422);
    // bad proposed_canonical_label → 422
    expect((await app.inject({ method: "POST", url: URL, cookies: cookie("platform_owner"), payload: { ...VALID, proposed_canonical_label: "BadNamespace:x" } })).statusCode).toBe(422);
    // short rationale → 422
    expect((await app.inject({ method: "POST", url: URL, cookies: cookie("platform_owner"), payload: { ...VALID, rationale: "too short" } })).statusCode).toBe(422);
    // reader → 403 (owner/super_admin only)
    expect((await app.inject({ method: "POST", url: URL, cookies: cookie("reader"), payload: VALID })).statusCode).toBe(403);
    await app.close();
  });
});
