/**
 * Integration test for PostgresLocalUserRepo against a DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays green without a DB.
 *
 * core.local_users ALREADY EXISTS in the squashed baseline. The suite wipes core.local_users between tests
 * so the "disable the LAST active super-admin" assertion has a deterministic global count (the table is the
 * auth-bootstrap surface; no other integration suite touches it).
 *
 * Coverage:
 *   - insert → getByUsername round-trips every field; the email decrypts back from the AAD-bound
 *     email_ciphertext envelope; email_fingerprint is the SHA-256 of the lowercased email.
 *   - recordLoginAttempt: 5th consecutive failure flips locked (returns true) + stamps locked_until; success
 *     clears the counter + lockout + stamps last_login_at.
 *   - disable refuses the LAST active super-admin; updatePassword on an unknown id raises NotFound.
 */

import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

import { emailFingerprint } from "#backend/api/auth/email_codec.js";
import {
  LastSuperAdminError,
  type LocalUser,
  LocalUserNotFoundError,
  PostgresLocalUserRepo,
} from "#backend/api/auth/local_user_repo.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

let pool: Pool;
let db: Kysely<unknown>;
let registry: KeyRegistry;

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  registry = new KeyRegistry();
  registry.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(9)]]) }));
  await sql`DELETE FROM core.local_users`.execute(db);
});

afterEach(async () => {
  if (!INTEGRATION_DSN) return;
  await sql`DELETE FROM core.local_users`.execute(db);
});

afterAll(async () => {
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

function makeUser(over: Partial<LocalUser> = {}): LocalUser {
  const n = counter;
  const now = new Date("2026-06-07T12:00:00.000Z");
  return {
    user_id: over.user_id ?? newUuid(),
    username: over.username ?? `itest-admin-${n}-${randomInt(0, 1 << 20)}`,
    email: over.email ?? `itest-admin-${n}-${randomInt(0, 1 << 20)}@codemaster.internal`,
    full_name: over.full_name ?? "Integration Admin",
    password_hash: over.password_hash ?? "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
    role: "super_admin",
    state: over.state ?? "active",
    last_password_change: over.last_password_change ?? now,
    last_login_at: over.last_login_at ?? null,
    failed_attempts: over.failed_attempts ?? 0,
    locked_until: over.locked_until ?? null,
    created_at: over.created_at ?? now,
    created_by_user_id: over.created_by_user_id ?? null,
  };
}

describeDb("PostgresLocalUserRepo (disposable :5434)", () => {
  it("insert → getByUsername round-trips; email is encrypted + fingerprinted at rest", async () => {
    const repo = new PostgresLocalUserRepo({ db, registry });
    const u = makeUser({ email: "Round.Trip@Example.com" });
    await repo.insert(u);

    const fetched = await repo.getByUsername({ username: u.username });
    expect(fetched).not.toBeNull();
    expect(fetched?.email).toBe("Round.Trip@Example.com"); // decrypts back to plaintext
    expect(fetched?.user_id).toBe(u.user_id);
    expect(fetched?.role).toBe("super_admin");

    // At rest: ciphertext is an AAD-bound envelope (not plaintext); fingerprint is sha256(lowercase).
    const raw = await sql<{ email_ciphertext: string; email_fingerprint: string }>`
      SELECT email_ciphertext, email_fingerprint FROM core.local_users WHERE user_id = ${u.user_id}
    `.execute(db);
    expect(raw.rows[0]?.email_ciphertext.startsWith("kms2:")).toBe(true);
    expect(raw.rows[0]?.email_ciphertext).not.toContain("Round.Trip");
    expect(raw.rows[0]?.email_fingerprint).toBe(emailFingerprint("Round.Trip@Example.com"));
  });

  it("recordLoginAttempt locks on the 5th failure (atomic UPDATE), success clears it", async () => {
    const repo = new PostgresLocalUserRepo({ db, registry });
    const u = makeUser();
    await repo.insert(u);
    const now = new Date("2026-06-07T12:00:00.000Z");

    for (let i = 1; i <= 4; i++) {
      expect(await repo.recordLoginAttempt({ userId: u.user_id, success: false, now })).toBe(false);
    }
    expect(await repo.recordLoginAttempt({ userId: u.user_id, success: false, now })).toBe(true);

    const locked = await repo.getById({ userId: u.user_id });
    expect(locked?.failed_attempts).toBe(5);
    expect(locked?.locked_until?.getTime()).toBe(now.getTime() + 15 * 60 * 1000);

    await repo.recordLoginAttempt({ userId: u.user_id, success: true, now });
    const cleared = await repo.getById({ userId: u.user_id });
    expect(cleared?.failed_attempts).toBe(0);
    expect(cleared?.locked_until).toBeNull();
    expect(cleared?.last_login_at?.getTime()).toBe(now.getTime());
  });

  it("refuses to disable the LAST active super-admin; allows it when another is active", async () => {
    const repo = new PostgresLocalUserRepo({ db, registry });
    const a = makeUser();
    const b = makeUser();
    await repo.insert(a);
    await repo.insert(b);

    await repo.disable({ userId: a.user_id, by: b.user_id }); // ok — b still active
    await expect(repo.disable({ userId: b.user_id, by: a.user_id })).rejects.toBeInstanceOf(
      LastSuperAdminError,
    );
    expect(await repo.listActiveSuperAdmins()).toHaveLength(1);
  });

  it("updatePassword on an unknown id raises NotFound", async () => {
    const repo = new PostgresLocalUserRepo({ db, registry });
    await expect(
      repo.updatePassword({ userId: newUuid(), newHash: "$argon2id$x", now: new Date() }),
    ).rejects.toBeInstanceOf(LocalUserNotFoundError);
  });
});
