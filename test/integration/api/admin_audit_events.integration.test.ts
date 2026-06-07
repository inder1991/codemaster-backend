/**
 * Integration test for GET /api/admin/audit-events + searchAuditEvents against the DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise.
 *
 * Seeds audit.audit_events rows with LOCALLY-encrypted before/after (the TS crypto model) and exercises:
 * decrypt → excerpt, the actor_kind='user' filter, action filter, cursor pagination, the cross-tenant +
 * >30d-window refusals, and the route role guard (org_owner is NOT allowed).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import {
  AuditCrossTenantRefusedError,
  AuditWindowTooWideError,
  searchAuditEvents,
} from "#backend/api/admin/audit_events_read.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import {
  AUDIT_AFTER_AAD,
  AUDIT_BEFORE_AAD,
  encryptAuditJsonBytea,
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-30T13:00:00.000Z"); // after the seeded events (12:00:0x) so the default now-7d window includes them
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "e1e1e1e1-1111-2222-3333-444444444444";
const ACTOR = "e2e2e2e2-1111-2222-3333-444444444444";
const E1 = "ea000001-1111-2222-3333-444444444444";
const E2 = "ea000002-1111-2222-3333-444444444444";
const E3 = "ea000003-1111-2222-3333-444444444444";
const E_SYS = "ea000004-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

async function seedEvent(
  id: string,
  actorKind: string,
  action: string,
  createdAt: string,
): Promise<void> {
  const before = encryptAuditJsonBytea({ k: "old-" + action }, AUDIT_BEFORE_AAD);
  const after = encryptAuditJsonBytea({ k: "new-" + action }, AUDIT_AFTER_AAD);
  await sql`INSERT INTO audit.audit_events
              (audit_event_id, installation_id, actor_kind, actor_id, action, target_kind, target_id,
               before, after, created_at)
            VALUES (${id}, ${INST}, ${actorKind}, ${ACTOR}, ${action}, 'session', 'tgt', ${before}, ${after}, ${createdAt})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(3)]]) }));
  setAuditKeyRegistry(reg);
  await sql`DELETE FROM audit.audit_events WHERE installation_id = ${INST}`.execute(db);
  await seedEvent(E1, "user", "login.success", "2026-06-30T12:00:01.000Z");
  await seedEvent(E2, "user", "role.granted", "2026-06-30T12:00:02.000Z");
  await seedEvent(E3, "user", "login.success", "2026-06-30T12:00:03.000Z");
  await seedEvent(E_SYS, "system", "retention.prune", "2026-06-30T12:00:04.000Z"); // excluded (actor_kind)
});

afterAll(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM audit.audit_events WHERE installation_id = ${INST}`.execute(db);
  }
  resetAuditKeyRegistryForTesting();
  await db?.destroy();
});

function mintCookie(role: Role): string {
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

describeDb("admin audit-events (disposable :5434)", () => {
  it("searchAuditEvents: user-actor only, created_at DESC, decrypts excerpts", async () => {
    const { rows } = await searchAuditEvents(db, {
      role: "platform_owner",
      callerInstallationId: INST,
      query: { crossTenant: false },
      cursor: null,
      size: 50,
      now: NOW,
    });
    expect(rows.map((r) => r.audit_event_id)).toEqual([E3, E2, E1]); // DESC; system row excluded
    expect(rows[0]?.before_excerpt).toContain("old-login.success");
    expect(rows[0]?.after_excerpt).toContain("new-login.success");
  });

  it("searchAuditEvents: action filter + cursor pagination", async () => {
    const filtered = await searchAuditEvents(db, {
      role: "platform_owner",
      callerInstallationId: INST,
      query: { action: "login.success", crossTenant: false },
      cursor: null,
      size: 50,
      now: NOW,
    });
    expect(filtered.rows.map((r) => r.audit_event_id)).toEqual([E3, E1]);

    const page1 = await searchAuditEvents(db, {
      role: "platform_owner",
      callerInstallationId: INST,
      query: { crossTenant: false },
      cursor: null,
      size: 2,
      now: NOW,
    });
    expect(page1.rows.map((r) => r.audit_event_id)).toEqual([E3, E2]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await searchAuditEvents(db, {
      role: "platform_owner",
      callerInstallationId: INST,
      query: { crossTenant: false },
      cursor: page1.nextCursor,
      size: 2,
      now: NOW,
    });
    expect(page2.rows.map((r) => r.audit_event_id)).toEqual([E1]);
    expect(page2.nextCursor).toBeNull();
  });

  it("searchAuditEvents: cross-tenant + >30d window refused for non-security_auditor", async () => {
    await expect(
      searchAuditEvents(db, {
        role: "platform_owner",
        callerInstallationId: INST,
        query: { crossTenant: true },
        cursor: null,
        size: 50,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(AuditCrossTenantRefusedError);

    await expect(
      searchAuditEvents(db, {
        role: "platform_owner",
        callerInstallationId: INST,
        query: { fromAt: "2026-01-01T00:00:00Z", toAt: "2026-06-30T00:00:00Z", crossTenant: false },
        cursor: null,
        size: 50,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(AuditWindowTooWideError);
  });

  it("GET /api/admin/audit-events — 200 for platform_owner, 403 for org_owner, 400 on bad cursor", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/audit-events",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ rows: Array<unknown> }>().rows.length).toBe(3);

    // org_owner is NOT in AUDIT_READ_ROLES
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/audit-events",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("org_owner") },
    });
    expect(forbidden.statusCode).toBe(403);

    const badCursor = await app.inject({
      method: "GET",
      url: "/api/admin/audit-events?cursor=not-a-valid-cursor%21",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner") },
    });
    expect(badCursor.statusCode).toBe(400);
    await app.close();
  });
});
