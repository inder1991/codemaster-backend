// The REAL /readyz dependency checks (CS3.2 — cutover-safety plan finding CS3; audit
// C5/H7/XH11/RT2). Pre-CS3.2 server.ts called buildApp() with NO checks, so /readyz was
// PERMANENTLY ready: a pod with a dead Postgres, a sealed Vault, or a crashed required runtime
// loop kept receiving traffic forever and self-healing structurally could not trigger.
//
// main.ts (the combined pod) composes these factories into buildApp's readiness deps:
//   * {@link makePostgresCheck} — a cheap `SELECT 1` over THE shared ADR-0062 pool (getPool(dsn));
//     wired whenever CODEMASTER_PG_CORE_DSN is set.
//   * {@link makeVaultCheck}   — the STANDARD unauthenticated `GET /v1/sys/health` probe (per the
//     standards-at-external-boundaries lens) over the injected VaultHttpClient transport (prod:
//     FetchVaultHttpClient, whose AbortSignal timeout bounds the probe); wired whenever VAULT_ADDR
//     is set, omitted gracefully otherwise.
//   * {@link makeRuntimeLoopsCheck} — the CS3.1 LoopHealthRegistry as a named readiness dependency:
//     a crashed required loop (runner/scheduler/outbox/review, fed by runSupervisedLoops) flips
//     /readyz to 503 so Kubernetes stops routing to the pod and a rollout replaces it. Wired ONLY
//     in the modes that boot the Postgres runtime (postgres|shadow) — in temporal/api-only shapes
//     the loops are not this pod's job and the check is simply absent.
//
// These are READINESS checks (dependency issues), never LIVENESS — see the probe-semantics doc in
// app.ts: /healthz fails only on the explicit process-wedge signal.

import type { VaultHttpClient } from "#backend/adapters/vault_http.js";
import type { LoopHealthRegistry } from "#backend/runner/loop_health.js";

import type { Clock } from "#platform/clock.js";

import type { DependencyCheck, HealthCheck, HealthResult } from "./app.js";

/** The minimal query surface the Postgres probe needs — the shared ADR-0062 `pg.Pool` satisfies it
 *  structurally; tests inject a fake. (Structural on purpose: the probe must not construct or own
 *  a pool — ADR-0062's single-pool invariant — only borrow the process-shared one.) */
export type QueryablePool = {
  query(queryText: string): Promise<unknown>;
};

const ok = (latencyMs: number): HealthResult => ({ status: "ok", latency_ms: latencyMs, error: null });
const down = (error: string, latencyMs: number | null = null): HealthResult => ({
  status: "down",
  latency_ms: latencyMs,
  error,
});

/** Normalize a thrown probe error to a bounded `Class: message` string (no payloads, no secrets). */
function describeError(e: unknown): string {
  const cls = e instanceof Error ? e.constructor.name : typeof e;
  const msg = e instanceof Error ? e.message.slice(0, 120) : String(e);
  return `${cls}: ${msg}`;
}

/**
 * Postgres readiness probe: ONE cheap `SELECT 1` on the SHARED pool. Latency from the injected
 * Clock's monotonic axis (the repo-wide clock seam). A reject → "down" with the normalized error.
 * Bound: `SELECT 1` is trivially fast once connected; a connect-level hang is bounded by the
 * kubelet's readiness-probe timeout (which is the correct effect — an unconnectable DB IS
 * not-ready), never by liveness (/healthz only snapshots, never gates, on this check).
 */
export function makePostgresCheck(args: { pool: QueryablePool; clock: Clock }): HealthCheck {
  return async () => {
    const t0 = args.clock.monotonic();
    try {
      await args.pool.query("SELECT 1");
      return ok(Math.round((args.clock.monotonic() - t0) * 1000));
    } catch (e) {
      return down(describeError(e));
    }
  };
}

/**
 * Vault readiness probe: the STANDARD unauthenticated `GET /v1/sys/health` (standby + performance
 * standby count as healthy — they serve reads; the probe asks "can this pod use Vault", not "is
 * this node the active primary"). 200 → ok; any other status (501 uninitialized, 503 sealed, …) →
 * down naming the status; a transport failure (the FetchVaultHttpClient's bounded AbortSignal
 * timeout included) → down with the transport's STERILE error (no token exists on this path at
 * all — sys/health is unauthenticated).
 */
export function makeVaultCheck(args: {
  /** VAULT_ADDR (trailing slashes tolerated — normalized like VaultHttpPort). */
  addr: string;
  http: VaultHttpClient;
  clock: Clock;
}): HealthCheck {
  const base = args.addr.replace(/\/+$/, "");
  const url = `${base}/v1/sys/health?standbyok=true&perfstandbyok=true`;
  return async () => {
    const t0 = args.clock.monotonic();
    try {
      const resp = await args.http.request({ method: "GET", url, headers: {} });
      const latencyMs = Math.round((args.clock.monotonic() - t0) * 1000);
      if (resp.status === 200) {
        return ok(latencyMs);
      }
      return down(`sys/health returned status ${resp.status}`, latencyMs);
    } catch (e) {
      return down(describeError(e));
    }
  };
}

/**
 * Loop-liveness readiness dependency (the CS3 closure): the CS3.1 {@link LoopHealthRegistry} —
 * fed by runSupervisedLoops' crash boundary — surfaced as the named 'runtime-loops' /readyz check.
 * Up while EVERY registered (= required) loop is up; an EMPTY registry is vacuously up BY DESIGN
 * (readiness must not fail during the boot window before the supervised set registers, and
 * required-ness is declared by register(), never assumed). Down names EVERY down loop with its
 * crash reason, so the 503 body tells the operator WHICH loop died without pod-exec'ing.
 * Synchronous + in-memory — no I/O, nothing to time-bound.
 */
export function makeRuntimeLoopsCheck(args: { loopHealth: LoopHealthRegistry }): DependencyCheck {
  return {
    name: "runtime-loops",
    check: async () => {
      if (args.loopHealth.allRequiredUp()) {
        return ok(0);
      }
      const reasons = Object.entries(args.loopHealth.snapshot())
        .filter((entry): entry is [string, { status: "down"; reason: string; since: Date }] => {
          return entry[1].status === "down";
        })
        .map(([loop, health]) => `${loop}: ${health.reason}`);
      return down(`required loop(s) down — ${reasons.join("; ")}`, 0);
    },
  };
}
