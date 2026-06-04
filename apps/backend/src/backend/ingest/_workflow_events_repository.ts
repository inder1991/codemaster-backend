/**
 * Repository writer for `audit.workflow_events` — 1:1 TypeScript/Kysely port of the frozen Python
 * spine primitive `vendor/codemaster-py/codemaster/ingest/_workflow_events_repository.py`
 * (Phase 2 / Task 5; Phase 2.1 stale-write gate part A1 of 3).
 *
 * The single primitive every spine path uses to append a row to the per-run event audit stream.
 * `audit.workflow_events` is the R1 event-history table (AD-3 lifecycle/event split): the compact
 * `lifecycle_state` lives on `core.review_runs` (operational truth), and the granular processing
 * milestones — `WEBHOOK_RECEIVED`, `PR_OPENED`, `INGESTED`, `ANALYZED`, `FINDINGS_PERSISTED`, etc. —
 * live here as one row each. The `persistAggregated`/`FINDINGS_PERSISTED` path consumes THIS writer.
 *
 * ## Contract (1:1 with the Python `emit_workflow_event`)
 *
 * {@link emitWorkflowEvent} inserts exactly one row and returns its `event_id`. It:
 *   1. Validates `eventType` against {@link EVENT_TYPES} — a TS-level reject before any SQL
 *      round-trip so callers see a typed error, not a Postgres CHECK violation.
 *   2. Enforces the BF-3 Phase B runtime guard: `installationId == null` REQUIRES
 *      `payload.orphan_reason ∈` {@link ORPHAN_REASONS}, else throws {@link BF3InstallationIdMissing}.
 *   3. Computes `sequence_no` atomically as `1 + MAX(sequence_no)` per `run_id` INSIDE the caller's
 *      transaction, serialized by a per-run `pg_advisory_xact_lock`. The
 *      `uq_workflow_events_run_sequence` UNIQUE index catches any concurrent race as a constraint
 *      error the caller handles.
 *   4. INSERTs the row and returns the freshly-minted `event_id` (uuid4 — event IDs do not need
 *      temporal ordering since `(run_id, sequence_no)` already imposes a per-run order).
 *
 * ## Transaction discipline
 *
 * The caller MUST own an OPEN transaction; this function neither opens nor commits. The Python
 * source takes an `AsyncSession` and raises `RuntimeError` when `session.in_transaction()` is false.
 * The TS analogue is structural: {@link emitWorkflowEvent} accepts a Kysely `Transaction<DB>` handle
 * (`dbOrTx`). Being inside a transaction is therefore guaranteed by the type — AND we mirror the
 * Python `RuntimeError` at runtime by rejecting a non-transaction `Kysely` (i.e. a handle that is not
 * an `instanceof Transaction`), so a caller that passes the bare engine fails loudly the same way the
 * Python caller does when it forgets `async with session.begin():`.
 *
 * The sequence_no computation requires read-then-write isolation; without an open transaction the
 * MAX and the INSERT race and `sequence_no` collisions surface as a UNIQUE-violation at INSERT time —
 * too late to recover cleanly. The function does NOT commit; the caller owns the transaction boundary
 * so the event emit and the caller's durable mutation share transactional fate.
 *
 * ## Idempotency / at-least-once
 *
 * The partial UNIQUE index `uq_workflow_events_provider_delivery (provider, delivery_id, received_at)
 * WHERE delivery_id IS NOT NULL` is the at-least-once dedupe key: a duplicate delivery surfaces as a
 * Postgres unique-violation from this function. The function does NOT swallow it — the caller treats
 * the duplicate as "already recorded" and rolls back. NULL `delivery_id` rows (lifecycle
 * transitions, internal milestones) are not subject to the partial index and emit freely.
 *
 * ## DEFERRED — BF-3 orphan-retention observability (Phase 3)
 *
 * The Python source increments three OTel counters via `codemaster.observability.pipeline_metrics`:
 * `record_bf3_installation_id_missing` (guard-raise branch), `record_bf3_orphan_emit` (legitimate-
 * orphan branch), and `record_emit_workflow_event` (success path, labeled by tenancy_state). All
 * three belong to the Phase-3 orphan-retention subsystem (driven by `run_id_retention.py`, which is
 * NOT ported here). They are NOT exercised by the `persistAggregated`/`FINDINGS_PERSISTED` path —
 * that path ALWAYS passes a non-null `installationId`, so it never touches the orphan branch and
 * never needs the orphan counters. They are deferred with this note rather than emitted as dead
 * instruments; porting them lands with the orphan-retention subsystem. `getMeter` is intentionally
 * NOT imported here for that reason. See `run_id_retention.py` + the Python module docstring Wave 9.
 */

import { type Kysely, sql, Transaction } from "kysely";

import { SystemRandom } from "#platform/randomness.js";

import { type Clock, WallClock } from "#platform/clock.js";

// ─── BF-1 advisory-lock namespace ────────────────────────────────────────────────────────────────
//
// Per-run advisory-lock namespace for the workflow_events sequence_no MAX-then-INSERT pair. Postgres
// advisory locks are keyed by a pair of int4 values; this distinct namespace keeps the lock distinct
// from any other advisory lock the application may acquire.
//
//   0x57424555 == 'WBEU' ASCII — workflow-events sequence-update. Fits in a signed int4.

/** BF-1 per-run advisory-lock namespace (`0x57424555` == 'WBEU'). 1:1 with the Python constant. */
export const WORKFLOW_EVENTS_SEQ_LOCK_NAMESPACE = 0x5742_4555;

// ─── Event-type registry (1:1 with codemaster/domain/audit_event_types.py::EVENT_TYPES) ──────────
//
// The R1 canonical event_type enum — kept in lockstep with the CHECK constraint
// `ck_workflow_events_event_type` (migration 0071_workflow_events, extended by
// 0078_workspace_event_types). Any addition here MUST ship with a follow-up migration extending the
// CHECK, and vice versa. Ported verbatim — same literal strings, same ordering.

/** The exact frozenset of valid `event_type` strings. Reject before SQL so callers see a typed error. */
export const EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  // Transport / event-processing milestones.
  "WEBHOOK_RECEIVED",
  "PR_OPENED",
  "PR_SYNCHRONIZE",
  "INGESTED",
  "ANALYSIS_STARTED",
  "ANALYZED",
  "FINDINGS_PERSISTED",
  "COMMENT_POSTED",
  "RETRY_STARTED",
  // Lifecycle transitions emitted by `transition_run`.
  "lifecycle_transition",
  // SERIAL+SUPERSEDE & cancellation propagation (AD-5).
  "RUN_SUPERSEDED",
  "RUN_CANCELLED",
  "RUN_DRAIN_COMPLETED",
  "STALE_WRITE_BLOCKED",
  // Workspace lifecycle subsystem (Phase 6, spec §5.3).
  "WORKSPACE_ALLOCATED",
  "WORKSPACE_RELEASE_REQUESTED",
  "WORKSPACE_RELEASED",
  "WORKSPACE_ORPHANED",
  "WORKSPACE_CLEANUP_FAILED",
  // Phase 1 PR-1c — placeholder PR conversation-tab comment posted at workflow start and torn down
  // by `delete_review_placeholder_activity` after the heavy review lands.
  "REVIEW_PLACEHOLDER_POSTED",
  "REVIEW_PLACEHOLDER_DELETED",
]);

// ─── Orphan markers (1:1 with codemaster/ingest/_workflow_events_repository.py::ORPHAN_REASONS) ───

/**
 * Tagged-union markers a caller MUST set in `payload.orphan_reason` when passing
 * `installationId=null`. Each marker corresponds to a documented legitimate-orphan path — null
 * tenancy is never silent. Adding a new marker requires architect approval.
 *
 * Recognized markers:
 *   - `orphan_retire`: the originating review row has been hard-deleted bypassing FK RESTRICT.
 *   - `bootstrap_sink`: outbox rows where review_id is also None (e.g. the bootstrap_audit sink).
 */
export const ORPHAN_REASONS: ReadonlySet<string> = new Set<string>(["orphan_retire", "bootstrap_sink"]);

// ─── BF3InstallationIdMissing (1:1 with the Python ValueError subclass) ──────────────────────────

/**
 * Raised when {@link emitWorkflowEvent} would write `installation_id=NULL` without a tagged
 * `orphan_reason` in payload. Indicates a propagation bug in a caller that didn't thread
 * `installationId` through. See {@link ORPHAN_REASONS} for the legitimate-orphan literals.
 *
 * Mirrors the Python `class BF3InstallationIdMissing(ValueError)`.
 */
export class BF3InstallationIdMissing extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BF3InstallationIdMissing";
  }
}

// ─── runIdToLockKey (1:1 with the Python `_run_id_to_lock_key`) ──────────────────────────────────

/**
 * Derive a signed int4 advisory-lock key from a `run_id` UUID. EXACT port of the Python
 * `int.from_bytes(run_id.bytes[:4], "big", signed=True)`: take the FIRST 4 bytes of the UUID (the
 * first 8 hex chars after stripping dashes) and read them big-endian as a SIGNED int32. Byte-identical
 * to Python for any UUID.
 *
 * `pg_advisory_xact_lock(int4, int4)` requires a pair of signed 32-bit integers; we pass
 * {@link WORKFLOW_EVENTS_SEQ_LOCK_NAMESPACE} as the first argument and this value as the second.
 * Signed interpretation is required because Postgres `int4` is signed. A collision (~1 in 2**32)
 * merely serializes two unrelated runs briefly; it does NOT corrupt sequence_no (the SELECT MAX is
 * still keyed on run_id). Operationally negligible.
 */
export function runIdToLockKey(runId: string): number {
  const firstFourBytesHex = runId.replace(/-/g, "").slice(0, 8);
  return Buffer.from(firstFourBytesHex, "hex").readInt32BE(0);
}

// ─── uuid4 minter (via the platform randomness seam — NOT raw crypto; clock/random gate bans that) ─
//
// No `uuid4()` helper exists in the randomness seam yet (only `uuid7` for run_id). The clock/random
// gate (check_clock_random.ts) bans `crypto.randomUUID` / `crypto.randomBytes` outside the seam file,
// so we mint uuid4 from the seam's `SystemRandom.tokenBytes(16)` (the one sanctioned crypto-randomness
// entry point — it delegates to node:crypto INSIDE the allowlisted seam) and set the RFC4122 version
// (0x4) + variant (0b10) bits. 1:1 in shape with the Python `uuid.uuid4()`: 122 random bits.

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

// ─── emitWorkflowEvent ───────────────────────────────────────────────────────────────────────────

/** A JSON-serializable payload object stored in the `payload` JSONB column. */
export type WorkflowEventPayload = Record<string, unknown>;

/** Arguments for {@link emitWorkflowEvent}. `dbOrTx` MUST be an open Kysely `Transaction`. */
export type EmitWorkflowEventArgs = {
  /** Open transaction handle. The caller owns the boundary; this neither opens nor commits. */
  dbOrTx: Transaction<unknown> | Kysely<unknown>;
  /** Provider key (`"github"` for the only supported provider today). NOT NULL on the table. */
  provider: string;
  /** The `core.review_runs.run_id` this event belongs to (FK RESTRICT — the run row must exist). */
  runId: string;
  /** The `core.pull_request_reviews.review_id` for denormalized joins (FK RESTRICT). */
  reviewId: string;
  /** One of {@link EVENT_TYPES}; rejected at the TS boundary if unknown. */
  eventType: string;
  /** JSON-serializable payload; defaults to `{}`. Stored as JSONB. */
  payload?: WorkflowEventPayload;
  /** Provider delivery correlation key (GitHub `X-GitHub-Delivery`); dedupes retried deliveries. */
  deliveryId?: string | null;
  /** Tenant attribution. `null` REQUIRES `payload.orphan_reason ∈` {@link ORPHAN_REASONS}. */
  installationId?: string | null;
  /** Injected clock; defaults to {@link WallClock}. The emitted `received_at` uses `clock.now()`. */
  clock?: Clock;
};

/**
 * Insert one `audit.workflow_events` row and return the `event_id`. 1:1 with the Python
 * `emit_workflow_event`. See the module docstring for the full contract.
 *
 * @throws {Error}                    `eventType` not in {@link EVENT_TYPES} (the ValueError analogue),
 *                                    OR `dbOrTx` is not an open `Transaction` (the RuntimeError
 *                                    `session.in_transaction()` analogue).
 * @throws {BF3InstallationIdMissing} `installationId == null` AND `payload.orphan_reason` not in
 *                                    {@link ORPHAN_REASONS}.
 *
 * A duplicate `(provider, delivery_id)`, an FK violation on `run_id`/`review_id`, or a concurrent
 * `sequence_no` race surfaces as the underlying Postgres unique/constraint error, propagated to the
 * caller per at-least-once delivery semantics (NOT swallowed).
 */
export async function emitWorkflowEvent(args: EmitWorkflowEventArgs): Promise<string> {
  const {
    dbOrTx,
    provider,
    runId,
    reviewId,
    eventType,
    payload,
    deliveryId = null,
    installationId = null,
  } = args;

  // BF-3 Phase B runtime enforcement: refuse the NULL-tenancy write unless the caller tagged the
  // payload with a recognized orphan_reason. (The Wave 9 OTel orphan counters are DEFERRED to the
  // Phase-3 orphan-retention subsystem — see module docstring; the FINDINGS_PERSISTED path never
  // reaches this branch because it always passes a non-null installationId.)
  if (installationId === null) {
    const orphanReason = (payload ?? {})["orphan_reason"];
    if (typeof orphanReason !== "string" || !ORPHAN_REASONS.has(orphanReason)) {
      const payloadKeys = Object.keys(payload ?? {}).sort();
      throw new BF3InstallationIdMissing(
        `emitWorkflowEvent called with installationId=null and no recognized orphan_reason in ` +
          `payload. eventType=${JSON.stringify(eventType)}, runId=${runId}, reviewId=${reviewId}, ` +
          `payloadKeys=${JSON.stringify(payloadKeys)}. Either pass installationId explicitly OR set ` +
          `payload.orphan_reason to one of ${JSON.stringify([...ORPHAN_REASONS].sort())}. ` +
          `See the BF-3 audit-tenancy invariant.`,
      );
    }
  }

  if (!EVENT_TYPES.has(eventType)) {
    throw new Error(
      `emitWorkflowEvent: eventType=${JSON.stringify(eventType)} is not in EVENT_TYPES. ` +
        `Valid values: ${JSON.stringify([...EVENT_TYPES].sort())}`,
    );
  }

  // Mirror the Python `session.in_transaction()` RuntimeError: the MAX(sequence_no)+INSERT pair only
  // composes safely inside an open transaction. A Kysely `Transaction` is structurally in one; a bare
  // `Kysely` engine is not, so reject it loudly (the analogue of the Python caller forgetting
  // `async with session.begin():`).
  if (!(dbOrTx instanceof Transaction)) {
    throw new Error(
      "emitWorkflowEvent requires an already-open transaction. Pass the Kysely Transaction handle " +
        "from `db.transaction().execute(async (tx) => { ... })`. Without a txn, the " +
        "MAX(sequence_no)+INSERT pair races concurrent emits and the UNIQUE(run_id, sequence_no) " +
        "index surfaces the collision as a constraint error at INSERT time.",
    );
  }
  const tx = dbOrTx;

  const effectiveClock: Clock = args.clock ?? new WallClock();
  const effectivePayload: WorkflowEventPayload = payload ?? {};

  // BF-1 — per-run advisory lock serializes the MAX-then-INSERT pair. `pg_advisory_xact_lock`
  // releases automatically at commit/rollback, so no explicit unlock is needed. Concurrent emits for
  // the SAME run_id block here; emits for DIFFERENT run_ids are unaffected (the second key derives
  // from run_id). The advisory lock is the actual serializer (the partition-key UNIQUE index cannot
  // be — received_at is part of the tuple).
  await sql`SELECT pg_advisory_xact_lock(${WORKFLOW_EVENTS_SEQ_LOCK_NAMESPACE}, ${runIdToLockKey(
    runId,
  )})`.execute(tx);

  // Compute next sequence_no for this run. COALESCE handles the first-event case (MAX over zero rows
  // is NULL). The advisory lock above guarantees the read-then-write is serialized within run_id.
  // tenant:exempt reason=audit-event-stream-keyed-by-run-id follow_up=PERMANENT-EXEMPTION-workflow-events-seq
  const nextSeqResult = await sql<{ next_seq: number }>`
    SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_seq
      FROM audit.workflow_events
     WHERE run_id = ${runId}
  `.execute(tx);
  const nextSeqRow = nextSeqResult.rows[0];
  if (nextSeqRow === undefined) {
    // COALESCE guarantees a row; undefined would be a Postgres protocol violation.
    throw new Error(
      "emitWorkflowEvent: SELECT COALESCE(MAX(...), 0) + 1 returned no row; expected exactly one " +
        "(Postgres protocol invariant)",
    );
  }
  const nextSequenceNo = Number(nextSeqRow.next_seq);

  const eventId = uuid4();
  // The INSERT carries `installation_id` explicitly in the column list (NULL only on the tagged-orphan
  // path guarded above), so the tenancy raw-SQL gate is satisfied. payload is JSON-serialized with
  // sorted keys + compact separators to match the Python `json.dumps(..., sort_keys=True,
  // separators=(",", ":"))` byte-shape, then CAST to jsonb.
  const payloadJson = stableJson(effectivePayload);
  await sql`
    INSERT INTO audit.workflow_events
      (event_id, provider, delivery_id, run_id, review_id,
       sequence_no, event_type, payload, received_at, installation_id)
    VALUES (${eventId}, ${provider}, ${deliveryId}, ${runId}, ${reviewId},
            ${nextSequenceNo}, ${eventType}, CAST(${payloadJson} AS jsonb),
            ${effectiveClock.now()}, ${installationId})
  `.execute(tx);

  return eventId;
}

/**
 * Deterministic JSON encoding matching the Python `json.dumps(payload, sort_keys=True,
 * separators=(",", ":"))`: recursively sorts object keys and uses compact separators, so the persisted
 * JSONB byte-shape is stable across replays (the column is JSONB, which canonicalizes anyway, but we
 * keep the producer-side encoding 1:1 with the frozen source).
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
