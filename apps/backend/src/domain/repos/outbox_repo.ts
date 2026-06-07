// Canonical write surface for `core.outbox` — Layer-2 typed producer repo. 1:1 port of
// vendor/codemaster-py/codemaster/domain/repos/outbox_repo.py (PostgresOutboxRepo / OutboxRepoPort).
//
// Three typed factory methods — one per workflow-causality class (ADR-0053). The method SIGNATURE is the
// enforcement layer (what SQL CHECK cannot express):
//   - appendReviewDispatch(runId, …)   — runId REQUIRED by signature; the type system refuses null.
//   - appendNonReviewDispatch(workflowType, …) — NO runId parameter (bootstrap sinks: sync_code_owners,
//     refresh_semantic_docs, …). A producer-drift WARN fires if a review workflowType is passed here.
//   - appendReconcile(…)               — NO runId / installationId (the installation_reconcile schema
//     exemption: ck_outbox_installation_id_required permits NULL installation_id only for that sink).
//
// Stateless — methods take the executor (a Kysely or a Transaction) so the INSERT joins the caller's
// transaction (the webhook persistence writes audit + idempotency + run-allocation + outbox atomically).

import { type Kysely, sql } from "kysely";

import { WallClock, type Clock } from "#platform/clock.js";
import { SystemRandom } from "#platform/randomness.js";

// ─── uuid4 minter (via the platform randomness seam — the clock/random gate bans raw crypto.randomUUID
//     outside the seam; mint v4 from tokenBytes(16), the sanctioned CSPRNG entry point). 1:1 shape with
//     the Python `uuid.uuid4()`. ───
const RANDOM = new SystemRandom();
function uuid4(): string {
  const b = Buffer.from(RANDOM.tokenBytes(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The `core.outbox.sink` values (Python `OutboxSink`). */
export const OUTBOX_SINK_TEMPORAL_WORKFLOW_START = "temporal_workflow_start";
export const OUTBOX_SINK_INSTALLATION_RECONCILE = "installation_reconcile";

/** Payload schema-version constants (Python contracts/outbox_row/v1.py). */
export const OUTBOX_PAYLOAD_SCHEMA_VERSION = 2;
export const RECONCILE_PAYLOAD_SCHEMA_VERSION = 1;

/** Review workflow types — dispatching one of these via {@link PostgresOutboxRepo.appendNonReviewDispatch}
 *  is producer drift. The TS review workflow type is `reviewPullRequest` (the registered Temporal type). */
export const REVIEW_WORKFLOW_TYPES: ReadonlySet<string> = new Set(["reviewPullRequest"]);

/** A Kysely instance or an open Transaction — the executor the raw `sql` runs on. */
type Executor = Kysely<unknown>;

/** A claimed outbox row (Python `OutboxRow`) — projected by {@link PostgresOutboxRepo.claimPending} for the
 *  dispatcher (run_id/review_id/provider feed the stale-write guard + the INGESTED emit). */
export type OutboxRow = {
  id: string;
  sink: string;
  payload: Record<string, unknown>;
  schemaVersion: number;
  attempts: number;
  traceContext: Record<string, unknown>;
  runId: string | null;
  reviewId: string | null;
  provider: string | null;
  installationId: string | null;
};

export class PostgresOutboxRepo {
  readonly #clock: Clock;

  /** The {@link Clock} is used ONLY by the consumer methods (leased_until / dispatched_at /
   *  last_attempted_at). The producer appends rely on the schema's `created_at DEFAULT now()`. */
  public constructor(args: { clock?: Clock } = {}) {
    this.#clock = args.clock ?? new WallClock();
  }

  /** Append a review-workflow dispatch row. `runId` is required by signature. */
  public async appendReviewDispatch(args: {
    db: Executor;
    runId: string;
    payload: unknown;
    schemaVersion: number;
    installationId: string;
    deliveryId?: string | null;
    traceContext?: unknown;
  }): Promise<void> {
    await this.#insert({
      db: args.db,
      sink: OUTBOX_SINK_TEMPORAL_WORKFLOW_START,
      payload: args.payload,
      schemaVersion: args.schemaVersion,
      runId: args.runId,
      installationId: args.installationId,
      deliveryId: args.deliveryId ?? null,
      traceContext: args.traceContext ?? null,
    });
  }

  /** Append a non-review (bootstrap-sink) dispatch row — NO runId. Fires a producer-drift WARN if a review
   *  workflow type is passed (the safety net for what SQL cannot constrain). */
  public async appendNonReviewDispatch(args: {
    db: Executor;
    workflowType: string;
    payload: unknown;
    schemaVersion: number;
    installationId: string;
    deliveryId?: string | null;
    traceContext?: unknown;
  }): Promise<void> {
    if (REVIEW_WORKFLOW_TYPES.has(args.workflowType)) {
      console.warn(
        JSON.stringify({ event: "outbox_producer_drift", workflow_type: args.workflowType }),
      );
    }
    await this.#insert({
      db: args.db,
      sink: OUTBOX_SINK_TEMPORAL_WORKFLOW_START,
      payload: args.payload,
      schemaVersion: args.schemaVersion,
      runId: null,
      installationId: args.installationId,
      deliveryId: args.deliveryId ?? null,
      traceContext: args.traceContext ?? null,
    });
  }

  /** Append an installation-reconcile row — NO runId / installationId (the sink's schema exemption). */
  public async appendReconcile(args: {
    db: Executor;
    payload: unknown;
    schemaVersion: number;
    deliveryId?: string | null;
    traceContext?: unknown;
  }): Promise<void> {
    await this.#insert({
      db: args.db,
      sink: OUTBOX_SINK_INSTALLATION_RECONCILE,
      payload: args.payload,
      schemaVersion: args.schemaVersion,
      runId: null,
      installationId: null,
      deliveryId: args.deliveryId ?? null,
      traceContext: args.traceContext ?? null,
    });
  }

  /** Single canonical INSERT — every column bound (Python `_insert`). `created_at` / `attempts` / `state`
   *  use the schema DEFAULTs (server clock / 0 / 'pending'). */
  async #insert(args: {
    db: Executor;
    sink: string;
    payload: unknown;
    schemaVersion: number;
    runId: string | null;
    installationId: string | null;
    deliveryId: string | null;
    traceContext: unknown;
  }): Promise<void> {
    const payloadJson = JSON.stringify(args.payload);
    const traceJson = args.traceContext !== null ? JSON.stringify(args.traceContext) : null;
    await sql`
      INSERT INTO core.outbox
        (id, sink, payload, schema_version, run_id, trace_context, delivery_id, installation_id)
      VALUES (
        ${uuid4()}, ${args.sink}, CAST(${payloadJson} AS JSONB),
        ${args.schemaVersion}, ${args.runId},
        CAST(${traceJson} AS JSONB), ${args.deliveryId}, ${args.installationId}
      )
    `.execute(args.db);
  }

  // ─── Consumer side (the dispatcher) ──────────────────────────────────────────────────────────────

  /**
   * Claim up to `batchSize` pending rows for `leaseSeconds` (Python `claim_pending_rows`). `FOR UPDATE OF o
   * SKIP LOCKED` so concurrent dispatcher pods see disjoint sets; sets `leased_until` so a crashed pod's
   * rows become eligible again after the lease. LEFT JOINs review_runs + pull_request_reviews to project
   * review_id + provider for the dispatcher's stale-write guard + INGESTED emit. The lease window is
   * computed in SQL from the injected clock's `now` (no `new Date()` — the clock/random gate).
   */
  public async claimPending(args: {
    db: Executor;
    batchSize?: number;
    leaseSeconds?: number;
  }): Promise<Array<OutboxRow>> {
    const batchSize = args.batchSize ?? 100;
    const leaseSeconds = args.leaseSeconds ?? 60;
    const now = this.#clock.now();
    return args.db.transaction().execute(async (tx) => {
      const claimed = await sql<{
        id: string;
        sink: string;
        payload: Record<string, unknown>;
        schema_version: number;
        attempts: number;
        trace_context: Record<string, unknown> | null;
        run_id: string | null;
        review_id: string | null;
        provider: string | null;
        installation_id: string | null;
      }>`
        SELECT o.id, o.sink, o.payload, o.schema_version, o.attempts, o.trace_context,
               o.run_id, rr.review_id, pr.provider, o.installation_id
          FROM core.outbox AS o
          LEFT JOIN core.review_runs AS rr ON rr.run_id = o.run_id
          LEFT JOIN core.pull_request_reviews AS pr ON pr.review_id = rr.review_id
         WHERE o.state = 'pending'
           AND (o.leased_until IS NULL OR o.leased_until < ${now})
         ORDER BY o.created_at
         LIMIT ${batchSize}
         FOR UPDATE OF o SKIP LOCKED
      `.execute(tx);
      const rows = claimed.rows;
      if (rows.length === 0) {
        return [];
      }
      const ids = rows.map((r) => r.id);
      await sql`
        UPDATE core.outbox
           SET leased_until = ${now}::timestamptz + ${leaseSeconds} * interval '1 second'
         WHERE id IN (${sql.join(ids)})
      `.execute(tx);
      return rows.map((r) => ({
        id: r.id,
        sink: r.sink,
        payload: r.payload,
        schemaVersion: r.schema_version,
        attempts: r.attempts,
        traceContext: r.trace_context ?? {},
        runId: r.run_id,
        reviewId: r.review_id,
        provider: r.provider,
        installationId: r.installation_id,
      }));
    });
  }

  /**
   * Final transition pending → dispatched (Python `mark_dispatched`). Idempotent under Temporal redrive:
   * the `AND state = 'pending'` guard makes a duplicate execution a rowcount-0 no-op. RETURNING the timing
   * columns feeds the dispatch-to-done histogram (the activity records it; the OTel emit is deferred).
   * Returns `null` when the row was already dispatched (redrive).
   */
  public async markDispatched(args: {
    db: Executor;
    id: string;
  }): Promise<{ lastAttemptedAt: Date | null; createdAt: Date | null } | null> {
    const result = await sql<{ last_attempted_at: Date | null; created_at: Date | null }>`
      UPDATE core.outbox
         SET state = 'dispatched', dispatched_at = ${this.#clock.now()}, leased_until = NULL
       WHERE id = ${args.id} AND state = 'pending'
       RETURNING last_attempted_at, created_at
    `.execute(args.db);
    const row = result.rows[0];
    return row ? { lastAttemptedAt: row.last_attempted_at, createdAt: row.created_at } : null;
  }

  /**
   * Atomically increment attempts and dead-letter at the threshold (Python `mark_attempt_failed`, S14.5.D).
   * A SINGLE UPDATE handles both "retry" (state unchanged) and "exhausted" (`attempts + 1 >= maxAttempts`
   * → 'dead') — no torn-state window where another pod re-claims between two writes. The `AND attempts =
   * expectedAttempts` guard (R-6) makes a Temporal redrive a rowcount-0 no-op rather than a double-
   * increment → spurious dead-letter. RETURNING `{state, sink}` lets the activity emit the canonical
   * dead-letter signal exactly once. Returns `null` when the guard rejected the write (redrive).
   */
  public async markAttemptFailed(args: {
    db: Executor;
    id: string;
    error: string;
    maxAttempts: number;
    expectedAttempts: number;
  }): Promise<{ state: string; sink: string } | null> {
    const result = await sql<{ state: string; sink: string }>`
      UPDATE core.outbox
         SET attempts = attempts + 1,
             last_error = ${args.error.slice(0, 1024)},
             last_attempted_at = ${this.#clock.now()},
             leased_until = NULL,
             state = CASE WHEN attempts + 1 >= ${args.maxAttempts} THEN 'dead' ELSE state END
       WHERE id = ${args.id} AND attempts = ${args.expectedAttempts}
       RETURNING state, sink
    `.execute(args.db);
    return result.rows[0] ?? null;
  }

  /**
   * Extend a held lease (Python `extend_lease`) — the substrate for the dispatch heartbeat (the heartbeat
   * loop is deferred; this method lands now so the seam stays clean). Also usable standalone for ops.
   */
  public async extendLease(args: { db: Executor; id: string; leaseSeconds: number }): Promise<void> {
    await sql`
      UPDATE core.outbox
         SET leased_until = ${this.#clock.now()}::timestamptz + ${args.leaseSeconds} * interval '1 second'
       WHERE id = ${args.id}
    `.execute(args.db);
  }

  /** Terminal dead-letter, ops-only manual path (Python `mark_dead`). The dispatcher reaches 'dead' via the
   *  atomic {@link markAttemptFailed} CASE; this remains for operator-driven dead-lettering. */
  public async markDead(args: { db: Executor; id: string; error: string }): Promise<void> {
    await sql`
      UPDATE core.outbox
         SET state = 'dead', last_error = ${args.error.slice(0, 1024)},
             last_attempted_at = ${this.#clock.now()}, leased_until = NULL
       WHERE id = ${args.id}
    `.execute(args.db);
  }
}
