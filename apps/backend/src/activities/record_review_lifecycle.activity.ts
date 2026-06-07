/**
 * Run-state lifecycle activities — REAL de-stubbed ports of the frozen Python `@activity.defn`s in
 * `vendor/codemaster-py/codemaster/activities/record_review_lifecycle.py` (Phase 4 Task 4 + BF-5 + BF-13).
 *
 * The review activity composes the analysis-stage milestones into the `audit.workflow_events` stream and
 * advances `core.review_runs.lifecycle_state` to its terminal state at the boundaries of the workflow.
 * This module owns the four activities the workflow body calls at those boundaries:
 *
 *   {@link recordReviewLifecycleEvent} — emits ONE granular `audit.workflow_events` row of the given
 *     type (`ANALYSIS_STARTED` or `ANALYZED`) for the run. Idempotent under Temporal at-least-once retry:
 *     a duplicate call for the same `(run_id, event_type)` is a no-op via a pre-INSERT SELECT.
 *   {@link finalizeReviewRun} — advances `lifecycle_state` RUNNING → COMPLETED via {@link transitionRun}.
 *     AD-8 idempotency: a Temporal retry observes ALREADY_APPLIED on the second call and is a no-op.
 *   {@link recordRunFailed} — RUNNING → FAILED (BF-5). The workflow body's outermost try/except calls
 *     this with the captured exception class + truncated first message line, then re-raises.
 *   {@link recordRunCancelled} — RUNNING → CANCELLED (BF-13). The workflow body's outermost
 *     `CancelledError` clause calls this, then re-raises.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox — so they open DB
 * sessions / transactions freely (the workflow body cannot). Production resolves the `db` from
 * `CODEMASTER_PG_CORE_DSN` (the ADR-0062 process-shared single pool per DSN); tests inject a disposable-PG
 * `db` + a {@link FakeClock}. Each activity owns its OWN one-shot transaction and (for the three
 * transition activities) its OWN {@link PendingEmits} collector — created before the transaction, drained
 * once AFTER it commits, dropped on rollback (BF-15: the AD-5 counters stay aligned with the DB state).
 *
 * ## ANALYZED vs FINDINGS_PERSISTED
 *
 * `FINDINGS_PERSISTED` is intentionally NOT emittable via {@link recordReviewLifecycleEvent} — it lives
 * inside the findings-repo INSERT transaction so the milestone shares the durable mutation's fate;
 * emitting it from a separate activity would race the durable write. The allow-list rejects it (and any
 * lifecycle-transition / stale-write event-type) at the boundary.
 */

import { type Kysely, sql, type Transaction } from "kysely";

import { tenantKysely } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";

import {
  emitWorkflowEvent,
  EVENT_TYPES,
} from "../ingest/_workflow_events_repository.js";
import { PendingEmits } from "../infra/post_commit_emit.js";
import { transitionRun } from "../domain/transition_run.js";

import type {
  FinalizeReviewRunInput,
  RecordReviewLifecycleEventInput,
  RecordRunCancelledInput,
  RecordRunFailedInput,
} from "#contracts/record_review_lifecycle_inputs.v1.js";

/**
 * Granular event types {@link recordReviewLifecycleEvent} is allowed to emit (1:1 with the Python
 * `_ALLOWED_GRANULAR_EVENTS`). `FINDINGS_PERSISTED` is intentionally excluded — see the module docstring.
 */
export const ALLOWED_GRANULAR_EVENTS: ReadonlySet<string> = new Set<string>([
  "ANALYSIS_STARTED",
  "ANALYZED",
]);

/**
 * Injected collaborators shared by all four activities. Both OPTIONAL — production resolves the `db` from
 * `CODEMASTER_PG_CORE_DSN` (the ADR-0062 shared pool) + uses a {@link WallClock}; tests inject a
 * disposable-PG `db` + a {@link FakeClock}.
 */
export type RecordReviewLifecycleDeps = {
  /** Kysely over the shared ADR-0062 pool. When omitted, built from `CODEMASTER_PG_CORE_DSN`. */
  db?: Kysely<unknown>;
  /** Time seam; default {@link WallClock}. Governs the terminal-timestamp stamp + the event `received_at`. */
  clock?: Clock;
};

/** Resolve the Kysely handle: the injected one, else built from `CODEMASTER_PG_CORE_DSN`. */
function resolveDb(deps: RecordReviewLifecycleDeps): Kysely<unknown> {
  if (deps.db !== undefined) {
    return deps.db;
  }
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set and no db injected; cannot run a review-lifecycle activity",
    );
  }
  return tenantKysely<unknown>(dsn);
}

/**
 * Emit ONE granular `audit.workflow_events` row, idempotently (1:1 with the frozen Python
 * `record_review_lifecycle_event_activity`).
 *
 * Pre-INSERT idempotency: a SELECT under the open transaction checks whether an event of this type
 * already exists for the `run_id`. If so, the call is a no-op — Temporal at-least-once retries must NOT
 * double-emit the milestone. Validates `event_type` against {@link ALLOWED_GRANULAR_EVENTS} at the
 * boundary so the activity refuses to emit lifecycle transitions / stale-write / FINDINGS_PERSISTED via
 * this path (those have dedicated emit sites), and (belt-and-braces) against {@link EVENT_TYPES} so a
 * future schema bump catches allow-list drift.
 *
 * @throws {Error} `event_type` not in {@link ALLOWED_GRANULAR_EVENTS} (the Python `ValueError`), OR not in
 *                 {@link EVENT_TYPES} (the table-CHECK defensive analogue).
 */
export async function recordReviewLifecycleEvent(
  req: RecordReviewLifecycleEventInput,
  deps: RecordReviewLifecycleDeps = {},
): Promise<void> {
  if (!ALLOWED_GRANULAR_EVENTS.has(req.event_type)) {
    throw new Error(
      `recordReviewLifecycleEvent: event_type=${JSON.stringify(req.event_type)} not allowed via this ` +
        `path; permitted values: ${JSON.stringify([...ALLOWED_GRANULAR_EVENTS].sort())}. ` +
        `FINDINGS_PERSISTED emits from the findings-repo INSERT txn; lifecycle_transition emits from ` +
        `transitionRun; STALE_WRITE_BLOCKED emits from assertCurrentRun.`,
    );
  }
  // Defensive: belt-and-braces against EVENT_TYPES too so a future schema bump catches drift between
  // this allow-list and the table CHECK.
  if (!EVENT_TYPES.has(req.event_type)) {
    throw new Error(
      `recordReviewLifecycleEvent: event_type=${JSON.stringify(req.event_type)} not in EVENT_TYPES ` +
        `(table CHECK constraint)`,
    );
  }

  const clock: Clock = deps.clock ?? new WallClock();
  const db = resolveDb(deps);

  await db.transaction().execute(async (tx: Transaction<unknown>) => {
    // Idempotency guard: skip the emit when an event of this type already exists for the run. Inside the
    // open txn so a concurrent emit racing on the same (run_id, event_type) would observe one another;
    // the common case (Temporal retry of the same activity) is non-concurrent and the SELECT suffices.
    // tenant:exempt reason=audit-event-stream-keyed-by-run-id follow_up=PERMANENT-EXEMPTION-review-lifecycle-event-idempotency
    const existing = await sql<{ one: number }>`
      SELECT 1 AS one FROM audit.workflow_events
       WHERE run_id = ${req.run_id} AND event_type = ${req.event_type}
       LIMIT 1
    `.execute(tx);
    if (existing.rows.length > 0) {
      return;
    }

    await emitWorkflowEvent({
      dbOrTx: tx,
      provider: req.provider,
      runId: req.run_id,
      reviewId: req.review_id,
      eventType: req.event_type,
      payload: req.payload,
      deliveryId: null,
      installationId: req.installation_id, // BF-3 Phase B (2026-05-17)
      clock,
    });
  });
}

/**
 * Open a one-shot transaction, run {@link transitionRun}, drain the post-commit emits. The shared driver
 * for the three terminal-transition activities (finalize / failed / cancelled). The {@link PendingEmits}
 * is created BEFORE the transaction + drained AFTER it commits (dropped on rollback — the AD-5 counters
 * stay aligned with the DB state, BF-15).
 */
async function driveTransition(
  db: Kysely<unknown>,
  args: {
    runId: string;
    fromState: string;
    toState: string;
    activity: string;
    attempt: number;
    workerId: string | null;
    durationMs: number | null;
    reason: string | null;
    clock: Clock;
  },
): Promise<void> {
  const pending = new PendingEmits();
  await db.transaction().execute(async (tx: Transaction<unknown>) => {
    await transitionRun({
      tx,
      runId: args.runId,
      fromState: args.fromState,
      toState: args.toState,
      activity: args.activity,
      attempt: args.attempt,
      workerId: args.workerId,
      durationMs: args.durationMs,
      reason: args.reason,
      clock: args.clock,
      pending,
    });
  });
  // The transaction committed (execute resolved); fire the queued AD-5 counter emits exactly once.
  pending.drain();
}

/**
 * Transition the run RUNNING → COMPLETED via the lifecycle primitive (1:1 with the frozen Python
 * `finalize_review_run_activity`). AD-8 idempotency: a Temporal retry observes ALREADY_APPLIED (the run
 * is already COMPLETED) and is a no-op — no second `lifecycle_transition` event, no second
 * terminal-timestamp stamp.
 *
 * @throws {StateDrift} the run row is missing OR the current `lifecycle_state` is neither RUNNING nor
 *                      COMPLETED (e.g. drifted to CANCELLED via a concurrent supersede).
 */
export async function finalizeReviewRun(
  req: FinalizeReviewRunInput,
  deps: RecordReviewLifecycleDeps = {},
): Promise<void> {
  const clock: Clock = deps.clock ?? new WallClock();
  const db = resolveDb(deps);
  await driveTransition(db, {
    runId: req.run_id,
    fromState: "RUNNING",
    toState: "COMPLETED",
    activity: "review_workflow.run",
    attempt: req.attempt,
    workerId: req.worker_id,
    durationMs: req.duration_ms,
    reason: null,
    clock,
  });
}

/**
 * Transition the run RUNNING → FAILED via the lifecycle primitive (BF-5; 1:1 with the frozen Python
 * `record_run_failed_activity`). Closes the AD-7 invariant `failed_at NOT NULL ⇒ state='FAILED'`: every
 * failure path stamps `failed_at` + emits one `lifecycle_transition` event with `to='FAILED'`. AD-8
 * idempotency: a Temporal retry observes ALREADY_APPLIED and is a no-op.
 *
 * @throws {StateDrift} the run drifted to a state other than RUNNING or FAILED (e.g. CANCELLED via a
 *                      concurrent supersede). The workflow body's outer try/except logs + swallows so the
 *                      original exception propagates — a drifted run already has a terminal state.
 */
export async function recordRunFailed(
  req: RecordRunFailedInput,
  deps: RecordReviewLifecycleDeps = {},
): Promise<void> {
  const clock: Clock = deps.clock ?? new WallClock();
  const db = resolveDb(deps);
  await driveTransition(db, {
    runId: req.run_id,
    fromState: "RUNNING",
    toState: "FAILED",
    activity: "review_workflow.run_failed",
    attempt: req.attempt,
    workerId: null,
    durationMs: null,
    reason: req.reason,
    clock,
  });
}

/**
 * Transition the run RUNNING → CANCELLED via the lifecycle primitive (BF-13; 1:1 with the frozen Python
 * `record_run_cancelled_activity`). Distinct from supersede-driven cancellation (which goes through the
 * dedicated `supersede_run` primitive and stamps `superseded_by_run_id`): this path stamps `cancelled_at`
 * only — the run was cancelled by an external signal, not displaced by a newer run. Closes the AD-7
 * invariant `cancelled_at NOT NULL ⇒ state='CANCELLED'`. AD-8 idempotency: a Temporal retry observes
 * ALREADY_APPLIED and is a no-op.
 *
 * @throws {StateDrift} the run drifted to a state other than RUNNING or CANCELLED (e.g. FAILED /
 *                      COMPLETED via a concurrent path). The workflow body's outer `CancelledError` clause
 *                      logs + swallows so the original `CancelledError` still propagates.
 */
export async function recordRunCancelled(
  req: RecordRunCancelledInput,
  deps: RecordReviewLifecycleDeps = {},
): Promise<void> {
  const clock: Clock = deps.clock ?? new WallClock();
  const db = resolveDb(deps);
  await driveTransition(db, {
    runId: req.run_id,
    fromState: "RUNNING",
    toState: "CANCELLED",
    activity: "review_workflow.run_cancelled",
    attempt: req.attempt,
    workerId: null,
    durationMs: null,
    reason: req.reason,
    clock,
  });
}
