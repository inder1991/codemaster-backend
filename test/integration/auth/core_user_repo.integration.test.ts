/**
 * Integration test for PostgresCoreUserRepo against the DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise.
 *
 * core.users ALREADY EXISTS in the squashed baseline (installation_id FK to core.installations; the
 * ck_core_users_credential_consistency CHECK; the partial unique index on local-credentialed usernames).
 * The suite seeds a single installations row, inserts users under it, and cleans up by installation_id.
 *
 * Coverage:
 *   - insert → getByUsername / getById round-trip; email is encrypted at rest + decrypts back.
 *   - an LDAP-bound row (password_hash IS NULL) is EXCLUDED from every read.
 *   - recordLoginAttempt locks on the 5th failure (atomic UPDATE); success clears it.
 *   - updatePassword rotates the hash.
 */

import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import {
  type CoreLocalCredentialedUser,
  PostgresCoreUserRepo,
} from "#backend/api/auth/core_user_repo.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;
let db: Kysely<unknown>;
let registry: KeyRegistry;

const INSTALL = "cccccccc-1111-2222-3333-444444444444";

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  registry = new KeyRegistry();
  registry.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(5)]]) }));
  await sql`
    INSERT INTO core.installations (installation_id, github_installation_id, account_login, account_type)
    VALUES (${INSTALL}, 920000002, 'itest-core-user-org', 'Organization')
    ON CONFLICT (installation_id) DO NOTHING
  `.execute(db);
  await sql`DELETE FROM core.users WHERE installation_id = ${INSTALL}`.execute(db);
});

afterEach(async () => {
  if (!INTEGRATION_DSN) return;
  await sql`DELETE FROM core.users WHERE installation_id = ${INSTALL}`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.users WHERE installation_id = ${INSTALL}`.execute(db);
    await sql`DELETE FROM core.installations WHERE installation_id = ${INSTALL}`.execute(db);
  }
  await db?.destroy();
});

let counter = 0;
function newUuid(): string {
  const h = createHash("sha1")
    .update(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}-${counter++}`)
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hx = b.toString("hex");
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20, 32)}`;
}

function makeUser(over: Partial<CoreLocalCredentialedUser> = {}): CoreLocalCredentialedUser {
  const now = new Date("2026-06-07T12:00:00.000Z");
  return {
    user_id: over.user_id ?? newUuid(),
    installation_id: INSTALL,
    username: over.username ?? `itest-core-${randomInt(0, 1 << 20)}`,
    email: over.email ?? `itest-core-${randomInt(0, 1 << 20)}@org.com`,
    display_name: over.display_name ?? "Core User",
    password_hash: over.password_hash ?? "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
    password_changed_at: over.password_changed_at ?? now,
    last_login_at: over.last_login_at ?? null,
    failed_attempts: over.failed_attempts ?? 0,
    locked_until: over.locked_until ?? null,
  };
}

describeDb("PostgresCoreUserRepo (disposable :5434)", () => {
  it("insert → getByUsername/getById round-trip; email encrypted at rest", async () => {
    const repo = new PostgresCoreUserRepo({ db, registry });
    const u = makeUser({ email: "Core.User@Org.com" });
    await repo.insert(u);

    const fetched = await repo.getByUsername({ username: u.username });
    expect(fetched?.email).toBe("Core.User@Org.com");
    expect(fetched?.user_id).toBe(u.user_id);
    expect((await repo.getById({ userId: u.user_id }))?.username).toBe(u.username);

    const raw = await sql<{ email: string }>`
      SELECT email FROM core.users WHERE user_id = ${u.user_id}
    `.execute(db);
    expect(raw.rows[0]?.email.startsWith("kms2:")).toBe(true);
    expect(raw.rows[0]?.email).not.toContain("Core.User");
  });

  it("EXCLUDES an LDAP-bound row (password_hash IS NULL) from reads", async () => {
    const ldapId = newUuid();
    const ldapUsername = `itest-ldap-${randomInt(0, 1 << 20)}`;
    // Direct insert: an LDAP row has all-NULL credential triple (the consistency CHECK's first branch).
    await sql`
      INSERT INTO core.users (user_id, installation_id, username, email, display_name)
      VALUES (${ldapId}, ${INSTALL}, ${ldapUsername}, 'ldap-placeholder-not-decrypted', 'LDAP User')
    `.execute(db);
    const repo = new PostgresCoreUserRepo({ db, registry });
    expect(await repo.getByUsername({ username: ldapUsername })).toBeNull();
    expect(await repo.getById({ userId: ldapId })).toBeNull();
  });

  it("recordLoginAttempt locks on the 5th failure; success clears it", async () => {
    const repo = new PostgresCoreUserRepo({ db, registry });
    const u = makeUser();
    await repo.insert(u);
    const now = new Date("2026-06-07T12:00:00.000Z");
    for (let i = 1; i <= 4; i++) {
      expect(await repo.recordLoginAttempt({ userId: u.user_id, success: false, now })).toBe(false);
    }
    expect(await repo.recordLoginAttempt({ userId: u.user_id, success: false, now })).toBe(true);
    const locked = await repo.getById({ userId: u.user_id });
    expect(locked?.locked_until?.getTime()).toBe(now.getTime() + 15 * 60 * 1000);

    await repo.recordLoginAttempt({ userId: u.user_id, success: true, now });
    const cleared = await repo.getById({ userId: u.user_id });
    expect(cleared?.failed_attempts).toBe(0);
    expect(cleared?.locked_until).toBeNull();
    expect(cleared?.last_login_at?.getTime()).toBe(now.getTime());
  });

  it("updatePassword rotates the hash", async () => {
    const repo = new PostgresCoreUserRepo({ db, registry });
    const u = makeUser();
    await repo.insert(u);
    await repo.updatePassword({
      userId: u.user_id,
      newHash: "$argon2id$rotated",
      now: new Date("2026-06-08T00:00:00Z"),
    });
    expect((await repo.getById({ userId: u.user_id }))?.password_hash).toBe("$argon2id$rotated");
  });
});
