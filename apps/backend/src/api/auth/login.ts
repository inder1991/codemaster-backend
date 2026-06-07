// Login dispatch — 1:1 port of codemaster/api/auth/login.py (Sprint 12 / S14.A).
//
// Three-stage dispatch: core.local_users → core.users → LDAP. The LOCKED precedence invariant: if a username
// exists in a tier, that tier OWNS the auth — we do NOT fall through to a lower tier on password mismatch
// (a super_admin whose corporate username also exists in LDAP must NEVER accidentally authenticate via LDAP).
//
// Single-factor (username + password); TOTP/2FA removed per project-owner direction (S14.A). Compensating
// controls: Argon2id + lockout-after-5-failures (each repo's recordLoginAttempt) + the rate-limit middleware
// above this layer. Lockout + audit are handled HERE (not the HTTP layer) so unit tests drive the substance
// without mocking the web framework.

import type { CoreUserRepo } from "#backend/api/auth/core_user_repo.js";
import { isLockedNow as isCoreUserLockedNow } from "#backend/api/auth/core_user_repo.js";
import type { AuthenticatedUser, LdapClientPort } from "#backend/api/auth/ldap_client.js";
import { LdapBindError } from "#backend/api/auth/ldap_client.js";
import type { AuditCallback, LocalUserRepo } from "#backend/api/auth/local_user_repo.js";
import { isLockedNow } from "#backend/api/auth/local_user_repo.js";
import { verifyPassword } from "#backend/api/auth/password_hasher.js";
import type { RoleResolver } from "#backend/api/auth/role_resolver.js";
import { type Role, resolveRoleFromLdapGroups } from "#backend/api/auth/roles.js";
import type { AuthSource } from "#backend/api/auth/session.js";

export type LoginOutcome =
  | "ok"
  | "bad_credentials"
  | "locked"
  | "no_role"
  | "ldap_unreachable"
  | "disabled";

export type LoginResult = {
  outcome: LoginOutcome;
  role: Role | null;
  user_id: string | null;
  email: string | null;
  ldap_groups: ReadonlyArray<string>;
  auth_source: AuthSource | null;
  /** Propagated from the authenticated identity into the cookie. local/ldap → null (global by design);
   *  core_local → the user's core.users.installation_id (so tenant-scoped routes see the right tenancy). */
  installation_id: string | null;
  /** True iff authenticate() emitted the audit row in the same TX as recordLoginAttempt's UPDATE — the
   *  caller uses this to skip the post-authenticate emit so attempts aren't double-counted. */
  audit_emitted: boolean;
};

/** Per-outcome audit-callback factory. The HTTP layer binds it to request context; authenticate() invokes
 *  it at each recordLoginAttempt site and threads the result into the repo's open transaction. Returns null
 *  to opt out (audit emission disabled). */
export type AuditCallbackFactory = (
  outcome: LoginOutcome,
  authSource: AuthSource | null,
  userId: string,
) => AuditCallback | null;

function result(partial: Partial<LoginResult> & { outcome: LoginOutcome }): LoginResult {
  return {
    role: null,
    user_id: null,
    email: null,
    ldap_groups: [],
    auth_source: null,
    installation_id: null,
    audit_emitted: false,
    ...partial,
  };
}

export type AuthenticateArgs = {
  username: string;
  password: string;
  localRepo: LocalUserRepo;
  ldap: LdapClientPort;
  now: Date;
  // When BOTH coreRepo and roleResolver are provided, dispatch includes the core.users step between
  // core.local_users and LDAP. When either is undefined the step is skipped (feature flag off).
  coreRepo?: CoreUserRepo;
  roleResolver?: RoleResolver;
  auditCallbackFactory?: AuditCallbackFactory;
};

export async function authenticate(args: AuthenticateArgs): Promise<LoginResult> {
  const { username, password, localRepo, ldap, now } = args;
  const factory = args.auditCallbackFactory;

  const localUser = await localRepo.getByUsername({ username });

  // ─── LOCAL PATH (highest precedence) ──────────────────────────
  if (localUser !== null) {
    if (localUser.state !== "active") {
      return result({ outcome: "disabled" });
    }
    if (isLockedNow(localUser, now)) {
      return result({ outcome: "locked" });
    }
    if (!(await verifyPassword(localUser.password_hash, password))) {
      const cb = factory ? factory("bad_credentials", "local", localUser.user_id) : null;
      await localRepo.recordLoginAttempt({
        userId: localUser.user_id,
        success: false,
        now,
        ...(cb !== null ? { auditCallback: cb } : {}),
      });
      return result({ outcome: "bad_credentials", audit_emitted: cb !== null });
    }
    const cb = factory ? factory("ok", "local", localUser.user_id) : null;
    await localRepo.recordLoginAttempt({
      userId: localUser.user_id,
      success: true,
      now,
      ...(cb !== null ? { auditCallback: cb } : {}),
    });
    return result({
      outcome: "ok",
      role: localUser.role,
      user_id: localUser.user_id,
      email: localUser.email,
      auth_source: "local",
      audit_emitted: cb !== null,
    });
  }

  // ─── CORE.USERS PATH (active only when both coreRepo + roleResolver are wired) ──
  const coreRepo = args.coreRepo;
  const roleResolver = args.roleResolver;
  if (coreRepo !== undefined && roleResolver !== undefined) {
    const coreUser = await coreRepo.getByUsername({ username });
    if (coreUser !== null) {
      if (isCoreUserLockedNow(coreUser, now)) {
        return result({ outcome: "locked" });
      }
      if (!(await verifyPassword(coreUser.password_hash, password))) {
        const cb = factory ? factory("bad_credentials", "core_local", coreUser.user_id) : null;
        await coreRepo.recordLoginAttempt({
          userId: coreUser.user_id,
          success: false,
          now,
          ...(cb !== null ? { auditCallback: cb } : {}),
        });
        return result({ outcome: "bad_credentials", audit_emitted: cb !== null });
      }
      // Resolve role BEFORE recordLoginAttempt so the audit callback knows the final outcome (ok vs
      // no_role) and emits inside the same TX. An UNCAUGHT resolver exception (a contract violation — the
      // documented contract is fail-closed → null) propagates and skips the counter reset + audit emit.
      const role = await roleResolver.resolve({
        userId: coreUser.user_id,
        installationId: coreUser.installation_id,
      });
      const finalOutcome: LoginOutcome = role === null ? "no_role" : "ok";
      const cb = factory ? factory(finalOutcome, "core_local", coreUser.user_id) : null;
      await coreRepo.recordLoginAttempt({
        userId: coreUser.user_id,
        success: true,
        now,
        ...(cb !== null ? { auditCallback: cb } : {}),
      });
      if (role === null) {
        return result({
          outcome: "no_role",
          user_id: coreUser.user_id,
          email: coreUser.email,
          installation_id: coreUser.installation_id,
          audit_emitted: cb !== null,
        });
      }
      return result({
        outcome: "ok",
        role,
        user_id: coreUser.user_id,
        email: coreUser.email,
        auth_source: "core_local",
        installation_id: coreUser.installation_id,
        audit_emitted: cb !== null,
      });
    }
  }

  // ─── LDAP PATH (fallthrough) ──────────────────────────────────
  let ldapUser: AuthenticatedUser;
  try {
    ldapUser = await ldap.authenticate({ username, password });
  } catch (e) {
    if (e instanceof LdapBindError) {
      // Bind failure reads as "bad credentials" from a UX standpoint.
      return result({ outcome: "bad_credentials" });
    }
    throw e;
  }
  const ldapRole = resolveRoleFromLdapGroups(ldapUser.groups);
  if (ldapRole === null) {
    return result({
      outcome: "no_role",
      user_id: ldapUser.user_id,
      email: ldapUser.email,
      ldap_groups: ldapUser.groups,
    });
  }
  return result({
    outcome: "ok",
    role: ldapRole,
    user_id: ldapUser.user_id,
    email: ldapUser.email,
    ldap_groups: ldapUser.groups,
    auth_source: "ldap",
  });
}
