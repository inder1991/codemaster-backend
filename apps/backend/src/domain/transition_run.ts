/**
 * `transitionRun` lifecycle state-machine primitive — 1:1 TypeScript/Kysely port of the frozen Python
 * spine primitive `vendor/codemaster-py/codemaster/workflow/_lifecycle.py::transition_run`
 * (Phase 4 / Task 1 + Task 5 — R1).
 *
 * The single primitive every spine worker uses to advance a `core.review_runs.lifecycle_state` and
 * record the transition in `audit.workflow_events` as a `lifecycle_transition` row. This is the
 * operational truth for "what state is this run in right now" (AD-3 lifecycle/event split): the compact
 * canonical state lives on `review_runs`; granular processing milestones (`PR_OPENED`, `INGESTED`,
 * `ANALYZED`, `FINDINGS_PERSISTED`) live as separate `event_type` values on `workflow_events` — they are
 * *events*, not states.
 *
 * ## Five-step protocol (1:1 with the Python)
 *
 *   1. Validate `fromState` / `toState` ∈ {@link LIFECYCLE_STATES} + `activity` non-empty + `attempt >= 1`
 *      at the boundary — typed errors, not Postgres CHECK violations.
 *   2. Assert an OPEN transaction (the Python `session.in_transaction()` `RuntimeError` analogue): reject
 *      a handle that is not an `instanceof Transaction`. Without a txn the SELECT FOR UPDATE releases its
 *      row lock immediately and the UPDATE + event-emit chain races concurrent writers.
 *   3. SELECT current `lifecycle_state` + `review_id` + `trigger_type` + `cancel_reason` + `provider` +
 *      `installation_id` (joined through pull_request_reviews → repositories) under `FOR UPDATE OF rr`.
 *   4. Branch:
 *        * row missing → {@link StateDrift} with `actualState = null`.
 *        * (BF-3 Phase B Wave 10 R2) `installation_id` unresolved → {@link RepositoriesResolveFailed}.
 *        * (BF-9) `expectedInstallationId` mismatch → {@link CrossInstallationViolation} BEFORE any
 *          mutation; `undefined` (default) logs a structured WARN grace-period notice and proceeds.
 *        * `current === toState` → return {@link TransitionOutcome.ALREADY_APPLIED} (NO UPDATE, NO event
 *          — Temporal at-least-once retry idempotency, AD-8).
 *        * `current !== fromState` → {@link StateDrift}.
 *        * else → ONE UPDATE flipping `lifecycle_state` (+ the terminal timestamp column for
 *          COMPLETED / FAILED / CANCELLED) so the AD-7 forward + inverse CHECK constraints never observe
 *          the row mid-transition.
 *   5. Emit ONE `lifecycle_transition` event via {@link emitWorkflowEvent} with the full metadata payload
 *      (`from`, `to`, `activity`, `attempt`, `worker_id`, `duration_ms`, `reason`), in the SAME
 *      transaction.
 *
 * ## AD-5 layer-5 telemetry
 *
 * On the APPLIED branch (only — a retry that hits ALREADY_APPLIED does NOT double-count), the primitive
 * queues the failure-side counters behind {@link emitAfterCommit} so they fire ONLY on a successful
 * commit-drain (dropped on rollback — no OTel/DB drift, BF-15):
 *   - `codemaster_review_runs_failed_total{trigger_type, cancel_reason}` on FAILED (NULL cancel_reason →
 *     literal `'none'`).
 *   - `codemaster_review_runs_cancelled_total{cancel_reason}` on CANCELLED (NULL cancel_reason →
 *     literal `'unknown'`, distinct from FAILED's sentinel).
 *   - `codemaster_review_runs_draining_total` (up-down) +1 on CANCELLED (Task 8 emits the matching
 *     decrement on RUN_DRAIN_COMPLETED — not ported here).
 * Counters live under the meter scope `codemaster.review_runs` (same scope as the stale-write guard).
 *
 * The caller owns the transaction boundary AND the {@link PendingEmits} collector — it creates the
 * collector BEFORE opening the transaction, threads it here, and calls `pending.drain()` exactly once
 * AFTER the transaction commits. On rollback the caller never drains and the queued emits are dropped.
 *
 * Transaction discipline: the caller owns the txn; this function neither opens nor commits — the state
 * flip, the timestamp stamp, and the event emit share one COMMIT and are atomic from any reader.
 */

import { type RawBuilder, sql, Transaction } from "kysely";

import { type Clock, WallClock } from "#platform/clock.js";
import {
  getMeter,
  type Counter,
  type UpDownCounter,
} from "#platform/observability/metrics.js";

import { emitWorkflowEvent } from "../ingest/_workflow_events_repository.js";
import { emitAfterCommit, type PendingEmits } from "../infra/post_commit_emit.js";

import { CrossInstallationViolation, RepositoriesResolveFailed } from "../workspace/errors.js";

// ─── BF-9 Phase A — cross-installation safety identifiers (1:1 with the Python constants) ────────────
const BF9_PRIMITIVE_NAME = "transition_run";
const BF9_KEY_KIND = "run_id";

// ─── OTel instruments (AD-5 layer-5 telemetry, Phase 4 / Task 5) ─────────────────────────────────────
//
// Meter scope pinned to `codemaster.review_runs` — the same scope used by the stale-write guard so all
// AD-5 review-run counters land in one OTel instrument scope. `getMeter` returns a no-op Meter when no
// MeterProvider is registered, so creating + adding to these instruments is always safe.
const METER = getMeter("codemaster.review_runs");

/** 1:1 with the Python `_runs_failed`. Labelled by {trigger_type, cancel_reason}; NULL → `'none'`. */
const RUNS_FAILED: Counter = METER.createCounter("codemaster_review_runs_failed_total", {
  description:
    "review_runs transitions to FAILED terminal state. " +
    "Labelled by {trigger_type, cancel_reason}; NULL cancel_reason " +
    "is reported as the literal 'none'.",
});
/** 1:1 with the Python `_runs_cancelled`. Labelled by {cancel_reason}; NULL → `'unknown'`. */
const RUNS_CANCELLED: Counter = METER.createCounter("codemaster_review_runs_cancelled_total", {
  description:
    "review_runs transitions to CANCELLED terminal state. " +
    "Labelled by {cancel_reason}; NULL cancel_reason is reported " +
    "as 'unknown' (distinct from FAILED's 'none' sentinel).",
});
/** 1:1 with the Python `_runs_draining`. +1 on CANCELLED; Task 8 emits the matching decrement. */
const RUNS_DRAINING: UpDownCounter = METER.createUpDownCounter(
  "codemaster_review_runs_draining_total",
  {
    description:
      "review_runs currently in CANCELLED-draining state " +
      "(incremented on CANCELLED transitions; decremented on " +
      "RUN_DRAIN_COMPLETED by Phase 4 / Task 8).",
  },
);

/**
 * Outcome of a {@link transitionRun} call (1:1 with the Python `TransitionOutcome` enum, modeled as a
 * frozen `as const` object + derived union per the repo's no-TS-enum style rule — callers read
 * `TransitionOutcome.APPLIED` and compare against the string value identically).
 *
 *   - `APPLIED` — the UPDATE advanced the row and the `lifecycle_transition` audit event was emitted.
 *   - `ALREADY_APPLIED` — the current state already equalled `toState` (Temporal at-least-once retry
 *     safety, AD-8; no UPDATE, no event).
 */
export const TransitionOutcome = {
  APPLIED: "applied",
  ALREADY_APPLIED: "already_applied",
} as const;

/** The outcome string union, the value type of {@link transitionRun}. */
export type TransitionOutcome = (typeof TransitionOutcome)[keyof typeof TransitionOutcome];

/**
 * `transitionRun` found an unexpected current state (1:1 with the Python `_lifecycle.StateDrift`).
 *
 * Distinct from the workspace `StateDrift` (which keys on `workspaceId` and uses a non-nullable
 * `actualState`): the run primitive keys on `runId` and `actualState` is `null` when the run row is
 * MISSING entirely (the Python `actual_state: str | None`). Carries enough lineage signal for the caller
 * to log the drift and exit the activity cleanly. `name` matches the class name so structured logs /
 * `instanceof` discrimination read identically to the Python.
 */
export class StateDrift extends Error {
  public readonly runId: string;
  public readonly expectedFrom: string;
  public readonly actualState: string | null;

  public constructor(args: { runId: string; expectedFrom: string; actualState: string | null }) {
    super(
      args.actualState === null
        ? `run ${args.runId} not found`
        : `run ${args.runId}: expected lifecycle_state '${args.expectedFrom}', got '${args.actualState}'`,
    );
    this.name = "StateDrift";
    this.runId = args.runId;
    this.expectedFrom = args.expectedFrom;
    this.actualState = args.actualState;
  }
}

/**
 * Canonical lifecycle states (1:1 with the Python `LIFECYCLE_STATES` frozenset / the migration
 * `ck_review_runs_lifecycle_state` CHECK). Kept as a `Set` so validation rejects bad values before any
 * SQL round-trip — callers see a typed error, not a Postgres CHECK violation.
 */
export const LIFECYCLE_STATES: ReadonlySet<string> = new Set<string>([
  // Active (1:1 with LIFECYCLE_ACTIVE).
  "PENDING",
  "RUNNING",
  "WAITING_RETRY",
  // Terminal (1:1 with LIFECYCLE_TERMINAL).
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "PARTIAL",
]);

/**
 * Terminal state → corresponding timestamp column (1:1 with the Python `_TERMINAL_TIMESTAMP_COLUMNS`).
 * `PARTIAL` is intentionally absent — it is an intermediate-terminal state with no dedicated timestamp
 * column; active states (`PENDING` / `RUNNING` / `WAITING_RETRY`) also map to no column. The AD-7
 * forward + inverse CHECKs require these timestamps present when the row is in the corresponding state,
 * so the primitive stamps them in lockstep with the state flip. Keys are validated `toState` values;
 * never user input.
 */
export const TERMINAL_TIMESTAMP_COLUMNS: ReadonlyMap<string, string> = new Map<string, string>([
  ["COMPLETED", "completed_at"],
  ["FAILED", "failed_at"],
  ["CANCELLED", "cancelled_at"],
]);

/** The row the FOR-UPDATE SELECT returns: current state + the metadata the event-emit + counters need. */
type CurrentRunRow = {
  lifecycle_state: string;
  review_id: string;
  trigger_type: string;
  cancel_reason: string | null;
  provider: string;
  installation_id: string | null;
};

/** Arguments for {@link transitionRun}. 1:1 with the Python keyword-only signature. */
export type TransitionRunArgs = {
  /**
   * Open transaction handle. The caller owns the boundary; this neither opens nor commits. A bare
   * `Kysely` engine is rejected at runtime (the `session.in_transaction()` `RuntimeError` analogue).
   */
  tx: Transaction<unknown>;
  /** The `core.review_runs.run_id` to transition. */
  runId: string;
  /** The state the caller expects the row to be in right now. Must be in {@link LIFECYCLE_STATES}. */
  fromState: string;
  /**
   * The state to advance to. Must be in {@link LIFECYCLE_STATES}. When equal to the current observed
   * state the call is a no-op (idempotent — AD-8).
   */
  toState: string;
  /** Free-text owner of the transition (e.g. `"review_workflow.run"`). Non-empty; recorded in the event. */
  activity: string;
  /** Retry attempt counter, `>= 1`. Mirrored from the run row's attempt_number; recorded in the event. */
  attempt: number;
  /** Optional worker pod identity for cross-pod attribution. Recorded in the event payload. */
  workerId?: string | null;
  /** Optional wall-clock duration of the producing activity. Recorded in the event payload. */
  durationMs?: number | null;
  /** Optional free-text reason (e.g. `"bedrock_timeout"`). Recorded in the event payload. */
  reason?: string | null;
  /**
   * BF-9 Phase A cross-installation safety guard. When provided, the primitive validates the run's
   * resolved `installation_id` equals this value and raises {@link CrossInstallationViolation} on
   * mismatch BEFORE any UPDATE / event emit. `undefined` (default) is the transitional Phase B grace
   * period — a structured WARN logs the gap.
   */
  expectedInstallationId?: string | undefined;
  /**
   * Injected clock; defaults to {@link WallClock}. Governs both the terminal-timestamp stamp on
   * `review_runs` and the emitted event's `received_at` so a {@link FakeClock} observes identical
   * timestamps on both.
   */
  clock?: Clock | undefined;
  /**
   * The caller's transaction-scoped post-commit emit collector. The AD-5 counters are PUSHED here (NOT
   * fired inline) and fire only when the caller drains after a successful commit — keeping the counters
   * aligned with the persisted state (dropped on rollback, BF-15).
   */
  pending: PendingEmits;
};

/**
 * Advance `core.review_runs.lifecycle_state` and emit the `lifecycle_transition` event (1:1 with the
 * Python `transition_run`). See the module docstring for the five-step protocol.
 *
 * @returns {@link TransitionOutcome.APPLIED} when the row was advanced; {@link
 *          TransitionOutcome.ALREADY_APPLIED} when the current state already equalled `toState`.
 * @throws {Error}                       `fromState`/`toState` not in {@link LIFECYCLE_STATES}; `activity`
 *                                       empty; `attempt < 1`; OR `tx` is not an open `Transaction` (the
 *                                       `session.in_transaction()` `RuntimeError` analogue).
 * @throws {StateDrift}                  the run row is missing (`actualState = null`) OR the current state
 *                                       is neither `fromState` nor `toState`.
 * @throws {RepositoriesResolveFailed}   the BF-9 SELECT could not resolve
 *                                       `core.repositories.installation_id` for the run (missing
 *                                       repositories row OR NULL installation_id). Raised BEFORE any
 *                                       UPDATE / event emit (fail-closed: tenancy integrity over
 *                                       availability).
 * @throws {CrossInstallationViolation}  `expectedInstallationId` is provided and does NOT match the run's
 *                                       resolved `installation_id` (no UPDATE runs; row unchanged).
 */
export async function transitionRun(args: TransitionRunArgs): Promise<TransitionOutcome> {
  const { tx, runId, fromState, toState, activity, attempt, pending } = args;
  const workerId = args.workerId ?? null;
  const durationMs = args.durationMs ?? null;
  const reason = args.reason ?? null;
  const expectedInstallationId = args.expectedInstallationId;

  // ── Step 1: validate at the boundary so callers see typed errors, not Postgres CHECK violations. ──
  if (!LIFECYCLE_STATES.has(fromState)) {
    throw new Error(
      `transitionRun: from_state='${fromState}' is not in LIFECYCLE_STATES. ` +
        `Valid values: ${JSON.stringify([...LIFECYCLE_STATES].sort())}`,
    );
  }
  if (!LIFECYCLE_STATES.has(toState)) {
    throw new Error(
      `transitionRun: to_state='${toState}' is not in LIFECYCLE_STATES. ` +
        `Valid values: ${JSON.stringify([...LIFECYCLE_STATES].sort())}`,
    );
  }
  if (typeof activity !== "string" || activity.length === 0) {
    throw new Error(`transitionRun: activity must be a non-empty string, got ${JSON.stringify(activity)}`);
  }
  if (attempt < 1) {
    throw new Error(`transitionRun: attempt must be >= 1, got ${attempt}`);
  }

  // ── Step 2: assert an OPEN transaction (the Python `session.in_transaction()` RuntimeError). ──
  if (!(tx instanceof Transaction)) {
    throw new Error(
      "transitionRun requires an already-open transaction. Pass the Kysely Transaction handle from " +
        "`db.transaction().execute(async (tx) => { ... })`. Without a txn, the SELECT FOR UPDATE " +
        "releases its row-level lock immediately and the UPDATE + event emit chain races concurrent " +
        "writers.",
    );
  }

  const effectiveClock: Clock = args.clock ?? new WallClock();

  // ── Step 3: read current state under FOR UPDATE OF rr. Join pull_request_reviews → repositories to
  // resolve `provider` (for the event emit) + `installation_id` (BF-9 + the audit tenancy column) +
  // `trigger_type` / `cancel_reason` (the AD-5 counter labels) in ONE round trip. The JOIN runs inside
  // the same transaction as the FOR-UPDATE lock on review_runs so a concurrent reassignment can't race
  // between verification and mutation. We do NOT lock repositories — this primitive never mutates it. ──
  // tenant:exempt reason=PK-lookup-by-run_id-FOR-UPDATE-joined-to-repositories follow_up=PERMANENT-EXEMPTION-review-runs-pk
  const currentResult = await sql<CurrentRunRow>`
    SELECT rr.lifecycle_state, rr.review_id, rr.trigger_type,
           rr.cancel_reason, pr.provider, r.installation_id
      FROM core.review_runs AS rr
      JOIN core.pull_request_reviews AS pr
        ON pr.review_id = rr.review_id
      JOIN core.repositories AS r
        ON r.github_repo_id = pr.repo_id
     WHERE rr.run_id = ${runId}
       FOR UPDATE OF rr
  `.execute(tx);

  const currentRow = currentResult.rows[0];
  if (currentRow === undefined) {
    throw new StateDrift({ runId, expectedFrom: fromState, actualState: null });
  }

  const currentState = currentRow.lifecycle_state;
  const reviewId = currentRow.review_id;
  const provider = currentRow.provider;
  const triggerType = currentRow.trigger_type;
  const cancelReason = currentRow.cancel_reason;
  const actualInstallationId = currentRow.installation_id;

  // ── BF-9 / fail-closed posture (1:1 with the Python branch). ──
  //   * actual=null — data-integrity break (repositories row missing OR installation_id NULL). Raise
  //     RepositoriesResolveFailed at the resolution site so the operator gets a single triage pivot;
  //     the audit row is never written with installation_id=NULL.
  //   * expected=undefined — Phase B grace period: structured WARN + proceed.
  //   * expected matches actual — proceed.
  //   * expected != actual — raise CrossInstallationViolation BEFORE any UPDATE / event emit.
  if (actualInstallationId === null) {
    throw new RepositoriesResolveFailed(
      `transitionRun: cannot resolve core.repositories.installation_id for review_id=${reviewId} ` +
        `(run_id=${runId}). The review_runs and pull_request_reviews rows exist but the repositories ` +
        `JOIN returned no row (or installation_id IS NULL). Data integrity break — investigate the ` +
        `repositories table state for github_repo_id corresponding to this review.`,
    );
  }
  if (expectedInstallationId === undefined) {
    // Structured WARN grace-period notice (1:1 with the Python `_LOG.warning`); no logger seam in the
    // domain layer yet — `console.warn` is the sanctioned stderr surface here.
    console.warn(
      `cross-installation: ${BF9_PRIMITIVE_NAME} called without expectedInstallationId; ` +
        `Phase B will require it. key_kind=${BF9_KEY_KIND} key_value=${runId}`,
    );
  } else if (actualInstallationId !== expectedInstallationId) {
    throw new CrossInstallationViolation({
      primitive: BF9_PRIMITIVE_NAME,
      keyKind: BF9_KEY_KIND,
      keyValue: runId,
      expectedInstallationId,
      actualInstallationId,
    });
  }

  // ── Step 4 (branch): idempotency — AD-8. A re-attempted transition lands on the same target state;
  // treat as success, no DB mutation, no event emit (no double-count of the AD-5 counters either). ──
  if (currentState === toState) {
    return TransitionOutcome.ALREADY_APPLIED;
  }

  if (currentState !== fromState) {
    throw new StateDrift({ runId, expectedFrom: fromState, actualState: currentState });
  }

  // ── Step 4 (flip): the AD-7 forward + inverse CHECK constraints require the state flip AND the
  // terminal timestamp column to land in ONE UPDATE so no constraint observes the row mid-transition.
  // The SET clause is composed from string literals + the static TERMINAL_TIMESTAMP_COLUMNS lookup (keys
  // are validated `toState` values); every value is bound via a parameterised `sql` fragment — no user
  // input enters the SQL string (mirrors the Python's `noqa: S608` static-composition note). ──
  const setClauses: Array<RawBuilder<unknown>> = [sql`lifecycle_state = ${toState}`];
  const tcol = TERMINAL_TIMESTAMP_COLUMNS.get(toState);
  if (tcol !== undefined) {
    // `sql.ref(tcol)` injects the validated column NAME as an identifier (not a bound value); the
    // timestamp itself is a bound parameter from the injected clock.
    setClauses.push(sql`${sql.ref(tcol)} = ${effectiveClock.now()}`);
  }
  // tenant:exempt reason=PK-update-by-run_id follow_up=PERMANENT-EXEMPTION-review-runs-pk
  await sql`
    UPDATE core.review_runs
       SET ${sql.join(setClauses, sql`, `)}
     WHERE run_id = ${runId}
  `.execute(tx);

  // ── Step 5: emit the lifecycle_transition event (AD-3). deliveryId is null — lifecycle transitions are
  // internally generated, never tied to a provider webhook delivery. run_id is the run being
  // transitioned; review_id is the denormalized analytics-join key. ──
  await emitWorkflowEvent({
    dbOrTx: tx,
    provider,
    runId,
    reviewId,
    eventType: "lifecycle_transition",
    payload: {
      from: fromState,
      to: toState,
      activity,
      attempt,
      worker_id: workerId,
      duration_ms: durationMs,
      reason,
    },
    deliveryId: null,
    installationId: actualInstallationId, // BF-3 Phase B
    clock: effectiveClock,
  });

  // ── AD-5 layer-5 telemetry (Phase 4 / Task 5). Counter emits live on the APPLIED branch so a Temporal
  // retry that hits the AD-8 ALREADY_APPLIED branch does NOT double-count. NULL cancel_reason is reported
  // as a literal string per the OTel attribute-value contract (no null values). Each emit is queued
  // behind emitAfterCommit (BF-15) so it only fires on a successful transaction commit; on rollback the
  // queued emit is dropped — no drift between the OTel counter and the DB row count. ──
  if (toState === "FAILED") {
    emitAfterCommit(pending, () =>
      RUNS_FAILED.add(1, {
        trigger_type: triggerType,
        cancel_reason: cancelReason ?? "none",
      }),
    );
  } else if (toState === "CANCELLED") {
    emitAfterCommit(pending, () =>
      RUNS_CANCELLED.add(1, { cancel_reason: cancelReason ?? "unknown" }),
    );
    // Draining gauge: increment on entry to CANCELLED; Task 8 emits the matching decrement on
    // RUN_DRAIN_COMPLETED.
    emitAfterCommit(pending, () => RUNS_DRAINING.add(1));
  }

  return TransitionOutcome.APPLIED;
}
