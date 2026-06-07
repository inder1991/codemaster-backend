/**
 * Integration test for DELETE /api/admin/integrations/{integration_id} against the DISPOSABLE Postgres
 * (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 *
 * 1:1 port of integrations.py delete_integration + postgres_integrations_repo.delete. core.integrations is
 * platform-shared (migration 0062 dropped installation_id), so delete is by integration_id only and the
 * audit row carries installation_id=NULL. Covers: 204 + row gone + audit; 404 (re-delete / unknown); 403.
 *
 * integration_id is the PK → globally unique; the `dd00dd00-` namespace is verified free across the tree.
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
const INST = "aa11bb22-3333-4444-5555-666677778888";
const D1 = "dd00dd00-0000-0000-0000-000000000001";
const D2 = "dd00dd00-0000-0000-0000-000000000002";
const ABSENT = "dd00dd00-0000-0000-0000-0000000000ff";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.integrations WHERE integration_id IN (${D1}, ${D2})`.execute(db);
}

// Each row carries a DISTINCT space_key — the unique index integrations_kind_space_key is on
// (kind, config_json->>'space_key') across the whole platform-shared table, so a shared key collides.
async function seed(id: string, spaceKey: string): Promise<void> {
  const config = { space_key: spaceKey, space_name: "Eng", scope: "whole_space", page_tree_root_id: null };
  await sql`INSERT INTO core.integrations (integration_id, kind, config_json)
            VALUES (${id}, 'confluence_space', CAST(${JSON.stringify(config)} AS jsonb))`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await seed(D1, "FWDEL1");
  await seed(D2, "FWDEL2");
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function cookie(role: Role): Record<string, string> {
  return {
    [SESSION_COOKIE_NAME]: issueCookie({
      user_id: "aa11bb22-0000-0000-0000-00000000000a",
      email: "u@x",
      role,
      auth_source: "local",
      ldap_groups: [],
      now: NOW,
      signing_key: SIGNING_KEY,
      installation_id: INST,
    }),
  };
}

type AuditEvent = { action: string; targetId: string; installationId: string | null; before: unknown; after: unknown };

async function makeApp(audited?: Array<AuditEvent>) {
  const app = buildApp({});
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    ...(audited
      ? {
          audit: async (e: AuditEvent) => {
            audited.push(e);
          },
        }
      : {}),
  });
  await app.ready();
  return app;
}

const url = (id: string): string => `/api/admin/integrations/${id}`;

describeDb("admin integrations DELETE (disposable :5434)", () => {
  it("owner deletes D1 → 204, row gone, audit integration.removed (installation_id NULL); re-delete → 404", async () => {
    const audited: Array<AuditEvent> = [];
    const app = await makeApp(audited);
    const res = await app.inject({ method: "DELETE", url: url(D1), cookies: cookie("platform_owner") });
    expect(res.statusCode).toBe(204);
    // row gone
    const after = await sql`SELECT 1 FROM core.integrations WHERE integration_id = ${D1}`.execute(db);
    expect(after.rows).toHaveLength(0);
    // audit emitted (platform-scope → installationId null)
    expect(audited).toHaveLength(1);
    expect(audited[0]!.action).toBe("integration.removed");
    expect(audited[0]!.targetId).toBe(D1);
    expect(audited[0]!.installationId).toBeNull();
    expect((audited[0]!.before as Record<string, unknown>)["kind"]).toBe("confluence_space");
    expect(audited[0]!.after).toBeNull();
    // re-delete the now-absent row → 404 (deterministic within this test; no audit)
    expect((await app.inject({ method: "DELETE", url: url(D1), cookies: cookie("platform_owner") })).statusCode).toBe(
      404,
    );
    expect(audited).toHaveLength(1);
    await app.close();
  });

  it("unknown id → 404", async () => {
    const app = await makeApp();
    expect(
      (await app.inject({ method: "DELETE", url: url(ABSENT), cookies: cookie("platform_owner") })).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("reader / operator → 403 (D2 survives)", async () => {
    const app = await makeApp();
    for (const role of ["reader", "platform_operator"] as const) {
      expect((await app.inject({ method: "DELETE", url: url(D2), cookies: cookie(role) })).statusCode).toBe(403);
    }
    // D2 still present (403 short-circuited before any DB write)
    const still = await sql`SELECT 1 FROM core.integrations WHERE integration_id = ${D2}`.execute(db);
    expect(still.rows).toHaveLength(1);
    await app.close();
  });
});
