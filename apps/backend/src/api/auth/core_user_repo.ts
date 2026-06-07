// Core-user repo — 1:1 port of codemaster/api/auth/core_user_repo.py +
// codemaster/api/auth/postgres_core_user_repo.py (F1 / Task 3).
//
// Persistence for core.users rows WITH local credentials (password_hash IS NOT NULL) — the companion to
// LocalUserRepo (super_admin in core.local_users). LDAP-bound rows (password_hash IS NULL) are NOT served
// here: every read filters `password_hash IS NOT NULL`. core.users IS tenant-scoped (installation_id NOT
// NULL) but reads are by username/user_id (the partial unique index uq_core_users_username_local is GLOBAL),
// so the raw-SQL tenancy gate WARNs — faithful to the frozen Python.
//
// `role` and `state` are NOT columns on core.users: roles come from core.role_grants at session-issue time
// (see role_resolver), and disabling a user = revoking their grants. The lockout state machine is the SHARED
// credential_lockout primitive (one place to be correct). email is encrypted under the core.users.email AAD.
//
// In production this path is gated behind ENABLE_CORE_USERS_LOCAL_AUTH (the gate lives in the login dispatch,
// Stage 3/4) — the repo itself is just persistence.

import { type Kysely, sql } from "kysely";

import type { KeyRegistry } from "#platform/crypto/key_registry.js";

import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_THRESHOLD,
  type LockoutState,
  applyAttempt,
  isLocked,
} from "#backend/api/auth/credential_lockout.js";
import {
  CORE_USER_EMAIL_AAD,
  decryptEmail,
  encryptEmail,
} from "#backend/api/auth/email_codec.js";

/** A core.users row WITH local credentials (plaintext email; storage encrypts it). */
export type CoreLocalCredentialedUser = {
  user_id: string;
  installation_id: string;
  username: string;
  email: string;
  display_name: string;
  password_hash: string;
  password_changed_at: Date;
  last_login_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
};

export class CoreUserNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CoreUserNotFoundError";
  }
}

/** Same-transaction audit emit hook (re-exported shape; see local_user_repo.AuditCallback). */
export type AuditCallback = (executor: Kysely<unknown>) => Promise<void>;

export type CoreUserRepo = {
  getByUsername(args: { username: string }): Promise<CoreLocalCredentialedUser | null>;
  getById(args: { userId: string }): Promise<CoreLocalCredentialedUser | null>;
  insert(user: CoreLocalCredentialedUser): Promise<void>;
  updatePassword(args: { userId: string; newHash: string; now: Date }): Promise<void>;
  recordLoginAttempt(args: {
    userId: string;
    success: boolean;
    now: Date;
    auditCallback?: AuditCallback;
  }): Promise<boolean>;
};

/** True iff `user.locked_until > now` (lockout window active). */
export function isLockedNow(user: CoreLocalCredentialedUser, now: Date): boolean {
  return isLocked(user.locked_until, now);
}

// ─── In-memory adapter (test-only) ────────────────────────────────────────────────────────────────

/** Test-only impl. Enforces the GLOBAL local-username uniqueness (mirrors uq_core_users_username_local). */
export class InMemoryCoreUserRepo implements CoreUserRepo {
  readonly #rows = new Map<string, CoreLocalCredentialedUser>();

  public async getByUsername(args: {
    username: string;
  }): Promise<CoreLocalCredentialedUser | null> {
    for (const u of this.#rows.values()) {
      if (u.username === args.username) {
        return u;
      }
    }
    return null;
  }

  public async getById(args: { userId: string }): Promise<CoreLocalCredentialedUser | null> {
    return this.#rows.get(args.userId) ?? null;
  }

  public async insert(user: CoreLocalCredentialedUser): Promise<void> {
    for (const existing of this.#rows.values()) {
      if (existing.username === user.username) {
        throw new Error(
          `username '${user.username}' already exists (local-credentialed; partial unique index ` +
            `uq_core_users_username_local)`,
        );
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
      throw new CoreUserNotFoundError(args.userId);
    }
    this.#rows.set(args.userId, {
      ...user,
      password_hash: args.newHash,
      password_changed_at: args.now,
    });
  }

  // InMemory ignores auditCallback (no session/transaction concept) — Protocol-parity carve-out.
  public async recordLoginAttempt(args: {
    userId: string;
    success: boolean;
    now: Date;
    auditCallback?: AuditCallback;
  }): Promise<boolean> {
    const user = this.#rows.get(args.userId);
    if (user === undefined) {
      throw new CoreUserNotFoundError(args.userId);
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

  /** Test helper. */
  public allRows(): ReadonlyArray<CoreLocalCredentialedUser> {
    return [...this.#rows.values()];
  }
}

// ─── Postgres adapter ─────────────────────────────────────────────────────────────────────────────

type CoreUserRow = {
  user_id: string;
  installation_id: string;
  username: string;
  email: string;
  display_name: string;
  password_hash: string;
  password_changed_at: Date;
  last_login_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
};

export class PostgresCoreUserRepo implements CoreUserRepo {
  readonly #db: Kysely<unknown>;
  readonly #registry: KeyRegistry;

  public constructor(args: { db: Kysely<unknown>; registry: KeyRegistry }) {
    this.#db = args.db;
    this.#registry = args.registry;
  }

  #rowToValue(row: CoreUserRow): CoreLocalCredentialedUser {
    return {
      user_id: row.user_id,
      installation_id: row.installation_id,
      username: row.username,
      email: decryptEmail(row.email, this.#registry, CORE_USER_EMAIL_AAD),
      display_name: row.display_name,
      password_hash: row.password_hash,
      password_changed_at: row.password_changed_at,
      last_login_at: row.last_login_at,
      failed_attempts: row.failed_attempts,
      locked_until: row.locked_until,
    };
  }

  public async getByUsername(args: {
    username: string;
  }): Promise<CoreLocalCredentialedUser | null> {
    const r = await sql<CoreUserRow>`
      SELECT user_id, installation_id, username, email, display_name, password_hash,
             password_changed_at, last_login_at, failed_attempts, locked_until
      FROM core.users WHERE username = ${args.username} AND password_hash IS NOT NULL
    `.execute(this.#db);
    const row = r.rows[0];
    return row === undefined ? null : this.#rowToValue(row);
  }

  public async getById(args: { userId: string }): Promise<CoreLocalCredentialedUser | null> {
    const r = await sql<CoreUserRow>`
      SELECT user_id, installation_id, username, email, display_name, password_hash,
             password_changed_at, last_login_at, failed_attempts, locked_until
      FROM core.users WHERE user_id = ${args.userId} AND password_hash IS NOT NULL
    `.execute(this.#db);
    const row = r.rows[0];
    return row === undefined ? null : this.#rowToValue(row);
  }

  public async insert(user: CoreLocalCredentialedUser): Promise<void> {
    await sql`
      INSERT INTO core.users
        (user_id, installation_id, username, email, display_name, password_hash,
         password_changed_at, last_login_at, failed_attempts, locked_until)
      VALUES
        (${user.user_id}, ${user.installation_id}, ${user.username},
         ${encryptEmail(user.email, this.#registry, CORE_USER_EMAIL_AAD)}, ${user.display_name},
         ${user.password_hash}, ${user.password_changed_at}, ${user.last_login_at},
         ${user.failed_attempts}, ${user.locked_until})
    `.execute(this.#db);
  }

  // No `password_hash IS NOT NULL` filter (the H3 fix): this method must accept rows whose password_hash is
  // currently NULL so the "promote LDAP-bound user to local credentials" workflow works. The caller must
  // ensure username is set first, else the ck_core_users_credential_consistency CHECK rejects the UPDATE.
  public async updatePassword(args: {
    userId: string;
    newHash: string;
    now: Date;
  }): Promise<void> {
    const r = await sql`
      UPDATE core.users SET password_hash = ${args.newHash}, password_changed_at = ${args.now}
      WHERE user_id = ${args.userId}
    `.execute(this.#db);
    if ((r.numAffectedRows ?? 0n) === 0n) {
      throw new CoreUserNotFoundError(args.userId);
    }
  }

  public async recordLoginAttempt(args: {
    userId: string;
    success: boolean;
    now: Date;
    auditCallback?: AuditCallback;
  }): Promise<boolean> {
    return this.#db.transaction().execute(async (tx) => {
      let row: { failed_attempts: number } | undefined;
      if (args.success) {
        const r = await sql<{ failed_attempts: number }>`
          UPDATE core.users
          SET failed_attempts = 0, locked_until = NULL, last_login_at = ${args.now}
          WHERE user_id = ${args.userId} AND password_hash IS NOT NULL
          RETURNING failed_attempts
        `.execute(tx);
        row = r.rows[0];
      } else {
        const lockoutAt = new Date(args.now.getTime() + LOCKOUT_DURATION_MS);
        const r = await sql<{ failed_attempts: number; locked_until: Date | null }>`
          UPDATE core.users
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 = ${LOCKOUT_THRESHOLD} THEN ${lockoutAt}
                                  ELSE locked_until END
          WHERE user_id = ${args.userId} AND password_hash IS NOT NULL
          RETURNING failed_attempts, locked_until
        `.execute(tx);
        row = r.rows[0];
      }
      if (row === undefined) {
        throw new CoreUserNotFoundError(args.userId);
      }
      if (args.auditCallback !== undefined) {
        await args.auditCallback(tx);
      }
      return row.failed_attempts >= LOCKOUT_THRESHOLD;
    });
  }
}
