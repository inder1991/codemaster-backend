/**
 * Three single-purpose finding-delivery lifecycle bookkeeping activities (B.10 / ADR-0056) — 1:1 in
 * intent with the frozen Python `lifecycle_activities.py`
 * (`vendor/codemaster-py/codemaster/review/lifecycle_activities.py`):
 *
 *   - {@link recordDeliveryFinalized} ← `record_delivery_finalized_activity` (inline_delivered flip)
 *   - {@link recordDeliverySkipped}   ← `record_delivery_skipped_activity`   (not_applicable / skipped)
 *   - {@link recordDeliveryDegraded}  ← `record_delivery_degraded_activity`  (body_only_fallback | failed)
 *
 * Each activity:
 *   - Takes one positional typed input (CLAUDE.md invariant 11): {@link FinalizedInputV1} /
 *     {@link SkippedInputV1} / {@link DegradedInputV1}.
 *   - Constructs {@link PostgresReviewFindingsRepo} over the ADR-0062 shared pool for
 *     `CODEMASTER_PG_CORE_DSN`, then calls the corresponding repo setter with `writesEnabled` threaded
 *     through from the `CODEMASTER_LIFECYCLE_WRITES_ENABLED` env var (default `false` — the dormant-ship
 *     kill switch; operators flip it at Helm).
 *   - Returns the integer count of rows actually flipped (Python `int` return = `len(flipped)`). The
 *     repo's `WHERE delivery_outcome IS NULL` guard makes the flip idempotent across Temporal retries, so
 *     the count can legitimately be a subset of `rfids` (already-finalized rows are not re-counted).
 *   - Re-raises a repo INVARIANT VIOLATION (the Python `ValueError` analogue — rfids/comment_ids or
 *     rfids/reasons length mismatch, an unknown eligibility_reason, or an out-of-set degraded outcome) as
 *     a NON-RETRYABLE {@link ApplicationFailure} with the same `type` string the frozen Python uses, so
 *     Temporal surfaces the caller-side bug fast instead of burning retries. Any OTHER error (transient
 *     DB failure, stale-write guard, etc.) propagates unchanged so Temporal's retry policy still applies.
 *
 * ## installation_id is a string end-to-end
 *
 * The activity-input contracts carry `installation_id` as a `str` (JSON-friendly across the Temporal
 * wire), and the TS repo setters take `installationId: string` directly (the SQL binds it as a UUID), so
 * — unlike the frozen Python which does `uuid.UUID(payload.installation_id)` to reach its UUID-typed repo
 * — there is NO conversion step here. The behavior is identical: a malformed installation_id surfaces as
 * a Postgres cast error inside the setter.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Runs in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. Real DB I/O lives here, exactly
 * as the frozen-Python activities own the repo writes. The clock seam below pins the repo's injected
 * Clock only for parity convenience; the setters themselves use SQL `NOW()` for `lifecycle_updated_at`,
 * so the Clock does not actually drive any column on these paths.
 */

import { ApplicationFailure } from "@temporalio/common";

import { PostgresReviewFindingsRepo, tenantKyselyForDsn } from "#backend/domain/repos/review_findings_repo.js";

import { FakeClock, WallClock, type Clock } from "#platform/clock.js";

import type { FinalizedInputV1, SkippedInputV1, DegradedInputV1 } from "#contracts/finding_lifecycle_inputs.v1.js";

/**
 * Resolve the {@link Clock} seam: a {@link FakeClock} pinned at `CODEMASTER_FAKE_CLOCK_ISO` when that env
 * var is a parseable ISO instant (deterministic seam for a future dual-run), else a {@link WallClock}.
 * An unparseable value throws loudly. Static `process.env.X` access (no dynamic indexing). The setters
 * use SQL `NOW()` rather than this clock, but the repo constructor requires one.
 */
function resolveClock(): Clock {
  const iso = process.env.CODEMASTER_FAKE_CLOCK_ISO;
  if (iso === undefined || iso === "") {
    return new WallClock();
  }
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(
      `CODEMASTER_FAKE_CLOCK_ISO=${JSON.stringify(iso)} is not a parseable ISO-8601 instant`,
    );
  }
  return new FakeClock({ now: instant });
}

/**
 * Read the `CODEMASTER_LIFECYCLE_WRITES_ENABLED` kill switch (1:1 with the frozen Python
 * `_LIFECYCLE_WRITES_ENABLED`: `os.environ.get(..., "false").lower() == "true"`). Default `false` — the
 * lifecycle setters ship dormant; operators flip the flag at Helm. The frozen Python reads this once at
 * worker startup; the TS activity reads it per call (matching how the sibling activities read
 * `CODEMASTER_PG_CORE_DSN` per call) — behavior is identical because the value is set once at pod start.
 */
function lifecycleWritesEnabled(): boolean {
  return (process.env.CODEMASTER_LIFECYCLE_WRITES_ENABLED ?? "false").toLowerCase() === "true";
}

/** Construct the findings repo over the ADR-0062 shared pool for `CODEMASTER_PG_CORE_DSN`. */
function buildRepo(): PostgresReviewFindingsRepo {
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error("CODEMASTER_PG_CORE_DSN is not set; cannot construct the review-findings repo");
  }
  return new PostgresReviewFindingsRepo({ db: tenantKyselyForDsn(dsn), clock: resolveClock() });
}

/**
 * The repo's pre-flight invariant violations (the frozen-Python `ValueError` analogues) surface as bare
 * `Error`s with these stable, deterministic message fragments (asserted in
 * review_findings_repo.integration.test.ts). They all fire BEFORE any DB access, so matching them is a
 * faithful, side-effect-free reproduction of Python's narrow `except ValueError`. A transient DB error
 * (a `pg` error, the stale-write guard's {@link StaleWriteError}, etc.) carries none of these fragments,
 * so it propagates unchanged and keeps Temporal's retry policy.
 */
function isRepoInvariantViolation(err: unknown): err is Error {
  if (!(err instanceof Error)) {
    return false;
  }
  return (
    err.message.startsWith("length mismatch:") ||
    err.message.startsWith("unknown eligibility_reason:") ||
    err.message.startsWith("record_delivery_degraded outcome=")
  );
}

/**
 * Run a lifecycle setter, converting a repo invariant violation into a non-retryable
 * {@link ApplicationFailure} carrying the frozen-Python `type` string (so Temporal surfaces the bug fast
 * and operators see the same failure type as the Python worker). Every other error propagates unchanged.
 */
async function runSetter(args: {
  failureType: string;
  setter: () => Promise<ReadonlyArray<string>>;
}): Promise<number> {
  try {
    const flipped = await args.setter();
    return flipped.length;
  } catch (err) {
    if (isRepoInvariantViolation(err)) {
      throw ApplicationFailure.create({
        message: err.message,
        type: args.failureType,
        nonRetryable: true,
      });
    }
    throw err;
  }
}

/**
 * Flip rows in core.review_findings to DELIVERY_FINALIZED via inline delivery (1:1 with
 * `record_delivery_finalized_activity`). Returns the count of rows actually flipped. A
 * rfids/comment_ids length mismatch re-raises as a non-retryable `FinalizedParityViolation`.
 */
export async function recordDeliveryFinalized(payload: FinalizedInputV1): Promise<number> {
  const repo = buildRepo();
  return runSetter({
    failureType: "FinalizedParityViolation",
    setter: () =>
      repo.recordDeliveryFinalized({
        installationId: payload.installation_id,
        rfids: payload.rfids,
        commentIds: payload.comment_ids,
        postedReviewPrId: payload.posted_review_pr_id,
        runId: payload.run_id,
        reviewId: payload.review_id,
        writesEnabled: lifecycleWritesEnabled(),
      }),
  });
}

/**
 * Flip rows to DELIVERY_FINALIZED via the not_applicable / skipped code path (1:1 with
 * `record_delivery_skipped_activity`). Returns the count flipped. A rfids/reasons length mismatch OR an
 * unknown eligibility_reason re-raises as a non-retryable `SkippedParityViolation`.
 */
export async function recordDeliverySkipped(payload: SkippedInputV1): Promise<number> {
  const repo = buildRepo();
  return runSetter({
    failureType: "SkippedParityViolation",
    setter: () =>
      repo.recordDeliverySkipped({
        installationId: payload.installation_id,
        rfids: payload.rfids,
        reasons: payload.reasons,
        postedReviewPrId: payload.posted_review_pr_id,
        runId: payload.run_id,
        reviewId: payload.review_id,
        writesEnabled: lifecycleWritesEnabled(),
      }),
  });
}

/**
 * Flip rows to DELIVERY_FINALIZED via a degraded outcome (body_only_fallback | failed) (1:1 with
 * `record_delivery_degraded_activity`). Returns the count flipped. An out-of-set outcome re-raises as a
 * non-retryable `DegradedOutcomeViolation` (the repo validates the outcome BEFORE the writes_enabled
 * short-circuit, exactly as the frozen Python does).
 */
export async function recordDeliveryDegraded(payload: DegradedInputV1): Promise<number> {
  const repo = buildRepo();
  return runSetter({
    failureType: "DegradedOutcomeViolation",
    setter: () =>
      repo.recordDeliveryDegraded({
        installationId: payload.installation_id,
        rfids: payload.rfids,
        outcome: payload.outcome,
        postedReviewPrId: payload.posted_review_pr_id,
        runId: payload.run_id,
        reviewId: payload.review_id,
        writesEnabled: lifecycleWritesEnabled(),
      }),
  });
}
