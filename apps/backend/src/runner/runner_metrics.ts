/**
 * Runner OTel metrics (Task 1.12) — observability for the coarse-grained `review_jobs` runner.
 *
 * Mirrors the established subsystem-metric idiom (`api/auth/metrics.ts` for the histogram +
 * `observability/reconcile_metrics.ts` for the counter pattern): a module-scoped {@link Meter} and
 * instruments created once at import (avoids per-emit `create_*` lock contention), routed through the
 * `#platform/observability/metrics.js::getMeter` seam. The seam returns a no-op Meter when no
 * MeterProvider is registered, so emission is safe BEFORE the exporter is wired — no null-checks, no
 * `TODO`s in the emit path.
 *
 * Instruments (Grafana-query-stable names; renaming requires ADR):
 *   * codemaster_runner_claim_latency_ms       — histogram: wall time of a `claim()` round-trip.
 *   * codemaster_runner_lease_steals_total      — counter: a claim that RECLAIMED an expired lease
 *                                                 (reclaim mints attempts > 1) — i.e. a prior owner crashed.
 *   * codemaster_runner_heartbeat_failures_total— counter: a heartbeat refused (stale token / past timeout_at).
 *   * codemaster_runner_stale_token_writes_total{op}
 *                                                — counter: a fenced terminal write affected 0 rows (the
 *                                                  lease was stolen) — op ∈ {markDone, markFailed}.
 *   * codemaster_runner_jobs_total{outcome}     — counter: one per settled runOneJob, outcome ∈
 *                                                  {idle, done, failed, lease_lost, cancelled}.
 *   * codemaster_runner_handler_duration_ms     — histogram: wall time the handler ran (claim → settle).
 *   * codemaster_runner_retry_attempts_total    — counter: a job re-enqueued for another attempt (markFailed
 *                                                  non-terminal).
 *   * codemaster_runner_crash_loop_reaped_total — counter: stuck runs reaped by `reapStuckRuns()`.
 *
 * ## Cardinality discipline
 * Bounded-enum labels ONLY: `op` ∈ {markDone, markFailed}; `outcome` ∈ {idle, done, failed, lease_lost, cancelled}.
 * NEVER per-tenant / per-installation / per-PR / per-job labels — same discipline the sibling modules enforce.
 *
 * Fail-safe: every emit swallows meter errors so telemetry never perturbs the runner loop.
 */

import { type Counter, type Histogram, getMeter } from "#platform/observability/metrics.js";

// Counter / histogram NAMES — Grafana-query-stable (renaming requires ADR).
export const CLAIM_LATENCY_MS_NAME = "codemaster_runner_claim_latency_ms";
export const LEASE_STEALS_NAME = "codemaster_runner_lease_steals_total";
export const HEARTBEAT_FAILURES_NAME = "codemaster_runner_heartbeat_failures_total";
export const STALE_TOKEN_WRITES_NAME = "codemaster_runner_stale_token_writes_total";
export const JOBS_TOTAL_NAME = "codemaster_runner_jobs_total";
export const HANDLER_DURATION_MS_NAME = "codemaster_runner_handler_duration_ms";
export const RETRY_ATTEMPTS_NAME = "codemaster_runner_retry_attempts_total";
export const CRASH_LOOP_REAPED_NAME = "codemaster_runner_crash_loop_reaped_total";

// Meter + instruments cached at MODULE scope (created once at import).
const METER = getMeter("codemaster.runner");

const CLAIM_LATENCY_HISTOGRAM: Histogram = METER.createHistogram(CLAIM_LATENCY_MS_NAME, {
  description:
    "Wall time in milliseconds of a review_jobs claim() round-trip (the SKIP-LOCKED dequeue UPDATE). " +
    "Rising tails signal lock contention or a saturated runner pool.",
});
const HANDLER_DURATION_HISTOGRAM: Histogram = METER.createHistogram(HANDLER_DURATION_MS_NAME, {
  description:
    "Wall time in milliseconds a runOneJob handler ran (claim → settle). Distribution drives the " +
    "lease-TTL + hard-runtime-ceiling tuning.",
});
const LEASE_STEALS_COUNTER: Counter = METER.createCounter(LEASE_STEALS_NAME, {
  description:
    "Count of claims that RECLAIMED an expired lease (attempts minted > 1) — i.e. a prior owner crashed " +
    "mid-job. A sustained non-zero rate signals pod churn or under-provisioned lease TTLs.",
});
const HEARTBEAT_FAILURES_COUNTER: Counter = METER.createCounter(HEARTBEAT_FAILURES_NAME, {
  description:
    "Count of heartbeats that were REFUSED (stale token after a lease steal, or past timeout_at). Each " +
    "refusal makes runOneJob abort its handler cooperatively.",
});
const STALE_TOKEN_WRITES_COUNTER: Counter = METER.createCounter(STALE_TOKEN_WRITES_NAME, {
  description:
    "Count of fenced terminal writes (markDone/markFailed) that affected 0 rows because the lease was " +
    "stolen — the worker that lost the race. Bounded label op ∈ {markDone, markFailed}.",
});
const JOBS_TOTAL_COUNTER: Counter = METER.createCounter(JOBS_TOTAL_NAME, {
  description:
    "Count of settled runOneJob invocations, labeled by outcome ∈ {idle, done, failed, lease_lost, cancelled}. " +
    "The canonical runner-throughput + error-rate surface.",
});
const RETRY_ATTEMPTS_COUNTER: Counter = METER.createCounter(RETRY_ATTEMPTS_NAME, {
  description:
    "Count of jobs re-enqueued for another attempt (markFailed non-terminal). Pairs with jobs_total to " +
    "compute the retry ratio during LLM/GitHub incidents.",
});
const CRASH_LOOP_REAPED_COUNTER: Counter = METER.createCounter(CRASH_LOOP_REAPED_NAME, {
  description:
    "Count of stuck runs reaped by reapStuckRuns() (expired leases whose attempts are exhausted). " +
    "Each reaped run had its job dead-lettered, its run CANCELLED, and its PR-mutex released in one txn.",
});

/** Record one claim() round-trip latency (ms). Fail-safe. */
export function recordClaimLatencyMs(ms: number): void {
  try { CLAIM_LATENCY_HISTOGRAM.record(ms); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one handler duration (ms). Fail-safe. */
export function recordHandlerDurationMs(ms: number): void {
  try { HANDLER_DURATION_HISTOGRAM.record(ms); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one lease-steal (a reclaim that minted attempts > 1). Fail-safe. */
export function recordLeaseSteal(): void {
  try { LEASE_STEALS_COUNTER.add(1); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one refused heartbeat (stale token / past timeout_at). Fail-safe. */
export function recordHeartbeatFailure(): void {
  try { HEARTBEAT_FAILURES_COUNTER.add(1); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one fenced terminal write that lost the race. `op` ∈ {markDone, markFailed}. Fail-safe. */
export function recordStaleTokenWrite(args: { op: "markDone" | "markFailed" }): void {
  try { STALE_TOKEN_WRITES_COUNTER.add(1, { op: args.op }); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one settled runOneJob outcome ∈ {idle, done, failed, lease_lost, cancelled}. Fail-safe. */
export function recordJobOutcome(args: { outcome: "idle" | "done" | "failed" | "lease_lost" | "cancelled" }): void {
  try { JOBS_TOTAL_COUNTER.add(1, { outcome: args.outcome }); } catch { /* telemetry never perturbs the runner */ }
}

/** Record one re-enqueued retry (markFailed non-terminal). Fail-safe. */
export function recordRetryAttempt(): void {
  try { RETRY_ATTEMPTS_COUNTER.add(1); } catch { /* telemetry never perturbs the runner */ }
}

/** Record the count of stuck runs reaped by one reapStuckRuns() sweep (0 emits nothing). Fail-safe. */
export function recordCrashLoopReaped(count: number): void {
  if (count <= 0) return;
  try { CRASH_LOOP_REAPED_COUNTER.add(count); } catch { /* telemetry never perturbs the runner */ }
}
