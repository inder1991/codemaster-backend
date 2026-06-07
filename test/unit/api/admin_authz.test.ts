// RBAC-seam tests: a route guarded by the requireRole preHandler, exercised via Fastify inject.

import cookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { makeRequireRole } from "#backend/api/admin/_authz.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import { SUPER_ADMIN_SESSION_INSTALLATION_ID } from "#backend/infra/sentinels.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");

function mintCookie(role: Role, installationId: string | null): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role,
    auth_source: installationId === null ? "local" : "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: installationId,
  });
}

async function makeApp(allowed: ReadonlyArray<Role>) {
  const app = buildApp({});
  const requireRole = makeRequireRole({ signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.register(async (scope) => {
    await scope.register(cookie);
    scope.get("/admin/thing", { preHandler: requireRole(allowed) }, async (request, reply) =>
      reply.code(200).send({
        role: request.authPrincipal?.role,
        installationId: request.authPrincipal?.installationId,
      }),
    );
  });
  await app.ready();
  return app;
}

describe("requireRole preHandler (admin RBAC seam)", () => {
  it("401 when no session cookie is present", async () => {
    const app = await makeApp(["platform_owner", "super_admin"]);
    const res = await app.inject({ method: "GET", url: "/admin/thing" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("401 on a tampered cookie", async () => {
    const app = await makeApp(["platform_owner", "super_admin"]);
    const res = await app.inject({
      method: "GET",
      url: "/admin/thing",
      cookies: { [SESSION_COOKIE_NAME]: "garbage.sig" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403 when the role is not in the allow-set (deterministic sorted detail)", async () => {
    const app = await makeApp(["platform_owner", "super_admin"]);
    const res = await app.inject({
      method: "GET",
      url: "/admin/thing",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader", null) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain("required one of [platform_owner, super_admin]");
    await app.close();
  });

  it("200 + attaches principal when the role is allowed (super_admin → sentinel installation)", async () => {
    const app = await makeApp(["platform_owner", "super_admin"]);
    const res = await app.inject({
      method: "GET",
      url: "/admin/thing",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("super_admin", null) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ role: string; installationId: string }>();
    expect(body.role).toBe("super_admin");
    expect(body.installationId).toBe(SUPER_ADMIN_SESSION_INSTALLATION_ID);
    await app.close();
  });

  it("resolves the real installation_id for a tenant-scoped (core_local) principal", async () => {
    const app = await makeApp(["org_owner"]);
    const res = await app.inject({
      method: "GET",
      url: "/admin/thing",
      cookies: {
        [SESSION_COOKIE_NAME]: mintCookie("org_owner", "11111111-1111-1111-1111-111111111111"),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ installationId: string }>().installationId).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
    await app.close();
  });
});
