import { hostname } from "node:os";

import type { Kysely } from "kysely";

import { OutboxDispatchActivities } from "#backend/activities/outbox_dispatch.activity.js";
import {
  RUNTIME_MODE_ENV,
  parseRuntimeMode,
  type BackgroundRunnerMode,
} from "#backend/boot_tasks.js";
import { PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import { LlmInvocationLedger } from "#backend/integrations/llm/invocation_ledger.js";
import { registerInstallationReconcileSink } from "#backend/outbox/sinks/installation_reconcile.js";
import { registerTemporalWorkflowStartSink } from "#backend/outbox/sinks/temporal_workflow_start.js";

import type { Clock } from "#platform/clock.js";
import { WallClock } from "#platform/clock.js";
import { disposePool, getPool, tenantKysely } from "#platform/db/database.js";

import { BackgroundJobsRepo } from "./background_jobs_repo.js";
import { makeOutboxBackgroundJobsPort } from "./background_jobs_temporal_port.js";
import {
  BackgroundRunnerLoop,
  runOneBackgroundJob,
  type BackgroundRunOutcome,
} from "./background_runner.js";
import { ensureScheduledJobs } from "./cron_schedules.js";
import { DisposableRegistry } from "./disposables.js";
import { HandlerRegistry } from "./handler_registry.js";
import { registerCronHandlers } from "./handlers/cron_handlers.js";
import { registerEventHandlers } from "./handlers/event_handlers.js";
import { LoopHealthRegistry } from "./loop_health.js";
import { OutboxDispatcherLoop } from "./outbox_dispatcher_loop.js";
import { RunnerLoop, runOneJob, type JobHandler, type RunOutcome } from "./review_job_runner.js";
import { runReviewJob } from "./review_job_shell.js";
import { ReviewJobsRepo } from "./review_jobs_repo.js";
import { assertRoutedWorkflowTypesHaveConsumers } from "./routed_consumers_check.js";
import { recordRunnerLoopCrashed } from "./runner_metrics.js";
import { SchedulerLoop, pollAndEnqueue } from "./scheduler.js";

// Phase 3a W4: the background-runner PROCESS ENTRYPOINT — composes the W2b BackgroundRunnerLoop
// (claim/dispatch/settle over core.background_jobs) + the W3 SchedulerLoop (the Postgres poller
// replacing Temporal Schedules) + the W2b HandlerRegistry into ONE Temporal-free runtime process.
// Closes the F6 review finding's composition gap: the three pieces existed but nothing wired them
// into a bootable process. Phase 3c adds the OutboxDispatcherLoop (the Postgres leased drain loop
// replacing the OutboxDispatcherWorkflow singleton) over the SAME shared pool/clock. CS2.1 (closes
// audit C6/OC4) composes the REVIEW-JOBS RunnerLoop (review_job_runner.ts over core.review_jobs —
// the table wireOutboxSinks routes `reviewPullRequest` onto; handler = the REAL runReviewJob; idle
// cycles run the unified reapStuckRuns) into the same process, in NON-SHADOW modes only. CS1.1: this
// runtime boots ONLY under CODEMASTER_RUNTIME_MODE=postgres|shadow (boot_tasks.ts — Temporal and
// the Postgres runtime are mutually exclusive by construction), so {@link wireOutboxSinks} ALWAYS
// binds the temporal_workflow_start / installation_reconcile sinks to the Postgres-enqueue port
// (BackgroundJobsTemporalPort) — the old CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS flag (and the
// RealTemporalClient fallback it selected) is REMOVED; in temporal mode the outbox is drained by
// the separate Temporal dispatcher worker (worker/outbox_dispatcher_main.ts), never by this
// process.
//
// ## NOT STARTED IN PRODUCTION YET (deliberate)
//
// Phase 3b W3b.1 registered the FIRST handlers (registerCronHandlers: mutex_janitor +
// review_run_reaper — the 2 interval crons migrated off Temporal Schedules) and runBackgroundRunner
// seeds their core.scheduled_jobs rows at startup (ensureScheduledJobs — the ensureCronSchedule
// idempotency, as ON CONFLICT DO NOTHING). The process itself stays COLD: NO deployment manifest /
// Helm chart / Procfile boots this entrypoint yet; the Temporal schedules keep firing the same
// idempotent sweeps until the runner is deployed (and Phase 4 deletes the Temporal side). Later
// Phase 3b waves register their handlers in {@link buildBackgroundRunner} (the buildActivities
// idiom: composition-root services are closed over at registration time, not threaded through
// HandlerDeps) and append their CRON_SCHEDULES entries.
//
// ## Shape
//
//   * {@link buildBackgroundRunner} — the PURE composition seam: constructs registry + the three
//     loops over ONE shared db/clock (the ADR-0062 single-pool invariant: `tenantKysely(dsn)` in
//     prod; tests inject their own Kysely + FakeClock). Also returns single-shot drive seams
//     (`runOneCycle` / `pollOnce` / `drainOutboxOnce`) bound to the SAME pieces the loops own, so
//     tests and operator diagnostics can drive exactly one cycle/pass without the infinite loops.
//   * {@link resolveBackgroundRunnerConfig} — env parsing, fail-loud (missing DSN / garbage numbers
//     refuse to boot; a half-configured runner is worse than no runner).
//   * {@link runSupervisedLoops} — the PER-LOOP SUPERVISION seam (Phase 4b W4b.2, review blocker
//     #3): each loop's run() is awaited behind its OWN catch boundary, so one loop's escaped error
//     stops THAT loop alone (logged + codemaster_runner_loop_crashed_total{loop}) while the others
//     KEEP RUNNING. Pre-W4b.2 the composition tied the three run() promises into a fail-fast race
//     (any crash fired stopAll()) — a scheduler fault stopped background-job execution AND outbox
//     draining. CS3.1 (cutover-safety CS3): the supervisor additionally feeds a LoopHealthRegistry
//     (loop_health.ts) — every supervised loop registered REQUIRED before start, a crashed loop
//     marked down with its reason — so a dead required loop is a QUERYABLE readiness signal, not
//     only a counter on a possibly no-op Meter (CS3.2 wired it into /readyz via main.ts's shared
//     registry + the 'runtime-loops' dependency check).
//   * {@link runBackgroundRunner} — the process entrypoint: build, run ALL loops concurrently under
//     runSupervisedLoops, wire SIGINT/SIGTERM → stop() all + drain (an in-flight job/poll/drain
//     always completes; the loops' cancellableSleep wakes immediately), then dispose the shared
//     pool. stopAll() fires ONLY on the signal path — NEVER as a side effect of one loop's failure.
//     The entrypoint returns once ALL loops have ended (graceful stop or crash), re-throwing
//     fail-loud when any loop crashed, so a fully-crashed runner exits non-zero and the platform
//     restarts it instead of lingering as a zombie.

/** Tunables for both loops. Resolved from env in prod ({@link resolveBackgroundRunnerConfig}). */
export type BackgroundRunnerConfig = {
  /** Lease-fencing identity stamped on claimed jobs (`lease_owner`); hostname+pid in prod. */
  owner: string;
  /** Job lease duration (seconds); the heartbeat extends it while the handler runs. */
  leaseS: number;
  /** Heartbeat cadence (seconds); must be comfortably below `leaseS`. */
  heartbeatS: number;
  /** HARD per-job runtime ceiling (seconds) — the W2b hard-timeout race force-settles past it. */
  maxRuntimeS: number;
  /** Runner idle sleep between empty claims (seconds); stuck-job reaping runs each idle cycle. */
  idleS: number;
  /** Scheduler poll cadence (seconds) over core.scheduled_jobs. */
  pollIntervalS: number;
  /** Outbox drain-loop idle sleep between empty claims (seconds) — the workflow's
   *  DEFAULT_DRAIN_INTERVAL_SECONDS=2 (Phase 3c). */
  outboxIdleS: number;
  /** Outbox dead-letter threshold. Resolved from the SAME env var the Temporal composition root
   *  reads (`CODEMASTER_OUTBOX_MAX_ATTEMPTS`, default 5 — build_outbox_activities.ts): both
   *  runtimes drain the same `core.outbox` table and MUST share one threshold. */
  outboxMaxAttempts: number;
};

/** What {@link buildBackgroundRunner} composes over: ONE shared Kysely (ADR-0062 pool) + Clock. */
export type BackgroundRunnerDeps = {
  /** Kysely over the SHARED process pool (`tenantKysely(dsn)` in prod — the ADR-0062 invariant). */
  db: Kysely<unknown>;
  clock: Clock;
  config: BackgroundRunnerConfig;
  /** CS1.2 SHADOW posture (CODEMASTER_RUNTIME_MODE=shadow): ONE flag threaded from here into every
   *  side-effect seam — the scheduler (no enqueue, no next_run_at advance), the outbox drain loop
   *  (no claim/lease, no dispatch, no markDispatched), the runner loop (no claim, no idle reap),
   *  and HandlerDeps (the HandlerRegistry wrapper suppresses every handler body, so no external
   *  GitHub/LLM/embed/clone call can start). CS2.1: shadow additionally OMITS the review-jobs
   *  RunnerLoop ENTIRELY (no `reviewLoop` handle is composed — see
   *  {@link BackgroundRunnerHandles.reviewLoop}). Default false (the production behavior); the single
   *  prod composition root ({@link runBackgroundRunner}) ALWAYS passes the mode-resolved value
   *  explicitly. */
  shadow?: boolean;
  /** CS2.1: the core Postgres DSN the REVIEW loop's pieces need — the default {@link runReviewJob}
   *  handler (in-process ports + the E4 supersede read run over `getPool(dsn)`) and the
   *  ReviewJobsRepo's unified reaper (`reapStuckRuns` resolves its raw-`pg` transaction pool from it).
   *  Production ({@link runBackgroundRunner}) ALWAYS passes it; when omitted both fall back to
   *  `CODEMASTER_PG_CORE_DSN` at FIRST USE (fail-loud there), keeping buildBackgroundRunner pure +
   *  bootable in DSN-less unit contexts (the dispose test's never-connected pool). */
  dsn?: string;
  /** CS2.1 TEST SEAM: the review-job handler the REVIEW RunnerLoop drives. Default = the REAL
   *  {@link runReviewJob} over the shared ADR-0062 pool — REAL makeInProcessPorts + the real lifecycle
   *  bundle (NO overrides in production: the full GitHub/LLM/workspace surface). Tests inject a
   *  recording stub so the composed loop can be driven without real GitHub/LLM side effects. */
  reviewHandler?: JobHandler;
};

/** The composed runtime pieces + single-shot drive seams (tests / operator diagnostics). */
export type BackgroundRunnerHandles = {
  /** The job_type → handler dispatch seam. W3b.1 cron handlers pre-registered; later Phase 3b
   *  migrations register here. */
  registry: HandlerRegistry;
  runnerLoop: BackgroundRunnerLoop;
  schedulerLoop: SchedulerLoop;
  /** Phase 3c: the Postgres leased outbox drain loop (replaces the OutboxDispatcherWorkflow
   *  singleton). Run ONE per deployment — the rows are leased (SKIP LOCKED) so extra drainers are
   *  SAFE, but the original singleton intent (global created_at-ordered draining) wants one. */
  outboxLoop: OutboxDispatcherLoop;
  /** CS2.1 (audit C6/OC4): the REVIEW-JOBS RunnerLoop — the consumer of `core.review_jobs` (the table
   *  the cutover routes `reviewPullRequest` onto). Drains jobs through the {@link JobHandler} (default:
   *  the REAL {@link runReviewJob}); its idle cycles run the UNIFIED reaper (`reapStuckRuns`: stuck
   *  job → dead + run CANCELLED + mutex released + audit, ONE txn) and the throttled LLM-ledger prune.
   *  Composed ONLY when NOT shadow: the review pipeline performs heavy GitHub/LLM side effects, so the
   *  cleanest shadow posture is to OMIT the loop entirely — shadow observes background/scheduler/outbox
   *  + the would-enqueue, never the review pipeline (no handle exists, so nothing can start it). */
  reviewLoop?: RunnerLoop;
  /** W4c.2 #10: the shared dispose registry the handler modules registered their lazily-built
   *  background resources on (the Confluence token-refresh loops). runBackgroundRunner's DISPOSE
   *  PHASE drains it once ALL loops have ended so the process exits promptly after SIGTERM. */
  disposables: DisposableRegistry;
  /** Drive exactly ONE claim → dispatch → settle cycle over the SAME pieces `runnerLoop` owns. */
  runOneCycle(): Promise<{ outcome: BackgroundRunOutcome; jobId?: string }>;
  /** Drive exactly ONE scheduler poll pass over the SAME pieces `schedulerLoop` owns. */
  pollOnce(): Promise<number>;
  /** Drive exactly ONE outbox drain pass over the SAME pieces `outboxLoop` owns. */
  drainOutboxOnce(): Promise<number>;
  /** CS2.1: drive exactly ONE review claim → handler → settle cycle over the SAME pieces `reviewLoop`
   *  owns; an IDLE cycle runs the loop's idle maintenance (the unified `reapStuckRuns` + the throttled
   *  ledger prune), mirroring `RunnerLoop.run()` minus the sleep. Present iff `reviewLoop` is
   *  (non-shadow). */
  runReviewCycleOnce?(): Promise<{ outcome: RunOutcome; jobId?: string }>;
};

/**
 * The PRODUCTION review-job handler (CS2.1): the REAL {@link runReviewJob} over the shared ADR-0062
 * pool — REAL makeInProcessPorts + the real lifecycle bundle (NO port/lifecycle overrides: the full
 * GitHub/LLM/workspace surface). Constructed LAZILY on the FIRST claimed job (then memoized) so
 * {@link buildBackgroundRunner} stays pure and bootable in DSN-less contexts (the unit dispose test's
 * never-connected pool); the DSN resolves `deps.dsn ?? CODEMASTER_PG_CORE_DSN` and fail-louds HERE
 * when neither is set — a claimed review job must NEVER run against a half-configured surface
 * (production always passes `deps.dsn`, so this throw is unreachable there).
 */
function makeDefaultReviewHandler(args: {
  repo: ReviewJobsRepo;
  dsn: string | undefined;
  clock: Clock;
}): JobHandler {
  let real: JobHandler | undefined;
  return async (job, signal) => {
    if (real === undefined) {
      const dsn = args.dsn ?? process.env["CODEMASTER_PG_CORE_DSN"];
      if (dsn === undefined || dsn === "") {
        throw new Error(
          "review runner: cannot build the default runReviewJob handler — no DSN. Pass " +
            "BackgroundRunnerDeps.dsn (production does) or set CODEMASTER_PG_CORE_DSN.",
        );
      }
      real = runReviewJob({ repo: args.repo, pool: getPool(dsn), dsn, clock: args.clock });
    }
    return real(job, signal);
  };
}

/**
 * The PURE composition seam: construct the HandlerRegistry + BackgroundRunnerLoop + SchedulerLoop
 * sharing ONE BackgroundJobsRepo over the injected db/clock, plus (CS2.1, non-shadow) the REVIEW-JOBS
 * RunnerLoop over a ReviewJobsRepo on the SAME db/clock. No I/O happens here (the pg pool is lazy);
 * callers own when the loops actually start.
 */
export function buildBackgroundRunner(deps: BackgroundRunnerDeps): BackgroundRunnerHandles {
  const { db, clock, config } = deps;
  // CS1.2: the ONE shadow flag every loop + the handler-dispatch deps are gated on (see
  // BackgroundRunnerDeps.shadow). Resolved once here; threaded through runnerArgs / schedulerArgs /
  // the outbox loop below, so the single-shot drive seams (runOneCycle / pollOnce /
  // drainOutboxOnce) carry the SAME posture as the loops.
  const shadow = deps.shadow ?? false;
  const repo = new BackgroundJobsRepo(db);

  // Phase 3b waves register job handlers HERE as the workflow migrations land (one register() per
  // job_type, composition-root services closed over at registration — the buildActivities idiom).
  // A claimed job with no handler dead-letters (`no handler for <job_type>`), never retry-loops, so
  // an accidentally-early enqueue surfaces once instead of burning attempts.
  const registry = new HandlerRegistry();
  // W4c.2 #10: the shared dispose registry — the handler modules register their DEFAULT lazy
  // clients' background-resource dispose handles (the Confluence token-refresh loops) here, and
  // runBackgroundRunner's dispose phase drains it after the loops end.
  const disposables = new DisposableRegistry();
  // W3b.1 + W3b.2 + W3d.1 + W3e.1: the 3 interval crons (mutex_janitor / review_run_reaper /
  // workspace_retention — the multi-step per-id fail-open janitor chain) + the 3 daily crons
  // (mark_stale_chunks / partition_maintenance / run_id_retention). No dsn / GitHub-client /
  // release-deps override here — the activities self-resolve their env config (CODEMASTER_PG_CORE_DSN;
  // partition maintenance prefers CODEMASTER_PG_MAINT_DSN; the workspace release activity reads
  // CODEMASTER_WORKSPACE_ROOT), exactly as under their Temporal dispatch, and the retention PR-closer
  // builds its deferred-Vault GitHub client on first use.
  registerCronHandlers(registry, { disposables });
  // W3d.1: the 3 reconcile/repair EVENT-DRIVEN job_types (reconcile_installation /
  // reconcile_repositories / repair_installation_repositories). The next wave's outbox
  // temporal_workflow_start cutover routes the producers' workflow_type strings onto these via
  // workflow_job_map.ts.
  registerEventHandlers(registry, { disposables });

  const runnerArgs = {
    repo,
    registry,
    clock,
    owner: config.owner,
    leaseS: config.leaseS,
    heartbeatS: config.heartbeatS,
    maxRuntimeS: config.maxRuntimeS,
    shadow,
  };
  const schedulerArgs = { repo, db, clock, shadow };

  // Phase 3c: the outbox drain loop — REUSES the proven Postgres-backed dispatch activities
  // (OutboxDispatchActivities, the exact 4 the Temporal worker registers via
  // buildOutboxActivities) over the SAME shared db/clock (ADR-0062). The dispatchRow sink routing
  // is untouched: temporal_workflow_start still dispatches via the RealTemporalClient until
  // Phase 3d rewires that sink.
  const outboxActivities = new OutboxDispatchActivities({
    repo: new PostgresOutboxRepo({ clock }),
    db,
    clock,
    maxAttempts: config.outboxMaxAttempts,
  });
  const outboxLoop = new OutboxDispatcherLoop({
    activities: {
      claimPendingRows: outboxActivities.claimPendingRows,
      dispatchRow: outboxActivities.dispatchRow,
      markDispatched: outboxActivities.markDispatched,
      markAttemptFailed: outboxActivities.markAttemptFailed,
    },
    clock,
    idleS: config.outboxIdleS,
    shadow,
  });

  // CS2.1 (cutover-safety CS2; closes audit C6/OC4): the REVIEW-JOBS RunnerLoop — the consumer of
  // core.review_jobs (the table the cutover's outbox sink routes `reviewPullRequest` onto via
  // wireOutboxSinks below). Without it the routed jobs sit 'ready' forever and stuck rows are never
  // reaped. Composed ONLY when NOT shadow — the review pipeline performs heavy GitHub/LLM side
  // effects; shadow OMITS the loop entirely rather than threading a suppression flag through the
  // shell (no handle exists, so nothing can start it). The loop shares the SAME db/clock (ADR-0062);
  // the same lease tunables as the background loop apply; the idle cycle runs the UNIFIED reaper
  // (ReviewJobsRepo.reapStuckRuns) + the throttled LLM-ledger prune over the REAL ledger.
  let reviewLoop: RunnerLoop | undefined;
  let runReviewCycleOnce: BackgroundRunnerHandles["runReviewCycleOnce"];
  if (!shadow) {
    const reviewRepo = new ReviewJobsRepo(db, {
      clock,
      ...(deps.dsn !== undefined ? { dsn: deps.dsn } : {}),
    });
    const reviewArgs = {
      repo: reviewRepo,
      clock,
      owner: config.owner,
      leaseS: config.leaseS,
      heartbeatS: config.heartbeatS,
      maxRuntimeS: config.maxRuntimeS,
      handler: deps.reviewHandler ?? makeDefaultReviewHandler({ repo: reviewRepo, dsn: deps.dsn, clock }),
    };
    const loop = new RunnerLoop({
      ...reviewArgs,
      ledger: new LlmInvocationLedger({ db }),
      idleS: config.idleS,
    });
    reviewLoop = loop;
    // ONE cycle over the SAME pieces the loop owns; an IDLE cycle runs the loop's idle maintenance
    // (the unified reaper + the throttled ledger prune — sharing the loop's throttle marker), exactly
    // mirroring RunnerLoop.run() minus the idle sleep.
    runReviewCycleOnce = async () => {
      const res = await runOneJob(reviewArgs);
      if (res.outcome === "idle") {
        await loop.runIdleMaintenance();
      }
      return res;
    };
  }

  return {
    registry,
    runnerLoop: new BackgroundRunnerLoop({ ...runnerArgs, idleS: config.idleS }),
    schedulerLoop: new SchedulerLoop({ ...schedulerArgs, pollIntervalS: config.pollIntervalS }),
    outboxLoop,
    ...(reviewLoop !== undefined && runReviewCycleOnce !== undefined
      ? { reviewLoop, runReviewCycleOnce }
      : {}),
    disposables,
    runOneCycle: async () => runOneBackgroundJob(runnerArgs),
    pollOnce: async () => pollAndEnqueue(schedulerArgs),
    drainOutboxOnce: async () => outboxLoop.drainOnce(),
  };
}

/**
 * Register the two event-driven outbox sinks (`temporal_workflow_start` + `installation_reconcile`,
 * both bound to the SAME port-shaped handler) onto the Postgres-enqueue port
 * (BackgroundJobsTemporalPort), so this runtime's drain loop dispatches the rows the webhook
 * producers append onto the platforms THIS process (and the review runner) consume:
 * core.background_jobs for the mapped event workflow types (workflow_job_map.ts translation; an
 * unmapped workflow_type fails loud into the row's last_error), and core.review_jobs for
 * `reviewPullRequest` (W4d.1 F6 — the REVIEW-JOBS platform the review shell runner claims from).
 *
 * CS1.1 subsumed the old CODEMASTER_OUTBOX_USE_BACKGROUND_JOBS selection: this runtime only boots
 * under CODEMASTER_RUNTIME_MODE=postgres|shadow, where Temporal is ABSENT by construction
 * (boot_tasks.ts mutual exclusivity), so there is no Temporal port to fall back to — the sinks
 * ALWAYS enqueue Postgres jobs. In temporal mode the outbox is drained by the separate Temporal
 * dispatcher worker (worker/outbox_dispatcher_main.ts), which wires the RealTemporalClient itself;
 * this process never boots there.
 *
 * Called once at process boot (runBackgroundRunner), BEFORE the drain loop starts — registerSink
 * throws on duplicates, so double-wiring fails loud. Exported for the cutover integration suite
 * (test/integration/runner/cutover_port.integration.test.ts), which drives the REAL boot wiring.
 *
 * `shadow` (CS1.2, default false): threads the no-side-effects posture into the port, whose
 * startWorkflow then performs NO real background/review enqueue (would-enqueue log + sentinel) —
 * the seam-level enforcement the cutover-safety plan mandates ("Enforcement is at the seam"),
 * defense-in-depth behind the drain loop's own shadow guard.
 */
export function wireOutboxSinks(db: Kysely<unknown>, shadow = false): void {
  const port = makeOutboxBackgroundJobsPort({
    backgroundJobs: new BackgroundJobsRepo(db),
    reviewJobs: new ReviewJobsRepo(db),
    shadow,
  });
  registerTemporalWorkflowStartSink(port);
  registerInstallationReconcileSink(port);
}

// Upper bounds for the loop tunables (W4b.1 review blocker #2 — lease/heartbeat config was
// previously unguarded above zero). These are sanity ceilings that catch unit typos (a
// milliseconds value fat-fingered into a seconds var), not tuning guidance — the defaults sit
// 1–2 orders of magnitude below every bound. Rationale per bound:
//   * lease ≤ 3600 (1h): a crashed runner's leased job is un-reclaimable until the lease expires;
//     an hours-long lease turns a pod crash into an hours-long stall of that job.
//   * heartbeat ≤ 1800 (30min): structurally ≤ lease/2 (cross-field check below), so this only
//     catches parse-level typos before the cross-field check names the pair.
//   * max runtime ≤ 86400 (24h): background work (Confluence sync, retention) runs minutes; a
//     day-plus hard ceiling is a typo and timeout_at-based reaping would effectively never fire.
//   * idle / scheduler-poll / outbox-idle ≤ 3600 (1h): a sleep above an hour starves the queue /
//     skips cron cadences within their evaluation window.
const MAX_LEASE_S = 3_600;
const MAX_HEARTBEAT_S = 1_800;
const MAX_RUNTIME_CEILING_S = 86_400;
const MAX_IDLE_OR_POLL_S = 3_600;

/** Parse a positive finite number from env, falling back when unset/empty; fail-loud on garbage,
 *  non-positive values, and values above the var's documented ceiling `maxS` (the absurdly-large
 *  guard — W4b.1 review blocker #2). */
function envPositiveSeconds(env: NodeJS.ProcessEnv, name: string, fallback: number, maxS: number): number {
  // `name` is a bounded set of CODEMASTER_BG_* literals from resolveBackgroundRunnerConfig — not an
  // attacker-controlled object-key sink; the prototype-pollution threat model does not apply.
  // eslint-disable-next-line security/detect-object-injection
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number of seconds; got '${raw}'`);
  }
  if (n > maxS) {
    throw new Error(
      `${name} must be <= ${maxS} seconds; got '${raw}' — an absurdly large value is almost ` +
        `certainly a unit typo (milliseconds pasted into a seconds var) and must refuse boot, ` +
        `not silently configure an hours-long loop`,
    );
  }
  return n;
}

/** Parse a positive integer from env, falling back when unset/empty; fail-loud on garbage. */
function envPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  // `name` is a bounded set of CODEMASTER_* literals from resolveBackgroundRunnerConfig — not an
  // attacker-controlled object-key sink; the prototype-pollution threat model does not apply.
  // eslint-disable-next-line security/detect-object-injection
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer; got '${raw}'`);
  }
  return n;
}

/**
 * Resolve the DSN + loop tunables from env. Fail-loud: a missing DSN, a non-positive/garbage
 * interval, a value above its documented ceiling, or an invalid lease/heartbeat/runtime PAIR
 * refuses to boot (a half-configured runner silently mis-leasing jobs is worse than a crash-loop
 * the platform surfaces). Defaults: lease 60s / heartbeat 15s / hard ceiling 900s (background
 * work — Confluence sync, retention — runs minutes, not the review pipeline's seconds) / idle 5s /
 * scheduler poll 30s / outbox idle 2s (the workflow's drain interval) / outbox dead-letter
 * threshold 5. `owner` is hostname+pid — traceable to the pod, no random seam.
 *
 * Cross-field invariants (W4b.1 review blocker #2), validated AFTER parse so each error names the
 * offending env var(s) + the constraint:
 *   * heartbeatS <= leaseS/2 — the heartbeat must be able to beat at least TWICE per lease window;
 *     a heartbeat that can't outrun its own lease risks lease expiry mid-handler, at which point a
 *     second runner claims the still-running job → duplicate execution.
 *   * leaseS <= maxRuntimeS — a lease window longer than the hard runtime ceiling is nonsensical
 *     (the job would hit timeout_at and be reaped while its first lease is still live).
 */
export function resolveBackgroundRunnerConfig(
  env: NodeJS.ProcessEnv,
): { dsn: string; config: BackgroundRunnerConfig } {
  const dsn = env["CODEMASTER_PG_CORE_DSN"];
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; the background runner cannot start without the core Postgres DSN",
    );
  }
  const config: BackgroundRunnerConfig = {
    owner: `bg-runner-${hostname()}-${process.pid}`,
    leaseS: envPositiveSeconds(env, "CODEMASTER_BG_LEASE_S", 60, MAX_LEASE_S),
    heartbeatS: envPositiveSeconds(env, "CODEMASTER_BG_HEARTBEAT_S", 15, MAX_HEARTBEAT_S),
    maxRuntimeS: envPositiveSeconds(env, "CODEMASTER_BG_MAX_RUNTIME_S", 900, MAX_RUNTIME_CEILING_S),
    idleS: envPositiveSeconds(env, "CODEMASTER_BG_IDLE_S", 5, MAX_IDLE_OR_POLL_S),
    pollIntervalS: envPositiveSeconds(env, "CODEMASTER_BG_SCHEDULER_POLL_S", 30, MAX_IDLE_OR_POLL_S),
    outboxIdleS: envPositiveSeconds(env, "CODEMASTER_BG_OUTBOX_IDLE_S", 2, MAX_IDLE_OR_POLL_S),
    outboxMaxAttempts: envPositiveInt(env, "CODEMASTER_OUTBOX_MAX_ATTEMPTS", 5),
  };
  if (config.heartbeatS > config.leaseS / 2) {
    throw new Error(
      `CODEMASTER_BG_HEARTBEAT_S (${config.heartbeatS}s) must be <= CODEMASTER_BG_LEASE_S/2 ` +
        `(lease=${config.leaseS}s → max heartbeat ${config.leaseS / 2}s): the heartbeat must beat ` +
        `at least twice per lease window, else the lease expires mid-handler and a second runner ` +
        `claims the still-running job → duplicate execution`,
    );
  }
  if (config.leaseS > config.maxRuntimeS) {
    throw new Error(
      `CODEMASTER_BG_LEASE_S (${config.leaseS}s) must be <= CODEMASTER_BG_MAX_RUNTIME_S ` +
        `(${config.maxRuntimeS}s): a lease window longer than the hard runtime ceiling is ` +
        `nonsensical — the job would be reaped at timeout_at while its first lease is still live`,
    );
  }
  return { dsn, config };
}

/** Bounded loop-name vocabulary of the supervision seam — doubles as the
 *  `codemaster_runner_loop_crashed_total{loop}` counter label (cardinality discipline).
 *  CS2.1 added `review` (the review-jobs RunnerLoop; supervised only in non-shadow). */
export type SupervisedLoopName = "runner" | "scheduler" | "outbox" | "review";

/** One crashed loop, as observed (caught + logged + metered) by {@link runSupervisedLoops}. */
export type LoopCrash = { loop: SupervisedLoopName; error: Error };

/** The narrow run() surface the supervisor needs — all three loop classes satisfy it structurally. */
type RunnableLoop = { run(): Promise<void> };

/**
 * Supervise ONE loop: await its run() behind a catch boundary so an escaped error CANNOT reach the
 * composition's Promise machinery as a rejection. On a crash: mark the loop DOWN on the threaded
 * {@link LoopHealthRegistry} (CS3.1 — the queryable readiness signal), meter the bounded
 * `codemaster_runner_loop_crashed_total{loop}` counter, ERROR-log which loop + the error, and
 * resolve with the {@link LoopCrash} — the crashed loop has stopped ON ITS OWN (its run() exited);
 * nothing here touches the sibling loops. NEVER rejects (markDown is safe by construction — the
 * caller registered `loop` before starting supervision; the metric is fail-safe; the rest is
 * console only), so the caller's Promise.all cannot fail-fast.
 */
async function superviseLoop(
  loop: SupervisedLoopName,
  runnable: RunnableLoop,
  health: LoopHealthRegistry,
): Promise<LoopCrash | undefined> {
  try {
    await runnable.run();
    return undefined; // graceful: stop() ended the loop — it stays "up" (a stop is not a degradation)
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    // CS3.1: feed the liveness registry FIRST (synchronously, before the metric/log) so any
    // observer that saw the crash metric also sees the loop down. Pre-CS3.1 the counter was the
    // only signal — a no-op Meter in an unwired pod made a dead required loop invisible, and the
    // hardcoded-ready /readyz could never trigger self-healing (audit C5/H7/XH11/RT2).
    health.markDown(loop, error);
    recordRunnerLoopCrashed({ loop });
    console.error(
      `background runner: ${loop} loop CRASHED and stopped — the other loops KEEP RUNNING ` +
        `(W4b.2 per-loop supervision; this pod is DEGRADED until restarted): ${error.stack ?? error.message}`,
    );
    return { loop, error };
  }
}

/**
 * Run ALL composed loops concurrently under PER-LOOP SUPERVISION (Phase 4b W4b.2, review blocker #3):
 * one loop's escaped error (a pass-level DB fault in the scheduler, a claim error in the runner /
 * outbox drainer / review runner — the loops' documented fail-loud run() contract) is caught at ITS
 * OWN boundary, logged + metered, and stops THAT loop alone; the other loops KEEP RUNNING. Resolves
 * only when EVERY loop has ended — graceful stop() or crash — with the list of observed crashes
 * (empty on a clean shutdown). The composition deliberately does NOT tie the run() promises into a
 * fail-fast race: superviseLoop never rejects, so this Promise.all cannot reject either. Calling the
 * loops' stop() is the CALLER's job (the SIGINT/SIGTERM path in {@link runBackgroundRunner}) — never
 * a side effect of one loop's failure.
 *
 * `reviewLoop` (CS2.1) is OPTIONAL: present in non-shadow (the review-jobs RunnerLoop joins the
 * supervised set as `loop=review`); absent in shadow (the composition omitted it entirely).
 *
 * `health` (CS3.1 — cutover-safety finding CS3): EVERY supervised loop is registered as a REQUIRED
 * loop on the {@link LoopHealthRegistry} BEFORE any loop starts (initially "up"; review only when
 * composed, so shadow never declares it required), and a loop's escaped crash marks THAT loop down
 * with the crash reason — in ADDITION to the existing metric + log. A dead required loop is thereby
 * a queryable in-process fact (`allRequiredUp() === false`) instead of only a counter on a possibly
 * no-op Meter; CS3.2 wires this into /readyz (main.ts threads ONE shared registry into both this
 * supervisor and the 'runtime-loops' dependency check) so the platform can self-heal the pod.
 */
export async function runSupervisedLoops(loops: {
  runnerLoop: RunnableLoop;
  schedulerLoop: RunnableLoop;
  outboxLoop: RunnableLoop;
  reviewLoop?: RunnableLoop;
  health: LoopHealthRegistry;
}): Promise<Array<LoopCrash>> {
  // Register the EXACT supervised set as required BEFORE starting any loop (register throws on
  // duplicates — reusing one registry across two supervised sets fails loud here, never silently
  // hides one set's crash behind the other's health). This also makes superviseLoop's markDown
  // safe by construction: every name it can mark was registered on this line.
  loops.health.register("runner");
  loops.health.register("scheduler");
  loops.health.register("outbox");
  if (loops.reviewLoop !== undefined) {
    loops.health.register("review");
  }
  const supervised = [
    superviseLoop("runner", loops.runnerLoop, loops.health),
    superviseLoop("scheduler", loops.schedulerLoop, loops.health),
    superviseLoop("outbox", loops.outboxLoop, loops.health),
  ];
  if (loops.reviewLoop !== undefined) {
    supervised.push(superviseLoop("review", loops.reviewLoop, loops.health));
  }
  const outcomes = await Promise.all(supervised);
  return outcomes.filter((o): o is LoopCrash => o !== undefined);
}

/**
 * The process entrypoint: build over the ADR-0062 shared pool + WallClock, run ALL composed loops
 * (runner + scheduler + outbox drain, + the CS2.1 review-jobs loop in non-shadow — the consumer of
 * core.review_jobs that closes audit C6/OC4) concurrently under {@link runSupervisedLoops}, and shut down
 * gracefully — SIGINT/SIGTERM stop() every loop, which DRAIN (an in-flight job/poll/drain pass
 * always completes; the idle/poll cancellableSleep wakes immediately). A crash in ONE loop stops
 * that loop ALONE (logged + metered; W4b.2 — pre-fix it fired stopAll() and tore down job
 * execution AND outbox draining together); the survivors keep running until a signal arrives. Once
 * ALL loops have ended the shared pool is disposed (no socket leaks across the exit path) and any
 * observed crash re-throws — fail-loud: a run in which a loop crashed never exits 0, and when EVERY
 * loop has crashed nothing keeps the process useful, so the throw lets the platform restart it
 * instead of leaving a zombie pod that looks healthy with zero live loops.
 *
 * NOT booted by any deployment yet — see the module doc (Phase 3b+ registers handlers first).
 *
 * `mode` is the resolved CODEMASTER_RUNTIME_MODE ("postgres" | "shadow" — "temporal" is excluded
 * by type AND re-asserted at runtime below: CS1.1 mutual exclusivity, defense-in-depth for
 * non-typechecked callers). Shadow-specific behavior layers onto this seam in the CS follow-ups;
 * the mode is threaded + logged from day one so the runner always knows which posture it boots in.
 *
 * `opts.loopHealth` (CS3.2): the SHARED {@link LoopHealthRegistry} the combined pod (main.ts)
 * created and ALSO surfaced to /readyz as the 'runtime-loops' dependency check — threading the
 * SAME instance here is what makes a crashed required loop flip readiness (the CS3 closure;
 * pre-CS3.2 the registry was constructed privately below, so nothing outside this function could
 * query it and /readyz stayed hardcoded ready). Omitted (the direct `node background_runner_main`
 * invocation) → a private registry: supervision semantics are identical, the readiness surface is
 * simply absent because that boot shape has no HTTP server.
 */
export async function runBackgroundRunner(
  mode: BackgroundRunnerMode,
  opts: { loopHealth?: LoopHealthRegistry } = {},
): Promise<void> {
  if (mode !== "postgres" && mode !== "shadow") {
    throw new Error(
      `runBackgroundRunner: mode must be 'postgres' or 'shadow'; got '${String(mode)}' — the ` +
        `Temporal and Postgres runtimes are mutually exclusive (CS1.1): the background runner ` +
        `NEVER boots under ${RUNTIME_MODE_ENV}=temporal (booting both double-runs every cron ` +
        `and double-drains the outbox)`,
    );
  }
  // CS1.2: the ONE shadow flag — resolved from the typed mode HERE and threaded explicitly into
  // every seam below (buildBackgroundRunner → the three loops + HandlerDeps; wireOutboxSinks → the
  // enqueue port). In shadow the runtime boots, polls, and observes but performs NO production
  // side effect (no schedule advance, no enqueue, no outbox claim/dispatch/markDispatched, no
  // handler external calls, no production-table writes).
  const shadow = mode === "shadow";
  const { dsn, config } = resolveBackgroundRunnerConfig(process.env);
  const db = tenantKysely<unknown>(dsn); // THE shared ADR-0062 pool for this DSN
  const clock = new WallClock();
  // `dsn` threads into the CS2.1 review loop's pieces (the default runReviewJob handler's in-process
  // ports + supersede read over getPool(dsn); the ReviewJobsRepo reaper's raw-pg transaction pool) —
  // the SAME shared ADR-0062 pool `db` rides on, never a second pool.
  const handles = buildBackgroundRunner({ db, clock, config, shadow, dsn });

  // CS2.2 FAIL-LOUD boot self-check (closes audit C6/OC4: never enqueue into a table nothing
  // drains): AFTER the runtime is built, BEFORE any loop starts / sink is wired / schedule is
  // seeded, assert EVERY workflow_type the cutover routes has a consumer in THIS process — a
  // registered HandlerRegistry handler for every WORKFLOW_TYPE_TO_JOB_TYPE value, and the CS2.1
  // review loop for `reviewPullRequest` (required in postgres mode; OMITTED BY DESIGN in shadow —
  // the documented observed-not-consumed exception, see routed_consumers_check.ts). A gap throws
  // here naming every missing consumer, so a mis-composed runner refuses to serve.
  assertRoutedWorkflowTypesHaveConsumers({
    registry: handles.registry,
    reviewLoopBooted: handles.reviewLoop !== undefined,
    shadow,
  });

  // Wire the event-driven outbox sinks onto the Postgres-enqueue port BEFORE the drain loop starts
  // (see wireOutboxSinks — CS1.1: always the BackgroundJobsTemporalPort; Temporal is absent in
  // this runtime's modes by construction). registerSink throws on duplicates — fail-loud.
  wireOutboxSinks(db, shadow);

  // Seed the cron schedules BEFORE the loops start (W3b.1) — idempotent ON CONFLICT DO NOTHING, so
  // concurrent pods / redeploys never clobber operator-paused/edited rows. Fail-loud: a runner that
  // cannot reach core.scheduled_jobs at boot should crash-loop visibly, not run schedule-less.
  // CS1.2 SHADOW guard: the seed INSERTs core.scheduled_jobs rows — a production-table write — so
  // it is SUPPRESSED in shadow (the real cutover boot seeds them; until then the shadow scheduler
  // observes whatever rows already exist and logs would-enqueue per due row).
  if (shadow) {
    console.info(
      "background runner shadow-mode: schedule seeding (ensureScheduledJobs) SUPPRESSED — no " +
        "production-table writes in shadow (CS1.2 no-side-effects contract)",
    );
  } else {
    await ensureScheduledJobs(db, clock);
  }

  // stopAll fires ONLY here — the SIGINT/SIGTERM shutdown path. NEVER wire it to a loop's failure
  // (W4b.2 review blocker #3: the pre-fix .catch(stopAll) tie meant one loop's crash tore down all
  // three); a crashed loop stops alone inside runSupervisedLoops while the others keep running.
  const stopAll = (): void => {
    handles.runnerLoop.stop();
    handles.schedulerLoop.stop();
    handles.outboxLoop.stop();
    handles.reviewLoop?.stop(); // CS2.1: composed only in non-shadow; an in-flight review job DRAINS
  };
  process.once("SIGINT", stopAll);
  process.once("SIGTERM", stopAll);

  console.info(
    `background runner starting: mode=${mode} owner=${config.owner} ` +
      `review_loop=${handles.reviewLoop !== undefined ? "composed" : "OMITTED (shadow — no review side effects)"} ` +
      `registered_job_types=[${handles.registry.registeredTypes().join(", ")}] ` +
      `(lease=${config.leaseS}s heartbeat=${config.heartbeatS}s maxRuntime=${config.maxRuntimeS}s ` +
      `idle=${config.idleS}s schedulerPoll=${config.pollIntervalS}s ` +
      `outboxIdle=${config.outboxIdleS}s outboxMaxAttempts=${config.outboxMaxAttempts})`,
  );

  // Per-loop SUPERVISION (W4b.2): resolves only when ALL composed loops have ended — graceful stop()
  // via the signal path above, or a crash that stopped ITS loop alone. The process therefore stays
  // alive (and the survivors keep working) past any single loop's crash; if EVERY loop crashes,
  // nothing is left running, this await completes, and the fail-loud throw below exits the process
  // so the platform restarts it.
  //
  // CS3.1: the supervisor registers every composed loop on `loopHealth` as REQUIRED before start
  // and marks a crashed loop down with its reason — a dead required loop is a queryable in-process
  // fact, not just a counter on a possibly no-op Meter. CS3.2 closed the loop: the combined pod
  // (main.ts) threads ITS registry in (the same instance /readyz aggregates via the
  // 'runtime-loops' check — api/dependency_checks.ts), so a crashed required loop flips the pod
  // not-ready and the platform stops routing to it / replaces it instead of routing forever
  // (audit C5/H7/XH11/RT2).
  const loopHealth = opts.loopHealth ?? new LoopHealthRegistry({ clock });
  const crashes = await runSupervisedLoops({ ...handles, health: loopHealth });

  process.removeListener("SIGINT", stopAll);
  process.removeListener("SIGTERM", stopAll);

  // W4c.2 #10 DISPOSE PHASE: once ALL loops have ended, stop the background resources the handlers
  // lazily constructed (the Confluence token-refresh loops — LIVE WallClock timers that otherwise
  // keep the event loop alive and hang the SIGTERM'd process). Error-safe (disposeAll never throws)
  // and runs BEFORE the pool disposal + the fail-loud crash re-throw, so every exit path — graceful
  // AND crashed — leaves no live timer behind.
  await handles.disposables.disposeAll();

  await disposePool(dsn);

  if (crashes.length > 0) {
    // Fail-loud at EXIT: even when the surviving loops drained gracefully on SIGTERM, a run in
    // which any loop crashed must not exit 0 — the non-zero exit + the aggregate message record
    // the degraded run for the platform and the logs.
    throw new AggregateError(
      crashes.map((c) => c.error),
      `background runner: ${crashes.length} loop(s) crashed during this run — ` +
        crashes.map((c) => `${c.loop}: ${c.error.message}`).join("; "),
    );
  }
}

// Main-module entrypoint guard — fires ONLY under a direct `node .../background_runner_main.js`
// invocation (no prod manifest does this yet; see the module doc), never on import. Fail LOUD on
// any startup error (same idiom as worker/main.ts / outbox_dispatcher_main.ts). CS1.1: the mode is
// parsed from env HERE too, so even a direct invocation cannot boot the Postgres runtime while
// CODEMASTER_RUNTIME_MODE is 'temporal' (the default) — mutual exclusivity holds on every boot
// path, not only through main.ts's resolveBootTasks.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(() => {
      const mode = parseRuntimeMode(process.env);
      if (mode === "temporal") {
        throw new Error(
          `refusing to boot the background runner: ${RUNTIME_MODE_ENV} is 'temporal' (the ` +
            `default) — in that mode the Temporal runtime owns the crons and the outbox, and ` +
            `booting this runner alongside would double-run them (CS1.1 mutual exclusivity). ` +
            `Set ${RUNTIME_MODE_ENV}=postgres or ${RUNTIME_MODE_ENV}=shadow.`,
        );
      }
      return runBackgroundRunner(mode);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `background runner FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}
