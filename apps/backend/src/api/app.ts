// HTTP app factory (F1·a) — the Fastify port of the FastAPI app in
// vendor/codemaster-py/codemaster/api/app.py::build_app.
//
// Owns the built-in /healthz, /readyz, /version endpoints. Routers (the GitHub webhook, auth, admin) are
// registered by the CALLER onto the returned instance before listen() — keeping this factory pure
// (no listen, no DB/Vault connection: the health checks are injected seams), so it is fully unit-testable
// via Fastify's in-process `app.inject(...)`. The listen/bootstrap entrypoint lives in api/server.ts.

import Fastify, { type FastifyInstance } from "fastify";

import { WallClock, type Clock } from "#platform/clock.js";

/** App version (Python `__version__`). No package.json version yet; pinned here until one lands. */
export const APP_VERSION = "0.1.0";
const CONTRACTS_SCHEMA_VERSION = 1;
/** 10 MB — the GitHub webhook body cap (Python WEBHOOK_BODY_CAP_BYTES). Set app-wide so the webhook route
 *  can receive up to the cap; the route enforces the exact 413 boundary itself. */
export const BODY_LIMIT_BYTES = 10 * 1024 * 1024;

/** Port of the Python `HealthResult` (status + latency + error). */
export type HealthResult = {
  status: "ok" | "unknown" | "down";
  latency_ms: number | null;
  error: string | null;
};
export type HealthCheck = () => Promise<HealthResult>;
const UNKNOWN_HEALTH: HealthResult = { status: "unknown", latency_ms: null, error: null };

/** A named readiness dependency check (ADR-0007 deep-readiness probes; the failed name surfaces in 503). */
export type DependencyCheck = { name: string; check: HealthCheck };

export type BuildAppDeps = {
  clock?: Clock;
  version?: string;
  buildSha?: string;
  /** Legacy single Postgres probe (folded into /readyz under the name "postgres"). */
  postgresCheck?: HealthCheck;
  /** Vault probe for /healthz (not aggregated into /readyz unless also passed as a dependencyCheck). */
  vaultCheck?: HealthCheck;
  /** Sprint-16 deep-readiness checks aggregated by /readyz. */
  dependencyChecks?: ReadonlyArray<DependencyCheck>;
};

/**
 * Build the HTTP app (1:1 in intent with the Python `build_app`). Registers the three built-in endpoints;
 * the caller mounts routers + calls `listen()`. Pure construction — unit-testable via `app.inject(...)`.
 */
export function buildApp(deps: BuildAppDeps = {}): FastifyInstance {
  const clock = deps.clock ?? new WallClock();
  const version = deps.version ?? APP_VERSION;
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  // GET /healthz — liveness + a dependency status snapshot (1:1 with the Python healthz).
  app.get("/healthz", async () => {
    const postgres = deps.postgresCheck !== undefined ? await deps.postgresCheck() : UNKNOWN_HEALTH;
    const vault = deps.vaultCheck !== undefined ? await deps.vaultCheck() : UNKNOWN_HEALTH;
    return { schema_version: 1, version, timestamp: clock.now().toISOString(), postgres, vault };
  });

  // GET /readyz — deep readiness (ADR-0007): aggregate all checks; 503 + the failed names if ANY is down.
  app.get("/readyz", async (_req, reply) => {
    const checks: Array<DependencyCheck> = [];
    if (deps.postgresCheck !== undefined) {
      checks.push({ name: "postgres", check: deps.postgresCheck });
    }
    if (deps.dependencyChecks !== undefined) {
      checks.push(...deps.dependencyChecks);
    }
    if (checks.length === 0) {
      // No dependencies declared → process-up readiness (the api-pod placeholder surface).
      return { schema_version: 1, ready: true, reason: null };
    }
    const failed: Array<string> = [];
    for (const { name, check } of checks) {
      try {
        const result = await check();
        if (result.status !== "ok") {
          failed.push(`${name}: ${result.error ?? "down"}`);
        }
      } catch (e) {
        const cls = e instanceof Error ? e.constructor.name : typeof e;
        const msg = e instanceof Error ? e.message.slice(0, 120) : String(e);
        failed.push(`${name}: ${cls}: ${msg}`);
      }
    }
    if (failed.length === 0) {
      return { schema_version: 1, ready: true, reason: null };
    }
    reply.code(503);
    return { schema_version: 1, ready: false, reason: failed.join("; ") };
  });

  // GET /version — build provenance. `node_version` replaces the Python `python_version`.
  app.get("/version", async () => ({
    schema_version: 1,
    version,
    build_sha: deps.buildSha ?? process.env.BUILD_SHA ?? "<unknown>",
    contracts_schema_version: CONTRACTS_SCHEMA_VERSION,
    node_version: process.version,
  }));

  return app;
}
