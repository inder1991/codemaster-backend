// Canonical combined entrypoint — the HTTP API + ALL Temporal workers run in ONE process/pod. This is the
// production deployment shape for the TS backend (a deliberate architecture decision; it diverges from the
// Python split into separate api / worker-* deployments). Replica-safe: the outbox-dispatcher singleton is
// enforced at the Temporal workflow level (fixed workflowId + USE_EXISTING conflict policy), so every
// replica's poller is safe to run.
//
// FAIL-LOUD: the HTTP API listen happens first, then ALL resolved boot tasks run concurrently (each blocks
// for the process lifetime). If ANY of them rejects — at startup OR a runtime crash — the process exits
// non-zero so Kubernetes restarts the pod and the fault is visible to alerting. No silently-degraded pod.
// (Matches every sibling entrypoint's `.catch(() => process.exit(1))` convention.)
//
// WHICH tasks boot is the PURE resolveBootTasks seam (boot_tasks.ts — Phase 4d review blocker #6,
// reshaped by CS1.1): CODEMASTER_RUNTIME_MODE unset/"temporal" (DEFAULT) → the two Temporal workers,
// byte-identical to the pre-mode boot; "postgres"/"shadow" → ONLY the Postgres background runner (runner +
// scheduler + outbox-drain loops), with the mode threaded through so the runner knows whether it shadows.
// The two runtimes are MUTUALLY EXCLUSIVE BY CONSTRUCTION — no mode boots both (the old two-boolean shape
// allowed exactly that: both runtimes fire the SAME crons and drain the SAME outbox, so the joined boot
// double-ran every cron — audit C7/C9/RC8/C8/RT1). The runner's thunk dynamic-imports its module graph, so
// the temporal-mode boot loads NOTHING of the Postgres runtime. (loop_health.ts is deliberately importable
// here: it is a leaf with zero runtime imports, NOT the runner's module graph.)
//
// PROBES (CS3.2 — cutover-safety CS3; audit C5/H7/XH11/RT2): this composition root wires the REAL
// dependency checks into /readyz — pre-CS3.2 runServer() got NO checks, so /readyz was permanently
// ready and a pod with a dead DB / sealed Vault / crashed required loop kept receiving traffic
// forever. Composition (api/dependency_checks.ts; semantics doc in api/app.ts):
//   * postgres  — a cheap SELECT 1 over THE shared ADR-0062 pool; wired when the core DSN is set
//     (omitted gracefully otherwise — a DSN-less boot has nothing to probe).
//   * vault     — the unauthenticated GET /v1/sys/health probe; wired when VAULT_ADDR is set,
//     omitted gracefully otherwise (dev/test pods without a Vault must not fail readiness on it).
//   * runtime-loops — the SHARED LoopHealthRegistry (CS3.1), created HERE and threaded BOTH into
//     runBackgroundRunner (whose runSupervisedLoops feeds it) AND into /readyz; wired ONLY in the
//     modes that boot the Postgres runtime — in temporal mode the loops are not this pod's job and
//     the check is simply absent (never fail readiness for loops that don't exist by design).
// /healthz takes NO dependency checks here — liveness is wedge-only (app.ts); a TOTAL loop loss
// needs no wedge signal because runBackgroundRunner re-throws and the fail-loud handler below
// exits the process, so the platform restarts the pod.

import { runServer, type RunServerDeps } from "#backend/api/server.js";
import {
  makePostgresCheck,
  makeRuntimeLoopsCheck,
  makeVaultCheck,
} from "#backend/api/dependency_checks.js";
import { FetchVaultHttpClient } from "#backend/adapters/vault_http.js";
import { parseRuntimeMode, resolveBootTasks } from "#backend/boot_tasks.js";
import { LoopHealthRegistry } from "#backend/runner/loop_health.js";
import { runWorker } from "#backend/worker/main.js";
import { runOutboxDispatcherWorker } from "#backend/worker/outbox_dispatcher_main.js";

import { WallClock } from "#platform/clock.js";
import { getPool } from "#platform/db/database.js";

async function main(): Promise<void> {
  // Resolve the boot composition BEFORE any I/O — a garbage CODEMASTER_RUNTIME_MODE value (or a
  // still-set removed cutover boolean) refuses boot here (fail-loud), before the HTTP server binds.
  // (parseRuntimeMode is pure; resolveBootTasks re-parses the same env below — one source of truth.)
  const mode = parseRuntimeMode(process.env);
  const clock = new WallClock();

  // CS3.2: ONE shared LoopHealthRegistry per pod that boots the Postgres runtime — the SAME
  // instance runSupervisedLoops feeds (crash → markDown) and /readyz queries (the 'runtime-loops'
  // check below). Before the runner registers its supervised set the registry is empty → vacuously
  // ready (required-ness is DECLARED by register(), never assumed), so the boot window cannot
  // wedge readiness. In temporal mode no registry exists at all.
  const loopHealth = mode === "temporal" ? undefined : new LoopHealthRegistry({ clock });

  const tasks = resolveBootTasks(process.env, {
    runWorker,
    runOutboxDispatcherWorker,
    runBackgroundRunner: async (runnerMode) => {
      const { runBackgroundRunner } = await import("#backend/runner/background_runner_main.js");
      await runBackgroundRunner(runnerMode, loopHealth !== undefined ? { loopHealth } : {});
    },
  });

  // CS3.2 readiness deps (each wired only when its target exists in this pod's env/mode — never
  // fail readiness on a dependency this pod does not have by design).
  const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
  const vaultAddr = process.env["VAULT_ADDR"];
  const serverDeps: RunServerDeps = {
    ...(dsn !== undefined && dsn !== ""
      ? { postgresCheck: makePostgresCheck({ pool: getPool(dsn), clock }) }
      : {}),
    ...(vaultAddr !== undefined && vaultAddr !== ""
      ? { vaultCheck: makeVaultCheck({ addr: vaultAddr, http: new FetchVaultHttpClient(), clock }) }
      : {}),
    ...(loopHealth !== undefined
      ? { dependencyChecks: [makeRuntimeLoopsCheck({ loopHealth })] }
      : {}),
  };

  // HTTP API first — app.listen() returns once bound; the server keeps serving on the event loop.
  await runServer(serverDeps);
  console.info(
    `combined backend boot: tasks=[${tasks.map((t) => t.name).join(", ")}] ` +
      `readyz_checks=[${[
        ...("postgresCheck" in serverDeps ? ["postgres"] : []),
        ...("vaultCheck" in serverDeps ? ["vault"] : []),
        ...(loopHealth !== undefined ? ["runtime-loops"] : []),
      ].join(", ")}]`,
  );
  // Every resolved task blocks for the process lifetime; run them concurrently. Promise.all rejects
  // the moment ANY rejects, propagating to the fail-loud handler below.
  await Promise.all(tasks.map((t) => t.run()));
}

main().catch((err: unknown) => {
  console.error("[FATAL] combined backend entrypoint failed:", err);
  process.exit(1);
});
