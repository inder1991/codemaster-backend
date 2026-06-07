// HTTP-edge tests for the auth router via Fastify `app.inject` (no network, no DB — InMemory repos +
// NoOp LDAP). Asserts the status-code + cookie contract of every endpoint.

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAuthRoutes, SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import { InMemoryLocalUserRepo, type LocalUser } from "#backend/api/auth/local_user_repo.js";
import { NoOpLdapClient } from "#backend/api/auth/noop_ldap.js";
import { LoginRateLimiter } from "#backend/api/auth/rate_limit.js";

const PW = "test-password-123";
const PW_HASH = "$argon2id$v=19$m=65536,t=3,p=4$B5QfWyYH3WdHYy1TH9rkoA$SomedFZGU2en2csfxEl+WOEJNowVbJjN0AIxtQoavN4";
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const CSRF_SECRET = Buffer.from("0123456789abcdef0123456789abcdef"); // 32 bytes → 64 hex chars

function superAdmin(over: Partial<LocalUser> = {}): LocalUser {
  const now = new Date("2026-06-07T12:00:00.000Z");
  return {
    user_id: "00000000-0000-0000-0000-0000000000aa",
    username: "root",
    email: "root@internal",
    full_name: "Root",
    password_hash: PW_HASH,
    role: "super_admin",
    state: "active",
    last_password_change: now,
    last_login_at: null,
    failed_attempts: 0,
    locked_until: null,
    created_at: now,
    created_by_user_id: null,
    ...over,
  };
}

async function makeApp(opts: {
  user?: LocalUser;
  rateLimiter?: LoginRateLimiter;
  csrfSecret?: Buffer;
} = {}) {
  const localRepo = new InMemoryLocalUserRepo();
  if (opts.user !== undefined) {
    await localRepo.insert(opts.user);
  }
  const app = buildApp({});
  await registerAuthRoutes(app, {
    localRepo,
    ldap: new NoOpLdapClient(),
    clock: new FakeClock({ now: new Date("2026-06-07T12:00:00.000Z") }),
    signingKey: SIGNING_KEY,
    secureCookies: false,
    ...(opts.rateLimiter !== undefined ? { rateLimiter: opts.rateLimiter } : {}),
    ...(opts.csrfSecret !== undefined ? { csrfSecret: opts.csrfSecret } : {}),
  });
  await app.ready();
  return app;
}

function loginPayload(username: string, password: string): string {
  return JSON.stringify({ username, password });
}

describe("auth routes (Fastify inject)", () => {
  describe("POST /api/auth/login", () => {
    it("ok → 200 + session cookie + body", async () => {
      const app = await makeApp({ user: superAdmin() });
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: loginPayload("root", PW),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ user_id: string; role: string; expires_at: string }>();
      expect(body.role).toBe("super_admin");
      expect(body.user_id).toBe("00000000-0000-0000-0000-0000000000aa");
      const sessionCookie = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
      expect(sessionCookie?.value).toBeTruthy();
      expect(sessionCookie?.httpOnly).toBe(true);
      expect(sessionCookie?.sameSite).toBe("Lax");
      await app.close();
    });

    it("wrong password → 401", async () => {
      const app = await makeApp({ user: superAdmin() });
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: loginPayload("root", "wrong"),
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("locked → 423", async () => {
      const app = await makeApp({
        user: superAdmin({ locked_until: new Date("2026-06-07T12:30:00.000Z") }),
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: loginPayload("root", "wrong"),
      });
      expect(res.statusCode).toBe(423);
      await app.close();
    });

    it("disabled → 403", async () => {
      const app = await makeApp({ user: superAdmin({ state: "disabled" }) });
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: loginPayload("root", PW),
      });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it("malformed body → 422", async () => {
      const app = await makeApp({ user: superAdmin() });
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ username: "root" }), // missing password
      });
      expect(res.statusCode).toBe(422);
      await app.close();
    });

    it("rate-limited → 429", async () => {
      const clock = new FakeClock({ now: new Date("2026-06-07T12:00:00.000Z") });
      const limiter = new LoginRateLimiter({
        maxAttempts: 1,
        windowMs: 5 * 60 * 1000,
        lockoutMs: 5 * 60 * 1000,
        clock,
      });
      const localRepo = new InMemoryLocalUserRepo();
      await localRepo.insert(superAdmin());
      const app = buildApp({});
      await registerAuthRoutes(app, {
        localRepo,
        ldap: new NoOpLdapClient(),
        clock,
        signingKey: SIGNING_KEY,
        secureCookies: false,
        rateLimiter: limiter,
      });
      await app.ready();
      // 1st failed attempt consumes the single allowed slot.
      const first = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: loginPayload("root", "wrong"),
      });
      expect(first.statusCode).toBe(401);
      // 2nd attempt is blocked pre-dispatch.
      const second = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: loginPayload("root", PW),
      });
      expect(second.statusCode).toBe(429);
      await app.close();
    });
  });

  describe("GET /api/auth/me", () => {
    it("round-trips: login cookie → identity", async () => {
      const app = await makeApp({ user: superAdmin() });
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: loginPayload("root", PW),
      });
      const session = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
      const me = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { [SESSION_COOKIE_NAME]: session },
      });
      expect(me.statusCode).toBe(200);
      const body = me.json<{ user_id: string; role: string; email: string; installation_id: string | null }>();
      expect(body.role).toBe("super_admin");
      expect(body.email).toBe("root@internal");
      expect(body.installation_id).toBeNull();
      await app.close();
    });

    it("no cookie → 401", async () => {
      const app = await makeApp({ user: superAdmin() });
      const res = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("tampered cookie → 401 + clears the cookie", async () => {
      const app = await makeApp({ user: superAdmin() });
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        cookies: { [SESSION_COOKIE_NAME]: "garbage.signature" },
      });
      expect(res.statusCode).toBe(401);
      const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
      expect(cleared?.value).toBe("");
      await app.close();
    });
  });

  describe("GET /api/auth/csrf", () => {
    it("with a secret → 200 + token + csrf cookie", async () => {
      const app = await makeApp({ csrfSecret: CSRF_SECRET });
      const res = await app.inject({ method: "GET", url: "/api/auth/csrf" });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ token: string }>().token).toBe(CSRF_SECRET.toString("hex"));
      expect(res.cookies.find((c) => c.name === "csrf_token")?.value).toBe(CSRF_SECRET.toString("hex"));
      await app.close();
    });

    it("without a secret → 503", async () => {
      const app = await makeApp({});
      const res = await app.inject({ method: "GET", url: "/api/auth/csrf" });
      expect(res.statusCode).toBe(503);
      await app.close();
    });
  });

  describe("POST /api/auth/logout", () => {
    it("→ 204 + clears the cookie (idempotent)", async () => {
      const app = await makeApp({});
      const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
      expect(res.statusCode).toBe(204);
      expect(res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)?.value).toBe("");
      await app.close();
    });
  });
});
