// Unit tests for the HTTP app factory (F1·a) — the Fastify port of codemaster/api/app.py::build_app.
// Uses Fastify's in-process `inject()` so no socket is bound; the DB/Vault health checks are injected
// seams (so this stays a pure unit test).

import { describe, expect, it } from "vitest";

import { buildApp } from "#backend/api/app.js";
import { FakeClock } from "#platform/clock.js";

describe("buildApp HTTP factory", () => {
  it("GET /healthz → 200; postgres/vault 'unknown' when no checks wired; clock-stamped timestamp", async () => {
    const app = buildApp({
      clock: new FakeClock({ now: new Date("2026-06-06T00:00:00.000Z") }),
      version: "9.9.9",
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.schema_version).toBe(1);
    expect(body.version).toBe("9.9.9");
    expect(body.timestamp).toBe("2026-06-06T00:00:00.000Z");
    expect(body.postgres.status).toBe("unknown");
    expect(body.vault.status).toBe("unknown");
    await app.close();
  });

  it("GET /readyz → 200 ready:true when NO dependency checks are declared (process-up readiness)", async () => {
    const app = buildApp({});
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ready).toBe(true);
    await app.close();
  });

  it("GET /readyz → 503 with ONLY the failed check name(s) in reason", async () => {
    const app = buildApp({
      dependencyChecks: [
        { name: "postgres", check: async () => ({ status: "down", latency_ms: null, error: "conn refused" }) },
        { name: "vault", check: async () => ({ status: "ok", latency_ms: 2, error: null }) },
      ],
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.ready).toBe(false);
    expect(body.reason).toContain("postgres: conn refused");
    expect(body.reason).not.toContain("vault");
    await app.close();
  });

  it("GET /readyz → 503 captures a THROWN check (name + error class)", async () => {
    const app = buildApp({
      dependencyChecks: [
        {
          name: "vault",
          check: async () => {
            throw new Error("boom");
          },
        },
      ],
    });
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toContain("vault: Error: boom");
    await app.close();
  });

  it("GET /version → 200 with build_sha + node_version + contracts_schema_version", async () => {
    const app = buildApp({ version: "1.2.3", buildSha: "abc123" });
    const res = await app.inject({ method: "GET", url: "/version" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe("1.2.3");
    expect(body.build_sha).toBe("abc123");
    expect(body.contracts_schema_version).toBe(1);
    expect(body.node_version).toBe(process.version);
    await app.close();
  });
});
