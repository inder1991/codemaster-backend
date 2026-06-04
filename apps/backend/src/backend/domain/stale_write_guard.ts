/**
 * Stale-write guard primitive (AD-4, AD-5; Phase 2 Task 9) — 1:1 TypeScript/Kysely port of the frozen
 * Python `vendor/codemaster-py/codemaster/domain/stale_write_guard.py` (Phase 2.1 stale-write gate
 * part A2 of 3).
 *
 * Every durable mutation across the spine MUST validate that its `run_id` still matches
 * `core.pull_request_reviews.current_run_id` before it persists. This is the AD-4 authoritative-pointer
 * invariant and the AD-5 Layer 4 "stale-write guard" of the cancellation-propagation contract. The
 * primitive lives here as a single async function so every spine writer (findings persistence, comment
 * poster, outbox dispatcher, aggregator, summary update) calls the same code path with the same
 * forensic-emit semantics.
 *
 * ## Contract (1:1 with the Python `assert_current_run`)
 *
 * {@link assertCurrentRun}:
 *   - Acquires a `FOR SHARE` read lock on the review row (allows concurrent readers; blocks the
 *     supersede `UPDATE` — which takes `FOR UPDATE` — from racing in mid-check).
 *   - Returns (resolves `void`) when `current_run_id === runId` — the caller proceeds.
 *   - Throws {@link StaleWriteError} when the review is missing (orphan write — no telemetry/emit),
 *     when `current_run_id` is NULL (no active run to validate against), or when
 *     `current_run_id !== runId`.
 *   - On a mismatch (INCLUDING the NULL case) the primitive ALSO inserts a `STALE_WRITE_BLOCKED` row
 *     in `audit.workflow_events` carrying `{"current": <str|null>, "incoming": <str>, "site": <str>}`,
 *     AND queues the OTel counter `codemaster_review_runs_stale_write_blocked_total{site=...}` behind
 *     {@link emitAfterCommit} (fires on the caller's commit-drain, dropped on rollback), AND throws.
 *
 * ## Transaction discipline (the open-txn requirement is structural here)
 *
 * The Python source takes an `AsyncSession` and raises `RuntimeError` when `session.in_transaction()`
 * is false — without an open transaction the `FOR SHARE` lock releases at autocommit and the guard
 * degenerates to a TOCTOU check. The TS analogue is structural: {@link assertCurrentRun} accepts a
 * Kysely `Transaction<unknown>` handle (`tx`). Being inside a transaction is therefore guaranteed by
 * the type. We ALSO mirror the Python `RuntimeError` at runtime by rejecting a non-`Transaction`
 * handle, so a caller that passes the bare engine fails loudly the same way the Python caller does
 * when it forgets `async with session.begin():`.
 *
 * The `STALE_WRITE_BLOCKED` event INSERT runs on the SAME `tx` the caller's durable write runs on, so
 * the emit and the caller's mutation share transactional fate. The Python primitive does NOT commit;
 * it only `flush()`-es the INSERT so the FK / CHECK constraints trip synchronously inside this
 * function rather than later in opaque caller code. Kysely executes each `sql\`...\`.execute(tx)`
 * statement eagerly against the transaction's connection (there is no client-side statement buffer to
 * flush), so awaiting the INSERT `.execute(tx)` IS the flush — the constraints trip here, before the
 * throw.
 *
 * ## Caller idiom (part B wires the SAVEPOINT)
 *
 * The caller wraps the guard call in a SAVEPOINT and RELEASEs it on `StaleWriteError`. In Kysely that
 * is a nested `tx.transaction().execute(...)` (a SAVEPOINT) or a raw `sql\`SAVEPOINT sp\`` /
 * `sql\`RELEASE SAVEPOINT sp\`` / `sql\`ROLLBACK TO SAVEPOINT sp\``. This A2 port supplies the
 * STRUCTURE the part-B caller wraps.
 *
 * EMPIRICALLY VERIFIED (against the frozen Python on a real PG): under `persistAggregated`'s
 * outer-rollback path the `STALE_WRITE_BLOCKED` forensic row does **NOT** survive. RELEASE-savepoint
 * only MERGES the row into the outer transaction; it does not independently commit, so when the
 * `StaleWriteError` propagates out and rolls the outer transaction back, the forensic row is discarded
 * with it. The frozen Python `persist_aggregated` behaves identically (0 rows after rejection). A
 * caller that genuinely needs emit-survives-rollback semantics would have to commit the forensic emit
 * on a SEPARATE connection/transaction — neither this primitive nor the part-B caller does that, and
 * the reference does not either. (The original Python module docstring's "survives the outer rollback"
 * wording is aspirational, not what the code achieves — corrected here to the observed behavior.)
 * This primitive itself does not predict the outcome; it only emits + flushes + throws faithfully.
 *
 * The OTel counter is queued through {@link emitAfterCommit} (NOT fired inline), so it only fires when
 * the caller drains its {@link PendingEmits} after a successful commit — keeping the counter aligned
 * with the persisted `STALE_WRITE_BLOCKED` row count (no drift if the outer transaction rolls back).
 *
 * ## Forensics
 *
 * The `site` argument names the caller for the audit trail (convention `"<module>.<function>"`, e.g.
 * `"findings_aggregator.persistFindings"`). It is recorded in BOTH the `payload` JSON column AND on
 * the OTel counter, so operators pivot Grafana → log search → audit row on the same stable string.
 */

import { sql, Transaction } from "kysely";

import { type Clock, WallClock } from "#platform/clock.js";
import { getMeter, type Counter } from "#platform/observability/metrics.js";

import { SystemRandom } from "#platform/randomness.js";

import {
  runIdToLockKey,
  WORKFLOW_EVENTS_SEQ_LOCK_NAMESPACE,
} from "../ingest/_workflow_events_repository.js";

import { emitAfterCommit, type PendingEmits } from "../infra/post_commit_emit.js";

// ─── OTel counter (Layer 5 telemetry per AD-5) — name + description verbatim from the Python ────────

/** 1:1 with the Python `_STALE_WRITE_COUNTER_NAME`. */
const STALE_WRITE_COUNTER_NAME = "codemaster_review_runs_stale_write_blocked_total";
/** 1:1 with the Python `_STALE_WRITE_COUNTER_DESCRIPTION` (byte-identical text). */
const STALE_WRITE_COUNTER_DESCRIPTION =
  "Number of durable writes refused by the AD-4 stale-write guard. " +
  "Labelled by the writer call-site (e.g. " +
  "'findings_aggregator.persist_findings'). A sustained non-zero " +
  "rate indicates a producer that has not been wired through " +
  "supersede correctly, OR a cancellation-propagation race exceeding " +
  "the AD-5 SLA window.";

// Cache the instrument at module scope (created once at import) — mirrors the Python lazy-cache that
// avoids per-emit `create_counter` contention. `getMeter` returns a no-op Meter when no MeterProvider
// is registered, so creating + adding to this counter is always safe (see metrics.ts).
const STALE_WRITE_COUNTER: Counter = getMeter("codemaster.review_runs").createCounter(
  STALE_WRITE_COUNTER_NAME,
  { description: STALE_WRITE_COUNTER_DESCRIPTION },
);

// ─── uuid4 minter (via the platform randomness seam — NOT raw crypto; clock/random gate bans that) ──
//
// Same seam + bit-twiddling as A1's `_workflow_events_repository.ts::uuid4` (that helper is module-
// private there, so we mint locally through the SAME sanctioned `SystemRandom.tokenBytes(16)` entry
// point and set the RFC4122 version (0x4) + variant (0b10) bits). 1:1 in shape with `uuid.uuid4()`.

/** Module-shared CSPRNG seam. `tokenBytes` is the sanctioned crypto-randomness entry point. */
const RANDOM = new SystemRandom();

/** Mint a random RFC4122 v4 UUID (canonical lowercase hyphenated) via the platform randomness seam. */
function uuid4(): string {
  const b = Buffer.from(RANDOM.tokenBytes(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ─── StaleWriteError (1:1 with the Python `class StaleWriteError(Exception)`) ───────────────────────

/**
 * Raised by {@link assertCurrentRun} when an incoming durable write would persist against a
 * non-authoritative `run_id`. Carries the four identifiers needed to triage the blocked write:
 *
 *   - `runId`        — the `incoming` (stale) run on whose behalf the caller tried to write.
 *   - `reviewId`     — the PR review row the caller targeted.
 *   - `currentRunId` — the authoritative `run_id` per `pull_request_reviews.current_run_id` at the
 *                      moment of the check; `null` when the review row exists but has no active run
 *                      pointer (pre-flip race / just-cancelled), AND `null` on the orphan-write
 *                      (review-row-missing) branch.
 *   - `site`         — the caller-supplied `"<module>.<function>"` label.
 */
export class StaleWriteError extends Error {
  public readonly runId: string;
  public readonly reviewId: string;
  public readonly currentRunId: string | null;
  public readonly site: string;

  public constructor(args: {
    runId: string;
    reviewId: string;
    currentRunId: string | null;
    site: string;
    message: string;
  }) {
    super(args.message);
    this.name = "StaleWriteError";
    this.runId = args.runId;
    this.reviewId = args.reviewId;
    this.currentRunId = args.currentRunId;
    this.site = args.site;
  }
}

// ─── assertCurrentRun ───────────────────────────────────────────────────────────────────────────

/** Arguments for {@link assertCurrentRun}. `tx` MUST be an OPEN Kysely `Transaction`. */
export type AssertCurrentRunArgs = {
  /** Open transaction handle — the SAME one the caller's durable write runs on (shared fate). */
  tx: Transaction<unknown>;
  /** The `run_id` the caller claims to belong to. */
  runId: string;
  /** The `core.pull_request_reviews.review_id` row identity. */
  reviewId: string;
  /** Caller call-site `"<module>.<function>"` for forensics (payload + counter label). */
  site: string;
  /** Transaction-scoped collector; the OTel counter is queued here and fired on the caller's drain. */
  pending: PendingEmits;
  /** Injected clock; defaults to {@link WallClock}. The emitted `received_at` uses `clock.now()`. */
  clock?: Clock;
};

/**
 * Validate that `runId` is the authoritative run for `reviewId` (AD-4). Reads
 * `pull_request_reviews.current_run_id` under a `FOR SHARE` lock so it cannot race the supersede
 * `UPDATE` (`FOR UPDATE`). On a mismatch it emits the `STALE_WRITE_BLOCKED` forensic row, queues the
 * OTel counter, and throws. 1:1 with the Python `assert_current_run`.
 *
 * @throws {Error}           `tx` is not an open `Transaction` — the `session.in_transaction()`
 *                           `RuntimeError` analogue. Without an open transaction the `FOR SHARE` lock
 *                           releases at autocommit and the guard degrades to a TOCTOU check.
 * @throws {StaleWriteError} Review row missing (orphan write — no emit/telemetry), or
 *                           `current_run_id` is NULL, or `current_run_id !== runId`.
 */
export async function assertCurrentRun(args: AssertCurrentRunArgs): Promise<void> {
  const { tx, runId, reviewId, site, pending } = args;

  // Mirror the Python `session.in_transaction()` RuntimeError. A Kysely `Transaction` is structurally
  // in one; a bare `Kysely` engine is not, so reject it loudly (the analogue of the Python caller
  // forgetting `async with session.begin():`). Without a txn the FOR SHARE lock releases at autocommit
  // and the guard degenerates to a TOCTOU check.
  if (!(tx instanceof Transaction)) {
    throw new Error(
      "assertCurrentRun requires an already-open transaction. Pass the Kysely Transaction handle " +
        "from `db.transaction().execute(async (tx) => { ... })`. Without a txn, the FOR SHARE lock " +
        "releases at autocommit and the guard degrades to a TOCTOU check.",
    );
  }

  const clock: Clock = args.clock ?? new WallClock();

  // FOR SHARE: read lock on the review row. Multiple readers may hold this simultaneously; the
  // supersede transaction's FOR UPDATE is mutually exclusive. We fetch `provider` in the same trip so
  // the STALE_WRITE_BLOCKED emit can satisfy the NOT NULL `workflow_events.provider` column without a
  // second round-trip.
  // tenant:exempt reason=PK-lookup-by-review-id follow_up=FOLLOW-UP-gf3-error-mode
  const reviewResult = await sql<{ current_run_id: string | null; provider: string }>`
    SELECT current_run_id, provider
      FROM core.pull_request_reviews
     WHERE review_id = ${reviewId}
       FOR SHARE
  `.execute(tx);
  const reviewRow = reviewResult.rows[0];

  if (reviewRow === undefined) {
    // Orphan write — the review row doesn't exist. There is nothing to emit against (the
    // fk_workflow_events_review FK would reject the audit row), so we throw WITHOUT telemetry; the
    // caller's tenancy / persistence layer should already have rejected this case far earlier.
    throw new StaleWriteError({
      runId,
      reviewId,
      currentRunId: null,
      site,
      message: `stale-write guard (${site}): review_id=${reviewId} not found (orphan write)`,
    });
  }

  const currentRunId: string | null = reviewRow.current_run_id;
  const provider: string = reviewRow.provider;

  if (currentRunId === runId) {
    // Happy path. Caller proceeds with durable write.
    return;
  }

  // Mismatch — either current_run_id is NULL (no active run pointer) or it points at a different run.
  // Emit STALE_WRITE_BLOCKED, queue the counter, then throw. The emit attributes the blocked write to
  // the *incoming* (stale) run_id so an operator tracing the forensic log sees which run tried to
  // persist.
  //
  // BF-1 — per-run advisory lock serializes the MAX-then-INSERT pair against concurrent
  // emit_workflow_event callers for the same run_id. Released automatically at commit/rollback.
  await sql`SELECT pg_advisory_xact_lock(${WORKFLOW_EVENTS_SEQ_LOCK_NAMESPACE}, ${runIdToLockKey(
    runId,
  )})`.execute(tx);

  // tenant:exempt reason=audit-event-stream-keyed-by-run-id follow_up=PERMANENT-EXEMPTION-workflow-events-seq
  const seqResult = await sql<{ next_seq: number }>`
    SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_seq
      FROM audit.workflow_events
     WHERE run_id = ${runId}
  `.execute(tx);
  const seqRow = seqResult.rows[0];
  const nextSequenceNo = seqRow !== undefined ? Number(seqRow.next_seq) : 1;

  const payloadJson = stableJson({
    current: currentRunId === null ? null : currentRunId,
    incoming: runId,
    site,
  });

  // Direct raw INSERT (NOT through emitWorkflowEvent): STALE_WRITE_BLOCKED rows carry a NULL
  // installation_id by design — the Python writes the row directly, bypassing the BF-3 orphan guard,
  // and audit.workflow_events.installation_id is nullable with no CHECK. The INSERT omits the column
  // (DB leaves it NULL), so this raw SQL legitimately carries no installation_id token.
  // tenant:exempt reason=stale-write-forensic-emit-null-installation follow_up=PERMANENT-EXEMPTION-workflow-events-seq
  await sql`
    INSERT INTO audit.workflow_events
      (event_id, provider, delivery_id, run_id, review_id,
       sequence_no, event_type, payload, received_at)
    VALUES (${uuid4()}, ${provider}, ${null}, ${runId}, ${reviewId},
            ${nextSequenceNo}, ${"STALE_WRITE_BLOCKED"}, CAST(${payloadJson} AS jsonb),
            ${clock.now()})
  `.execute(tx);
  // Awaiting the INSERT `.execute(tx)` above IS the flush: Kysely runs it eagerly against the
  // transaction connection, so the FK (run_id / review_id) and event_type CHECK trip synchronously
  // HERE, never later in opaque caller code (mirrors the Python `await session.flush()`).

  // BF-15: queue the counter emit behind emitAfterCommit so it only fires on a successful commit of
  // the caller's transaction (the caller drains its PendingEmits after `.execute()` resolves). If the
  // caller rolls the outer transaction back, the counter stays aligned with the absent
  // STALE_WRITE_BLOCKED row — no drift between the counter and the audit-event row count.
  emitAfterCommit(pending, () => STALE_WRITE_COUNTER.add(1, { site }));

  throw new StaleWriteError({
    runId,
    reviewId,
    currentRunId,
    site,
    message:
      `stale-write guard (${site}): incoming run_id=${runId} does not ` +
      `match current_run_id=${currentRunId} for review_id=${reviewId}`,
  });
}

/**
 * Deterministic JSON encoding matching the Python `json.dumps(payload, sort_keys=True,
 * separators=(",", ":"))`: recursively sorts object keys and uses compact separators (no spaces), so
 * the persisted JSONB byte-shape is producer-side 1:1 with the frozen source. For the payload here
 * the SORTED top-level key order is `current`, `incoming`, `site`.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** Recursively sort object keys (arrays preserve order; primitives pass through). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      // `key` is a bounded own-enumerable string key of a plain object (from Object.keys), never an
      // attacker-controlled object-key sink — the prototype-pollution threat model does not apply.
      // eslint-disable-next-line security/detect-object-injection
      sorted[key] = sortKeysDeep(src[key]);
    }
    return sorted;
  }
  return value;
}
