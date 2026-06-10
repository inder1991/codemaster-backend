import { createHash } from "node:crypto"; // sanctioned hashing primitive (clock_random gate bans random.*, NOT createHash)
import { type Kysely, sql } from "kysely";
import { uuid4 } from "#platform/randomness.js";
import { type Clock, WallClock } from "#platform/clock.js";
import { getPool, withPgTransaction } from "#platform/db/database.js";
import { bindAuditContext, emitAuditEvent } from "#backend/audit/emit.js";
import { ReviewJobV1 } from "#contracts/review_jobs.v1.js";
import { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";

// D1 (migration 0037): core.review_jobs is the durable workflow-argument store. enqueue REQUIRES a valid
// ReviewPullRequestPayloadV1 (inner schema_version=2); it is canonicalized + sha256'd at write, and
// verifyPayload re-parses + re-hashes it in the shell before running, so a corrupted/drifted row is caught.
export const JOB_PAYLOAD_SCHEMA_VERSION = 1; // F1: storage-envelope version (NOT the payload's inner schema_version=2)

export type EnqueueArgs = { runId: string; reviewId: string; installationId: string;
  payload: unknown; // validated inside enqueue via ReviewPullRequestPayloadV1.parse (D1)
  deliveryId?: string | null; priority?: number; maxAttempts?: number };
export type FencedResult = { applied: boolean };

/** Thrown by {@link ReviewJobsRepo.verifyPayload} when the stored payload's hash does not match the stored sha256. */
export class PayloadIntegrityError extends Error {
  constructor(public readonly jobId: string, message: string) {
    super(message);
    this.name = "PayloadIntegrityError";
  }
}

/**
 * Stable, key-ordered JSON encoding (recursively sorts object keys; arrays keep order; primitives pass
 * through) so the same payload always hashes identically across processes/re-runs. Mirrors the codebase's
 * `stableJson`/`sortKeysDeep` idiom (ingest/_workflow_events_repository.ts) — NOT a clock/random surface.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      // `key` is a bounded own-enumerable string key of a plain object (Object.keys) — not an
      // attacker-controlled object-key sink; the prototype-pollution threat model does not apply.
      // eslint-disable-next-line security/detect-object-injection
      sorted[key] = sortKeysDeep(src[key]);
    }
    return sorted;
  }
  return value;
}
/** sha256 hex over a string preimage. `createHash` is the gate-sanctioned hashing primitive. */
function sha256hex(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "utf-8")).digest("hex");
}

export class ReviewJobsRepo {
  /**
   * @param db          Kysely over the (shared, ADR-0062) pool — drives every fenced single-statement op.
   * @param reaperDeps  Collaborators for {@link reapStuckRuns}, which needs a raw `pg` transaction (so the
   *   per-run audit emit commits in the SAME txn as the job/run/mutex flip). Both OPTIONAL: `dsn` defaults
   *   to `CODEMASTER_PG_CORE_DSN` (the pool is resolved via the shared {@link getPool}, NOT a fresh pool —
   *   honoring ADR-0062), and `clock` defaults to {@link WallClock} (stamps the audit `created_at` only;
   *   the run's `cancelled_at` is the DB `now()`, faithful with `reviewRunReaperActivity`).
   */
  constructor(
    private db: Kysely<unknown>,
    private reaperDeps: { dsn?: string; clock?: Clock } = {},
  ) {}

  async enqueue(a: EnqueueArgs): Promise<string> {
    // D1: the job becomes the durable workflow-argument store. (1) validate the inner contract
    // (schema_version MUST be 2 — review_pull_request.v1.ts); an invalid payload throws here, BEFORE any
    // INSERT, so nothing is written. (2) canonicalize + (3) hash; (4) store payload + envelope version + sha.
    const payload = ReviewPullRequestPayloadV1.parse(a.payload);
    const canonical = canonicalJson(payload);
    const payloadSha256 = sha256hex(canonical);
    const jobId = uuid4();
    // The INSERT lists installation_id ⇒ raw-SQL tenancy gate escape hatch (a) is satisfied (no marker needed).
    await sql`INSERT INTO core.review_jobs
        (job_id, run_id, review_id, installation_id, delivery_id, priority, max_attempts,
         job_payload_schema_version, payload, payload_sha256)
      VALUES (${jobId}, ${a.runId}, ${a.reviewId}, ${a.installationId},
        ${a.deliveryId ?? null}, ${a.priority ?? 0}, ${a.maxAttempts ?? 3},
        ${JOB_PAYLOAD_SCHEMA_VERSION}, CAST(${canonical} AS jsonb), ${payloadSha256})`.execute(this.db);
    return jobId;
  }

  /**
   * Re-derive the typed workflow argument from a job row: parse the stored `payload` through
   * {@link ReviewPullRequestPayloadV1}, recompute its canonical hash, and assert it equals the stored
   * `payload_sha256`. The shell calls this BEFORE running — a hash mismatch (corruption / out-of-band edit)
   * raises {@link PayloadIntegrityError} so a drifted argument never silently drives a review.
   *
   * The driver hands JSONB back as a JS object; canonicalJson re-orders keys identically to enqueue, so the
   * recomputed hash is stable regardless of the column's internal byte order.
   */
  verifyPayload(job: ReviewJobV1): ReviewPullRequestPayloadV1 {
    const raw = (job as Record<string, unknown>)["payload"];
    const payload = ReviewPullRequestPayloadV1.parse(raw);
    const recomputed = sha256hex(canonicalJson(payload));
    const stored = (job as Record<string, unknown>)["payload_sha256"];
    if (recomputed !== stored) {
      throw new PayloadIntegrityError(
        job.job_id,
        `payload hash mismatch for job ${job.job_id}: stored=${String(stored)} recomputed=${recomputed}`,
      );
    }
    return payload;
  }

  async getById(jobId: string): Promise<ReviewJobV1 | null> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql<ReviewJobV1>`SELECT * FROM core.review_jobs WHERE job_id = ${jobId}`.execute(this.db);
    return r.rows[0] ? ReviewJobV1.parse(r.rows[0]) : null;
  }

  async claim(a: { owner: string; leaseMs: number; maxRuntimeMs: number }): Promise<ReviewJobV1 | null> {
    // tenant:exempt reason=worker-pool-claim-across-tenants follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql<ReviewJobV1>`
      UPDATE core.review_jobs SET state = 'leased', lease_owner = ${a.owner}, attempt_token = gen_random_uuid(),
             leased_until = now() + (${a.leaseMs}::double precision / 1000) * interval '1 second',
             timeout_at   = now() + (${a.maxRuntimeMs}::double precision / 1000) * interval '1 second',
             heartbeat_at = now(), started_at = COALESCE(started_at, now()), attempts = attempts + 1
        WHERE job_id = (
          SELECT job_id FROM core.review_jobs
            WHERE (state = 'ready'  AND run_after <= now())
               OR (state = 'leased' AND leased_until < now() AND attempts < max_attempts)  -- maxed crashes are NOT reclaimed
            ORDER BY priority DESC, run_after FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`.execute(this.db);
    return r.rows[0] ? ReviewJobV1.parse(r.rows[0]) : null;
  }

  async heartbeat(a: { jobId: string; owner: string; token: string; leaseMs: number }): Promise<boolean> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql`UPDATE core.review_jobs
        SET leased_until = now() + (${a.leaseMs}::double precision / 1000) * interval '1 second', heartbeat_at = now()
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}
        AND (timeout_at IS NULL OR now() < timeout_at)`.execute(this.db);
    return Number(r.numAffectedRows ?? 0n) === 1;
  }

  async markDone(a: { jobId: string; owner: string; token: string }): Promise<FencedResult> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql`UPDATE core.review_jobs
        SET state = 'done', finished_at = now(),
            leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
      .execute(this.db);
    return { applied: Number(r.numAffectedRows ?? 0n) === 1 };
  }

  /**
   * Terminally settle a job as `cancelled` (E3) — the superseded loser exits clean and is NEVER re-enqueued.
   * Fenced exactly like {@link markDone} (owning `lease_owner`+`attempt_token` required; a stale token affects
   * 0 rows → `applied:false`). Records `cancel_reason`+`finished_at` and clears ALL lease metadata, so a
   * `cancelled` job is neither `claim`-reclaimable (not `ready`, not a live `leased`) nor a `markFailed` retry.
   */
  async markCancelled(a: { jobId: string; owner: string; token: string; reason: string }): Promise<FencedResult> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql`UPDATE core.review_jobs
        SET state = 'cancelled', cancel_reason = left(${a.reason}, 2000), finished_at = now(),
            leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
      .execute(this.db);
    return { applied: Number(r.numAffectedRows ?? 0n) === 1 };
  }

  /**
   * Persist the acquired PR-mutex id onto the job row (D3/F6) so a re-run can REUSE it instead of a fresh
   * competing acquire. Fenced exactly like {@link markDone} — only the owning `lease_owner`+`attempt_token`
   * on a still-`leased` row may write, so a stolen lease (the superseded loser) cannot stamp a mutex id over
   * the rightful owner's. A stale token affects 0 rows → `applied:false`. Idempotent on re-write of the same id.
   */
  async persistMutexId(a: { jobId: string; owner: string; token: string; mutexId: string }): Promise<FencedResult> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql`UPDATE core.review_jobs SET mutex_id = ${a.mutexId}
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
      .execute(this.db);
    return { applied: Number(r.numAffectedRows ?? 0n) === 1 };
  }

  /**
   * Read the identity columns of a `core.pr_review_mutex` row by `mutex_id` for the shell's OWNERSHIP
   * VALIDATION (F6): the reuse path asserts the referenced row's (installation_id, repository_id, pr_number)
   * MATCH the job payload AND it is still live (`released_at IS NULL`), else it re-acquires fresh. The FK
   * `review_jobs.mutex_id → pr_review_mutex(mutex_id)` (migration 0037) guarantees the row EXISTS; this read
   * lets the code prove it is the RIGHT row. Returns `null` only if the row was hard-deleted (FK uses
   * ON DELETE SET NULL, so a deleted parent would already have nulled `mutex_id` — defensive).
   */
  async readMutexRow(mutexId: string): Promise<{
    mutex_id: string; installation_id: string; repository_id: string; pr_number: number;
    released_at: string | null;
  } | null> {
    // tenant:exempt reason=PK-lookup-by-mutex_id-for-ownership-validation follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql<{
      mutex_id: string; installation_id: string; repository_id: string; pr_number: number;
      released_at: string | null;
    }>`SELECT mutex_id, installation_id, repository_id, pr_number, released_at
       FROM core.pr_review_mutex WHERE mutex_id = ${mutexId}`.execute(this.db);
    return r.rows[0] ?? null;
  }

  async markFailed(a: { jobId: string; owner: string; token: string; error: string; baseBackoffMs: number }):
    Promise<{ applied: boolean; terminal: boolean }> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql<{ terminal: boolean }>`UPDATE core.review_jobs SET
        last_error  = left(${a.error}, 2000),
        state       = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'ready' END,
        dead_reason = CASE WHEN attempts >= max_attempts THEN left(${a.error}, 2000) ELSE dead_reason END,
        finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE finished_at END,
        -- exponential backoff with ±25% jitter (avoid a herd re-claiming after an LLM/GitHub incident):
        run_after   = now() + ((${a.baseBackoffMs}::double precision * power(2, attempts - 1)) * (0.75 + random() * 0.5) / 1000) * interval '1 second',
        lease_owner = NULL, attempt_token = NULL, leased_until = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}
      RETURNING (state = 'dead') AS terminal`.execute(this.db);
    return { applied: r.rows.length === 1, terminal: r.rows[0]?.terminal ?? false };
  }

  /**
   * Atomically settle a job AND its run terminal in ONE transaction (F4 — no split-brain). The job and the
   * run can only move TOGETHER: a single fenced `db.transaction()` (a) fence-updates `core.review_jobs`
   * (state → `jobState` ∈ {cancelled,dead}, `cancel_reason`/`dead_reason`, `finished_at`, ALL lease metadata
   * cleared) exactly like {@link markCancelled}/{@link markFailed}, and (b) iff that fence applied, updates
   * `core.review_runs` (lifecycle_state → `runState` ∈ {CANCELLED,FAILED}, stamping the matching terminal
   * timestamp so the AD-7 biconditional CHECKs `CANCELLED ⇔ cancelled_at` / `FAILED ⇔ failed_at` hold).
   *
   * Fenced like {@link markDone}: a STALE token affects 0 job rows → the run update is SKIPPED and the whole
   * transaction is a no-op (`applied:false`). So a stolen lease (the superseded loser) can neither cancel the
   * job nor strand the run — and a `terminalSettle` that throws mid-way (e.g. a txn-level failure on the run
   * update) ROLLS BACK both writes, leaving `job=leased` + `run=RUNNING` for the runner to reclaim and re-run
   * (convergence WITHOUT the age-sweep).
   *
   * The run's `cancel_reason` (CANCELLED only) is a separate, CHECK-constrained column on `core.review_runs`
   * (∈ superseded|operator_cancelled|timeout|repository_disabled|installation_suspended|shutdown) — it is the
   * `runCancelReason` arg (default `'operator_cancelled'`), DISTINCT from the job's free-text `reason` (which
   * carries the human-readable cause onto `review_jobs.cancel_reason`/`dead_reason`). The default avoids the
   * run-side `'superseded'` value on purpose: `'superseded'` carries a COUPLED invariant
   * (`ck_review_runs_supersede_reason` requires `superseded_by_run_id IS NOT NULL`), which the upstream
   * supersede primitive — NOT this terminal-settle — is responsible for setting. FAILED runs carry no
   * `cancel_reason` (left untouched).
   */
  async terminalSettle(a: {
    jobId: string; owner: string; token: string; runId: string;
    jobState: "cancelled" | "dead"; runState: "CANCELLED" | "FAILED";
    reason: string; runCancelReason?: string;
  }): Promise<FencedResult> {
    return this.db.transaction().execute(async (tx) => {
      // (a) Fence-update the JOB exactly like markCancelled/markFailed: only the owning lease may settle it.
      //     `reason` lands on cancel_reason (cancelled) or dead_reason (dead). A stale token → 0 rows.
      let jobAffected: bigint;
      if (a.jobState === "cancelled") {
        // tenant:exempt reason=PK-update-by-job_id-fenced follow_up=FOLLOW-UP-gf3-error-mode
        const r = await sql`UPDATE core.review_jobs
            SET state = 'cancelled', cancel_reason = left(${a.reason}, 2000), finished_at = now(),
                leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
          WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
          .execute(tx);
        jobAffected = r.numAffectedRows ?? 0n;
      } else {
        // tenant:exempt reason=PK-update-by-job_id-fenced follow_up=FOLLOW-UP-gf3-error-mode
        const r = await sql`UPDATE core.review_jobs
            SET state = 'dead', dead_reason = left(${a.reason}, 2000), finished_at = now(),
                leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
          WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
          .execute(tx);
        jobAffected = r.numAffectedRows ?? 0n;
      }
      if (Number(jobAffected) !== 1) {
        // Stale token: the job fence affected 0 rows. Touch NOTHING on the run — committing here changes no
        // row, so the run stays in its prior (e.g. RUNNING) state. No split-brain.
        return { applied: false };
      }
      // (b) The job settled → settle the RUN in lockstep. Stamp the matching terminal timestamp so the
      //     biconditional AD-7 CHECKs (CANCELLED ⇔ cancelled_at, FAILED ⇔ failed_at) hold at COMMIT.
      if (a.runState === "CANCELLED") {
        // tenant:exempt reason=PK-update-by-run_id-lockstep-with-job follow_up=FOLLOW-UP-gf3-error-mode
        await sql`UPDATE core.review_runs
            SET lifecycle_state = 'CANCELLED', cancelled_at = now(), cancel_reason = ${a.runCancelReason ?? "operator_cancelled"}
          WHERE run_id = ${a.runId}`.execute(tx);
      } else {
        // tenant:exempt reason=PK-update-by-run_id-lockstep-with-job follow_up=FOLLOW-UP-gf3-error-mode
        await sql`UPDATE core.review_runs
            SET lifecycle_state = 'FAILED', failed_at = now()
          WHERE run_id = ${a.runId}`.execute(tx);
      }
      return { applied: true };
    });
  }

  /**
   * The UNIFIED stuck-run reaper (D3, gate ④) — supersedes the old `reapCrashLooped` (which only
   * dead-lettered the job and left the run stuck at RUNNING + the PR-mutex held forever, so the review
   * read "In Progress" in the UI and the next push on the same PR was blocked).
   *
   * ONE {@link withPgTransaction} transaction does the whole sweep so a throw rolls EVERYTHING back (no
   * split-brain). For every STUCK job — `state='leased' AND leased_until < now() AND attempts >=
   * max_attempts` (lease expired AND attempts EXHAUSTED, so `claim()` will NOT reclaim it; an expired
   * lease with attempts REMAINING is deliberately LEFT for `claim()` to reclaim) — it atomically:
   *
   *   (1) flips the JOB → `dead` (`dead_reason` set, `finished_at=now()`, ALL lease metadata cleared) —
   *       a CTE `UPDATE … RETURNING (job_id, run_id, mutex_id)` so the reaped set drives steps 2-4;
   *   (2) flips each reaped run → `CANCELLED` (`lifecycle_state='CANCELLED'`, `cancelled_at=now()` (DB
   *       clock), `cancel_reason='timeout'`). CHECK-safe: `ck_review_runs_cancelled_at_present` +
   *       `ck_review_runs_cancel_reason` admit `'timeout'`; `superseded_by_run_id` is NOT set (only the
   *       `'superseded'` reason couples that invariant);
   *   (3) for each job that held a PR-mutex (`mutex_id IS NOT NULL`) releases that row
   *       (`released_at=now()` WHERE still live) so the mutex janitor/next push is unblocked;
   *   (4) records EXACTLY ONE `review_run.reaped` audit event per reaped run (resolving `installation_id`
   *       via the FK chain `review_id → pull_request_reviews.repo_id (github_repo_id) →
   *       repositories.installation_id`; an ORPHAN whose repo FK chain is broken — NULL installation —
   *       is reaped WITHOUT audit so one orphan cannot roll back the entire sweep, 1:1 with
   *       `reviewRunReaperActivity`).
   *
   * Cross-tenant by design (liveness backstop — MUST see every tenant's stuck runs); the raw-SQL sites
   * carry the inline `tenant:exempt` markers. Returns the count of jobs/runs reaped.
   */
  async reapStuckRuns(): Promise<number> {
    const dsn = this.reaperDeps.dsn ?? process.env["CODEMASTER_PG_CORE_DSN"];
    if (dsn === undefined || dsn === "") {
      throw new Error("reapStuckRuns: CODEMASTER_PG_CORE_DSN is not set and no dsn injected");
    }
    const clock: Clock = this.reaperDeps.clock ?? new WallClock();
    const pool = getPool(dsn);

    return withPgTransaction(pool, async (client) => {
      // (1) Flip every STUCK job → dead in ONE statement, RETURNing the run + mutex it stranded. The
      //     `attempts >= max_attempts` predicate is the exhaustion gate (an expired-but-retryable lease is
      //     NOT matched — claim() owns reclaiming those). The outer SELECT resolves installation_id for the
      //     audit fan-out via the same FK chain + LEFT JOIN as reviewRunReaperActivity (orphan → NULL).
      // tenant:exempt reason=worker-pool-claim-across-tenants follow_up=FOLLOW-UP-gf3-error-mode
      const reapedRes = await client.query<{
        job_id: string; run_id: string; mutex_id: string | null; installation_id: string | null;
      }>(
        "WITH reaped AS ( " +
          "  UPDATE core.review_jobs " +
          "     SET state = 'dead', " +
          "         dead_reason = COALESCE(dead_reason, 'lease expired with attempts exhausted (stuck run)'), " +
          "         finished_at = now(), " +
          "         leased_until = NULL, lease_owner = NULL, attempt_token = NULL, " +
          "         timeout_at = NULL, heartbeat_at = NULL " +
          "   WHERE state = 'leased' AND leased_until < now() AND attempts >= max_attempts " +
          "  RETURNING job_id, run_id, mutex_id " +
          ") " +
          "SELECT rj.job_id, rj.run_id, rj.mutex_id, rep.installation_id " +
          "FROM reaped rj " +
          "JOIN core.review_runs rr ON rr.run_id = rj.run_id " +
          "JOIN core.pull_request_reviews ppr ON ppr.review_id = rr.review_id " +
          "LEFT JOIN core.repositories rep ON rep.github_repo_id = ppr.repo_id",
        [],
      );
      const reaped = reapedRes.rows;

      for (const row of reaped) {
        // (2) The run dies WITH the job: CANCELLED / timeout / cancelled_at=now() (DB clock). CHECK-safe.
        // tenant:exempt reason=PK-update-by-run_id-lockstep-with-job follow_up=FOLLOW-UP-gf3-error-mode
        await client.query(
          "UPDATE core.review_runs " +
            "   SET lifecycle_state = 'CANCELLED', cancelled_at = now(), cancel_reason = 'timeout' " +
            " WHERE run_id = $1",
          [row.run_id],
        );

        // (3) Release the held PR-mutex (only if still live) so the next push on this PR is unblocked.
        if (row.mutex_id !== null) {
          // tenant:exempt reason=PK-update-by-mutex_id-release-stranded-lease follow_up=FOLLOW-UP-gf3-error-mode
          await client.query(
            "UPDATE core.pr_review_mutex SET released_at = now() " +
              "WHERE mutex_id = $1 AND released_at IS NULL",
            [row.mutex_id],
          );
        }

        // (4) EXACTLY ONE audit event per reaped run. Orphan (NULL installation_id via the LEFT JOIN) →
        //     skip the per-tenant emit rather than let bindAuditContext(null) roll back the whole sweep.
        if (row.installation_id === null) {
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

      return reaped.length;
    });
  }
}
