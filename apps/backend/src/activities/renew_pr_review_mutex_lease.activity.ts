/**
 * `renewPrReviewMutexLeaseActivity` — REAL de-stubbed port of the frozen Python
 * `@activity.defn renew_pr_review_mutex_lease_activity`
 * (vendor/codemaster-py/codemaster/activities/renew_pr_review_mutex_lease.py).
 *
 * Extends the review's liveness lease. Called by the workflow body inside the pipeline so a
 * long-but-live review keeps its mutex, while a wedged/dead review stops renewing and its lease
 * expires (reclaimed by the next acquire or the janitor).
 *
 * ## Return contract — the lost-claim signal (NOT a fail-open seam)
 *
 * Returns the DB's HONEST still-held boolean:
 *   - `true`  — the lease was extended (the live row exists and is still owned).
 *   - `false` — the row was already released / reclaimed (a newer review stole it, or the janitor
 *               swept it). This is the lost-claim signal the workflow honors to abort a stolen review.
 *
 * The FAIL-OPEN semantics (a transient renewal *error* must not kill a live review) live in the WORKFLOW
 * BODY, not here — 1:1 with the frozen Python, whose activity body has no try/except and returns the raw
 * `rowcount == 1` boolean. The workflow's `_claim_still_held()` wraps the dispatch in `try/except` and
 * returns `True` on a Temporal-level error (`renew_pull_request.py` — fail-open), while a clean `false`
 * return is a DEFINITIVE lost claim that aborts non-retryably. This activity therefore lets a genuine DB
 * error PROPAGATE (the workflow + Temporal retry policy absorb it); it never swallows.
 *
 * ## installation_id resolution (the activity-vs-helper divergence)
 *
 * The frozen Python activity takes a bare `mutex_id: str` and the core helper keys ONLY on `mutex_id`
 * (the PK). The already-ported TS helper {@link renewPrReviewMutexLease} additionally accepts
 * `installationId` as a redundant, loss-free WHERE predicate (mutex_id is the PK, so it selects the same
 * one row). To satisfy that signature without changing the activity's 1:1 input shape, this activity
 * resolves `installation_id` by a PK lookup on `core.pr_review_mutex` inside the same transaction, then
 * delegates. A missing row → no `installationId` to resolve → the renew is a definitive lost claim
 * (`false`), matching the Python helper's `rowcount == 0 → False` for a vanished row.
 *
 * ## TTL source (platform-config follow-up)
 *
 * The frozen Python reads `pr_review_mutex_lease_ttl_seconds` from `core.platform_config` (default 1800,
 * floored at 600). The PlatformConfigCache is not yet ported, so the TTL is sourced from
 * `CODEMASTER_PR_REVIEW_MUTEX_LEASE_TTL_SECONDS` (operator-tunable seam) with the SAME default (1800 =
 * {@link DEFAULT_LEASE_TTL_SECONDS}) and the SAME `max(..., 600)` floor. Wiring this to the ported
 * PlatformConfigCache is FOLLOW-UP-platform-config-cache-port.
 *
 * ## Runtime context
 *
 * Activities run in the NORMAL Node runtime (NOT the workflow V8 sandbox) — DB access via the shared
 * ADR-0062 pool ({@link getPool}) is sanctioned. The acquire-style transaction (`withMutexTransaction`)
 * brackets the PK lookup + the renew UPDATE on ONE checked-out client.
 *
 * ## Shared-wiring boundary
 *
 * This module exports the registered activity function only. The worker registry / build_activities /
 * orchestrator activity_ports — owned by the Integrate/Workflow phase — bind it under the Temporal name
 * `renew_pr_review_mutex_lease_activity`. This module does NOT touch those wiring files.
 */

import {
  DEFAULT_LEASE_TTL_SECONDS,
  renewPrReviewMutexLease,
  withMutexTransaction,
} from "#backend/concurrency/pr_mutex.js";

import { getPool } from "#platform/db/database.js";

/** Floor on the lease TTL — 1:1 with the Python `max(int(...), 600)`. A sub-10-minute lease would risk a
 *  mid-stage expiry, so the operator-tunable value is clamped to ≥ 600 s regardless of the env override. */
const MIN_LEASE_TTL_SECONDS = 600;

/** RFC4122 UUID shape (any version/variant). Mirrors the Python `uuid.UUID(mutex_id)` parse — a malformed
 *  id raises before any DB work, so a bad caller surfaces as an error rather than a silent no-op. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Injected collaborators. All OPTIONAL — production resolves the shared pool from `CODEMASTER_PG_CORE_DSN`
 * (the ADR-0062 pool) and the TTL from `CODEMASTER_PR_REVIEW_MUTEX_LEASE_TTL_SECONDS`; tests may inject a
 * disposable-PG `dsn` and a fixed `leaseTtlSeconds`.
 */
export type RenewPrReviewMutexLeaseDeps = {
  /** DSN for the shared pool; default `CODEMASTER_PG_CORE_DSN`. */
  dsn?: string;
  /** Lease TTL in seconds; default from `CODEMASTER_PR_REVIEW_MUTEX_LEASE_TTL_SECONDS`, else
   *  {@link DEFAULT_LEASE_TTL_SECONDS}. Whatever the source, the value is floored at
   *  {@link MIN_LEASE_TTL_SECONDS} (1:1 with the Python `max(..., 600)`). */
  leaseTtlSeconds?: number;
};

/** Resolve the DSN for the shared pool: the injected one, else `CODEMASTER_PG_CORE_DSN`. */
function resolveDsn(deps: RenewPrReviewMutexLeaseDeps): string {
  if (deps.dsn !== undefined && deps.dsn !== "") {
    return deps.dsn;
  }
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set and no dsn injected; cannot renew a PR review mutex lease",
    );
  }
  return dsn;
}

/** Resolve + floor the lease TTL. 1:1 with the Python `max(int(cfg.get(..., 1800)), 600)`: the injected /
 *  env value is parsed as an int, defaulted to {@link DEFAULT_LEASE_TTL_SECONDS}, then clamped to ≥ 600. */
function resolveLeaseTtlSeconds(deps: RenewPrReviewMutexLeaseDeps): number {
  let raw: number;
  if (deps.leaseTtlSeconds !== undefined) {
    raw = deps.leaseTtlSeconds;
  } else {
    const fromEnv = process.env["CODEMASTER_PR_REVIEW_MUTEX_LEASE_TTL_SECONDS"];
    const parsed = fromEnv !== undefined && fromEnv !== "" ? Number.parseInt(fromEnv, 10) : Number.NaN;
    raw = Number.isFinite(parsed) ? parsed : DEFAULT_LEASE_TTL_SECONDS;
  }
  return Math.max(Math.trunc(raw), MIN_LEASE_TTL_SECONDS);
}

/**
 * The registered activity — extends `mutex_id`'s lease, returning the DB's still-held boolean.
 *
 * @param mutexId UUID of the mutex row to renew. A malformed UUID raises (1:1 with Python `uuid.UUID`).
 * @returns `true` if the lease was extended; `false` on a definitive lost claim (row released / gone).
 * @throws {RangeError} `mutexId` is not a valid UUID.
 * @throws propagates a genuine DB error (the workflow body's fail-open try/except absorbs it).
 */
export async function renewPrReviewMutexLeaseActivity(
  mutexId: string,
  deps: RenewPrReviewMutexLeaseDeps = {},
): Promise<boolean> {
  if (!UUID_RE.test(mutexId)) {
    throw new RangeError(`not a valid UUID: ${JSON.stringify(mutexId)}`);
  }
  const dsn = resolveDsn(deps);
  const leaseTtlSeconds = resolveLeaseTtlSeconds(deps);
  const pool = getPool(dsn);

  return withMutexTransaction(pool, async (client) => {
    // Resolve installation_id by PK (mutex_id is the PK). A live OR released row both carry it; a vanished
    // row resolves nothing → definitive lost claim (false), 1:1 with the helper's rowcount==0 → False.
    // tenant:exempt reason=PK-lookup-by-mutex_id-to-derive-installation_id follow_up=PERMANENT-EXEMPTION-pr-mutex-pk
    const row = await client.query<{ installation_id: string }>(
      "SELECT installation_id FROM core.pr_review_mutex WHERE mutex_id = $1",
      [mutexId],
    );
    const installationId = row.rows[0]?.installation_id;
    if (installationId === undefined) {
      return false;
    }
    return renewPrReviewMutexLease({ client, installationId, mutexId, leaseTtlSeconds });
  });
}
