/**
 * `releasePrReviewMutexActivity` — REAL de-stubbed port of the frozen Python
 * `@activity.defn release_pr_review_mutex_activity`
 * (vendor/codemaster-py/codemaster/activities/release_pr_review_mutex.py).
 *
 * Releases the per-PR review mutex. The workflow body calls this in a `finally` block around the
 * orchestrator invocation, so it MUST be safe to call against an already-released / expired / swept
 * mutex.
 *
 * ## Idempotency (the finally-block contract)
 *
 * Releasing an already-released mutex is a NO-OP: the underlying UPDATE filters on `released_at IS NULL`,
 * so a second release touches zero rows and does not throw. A missing mutex row is likewise a no-op. This
 * is 1:1 with the frozen Python `release_pr_review_mutex` (whose `rowcount == 0` is "fine — release on an
 * already-released row is a no-op"). The activity returns `void`.
 *
 * ## Commit semantics (the 37-leaked-rows bug this port must NOT reintroduce)
 *
 * The release UPDATE MUST COMMIT. The pre-2026-06-03 Python used a bare `async with session:` with no
 * commit, so every release rolled back on close and 37 mutex rows leaked (0 ever released — ADR-0064).
 * {@link withMutexTransaction} brackets the work in `BEGIN`/`COMMIT` on one checked-out client — a clean
 * return commits; a throw rolls back (and releases the advisory lock, though release takes none).
 *
 * ## installation_id resolution
 *
 * Same divergence as the renew activity: the frozen Python keys on `mutex_id` only (the PK); the ported
 * TS {@link releasePrReviewMutex} additionally takes a redundant `installationId` WHERE predicate. The
 * activity resolves it by a PK lookup inside the same transaction. A vanished row resolves nothing → the
 * release is a no-op (idempotent), exactly as if the UPDATE had matched zero rows.
 *
 * ## Clock authority
 *
 * The `released_at` audit timestamp comes from the injected {@link Clock} (default {@link WallClock}),
 * 1:1 with the Python `release_pr_review_mutex(..., clock=WallClock())`. (Acquire/renew use the DB
 * `now()`; only release stamps `released_at` from the injected clock — verbatim with the helper.)
 *
 * ## Runtime context / shared-wiring boundary
 *
 * Runs in the NORMAL Node runtime (DB access sanctioned). Exports the registered activity function only;
 * the Integrate/Workflow phase binds it under the Temporal name `release_pr_review_mutex_activity` and
 * does NOT live here.
 */

import { releasePrReviewMutex, withMutexTransaction } from "#backend/concurrency/pr_mutex.js";

import { getPool } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";

/** RFC4122 UUID shape (any version/variant). Mirrors the Python `uuid.UUID(mutex_id)` parse, which raises
 *  `ValueError("not a valid UUID: ...")` before any DB work on a malformed id. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Injected collaborators. All OPTIONAL — production resolves the shared pool from `CODEMASTER_PG_CORE_DSN`
 * (the ADR-0062 pool) and stamps `released_at` from a {@link WallClock}; tests may inject a disposable-PG
 * `dsn` and a {@link FakeClock}.
 */
export type ReleasePrReviewMutexDeps = {
  /** DSN for the shared pool; default `CODEMASTER_PG_CORE_DSN`. */
  dsn?: string;
  /** Time seam for the `released_at` audit stamp; default {@link WallClock} (1:1 with the Python). */
  clock?: Clock;
};

/** Resolve the DSN for the shared pool: the injected one, else `CODEMASTER_PG_CORE_DSN`. */
function resolveDsn(deps: ReleasePrReviewMutexDeps): string {
  if (deps.dsn !== undefined && deps.dsn !== "") {
    return deps.dsn;
  }
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set and no dsn injected; cannot release a PR review mutex",
    );
  }
  return dsn;
}

/**
 * The registered activity — releases `mutex_id`. Idempotent + commit-safe; returns `void`.
 *
 * @param mutexId UUID of the mutex row to release. A malformed UUID raises (1:1 with Python `uuid.UUID`).
 * @throws {RangeError} `mutexId` is not a valid UUID.
 */
export async function releasePrReviewMutexActivity(
  mutexId: string,
  deps: ReleasePrReviewMutexDeps = {},
): Promise<void> {
  if (!UUID_RE.test(mutexId)) {
    throw new RangeError(`not a valid UUID: ${JSON.stringify(mutexId)}`);
  }
  const dsn = resolveDsn(deps);
  const clock: Clock = deps.clock ?? new WallClock();
  const pool = getPool(dsn);

  await withMutexTransaction(pool, async (client) => {
    // Resolve installation_id by PK (mutex_id is the PK). A vanished row resolves nothing → the release
    // is a no-op (idempotent), exactly as the helper's rowcount==0 path.
    // tenant:exempt reason=PK-lookup-by-mutex_id-to-derive-installation_id follow_up=PERMANENT-EXEMPTION-pr-mutex-pk
    const row = await client.query<{ installation_id: string }>(
      "SELECT installation_id FROM core.pr_review_mutex WHERE mutex_id = $1",
      [mutexId],
    );
    const installationId = row.rows[0]?.installation_id;
    if (installationId === undefined) {
      return;
    }
    await releasePrReviewMutex({ client, installationId, mutexId, clock });
  });
}
