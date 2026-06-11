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
/** One dependency probe. MUST be internally time-bounded (its own query/transport timeout): both
 *  probe routes await it, and an unbounded hang turns into a kubelet probe timeout. */
export type HealthCheck = () => Promise<HealthResult>;
const UNKNOWN_HEALTH: HealthResult = { status: "unknown", latency_ms: null, error: null };

/** A named readiness dependency check (ADR-0007 deep-readiness probes; the failed name surfaces in 503). */
export type DependencyCheck = { name: string; check: HealthCheck };

/** The /healthz LIVENESS wedge signal (CS3.2): `null` = the process can make progress; a string =
 *  the process is WEDGED (the reason) and ONLY then does liveness fail. Synchronous + in-memory BY
 *  DESIGN — liveness must never await dependency I/O (see the probe-semantics doc below). */
export type WedgeCheck = () => string | null;

export type BuildAppDeps = {
  clock?: Clock;
  version?: string;
  buildSha?: string;
  /** Postgres probe — aggregated into /readyz under the name "postgres" AND shown (informationally
   *  only — never status-affecting) in the /healthz snapshot. */
  postgresCheck?: HealthCheck;
  /** Vault probe — CS3.2: aggregated into /readyz under the name "vault" (pre-CS3.2 it fed only the
   *  /healthz snapshot, so a dead Vault never failed readiness) AND shown in the /healthz snapshot. */
  vaultCheck?: HealthCheck;
  /** Further deep-readiness checks aggregated by /readyz (ADR-0007) — e.g. the CS3.2
   *  'runtime-loops' loop-liveness check (api/dependency_checks.ts::makeRuntimeLoopsCheck). */
  dependencyChecks?: ReadonlyArray<DependencyCheck>;
  /** CS3.2 LIVENESS seam: /healthz fails (503) IFF this returns a wedge reason. Omitted → /healthz
   *  is always 200 — a process that serves HTTP is alive (a TOTAL loop loss exits the process via
   *  main.ts's fail-loud Promise.all, so K8s restarts it without any probe's help). */
  wedgeCheck?: WedgeCheck;
};

/** Run one /healthz SNAPSHOT probe: informational only — a missing check reports "unknown" and a
 *  THROWN check normalizes to "down" (pre-CS3.2 a throw 500'd the LIVENESS route — a downstream
 *  outage masquerading as a dead process is exactly the restart-storm shape). */
async function snapshotHealth(check: HealthCheck | undefined): Promise<HealthResult> {
  if (check === undefined) {
    return UNKNOWN_HEALTH;
  }
  try {
    return await check();
  } catch (e) {
    const cls = e instanceof Error ? e.constructor.name : typeof e;
    const msg = e instanceof Error ? e.message.slice(0, 120) : String(e);
    return { status: "down", latency_ms: null, error: `${cls}: ${msg}` };
  }
}

/**
 * Build the HTTP app (1:1 in intent with the Python `build_app`). Registers the three built-in endpoints;
 * the caller mounts routers + calls `listen()`. Pure construction — unit-testable via `app.inject(...)`.
 */
export function buildApp(deps: BuildAppDeps = {}): FastifyInstance {
  const clock = deps.clock ?? new WallClock();
  const version = deps.version ?? APP_VERSION;
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  // ── K8s PROBE SEMANTICS (CS3.2 — cutover-safety CS3; audit C5/H7/XH11/RT2). The two probes are
  // distinct and NON-INTERCHANGEABLE; getting them wrong causes restart storms during downstream
  // outages:
  //
  //   * /readyz (READINESS) — fails on DEPENDENCY issues: 503 + the failed name(s) when ANY of
  //     {Postgres, Vault, a required runtime loop, any further dependencyCheck} is down. Effect:
  //     Kubernetes stops routing traffic to the pod; the rollout controller replaces a
  //     persistently-degraded pod via a normal rolling-replace. The pod may recover internally and
  //     flip back to Ready — NO crash loop.
  //   * /healthz (LIVENESS) — fails ONLY on a process WEDGE (the explicit wedgeCheck seam): the
  //     process itself cannot make progress even after internal recovery. It MUST NOT fail merely
  //     because DB/Vault/a loop is down — otherwise every pod restarts in lockstep while the
  //     dependency is the actual problem. The dependency snapshot in its body is INFORMATIONAL
  //     (a thrown check normalizes to "down"; the status code stays 200).
  //
  // A TOTAL loss (every runtime loop crashed) needs no wedge signal: runBackgroundRunner re-throws,
  // main.ts's fail-loud Promise.all exits non-zero, and the platform restarts the pod.

  // GET /healthz — LIVENESS: wedge-only failure + an informational dependency snapshot.
  app.get("/healthz", async (_req, reply) => {
    const wedge = deps.wedgeCheck !== undefined ? deps.wedgeCheck() : null;
    if (wedge !== null) {
      reply.code(503);
      return {
        schema_version: 1,
        version,
        timestamp: clock.now().toISOString(),
        wedged: true,
        reason: wedge,
      };
    }
    const postgres = await snapshotHealth(deps.postgresCheck);
    const vault = await snapshotHealth(deps.vaultCheck);
    return {
      schema_version: 1,
      version,
      timestamp: clock.now().toISOString(),
      wedged: false,
      postgres,
      vault,
    };
  });

  // GET /readyz — READINESS (ADR-0007 deep readiness): aggregate ALL declared checks — the named
  // postgres/vault slots (CS3.2 folded vault in; it was snapshot-only before) plus every
  // dependencyCheck; 503 + the failed names if ANY is down.
  app.get("/readyz", async (_req, reply) => {
    const checks: Array<DependencyCheck> = [];
    if (deps.postgresCheck !== undefined) {
      checks.push({ name: "postgres", check: deps.postgresCheck });
    }
    if (deps.vaultCheck !== undefined) {
      checks.push({ name: "vault", check: deps.vaultCheck });
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
