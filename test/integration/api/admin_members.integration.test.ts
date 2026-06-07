/**
 * Integration test for GET /api/admin/members + buildMembersPage against the DISPOSABLE Postgres
 * (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set; SKIPS else.
 *
 * Exercises the load-bearing port nuances:
 *   - JOIN core.users ON u.user_id (NOT u.id — Python's stale SQL would 500 against the real schema).
 *   - email DECRYPTED via the core.users.email AAD codec (column is ciphertext, not plaintext).
 *   - granted_by_user_id ALWAYS null (the production core.role_grants has no granter column).
 *   - platform rows (installation_id NULL) returned in every per-install view + the zero-UUID platform view.
 *   - route-layer tenancy guard: platform_owner cannot cross-tenant read; super_admin can.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { buildMembersPage } from "#backend/api/admin/members_read.js";
import { CORE_USER_EMAIL_AAD, encryptEmail } from "#backend/api/auth/email_codec.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import { SUPER_ADMIN_PLATFORM_VIEW_UUID } from "#backend/infra/sentinels.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INSTALL = "6a6a6a6a-1111-2222-3333-444444444444";
const OTHER = "6b6b6b6b-1111-2222-3333-444444444444";
const U_PLAT = "6c6c6c6c-1111-2222-3333-444444444444";
const U_INST = "6d6d6d6d-1111-2222-3333-444444444444";
const T1 = "2026-06-01T00:00:00Z"; // platform pending (older → sorts first)
const T2 = "2026-06-02T00:00:00Z"; // install pending

let pool: Pool;
let db: Kysely<unknown>;
let registry: KeyRegistry;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.role_grant_pending WHERE subject_id IN (${U_PLAT}, ${U_INST})`.execute(db);
  await sql`DELETE FROM core.role_grants WHERE subject_id IN (${U_PLAT}, ${U_INST})`.execute(db);
  await sql`DELETE FROM core.users WHERE user_id IN (${U_PLAT}, ${U_INST})`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id IN (${INSTALL}, ${OTHER})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  registry = new KeyRegistry();
  registry.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(5)]]) }));
  await cleanup();

  for (const [inst, gh] of [
    [INSTALL, 960000010],
    [OTHER, 960000020],
  ] as const) {
    await sql`INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
              VALUES (${inst}, ${gh}, ${"itest-mem-" + String(gh)}, 'Organization')`.execute(db);
  }
  // emails are stored ciphertext (core.users.email is application-encrypted, ADR-0033)
  const encAlice = encryptEmail("alice@example.com", registry, CORE_USER_EMAIL_AAD);
  const encBob = encryptEmail("bob@example.com", registry, CORE_USER_EMAIL_AAD);
  await sql`INSERT INTO core.users (user_id, installation_id, email, display_name)
            VALUES (${U_PLAT}, ${INSTALL}, ${encAlice}, 'Alice'),
                   (${U_INST}, ${INSTALL}, ${encBob}, 'Bob')`.execute(db);
  await sql`INSERT INTO core.role_grants (installation_id, subject_kind, subject_id, role, scope)
            VALUES (NULL, 'user', ${U_PLAT}, 'platform_owner', 'platform'),
                   (${INSTALL}, 'user', ${U_INST}, 'reader', 'installation')`.execute(db);
  await sql`INSERT INTO core.role_grant_pending
              (installation_id, subject_kind, subject_id, role, action, requested_at, requested_by_user_id, state, scope)
            VALUES (NULL, 'user', ${U_PLAT}, 'reader', 'grant', ${T1}, ${U_PLAT}, 'pending', 'platform'),
                   (${INSTALL}, 'user', ${U_INST}, 'platform_operator', 'grant', ${T2}, ${U_INST}, 'pending', 'installation')`.execute(
    db,
  );
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function mintCookie(role: Role, installationId: string | null): string {
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
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }), registry });
  await app.ready();
  return app;
}

describeDb("admin members (disposable :5434)", () => {
  it("buildMembersPage per-install: platform + install rows, decrypted email, null granter, sorted", async () => {
    const page = await buildMembersPage({ db, registry, installationId: INSTALL });
    expect(page.members.map((m) => m.display_name)).toEqual(["Alice", "Bob"]); // display_name ASC
    const alice = page.members[0]!;
    expect(alice.email).toBe("alice@example.com"); // DECRYPTED, not ciphertext
    expect(alice.role).toBe("platform_owner");
    expect(alice.scope).toBe("platform");
    expect(alice.granted_by_user_id).toBeNull(); // column absent in production schema → always null
    const bob = page.members[1]!;
    expect(bob.email).toBe("bob@example.com");
    expect(bob.role).toBe("reader");
    expect(bob.scope).toBe("installation");
    // pending: platform (T1) then install (T2), requested_at ASC
    expect(page.pending_changes.map((p) => p.scope)).toEqual(["platform", "installation"]);
    expect(page.pending_changes[0]!.role).toBe("reader");
    expect(page.pending_changes[1]!.role).toBe("platform_operator");
  });

  it("buildMembersPage platform view (zero-UUID): platform rows only", async () => {
    const page = await buildMembersPage({
      db,
      registry,
      installationId: SUPER_ADMIN_PLATFORM_VIEW_UUID,
    });
    expect(page.members.map((m) => m.user_id)).toEqual([U_PLAT]);
    expect(page.pending_changes.map((p) => p.scope)).toEqual(["platform"]);
  });

  it("route: platform_owner reads own install (200), cross-tenant install (403)", async () => {
    const app = await makeApp();
    const own = await app.inject({
      method: "GET",
      url: `/api/admin/members?installation_id=${INSTALL}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner", INSTALL) },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json<{ members: Array<unknown> }>().members).toHaveLength(2);
    const cross = await app.inject({
      method: "GET",
      url: `/api/admin/members?installation_id=${OTHER}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("platform_owner", INSTALL) },
    });
    expect(cross.statusCode).toBe(403);
    await app.close();
  });

  it("route: super_admin cross-tenant (200); reader (403); missing param (422)", async () => {
    const app = await makeApp();
    const sa = await app.inject({
      method: "GET",
      url: `/api/admin/members?installation_id=${INSTALL}`,
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("super_admin", null) },
    });
    expect(sa.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/members?installation_id=${INSTALL}`,
          cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader", INSTALL) },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/admin/members`,
          cookies: { [SESSION_COOKIE_NAME]: mintCookie("super_admin", null) },
        })
      ).statusCode,
    ).toBe(422);
    await app.close();
  });
});
