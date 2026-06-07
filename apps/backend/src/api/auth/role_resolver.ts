// Role resolver — 1:1 port of codemaster/api/auth/role_resolver.py (F1 / Task 4).
//
// Resolves the role for a core.users user at session-issue time from core.role_grants. A user's role is the
// HIGHEST-precedence active grant where subject_kind='user', subject_id=user_id, AND (scope='platform' OR
// installation_id=user.installation_id). Cross-installation grants are NOT honored; platform-scope grants
// ARE honored regardless of the user's home installation.
//
// Fail-CLOSED contract: on DB error (timeout, connection loss, query failure) the Postgres resolver returns
// null — the caller maps null to a 403. A transient DB hiccup denies ONE login, it does not 500 the auth path.
//
// FAITHFUL-PORT NOTE: like the frozen Python, the query does NOT filter `revoked_at IS NULL` — revocation is
// not honored at resolve time in either implementation. Matching the frozen behavior is intentional; a
// revocation-honoring change would be a separate, parity-breaking decision.

import { type Kysely, sql } from "kysely";

import { type Role, rolePrecedence } from "#backend/api/auth/roles.js";

/** The resolver port both adapters satisfy. */
export type RoleResolver = {
  /** Highest-precedence role for this user in their installation (or platform-scope), or null if no active
   *  grant exists (or on DB error — fail-closed). */
  resolve(args: { userId: string; installationId: string }): Promise<Role | null>;
};

/** Pick the highest-precedence role (lowest precedence number) from candidates, or null when empty. */
function highestPrecedence(candidates: ReadonlyArray<Role>): Role | null {
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((a, b) => (rolePrecedence(a) <= rolePrecedence(b) ? a : b));
}

/** A single role grant for the in-memory resolver. `installationId` is null for platform-scope grants. */
export type RoleGrant = {
  userId: string;
  installationId: string | null;
  scope: "platform" | "installation";
  role: Role;
};

/** Test-only resolver backed by an in-memory grant list. */
export class InMemoryRoleResolver implements RoleResolver {
  readonly #grants: ReadonlyArray<RoleGrant>;

  public constructor(grants: ReadonlyArray<RoleGrant>) {
    this.#grants = grants;
  }

  public async resolve(args: { userId: string; installationId: string }): Promise<Role | null> {
    const candidates: Array<Role> = [];
    for (const g of this.#grants) {
      if (g.userId !== args.userId) {
        continue;
      }
      if (g.scope === "platform") {
        candidates.push(g.role);
      } else if (g.scope === "installation" && g.installationId === args.installationId) {
        candidates.push(g.role);
      }
      // any other scope value / cross-installation grant: ignored.
    }
    return highestPrecedence(candidates);
  }
}

/** Production resolver. Queries core.role_grants; fails CLOSED (returns null) on any DB error. */
export class PostgresRoleResolver implements RoleResolver {
  readonly #db: Kysely<unknown>;

  public constructor(args: { db: Kysely<unknown> }) {
    this.#db = args.db;
  }

  public async resolve(args: { userId: string; installationId: string }): Promise<Role | null> {
    let roles: Array<Role>;
    try {
      const r = await sql<{ role: Role }>`
        SELECT role FROM core.role_grants
        WHERE subject_kind = 'user'
          AND subject_id = ${args.userId}
          AND (scope = 'platform' OR (scope = 'installation' AND installation_id = ${args.installationId}))
      `.execute(this.#db);
      roles = r.rows.map((row) => row.role);
    } catch (exc) {
      // fail-closed: deny this one login, do not crash the auth path.
      console.warn(
        JSON.stringify({
          event: "role_resolver_db_error",
          user_id: args.userId,
          installation_id: args.installationId,
          error_class: exc instanceof Error ? exc.constructor.name : typeof exc,
        }),
      );
      return null;
    }
    return highestPrecedence(roles);
  }
}
