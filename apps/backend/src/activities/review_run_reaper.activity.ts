/**
 * `reviewRunReaperActivity` — REAL de-stubbed port of the frozen Python
 * `@activity.defn review_run_reaper_activity`
 * (vendor/codemaster-py/codemaster/activities/review_run_reaper.py). Fix D / M2 (mutex-liveness
 * hardening, ADR-0064).
 *
 * Sweeps `core.review_runs` rows stuck in `RUNNING` because the worker that owned them died (OOM / pod
 * eviction / terminate) before the workflow could invoke `record_run_failed_activity` /
 * `record_run_cancelled_activity`. Without this reaper a dead-worker run stays at `RUNNING` forever —
 * the review reads "In Progress" in the UI and the mutex janitor never reclaims the associated
 * `core.pr_review_mutex` row, blocking the next push on the same PR.
 *
 * ## The load-bearing CTE + LEFT JOIN (byte-faithful with the Python)
 *
 * One statement does the work: a CTE `UPDATE … RETURNING` flips every stale RUNNING run to
 * `CANCELLED` and returns `(run_id, review_id)`, then the outer `SELECT` resolves each run's
 * `installation_id` via the FK chain `review_runs.review_id → pull_request_reviews.repo_id
 * (github_repo_id) → repositories.installation_id`. The `LEFT JOIN` on repositories is deliberate:
 * a run whose repo FK chain is broken (the repo row was deleted / never recorded) yields a NULL
 * `installation_id` — an ORPHAN — and is REAPED anyway (the cancellation already applied in the CTE
 * UPDATE) but SKIPS the per-tenant audit emit so one orphan cannot roll back the entire sweep.
 *
 * The UPDATE sets EXACTLY `lifecycle_state='CANCELLED'`, `cancelled_at=now()` (DB clock — faithful with
 * the Python's SQL `now()`), `cancel_reason='timeout'`. NO other column is touched — in particular
 * `completed_at` MUST stay NULL (`ck_review_runs_completed_at_state` requires it NULL unless
 * state='COMPLETED'), and `degradation_notes` does not exist on this table.
 *
 * ## Live-job shield (D3, gate ④ — ADR-0077)
 *
 * The CTE UPDATE WHERE carries `AND NOT EXISTS (SELECT 1 FROM core.review_jobs j WHERE j.run_id =
 * review_runs.run_id AND j.state IN ('ready','leased'))` so the Temporal age-sweep reaper NEVER fights a
 * live runner job: a run that still has a claimable/leased `core.review_jobs` row is being actively driven
 * by the Phase-1 runner loop (its own per-job lease + heartbeat is the liveness authority), so age alone
 * must not cancel it. The verbatim `state IN ('ready','leased')` rides `uq_review_jobs_active_run`'s partial
 * index. Once the job reaches a terminal state (done/dead/cancelled), it falls out of the predicate and a
 * still-stale RUNNING run becomes reapable on the next sweep.
 *
 * ## Cross-tenant by design (Python `@privileged_path`)
 *
 * The UPDATE/SELECT carry NO `installation_id` filter — the reaper is a liveness backstop that MUST see
 * every tenant's stuck runs. The frozen Python guards this with the `@privileged_path` decorator; the TS
 * raw-SQL gate accepts the equivalent inline `// tenant:exempt reason=… follow_up=…` marker on the SQL.
 *
 * ## Stale-threshold divergence (ADR-0074 — env var, not platform_config)
 *
 * The Python reads `review_run_reaper_stale_after_seconds` (default 3600) from `core.platform_config` via
 * the `platform_config_cache`. That cache is NOT yet ported, so — exactly as
 * `renew_pr_review_mutex_lease.activity.ts::resolveLeaseTtlSeconds` established — the threshold is sourced
 * from `CODEMASTER_REVIEW_RUN_REAPER_STALE_AFTER_SECONDS` (default {@link DEFAULT_STALE_AFTER_SECONDS} =
 * 3600), floored at {@link MIN_STALE_AFTER_SECONDS} = 300 (operator-safe minimum, per ADR-0074). An
 * injected `deps.staleAfterSeconds` takes precedence (still floored). Re-basing onto the ported
 * platform_config cache is FOLLOW-UP-platform-config-cache.
 *
 * ## Clock authority
 *
 * The injected {@link Clock} (default {@link WallClock}) stamps the audit `created_at` only — 1:1 with
 * the Python `emit_audit_event(..., clock=WallClock())`. The run's `cancelled_at` comes from the DB
 * `now()` inside the UPDATE (faithful — the Python UPDATE uses SQL `now()`), NOT from the injected clock.
 *
 * ## Runtime context / shared-wiring boundary
 *
 * Runs in the NORMAL Node runtime (DB access sanctioned), inside one {@link withPgTransaction} bracket so
 * the cancellation + every audit row commit atomically (a throw rolls the whole sweep back). Exports the
 * registered activity function only; the Integrate/Workflow phase binds it under the Temporal name
 * `review_run_reaper_activity` and owns the worker registry — NOT this module.
 */

import { bindAuditContext, emitAuditEvent } from "#backend/audit/emit.js";

import { getPool, withPgTransaction } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";

import { ReviewRunReaperResultV1 } from "#contracts/review_run_reaper_result.v1.js";

/** Default stale threshold — 1:1 with the Python `int(cfg.get(..., 3600))` (1 hour). */
const DEFAULT_STALE_AFTER_SECONDS = 3600;

/** Operator-safe floor on the stale threshold (ADR-0074). A sub-5-minute reaper would race the normal
 *  finalize/cancel path and reap live-but-slow runs, so the env/injected value is clamped to ≥ 300 s. */
const MIN_STALE_AFTER_SECONDS = 300;

/**
 * Injected collaborators. All OPTIONAL — production resolves the shared pool from `CODEMASTER_PG_CORE_DSN`
 * (the ADR-0062 pool), the threshold from `CODEMASTER_REVIEW_RUN_REAPER_STALE_AFTER_SECONDS`, and stamps
 * the audit `created_at` from a {@link WallClock}; tests inject a disposable-PG `dsn`, a fixed
 * `staleAfterSeconds`, and/or a {@link FakeClock}.
 */
export type ReviewRunReaperDeps = {
  /** DSN for the shared pool; default `CODEMASTER_PG_CORE_DSN`. */
  dsn?: string;
  /** Time seam for the audit `created_at` stamp; default {@link WallClock} (1:1 with the Python). */
  clock?: Clock;
  /** Stale threshold in seconds; default from `CODEMASTER_REVIEW_RUN_REAPER_STALE_AFTER_SECONDS`, else
   *  {@link DEFAULT_STALE_AFTER_SECONDS}. Whatever the source, floored at {@link MIN_STALE_AFTER_SECONDS}. */
  staleAfterSeconds?: number;
};

/** Resolve the DSN for the shared pool: the injected one, else `CODEMASTER_PG_CORE_DSN`. */
function resolveDsn(deps: ReviewRunReaperDeps): string {
  if (deps.dsn !== undefined && deps.dsn !== "") {
    return deps.dsn;
  }
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set and no dsn injected; cannot run the review-run reaper",
    );
  }
  return dsn;
}

/** Resolve + floor the stale threshold. Mirrors `renew_pr_review_mutex_lease.activity.ts`: the injected /
 *  env value is parsed as an int, defaulted to {@link DEFAULT_STALE_AFTER_SECONDS}, then clamped to ≥ 300. */
function resolveStaleAfterSeconds(deps: ReviewRunReaperDeps): number {
  let raw: number;
  if (deps.staleAfterSeconds !== undefined) {
    raw = deps.staleAfterSeconds;
  } else {
    const fromEnv = process.env["CODEMASTER_REVIEW_RUN_REAPER_STALE_AFTER_SECONDS"];
    const parsed = fromEnv !== undefined && fromEnv !== "" ? Number.parseInt(fromEnv, 10) : Number.NaN;
    raw = Number.isFinite(parsed) ? parsed : DEFAULT_STALE_AFTER_SECONDS;
  }
  return Math.max(Math.trunc(raw), MIN_STALE_AFTER_SECONDS);
}

/** One reaped run as RETURNING-resolved: the cancelled run + its tenant (NULL for an orphan). */
type ReapedRow = {
  run_id: string;
  review_id: string;
  installation_id: string | null;
};

/**
 * The registered activity — sweep stale RUNNING runs to CANCELLED, audit each non-orphan reap, and
 * return the scanned/reaped counters (always equal: every flipped row is counted on both axes).
 */
export async function reviewRunReaperActivity(
  deps: ReviewRunReaperDeps = {},
): Promise<ReviewRunReaperResultV1> {
  const dsn = resolveDsn(deps);
  const clock: Clock = deps.clock ?? new WallClock();
  const staleAfterSeconds = resolveStaleAfterSeconds(deps);
  const pool = getPool(dsn);

  const reaped = await withPgTransaction(pool, async (client) => {
    // The CTE UPDATE flips every stale RUNNING run to CANCELLED and RETURNs (run_id, review_id); the
    // outer SELECT resolves installation_id via review_id → pull_request_reviews.repo_id (github_repo_id)
    // → repositories.installation_id. The LEFT JOIN yields NULL for an orphan (broken repo FK chain).
    // tenant:exempt reason=cross-tenant-liveness-reaper follow_up=PERMANENT-EXEMPTION-review-run-reaper
    const result = await client.query<ReapedRow>(
      "WITH reaped AS ( " +
        "  UPDATE core.review_runs " +
        "     SET lifecycle_state = 'CANCELLED', " +
        "         cancelled_at = now(), " +
        "         cancel_reason = 'timeout' " +
        "   WHERE lifecycle_state = 'RUNNING' " +
        "     AND started_at < now() - make_interval(secs => $1) " +
        "     AND NOT EXISTS (SELECT 1 FROM core.review_jobs j WHERE j.run_id = review_runs.run_id AND j.state IN ('ready','leased')) " +
        "  RETURNING run_id, review_id " +
        ") " +
        "SELECT r.run_id, r.review_id, rep.installation_id " +
        "FROM reaped r " +
        "JOIN core.pull_request_reviews ppr ON ppr.review_id = r.review_id " +
        "LEFT JOIN core.repositories rep ON rep.github_repo_id = ppr.repo_id",
      [staleAfterSeconds],
    );
    const rows = result.rows;

    for (const row of rows) {
      if (row.installation_id === null) {
        // Orphan run — the repo FK lookup missed (LEFT JOIN). The cancellation already applied in the
        // CTE UPDATE; skip the per-tenant audit emit rather than let bindAuditContext(null) →
        // AuditContextMissing roll back the ENTIRE sweep transaction (one orphan must not block reaping
        // every other stuck run). 1:1 with the Python `continue` after the warning.
        console.warn(
          `review_run.reaped: no installation_id via repo FK chain for run ${row.run_id}; ` +
            "reaped without audit row",
        );
        continue;
      }
      bindAuditContext(client, { installationId: row.installation_id });
      await emitAuditEvent({
        client,
        actorKind: "system",
        actorId: null,
        action: "review_run.reaped",
        targetKind: "review_run",
        targetId: String(row.run_id),
        before: { lifecycle_state: "RUNNING" },
        after: { lifecycle_state: "CANCELLED", cancel_reason: "timeout" },
        clock,
      });
    }

    return rows.length;
  });

  return ReviewRunReaperResultV1.parse({ scanned: reaped, reaped });
}
