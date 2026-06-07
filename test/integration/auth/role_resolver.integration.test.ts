/**
 * Integration test for PostgresRoleResolver against the DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise.
 *
 * core.role_grants ALREADY EXISTS in the squashed baseline (role CHECK ∈ {platform_owner, platform_operator,
 * reader}; biconditional scope↔installation_id CHECK). Each test seeds grants for a UNIQUE subject_id and
 * cleans up by subject_id so rows never collide.
 *
 * Coverage:
 *   - platform-scope grant honored for any installation; installation-scope honored only for its own
 *     installation; highest precedence wins.
 *   - no grants → null.
 *   - fail-CLOSED: a destroyed connection pool surfaces as null, not a throw.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { PostgresRoleResolver } from "#backend/api/auth/role_resolver.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;
let db: Kysely<unknown>;

const USER = "11111111-2222-3333-4444-555566667777";
const INSTALL_A = "aaaaaaaa-1111-2222-3333-444444444444";
const INSTALL_B = "bbbbbbbb-1111-2222-3333-444444444444";

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  // installation-scope grants FK to core.installations — seed INSTALL_A. github_installation_id is a
  // high constant unlikely to collide on the disposable DB.
  await sql`
    INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
    VALUES (${INSTALL_A}, 920000001, 'itest-role-resolver-org', 'Organization')
    ON CONFLICT (installation_id) DO NOTHING
  `.execute(db);
});

afterEach(async () => {
  if (!INTEGRATION_DSN) return;
  await sql`DELETE FROM core.role_grants WHERE subject_id = ${USER}`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.role_grants WHERE subject_id = ${USER}`.execute(db);
    await sql`DELETE FROM core.installations WHERE installation_id = ${INSTALL_A}`.execute(db);
  }
  await db?.destroy();
});

async function grant(
  scope: "platform" | "installation",
  role: string,
  installationId: string | null,
): Promise<void> {
  await sql`
    INSERT INTO core.role_grants (installation_id, subject_kind, subject_id, role, scope)
    VALUES (${installationId}, 'user', ${USER}, ${role}, ${scope})
  `.execute(db);
}

describeDb("PostgresRoleResolver (disposable :5434)", () => {
  it("returns the highest-precedence role across platform + installation grants", async () => {
    await grant("installation", "reader", INSTALL_A);
    await grant("platform", "platform_operator", null);
    await grant("platform", "platform_owner", null);
    const r = new PostgresRoleResolver({ db });
    expect(await r.resolve({ userId: USER, installationId: INSTALL_A })).toBe("platform_owner");
  });

  it("does not honor an installation-scope grant for a different installation", async () => {
    await grant("installation", "reader", INSTALL_A);
    const r = new PostgresRoleResolver({ db });
    expect(await r.resolve({ userId: USER, installationId: INSTALL_A })).toBe("reader");
    expect(await r.resolve({ userId: USER, installationId: INSTALL_B })).toBeNull();
  });

  it("returns null when the user has no grants", async () => {
    const r = new PostgresRoleResolver({ db });
    expect(await r.resolve({ userId: USER, installationId: INSTALL_A })).toBeNull();
  });

  it("fails CLOSED (returns null, does not throw) on a DB error", async () => {
    const deadPool = new Pool({ connectionString: INTEGRATION_DSN, max: 1 });
    const deadDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: deadPool }) });
    await deadDb.destroy(); // force every subsequent query to error
    const r = new PostgresRoleResolver({ db: deadDb });
    expect(await r.resolve({ userId: USER, installationId: INSTALL_A })).toBeNull();
  });
});
