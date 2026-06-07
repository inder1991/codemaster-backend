// Local-user repo — 1:1 port of codemaster/api/auth/local_user_repo.py +
// codemaster/api/auth/postgres_local_user_repo.py (Sprint 20 / S17.AUTH.1).
//
// Persistence for core.local_users (the super_admin bootstrap accounts). INTENTIONALLY tenant-AGNOSTIC:
// local super-admin auth crosses installation boundaries by design, so the table carries no
// installation_id and the tenancy gate does not apply.
//
// LocalUser (the value object here) is the boundary shape carried across the port; the DB stores email
// encrypted (email_ciphertext, AAD-bound) + fingerprinted (email_fingerprint, SHA-256 of lowercase) for
// UNIQUE-by-email lookup without exposing plaintext at the index. The lockout state machine is the shared
// credential_lockout primitive (one place to be correct).

import { type Kysely, sql, type Transaction } from "kysely";

import type { KeyRegistry } from "#platform/crypto/key_registry.js";

import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_THRESHOLD,
  type LockoutState,
  applyAttempt,
  isLocked,
} from "#backend/api/auth/credential_lockout.js";
import {
  LOCAL_USER_EMAIL_AAD,
  decryptEmail,
  emailFingerprint,
  encryptEmail,
} from "#backend/api/auth/email_codec.js";

/** The boundary value object for a core.local_users row (plaintext email; storage encrypts it). */
export type LocalUser = {
  user_id: string;
  username: string;
  email: string;
  full_name: string;
  password_hash: string;
  role: "super_admin";
  state: "active" | "disabled";
  last_password_change: Date;
  last_login_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
  created_at: Date;
  created_by_user_id: string | null;
};

/** Refused: the last active super-admin cannot be disabled. */
export class LastSuperAdminError extends Error {
  public constructor(message = "cannot disable the last active super-admin") {
    super(message);
    this.name = "LastSuperAdminError";
  }
}

export class LocalUserNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LocalUserNotFoundError";
  }
}

/** Same-transaction audit emit hook — invoked with the open executor BEFORE commit so a raising callback
 *  rolls back the user-state mutation atomically (F1/R8 same-TX contract). */
export type AuditCallback = (executor: Kysely<unknown> | Transaction<unknown>) => Promise<void>;

/** The persistence port both adapters satisfy (structural). */
export type LocalUserRepo = {
  getByUsername(args: { username: string }): Promise<LocalUser | null>;
  getById(args: { userId: string }): Promise<LocalUser | null>;
  insert(user: LocalUser): Promise<void>;
  updatePassword(args: { userId: string; newHash: string; now: Date }): Promise<void>;
  recordLoginAttempt(args: {
    userId: string;
    success: boolean;
    now: Date;
    auditCallback?: AuditCallback;
  }): Promise<boolean>;
  disable(args: { userId: string; by: string }): Promise<void>;
  listActiveSuperAdmins(): Promise<ReadonlyArray<LocalUser>>;
};

/** True iff `user.locked_until > now` (lockout active). Thin wrapper around the shared primitive. */
export function isLockedNow(user: LocalUser, now: Date): boolean {
  return isLocked(user.locked_until, now);
}

// ─── In-memory adapter (test-only; mirrors the Python carve-out) ──────────────────────────────────

/** Test-only impl backed by a Map. Synchronous mutations are atomic on the single-threaded event loop. */
export class InMemoryLocalUserRepo implements LocalUserRepo {
  readonly #rows = new Map<string, LocalUser>();

  public async getByUsername(args: { username: string }): Promise<LocalUser | null> {
    for (const u of this.#rows.values()) {
      if (u.username === args.username) {
        return u;
      }
    }
    return null;
  }

  public async getById(args: { userId: string }): Promise<LocalUser | null> {
    return this.#rows.get(args.userId) ?? null;
  }

  public async insert(user: LocalUser): Promise<void> {
    for (const existing of this.#rows.values()) {
      if (existing.username === user.username) {
        throw new Error(`username '${user.username}' already exists`);
      }
    }
    this.#rows.set(user.user_id, { ...user });
  }

  public async updatePassword(args: {
    userId: string;
    newHash: string;
    now: Date;
  }): Promise<void> {
    const user = this.#rows.get(args.userId);
    if (user === undefined) {
      throw new LocalUserNotFoundError(args.userId);
    }
    this.#rows.set(args.userId, {
      ...user,
      password_hash: args.newHash,
      last_password_change: args.now,
    });
  }

  // The InMemory adapter has no session/transaction concept, so it ignores auditCallback (its same-TX
  // semantics are vacuous) — matching the Python `# noqa: ARG002` Protocol-parity carve-out.
  public async recordLoginAttempt(args: {
    userId: string;
    success: boolean;
    now: Date;
    auditCallback?: AuditCallback;
  }): Promise<boolean> {
    const user = this.#rows.get(args.userId);
    if (user === undefined) {
      throw new LocalUserNotFoundError(args.userId);
    }
    const current: LockoutState = {
      failed_attempts: user.failed_attempts,
      locked_until: user.locked_until,
      last_login_at: user.last_login_at,
    };
    const next = applyAttempt(current, { success: args.success, now: args.now });
    this.#rows.set(args.userId, {
      ...user,
      failed_attempts: next.failed_attempts,
      locked_until: next.locked_until,
      last_login_at: next.last_login_at,
    });
    return next.failed_attempts >= LOCKOUT_THRESHOLD;
  }

  public async disable(args: { userId: string; by: string }): Promise<void> {
    void args.by; // captured for audit symmetry with the Postgres adapter; not stored at this layer.
    const user = this.#rows.get(args.userId);
    if (user === undefined) {
      throw new LocalUserNotFoundError(args.userId);
    }
    const active = [...this.#rows.values()].filter(
      (u) => u.state === "active" && u.role === "super_admin",
    );
    if (user.state === "active" && active.length <= 1) {
      throw new LastSuperAdminError();
    }
    this.#rows.set(args.userId, { ...user, state: "disabled" });
  }

  public async listActiveSuperAdmins(): Promise<ReadonlyArray<LocalUser>> {
    return [...this.#rows.values()].filter((u) => u.state === "active" && u.role === "super_admin");
  }

  /** Test helper. */
  public allRows(): ReadonlyArray<LocalUser> {
    return [...this.#rows.values()];
  }
}

// ─── Postgres adapter ─────────────────────────────────────────────────────────────────────────────

type LocalUserRow = {
  user_id: string;
  username: string;
  email_ciphertext: string;
  full_name: string;
  password_hash: string;
  role: "super_admin";
  state: "active" | "disabled";
  last_password_change: Date;
  last_login_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
  created_at: Date;
  created_by_user_id: string | null;
};

/** Production adapter against core.local_users. Holds a Kysely handle + the field-encryption registry
 *  (used to encrypt/decrypt the email_ciphertext column under the per-column AAD). */
export class PostgresLocalUserRepo implements LocalUserRepo {
  readonly #db: Kysely<unknown>;
  readonly #registry: KeyRegistry;

  public constructor(args: { db: Kysely<unknown>; registry: KeyRegistry }) {
    this.#db = args.db;
    this.#registry = args.registry;
  }

  #rowToValue(row: LocalUserRow): LocalUser {
    return {
      user_id: row.user_id,
      username: row.username,
      email: decryptEmail(row.email_ciphertext, this.#registry, LOCAL_USER_EMAIL_AAD),
      full_name: row.full_name,
      password_hash: row.password_hash,
      role: row.role,
      state: row.state,
      last_password_change: row.last_password_change,
      last_login_at: row.last_login_at,
      failed_attempts: row.failed_attempts,
      locked_until: row.locked_until,
      created_at: row.created_at,
      created_by_user_id: row.created_by_user_id,
    };
  }

  public async getByUsername(args: { username: string }): Promise<LocalUser | null> {
    const r = await sql<LocalUserRow>`
      SELECT user_id, username, email_ciphertext, full_name, password_hash, role, state,
             last_password_change, last_login_at, failed_attempts, locked_until,
             created_at, created_by_user_id
      FROM core.local_users WHERE username = ${args.username}
    `.execute(this.#db);
    const row = r.rows[0];
    return row === undefined ? null : this.#rowToValue(row);
  }

  public async getById(args: { userId: string }): Promise<LocalUser | null> {
    const r = await sql<LocalUserRow>`
      SELECT user_id, username, email_ciphertext, full_name, password_hash, role, state,
             last_password_change, last_login_at, failed_attempts, locked_until,
             created_at, created_by_user_id
      FROM core.local_users WHERE user_id = ${args.userId}
    `.execute(this.#db);
    const row = r.rows[0];
    return row === undefined ? null : this.#rowToValue(row);
  }

  public async insert(user: LocalUser): Promise<void> {
    await sql`
      INSERT INTO core.local_users
        (user_id, username, email_ciphertext, email_fingerprint, full_name, password_hash, role, state,
         last_password_change, last_login_at, failed_attempts, locked_until, created_at, created_by_user_id)
      VALUES
        (${user.user_id}, ${user.username}, ${encryptEmail(user.email, this.#registry, LOCAL_USER_EMAIL_AAD)},
         ${emailFingerprint(user.email)}, ${user.full_name}, ${user.password_hash}, ${user.role}, ${user.state},
         ${user.last_password_change}, ${user.last_login_at}, ${user.failed_attempts}, ${user.locked_until},
         ${user.created_at}, ${user.created_by_user_id})
    `.execute(this.#db);
  }

  public async updatePassword(args: {
    userId: string;
    newHash: string;
    now: Date;
  }): Promise<void> {
    const r = await sql`
      UPDATE core.local_users SET password_hash = ${args.newHash}, last_password_change = ${args.now}
      WHERE user_id = ${args.userId}
    `.execute(this.#db);
    if ((r.numAffectedRows ?? 0n) === 0n) {
      throw new LocalUserNotFoundError(args.userId);
    }
  }

  public async recordLoginAttempt(args: {
    userId: string;
    success: boolean;
    now: Date;
    auditCallback?: AuditCallback;
  }): Promise<boolean> {
    // Atomic UPDATE ... RETURNING inside a transaction. The audit callback (when supplied) fires AFTER
    // the UPDATE and BEFORE commit, so a raising callback rolls back the counter mutation too.
    return this.#db.transaction().execute(async (tx) => {
      let row: { failed_attempts: number } | undefined;
      if (args.success) {
        const r = await sql<{ failed_attempts: number; locked_until: Date | null }>`
          UPDATE core.local_users
          SET failed_attempts = 0, locked_until = NULL, last_login_at = ${args.now}
          WHERE user_id = ${args.userId}
          RETURNING failed_attempts, locked_until
        `.execute(tx);
        row = r.rows[0];
      } else {
        // Lockout window kicks in ONLY on the exact transition to threshold (= not >=) so a spammer
        // can't keep re-extending locked_until forever.
        const lockoutAt = new Date(args.now.getTime() + LOCKOUT_DURATION_MS);
        const r = await sql<{ failed_attempts: number; locked_until: Date | null }>`
          UPDATE core.local_users
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 = ${LOCKOUT_THRESHOLD} THEN ${lockoutAt}
                                  ELSE locked_until END
          WHERE user_id = ${args.userId}
          RETURNING failed_attempts, locked_until
        `.execute(tx);
        row = r.rows[0];
      }
      if (row === undefined) {
        throw new LocalUserNotFoundError(args.userId);
      }
      if (args.auditCallback !== undefined) {
        await args.auditCallback(tx);
      }
      return row.failed_attempts >= LOCKOUT_THRESHOLD;
    });
  }

  public async disable(args: { userId: string; by: string }): Promise<void> {
    void args.by; // audit symmetry; not stored at this layer (audit emit lives on the calling route).
    await this.#db.transaction().execute(async (tx) => {
      const target = await sql<{ state: "active" | "disabled" }>`
        SELECT state FROM core.local_users WHERE user_id = ${args.userId}
      `.execute(tx);
      const targetRow = target.rows[0];
      if (targetRow === undefined) {
        throw new LocalUserNotFoundError(args.userId);
      }
      const countRes = await sql<{ n: string }>`
        SELECT COUNT(*) AS n FROM core.local_users WHERE state = 'active' AND role = 'super_admin'
      `.execute(tx);
      const activeCount = Number(countRes.rows[0]?.n ?? "0");
      if (targetRow.state === "active" && activeCount <= 1) {
        throw new LastSuperAdminError();
      }
      await sql`
        UPDATE core.local_users SET state = 'disabled' WHERE user_id = ${args.userId}
      `.execute(tx);
    });
  }

  public async listActiveSuperAdmins(): Promise<ReadonlyArray<LocalUser>> {
    const r = await sql<LocalUserRow>`
      SELECT user_id, username, email_ciphertext, full_name, password_hash, role, state,
             last_password_change, last_login_at, failed_attempts, locked_until,
             created_at, created_by_user_id
      FROM core.local_users WHERE state = 'active' AND role = 'super_admin'
    `.execute(this.#db);
    return r.rows.map((row) => this.#rowToValue(row));
  }
}
