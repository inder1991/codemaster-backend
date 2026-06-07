// Admin RBAC seam — port of codemaster/api/admin/_authz.py (require_role) + the session-resolution intent of
// session_resolver.py, adapted to Fastify.
//
// The Python session_resolver uses a contextvars+middleware workaround to feed 12 legacy zero-arg
// SessionResolvers without touching 30+ handler signatures. A Fastify port carries no such legacy, so the
// idiomatic equivalent is a `requireRole` PREHANDLER: it reads the session cookie, verifies it, resolves the
// principal, enforces the per-route allow-set, and attaches the principal to the request for the handler.
//
// Authz model (1:1 with _authz.py): each route declares an explicit ALLOW-SET of roles (NOT precedence) and
// the guard checks `role ∈ allowed`. 401 on missing/invalid cookie; 403 (with a deterministic sorted detail)
// on role mismatch. Local super_admins / LDAP users have no installation context, so the resolver
// substitutes the SUPER_ADMIN_SESSION_INSTALLATION_ID sentinel (the fail-closed tenancy hook refuses the
// zero-UUID for routes that require a real installation).

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";

import type { Clock } from "#platform/clock.js";

import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { SessionCookieInvalid, verifyCookie } from "#backend/api/auth/session.js";
import { SUPER_ADMIN_SESSION_INSTALLATION_ID } from "#backend/infra/sentinels.js";

/** `(installation_id, user_id, role)` — the resolved principal a guarded handler reads. */
export type SessionPrincipal = {
  installationId: string;
  userId: string;
  role: Role;
};

declare module "fastify" {
  // Module augmentation REQUIRES `interface` (declaration merging can't extend via `type`).
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface FastifyRequest {
    /** Set by the {@link requireRole} preHandler once authz passes. */
    authPrincipal?: SessionPrincipal;
  }
}

/** Raised when no/invalid session cookie is present (→ 401). */
export class SessionUnauthorized extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SessionUnauthorized";
  }
}

/** Resolve the principal from a session-cookie value. Throws {@link SessionUnauthorized} on missing/invalid.
 *  installation_id falls back to the super-admin sentinel when the cookie carries none (super_admin / LDAP). */
export function resolveSession(
  cookieValue: string | undefined,
  opts: { signingKey: Buffer | Uint8Array; now: Date },
): SessionPrincipal {
  if (cookieValue === undefined || cookieValue === "") {
    throw new SessionUnauthorized("no session");
  }
  let session;
  try {
    session = verifyCookie(cookieValue, { signing_key: opts.signingKey, now: opts.now });
  } catch (e) {
    if (e instanceof SessionCookieInvalid) {
      throw new SessionUnauthorized(e.message);
    }
    throw e;
  }
  return {
    installationId: session.installation_id ?? SUPER_ADMIN_SESSION_INSTALLATION_ID,
    userId: session.user_id,
    role: session.role,
  };
}

export type RequireRoleDeps = {
  signingKey: Buffer | Uint8Array;
  clock: Clock;
  /** Override the cookie name (defaults to the auth router's "session"). */
  cookieName?: string;
};

/**
 * Build a `requireRole` factory bound to the signing key + clock. The returned function takes the per-route
 * allow-set and yields a Fastify preHandler:
 *   - 401 (+ no principal) when the session cookie is missing/invalid;
 *   - 403 with `role insufficient; required one of [...], got X` (roles sorted, deterministic) on mismatch;
 *   - otherwise attaches `request.authPrincipal` and lets the handler run.
 */
export function makeRequireRole(
  deps: RequireRoleDeps,
): (allowed: ReadonlyArray<Role>) => preHandlerHookHandler {
  const cookieName = deps.cookieName ?? SESSION_COOKIE_NAME;
  return (allowed: ReadonlyArray<Role>): preHandlerHookHandler => {
    const allowedSorted = [...allowed].sort();
    const allowedSet = new Set<Role>(allowed);
    return async (request: FastifyRequest, reply: FastifyReply) => {
      let principal: SessionPrincipal;
      try {
        // cookieName is a bound config value (defaults to the "session" constant), never request-controlled.
        // eslint-disable-next-line security/detect-object-injection
        principal = resolveSession(request.cookies[cookieName], {
          signingKey: deps.signingKey,
          now: deps.clock.now(),
        });
      } catch (e) {
        if (e instanceof SessionUnauthorized) {
          await reply.code(401).send({ detail: e.message });
          return reply;
        }
        throw e;
      }
      if (!allowedSet.has(principal.role)) {
        await reply.code(403).send({
          detail: `role insufficient; required one of [${allowedSorted.join(", ")}], got ${principal.role}`,
        });
        return reply;
      }
      request.authPrincipal = principal;
      return undefined;
    };
  };
}
