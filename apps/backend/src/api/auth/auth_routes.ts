// Fastify auth router — port of codemaster/api/auth/routes.py (Sprint 14 / S14.A).
//
// Single-factor (username + password). Endpoints (prefix /api/auth):
//   POST /login   — verify credentials, set the HttpOnly session cookie
//   GET  /me      — return identity from the session cookie
//   GET  /csrf    — seed the double-submit CSRF token (cookie + body)
//   POST /logout  — clear the session cookie (idempotent)
//
// Registered onto an encapsulated Fastify scope (mirrors github_webhook_routes), so @fastify/cookie is
// scoped here and the app factory stays pure. The lockout + dispatch substance lives in authenticate()
// (login.ts); this layer is the HTTP edge: rate-limit gate → dispatch → metrics → cookie → status mapping.
//
// DEFERRED (optional + fail-safe in the Python, wired as None unless configured): login.success/.failure
// audit emission (auditCallbackFactory / auditSessionFactory) and the app-wide CSRF *verification*
// middleware. Both pair with the admin-pod bootstrap wiring + the TS audit-emit pg-client seam.
// Tracked: FOLLOW-UP-login-audit-emit-wiring, FOLLOW-UP-csrf-verification-middleware.

import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Clock } from "#platform/clock.js";

import {
  CsrfTokenResponseV1,
  LoginRequestV1,
  LoginResponseV1,
  MeResponseV1,
} from "#contracts/auth.v1.js";

import type { CoreUserRepo } from "#backend/api/auth/core_user_repo.js";
import type { LdapClientPort } from "#backend/api/auth/ldap_client.js";
import type { LocalUserRepo } from "#backend/api/auth/local_user_repo.js";
import { type LoginOutcome, authenticate } from "#backend/api/auth/login.js";
import { recordLoginAttempt } from "#backend/api/auth/metrics.js";
import { LoginRateLimiter } from "#backend/api/auth/rate_limit.js";
import type { RoleResolver } from "#backend/api/auth/role_resolver.js";
import {
  SESSION_LIFETIME_MS,
  SessionCookieInvalid,
  issueCookie,
  verifyCookie,
} from "#backend/api/auth/session.js";

export const SESSION_COOKIE_NAME = "session";
const CSRF_COOKIE_NAME = "csrf_token";

export type AuthRoutesOptions = {
  localRepo: LocalUserRepo;
  ldap: LdapClientPort;
  clock: Clock;
  signingKey: Buffer | Uint8Array;
  /** Secure flag on emitted cookies (true in prod HTTPS; false in local-dev HTTP). */
  secureCookies?: boolean;
  /** CSRF double-submit secret; the /csrf endpoint returns its hex. 503 when absent. */
  csrfSecret?: Buffer | Uint8Array;
  rateLimiter?: LoginRateLimiter;
  /** core.users dispatch step (the ENABLE_CORE_USERS_LOCAL_AUTH flag); both required to activate it. */
  coreRepo?: CoreUserRepo;
  roleResolver?: RoleResolver;
};

// LoginOutcome → (HTTP status, detail). 'ok' is handled separately (cookie + 200).
const OUTCOME_ERRORS = new Map<LoginOutcome, { status: number; detail: string }>([
  ["bad_credentials", { status: 401, detail: "bad credentials" }],
  ["locked", { status: 423, detail: "account locked" }],
  ["disabled", { status: 403, detail: "account disabled" }],
  ["no_role", { status: 403, detail: "no role assigned" }],
  ["ldap_unreachable", { status: 503, detail: "ldap unreachable" }],
]);

/** Leftmost X-Forwarded-For entry (the original client) for rate-limit bucketing, else the socket IP. */
function clientIp(request: FastifyRequest): string {
  const xff = request.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (raw !== undefined && raw !== "") {
    const leftmost = raw.split(",")[0]?.trim();
    if (leftmost !== undefined && leftmost !== "") {
      return leftmost;
    }
  }
  return request.ip || "unknown";
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const secureCookies = opts.secureCookies ?? true;
  const rateLimiter =
    opts.rateLimiter ??
    new LoginRateLimiter({
      maxAttempts: 10,
      windowMs: 5 * 60 * 1000,
      lockoutMs: 5 * 60 * 1000,
      clock: opts.clock,
    });

  await app.register(async (scope) => {
    await scope.register(cookie);

    function setSessionCookie(reply: FastifyReply, value: string, maxAgeSeconds: number): void {
      reply.setCookie(SESSION_COOKIE_NAME, value, {
        maxAge: maxAgeSeconds,
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
        path: "/",
      });
    }
    function clearSessionCookie(reply: FastifyReply): void {
      reply.setCookie(SESSION_COOKIE_NAME, "", {
        maxAge: 0,
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
        path: "/",
      });
    }

    scope.post("/api/auth/login", async (request, reply) => {
      const parsed = LoginRequestV1.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({ detail: "invalid login request" });
      }
      const now = opts.clock.now();
      const ip = clientIp(request);
      const tStart = opts.clock.monotonic();

      // Pre-auth per-IP rate-limit gate — defends against credential spraying (which per-account lockout
      // misses, since each username only sees one failure).
      if (!rateLimiter.checkAllowed(ip)) {
        recordLoginAttempt({
          authSource: null,
          outcome: "rate_limited",
          latencySeconds: opts.clock.monotonic() - tStart,
        });
        return reply
          .code(429)
          .send({ detail: "rate limited — too many failed attempts; try again later" });
      }

      const result = await authenticate({
        username: parsed.data.username,
        password: parsed.data.password,
        localRepo: opts.localRepo,
        ldap: opts.ldap,
        now,
        ...(opts.coreRepo !== undefined ? { coreRepo: opts.coreRepo } : {}),
        ...(opts.roleResolver !== undefined ? { roleResolver: opts.roleResolver } : {}),
      });

      recordLoginAttempt({
        authSource: result.auth_source,
        outcome: result.outcome,
        latencySeconds: opts.clock.monotonic() - tStart,
      });

      // Success clears the IP's history; any non-ok outcome (incl. ldap_unreachable) records a failure.
      if (result.outcome === "ok") {
        rateLimiter.recordSuccess(ip);
      } else {
        rateLimiter.recordFailure(ip);
      }

      if (result.outcome === "ok") {
        // Invariant: these are set when outcome === "ok".
        const cookieValue = issueCookie({
          user_id: result.user_id!,
          email: result.email!,
          role: result.role!,
          auth_source: result.auth_source!,
          ldap_groups: result.ldap_groups,
          now,
          signing_key: opts.signingKey,
          installation_id: result.installation_id,
        });
        setSessionCookie(reply, cookieValue, Math.floor(SESSION_LIFETIME_MS / 1000));
        return reply.code(200).send(
          LoginResponseV1.parse({
            user_id: result.user_id,
            role: result.role,
            expires_at: new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString(),
          }),
        );
      }

      const mapped = OUTCOME_ERRORS.get(result.outcome);
      if (mapped === undefined) {
        return reply.code(500).send({ detail: "unexpected login outcome" });
      }
      return reply.code(mapped.status).send({ detail: mapped.detail });
    });

    scope.get("/api/auth/me", async (request, reply) => {
      // SESSION_COOKIE_NAME is a hardcoded module constant, never attacker-controlled — not an injection sink.
      // eslint-disable-next-line security/detect-object-injection
      const cookieValue = request.cookies[SESSION_COOKIE_NAME];
      if (cookieValue === undefined || cookieValue === "") {
        return reply.code(401).send({ detail: "no session" });
      }
      try {
        const session = verifyCookie(cookieValue, {
          signing_key: opts.signingKey,
          now: opts.clock.now(),
        });
        const me = MeResponseV1.parse({
          user_id: session.user_id,
          role: session.role,
          email: session.email,
          installation_id: session.installation_id,
        });
        return reply.code(200).send(me);
      } catch (e) {
        // Tampered/expired cookie, or a malformed installation_id in the payload. Clear the stale cookie.
        clearSessionCookie(reply);
        const detail = e instanceof SessionCookieInvalid ? e.message : "session invalid";
        return reply.code(401).send({ detail });
      }
    });

    scope.get("/api/auth/csrf", async (_request, reply) => {
      if (opts.csrfSecret === undefined) {
        return reply.code(503).send({ detail: "csrf secret not configured" });
      }
      const token = Buffer.from(opts.csrfSecret).toString("hex");
      // Seed the double-submit cookie (readable by the SPA; NOT HttpOnly). The body carries the same token.
      reply.setCookie(CSRF_COOKIE_NAME, token, {
        httpOnly: false,
        secure: secureCookies,
        sameSite: "lax",
        path: "/",
      });
      return reply.code(200).send(CsrfTokenResponseV1.parse({ token }));
    });

    scope.post("/api/auth/logout", async (_request, reply) => {
      clearSessionCookie(reply);
      return reply.code(204).send();
    });
  });
}
