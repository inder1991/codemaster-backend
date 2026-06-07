// The 4 OutboxDispatcherWorkflow activities (1:1 with the @activity.defn functions in
// vendor/codemaster-py/codemaster/activities/outbox.py: claim_pending_rows / dispatch_row /
// mark_dispatched / mark_attempt_failed). Bundled in one collaborator-injected holder (Shape B) —
// buildOutboxActivities constructs it once at worker boot and registers the four arrow-property methods.
//
// Activities run in the NORMAL Node runtime (NOT the workflow V8-isolate sandbox), so they freely touch
// Postgres + the injected Clock. Each registered method takes exactly ONE typed input (CLAUDE.md
// invariant 11); the #guardTransitionAndIngest helper is private (not registered), so its multi-arg shape
// is fine.

import { type Kysely, sql, type Transaction } from "kysely";

import type { OutboxRow, PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import { assertCurrentRun, StaleWriteError } from "#backend/domain/stale_write_guard.js";
import { TransitionOutcome, transitionRun } from "#backend/domain/transition_run.js";
import { emitWorkflowEvent } from "#backend/ingest/_workflow_events_repository.js";
import { PendingEmits } from "#backend/infra/post_commit_emit.js";
import { getSink, type SinkContext } from "#backend/outbox/sink_registry.js";

import { type Clock } from "#platform/clock.js";

import {
  ClaimPendingRowsInputV1,
  DispatchRowInputV1,
  MarkAttemptFailedInputV1,
  MarkDispatchedInputV1,
} from "#contracts/outbox_dispatch.v1.js";

export type OutboxDispatchActivitiesOptions = {
  repo: PostgresOutboxRepo;
  /** The dispatcher's own connection (its own pool; ADR-0062 cached engine). */
  db: Kysely<unknown>;
  clock: Clock;
  /** `cfg.max_attempts` — the dead-letter threshold the markAttemptFailed activity injects (default 5). */
  maxAttempts: number;
};

export class OutboxDispatchActivities {
  readonly #repo: PostgresOutboxRepo;
  readonly #db: Kysely<unknown>;
  readonly #clock: Clock;
  readonly #maxAttempts: number;

  public constructor(o: OutboxDispatchActivitiesOptions) {
    // 1:1 with the Python configure() ValueError, hardened against an env-sourced NaN (Number("abc")):
    // `NaN < 1` is false, so a plain `< 1` check would let a non-dead-lettering threshold through.
    if (!Number.isInteger(o.maxAttempts) || o.maxAttempts < 1) {
      throw new Error(`max_attempts must be an integer >= 1; got ${String(o.maxAttempts)}`);
    }
    this.#repo = o.repo;
    this.#db = o.db;
    this.#clock = o.clock;
    this.#maxAttempts = o.maxAttempts;
  }

  /** `claim_pending_rows` — lease a batch of pending rows for the dispatcher loop. */
  public readonly claimPendingRows = async (input: ClaimPendingRowsInputV1): Promise<Array<OutboxRow>> => {
    const v = ClaimPendingRowsInputV1.parse(input); // boundary validation (parity with the Python data-converter)
    return this.#repo.claimPending({
      db: this.#db,
      batchSize: v.batch_size,
      leaseSeconds: v.lease_seconds,
    });
  };

  /**
   * `dispatch_row` — resolve the sink + invoke it. For review-causal rows (run_id && review_id present) the
   * AD-4 stale-write guard + PENDING→RUNNING lifecycle transition + INGESTED milestone run FIRST in one
   * transaction (a superseded run cannot drive the downstream durable mutation). Bootstrap-sink rows
   * (installation_reconcile / sync_code_owners, whose review_id is null) skip the guard block entirely.
   */
  public readonly dispatchRow = async (input: DispatchRowInputV1): Promise<void> => {
    // Boundary validation FIRST — restores the DispatchRowInputV1.superRefine tagged-union guard
    // (installation_id null IFF orphan_reason set) that the Python pydantic_data_converter re-runs on
    // activity-side deserialization. The TS stock JSON converter does not, so without this the BF-3
    // NULL-tenant-column invariant would be enforced nowhere at runtime.
    const v = DispatchRowInputV1.parse(input);

    const handler = getSink(v.sink); // throws UnknownSinkError BEFORE any DB work (1:1 with Python)

    if (v.run_id !== null && v.review_id !== null) {
      await this.#guardTransitionAndIngest(v, v.run_id, v.review_id);
    }

    const context: SinkContext = {
      deliveryId: null, // DispatchRowInput carries no delivery_id field
      installationId: v.installation_id,
      runId: v.run_id,
    };

    // SEAM (heartbeat — DEFER §D4): the lease-extend loop is not ported. The only live sink
    // (temporal_workflow_start) completes sub-second, well within the 10s claim lease. A handler that could
    // run 10–60s (the dispatchRow start-to-close timeout) would lose its lease and risk double-dispatch
    // without this. Activate by spawning a `this.#repo.extendLease` loop on `this.#clock.sleep` here.
    const heartbeat = this.#startLeaseHeartbeat();
    try {
      // SEAM (trace-restore — DEFER §E): OTel trace-context restore is not ported. `v.trace_context` is
      // carried through the contract but not bound to the OTel context here (fail-open — Python's
      // bind_trace_context({}) is a no-op for empty context). Activate by binding it around this call.
      await handler({ payload: v.payload, context });
    } finally {
      heartbeat.stop();
    }
  };

  /**
   * `mark_dispatched` — final pending→dispatched transition (idempotent; redrive → repo returns null). The
   * dispatch-to-done histogram from the returned timing is deferred with the OTel surface (§D5).
   */
  public readonly markDispatched = async (input: MarkDispatchedInputV1): Promise<void> => {
    const v = MarkDispatchedInputV1.parse(input);
    await this.#repo.markDispatched({ db: this.#db, id: v.row_id });
    // SEAM (OTel — DEFER §D5): on a non-null return, record the dispatch-to-done histogram from the timing.
  };

  /**
   * `mark_attempt_failed` — atomic increment + dead-letter at `maxAttempts` (R-6 redrive-safe via the
   * input's expected_attempts). Emits the canonical `outbox.dead_letter` signal EXACTLY ONCE when the row
   * crosses into 'dead' (the repo's `null` on a redrive suppresses a duplicate signal).
   */
  public readonly markAttemptFailed = async (input: MarkAttemptFailedInputV1): Promise<void> => {
    const v = MarkAttemptFailedInputV1.parse(input);
    const result = await this.#repo.markAttemptFailed({
      db: this.#db,
      id: v.row_id,
      error: v.error,
      maxAttempts: this.#maxAttempts,
      expectedAttempts: v.expected_attempts,
    });
    if (result?.state === "dead") {
      // SEAM (OTel — DEFER §D5): OUTBOX_DEAD_LETTER_COUNTER.add(1, { sink: result.sink }). The structured
      // log is the live signal SREs page off until the OTel counter is wired.
      console.error(
        JSON.stringify({
          event: "outbox.dead_letter",
          row_id: v.row_id,
          sink: result.sink,
          error: v.error,
        }),
      );
    }
  };

  /**
   * The guard + lifecycle + INGESTED block (1:1 with the Python dispatch_row guard, outbox.py:633-721).
   * One transaction: the AD-4 stale-write guard (in a raw SAVEPOINT so its forensic STALE_WRITE_BLOCKED
   * row survives the re-raise), then PENDING→RUNNING, then the INGESTED milestone gated on APPLIED (a
   * Temporal retry observes ALREADY_APPLIED → no duplicate milestone). `pending` collects the post-commit
   * OTel emits, drained only after a successful commit.
   */
  async #guardTransitionAndIngest(input: DispatchRowInputV1, runId: string, reviewId: string): Promise<void> {
    const pending = new PendingEmits();

    await this.#db.transaction().execute(async (txTyped) => {
      // The cross-subsystem seams accept a schema-agnostic Transaction<unknown> (they run raw `sql` + do
      // their own `instanceof Transaction` check). Widen once; the runtime handle is the same.
      const tx = txTyped as unknown as Transaction<unknown>;

      // FIRST: the AD-4 guard in a raw SAVEPOINT. RELEASE (not ROLLBACK TO) on a StaleWriteError merges the
      // guard's forensic INSERT into the outer transaction (1:1 with Python's begin_nested + sp.commit()),
      // then the re-raise propagates out of .execute() → outer rollback (no partial state).
      await sql`SAVEPOINT sp_outbox_stale_write_guard`.execute(tx);
      try {
        await assertCurrentRun({
          tx,
          runId,
          reviewId,
          site: "outbox_dispatcher.dispatch_row",
          pending,
          clock: this.#clock,
        });
      } catch (err) {
        if (err instanceof StaleWriteError) {
          await sql`RELEASE SAVEPOINT sp_outbox_stale_write_guard`.execute(tx);
        }
        throw err;
      }
      await sql`RELEASE SAVEPOINT sp_outbox_stale_write_guard`.execute(tx);

      // THEN: advance PENDING → RUNNING. transitionRun raises StateDrift if the run drifted (e.g. CANCELLED
      // via operator-supersede) → propagates → the sink is NOT invoked. Returns ALREADY_APPLIED on retry.
      const outcome = await transitionRun({
        tx,
        runId,
        fromState: "PENDING",
        toState: "RUNNING",
        activity: "outbox_dispatcher.dispatch_row",
        attempt: 1,
        pending,
        clock: this.#clock,
      });

      // THEN: the INGESTED milestone, gated on APPLIED so a Temporal at-least-once retry (ALREADY_APPLIED)
      // does not duplicate it. provider falls back to "github" only defensively (the JOIN resolves it).
      if (outcome === TransitionOutcome.APPLIED) {
        const ingestedPayload: Record<string, unknown> = { outbox_id: input.row_id, sink: input.sink };
        if (input.orphan_reason !== null) {
          ingestedPayload.orphan_reason = input.orphan_reason; // forward-compat with the orphan runtime guard
        }
        await emitWorkflowEvent({
          dbOrTx: tx,
          provider: input.provider ?? "github",
          runId,
          reviewId,
          eventType: "INGESTED",
          payload: ingestedPayload,
          deliveryId: null,
          installationId: input.installation_id,
          clock: this.#clock,
        });
      }
    });

    // After COMMIT: fire the queued OTel emits (e.g. the guard's stale-write counter — none on the happy
    // path). On rollback we never reach here, so they're dropped (BF-15 commit-aligned semantics).
    pending.drain();
  }

  /** SEAM (heartbeat — DEFER §D4): no-op until the lease-extend loop is activated (see dispatchRow). */
  #startLeaseHeartbeat(): { stop(): void } {
    return {
      stop(): void {
        /* no-op until the heartbeat loop is activated */
      },
    };
  }
}
