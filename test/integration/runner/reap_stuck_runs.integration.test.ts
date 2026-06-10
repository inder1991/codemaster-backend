// test/integration/runner/reap_stuck_runs.integration.test.ts
//
// W6.1 (D3, gate ④): reapStuckRuns — the UNIFIED reaper replacing reapCrashLooped. ONE
// withPgTransaction transaction that, for every STUCK job (state='leased' AND leased_until < now()
// AND attempts >= max_attempts — attempts exhausted), atomically: (1) job.state → 'dead'; (2) its run →
// CANCELLED (cancel_reason='timeout', cancelled_at=now()); (3) releases the job's PR-mutex row if held;
// (4) records EXACTLY ONE review_run.reaped audit event per reaped run.
//
// DB-gated against the DISPOSABLE Postgres (CODEMASTER_PG_CORE_DSN=…:5434/codemaster); SKIPS without a
// DSN (describeDb). Runs --no-file-parallelism. The audit emit needs a dev KeyRegistry (no Vault), so the
// suite installs one in beforeAll and the per-test beforeEach DELETEs core.review_jobs (cross-tenant scan
// isolation, 1:1 with the sibling runner tests).

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { randomUUID, randomInt } from "node:crypto"; // test/ is OUT of the clock/random gate's scope

import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";
import { disposePool } from "#platform/db/database.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import { minimalReviewPayload } from "./_fixtures.js";

let db: Kysely<unknown>;
let pool: Pool;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

/** Install a deterministic dev key registry so the audit before/after encryption has a key (no Vault). */
beforeAll(() => {
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(0x42)]]) }));
  setAuditKeyRegistry(reg);
});

afterAll(async () => {
  resetAuditKeyRegistryForTesting();
  await db?.destroy();
  // reapStuckRuns resolves the shared (ADR-0062) pool from CODEMASTER_PG_CORE_DSN via getPool — end it too.
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

// Cross-tenant scan isolation (vitest shuffles order; reapStuckRuns scans ALL leased rows).
beforeEach(async () => {
  if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db);
});

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  repositoryId: string;
  runId: string;
  reviewId: string;
  prNumber: number;
};

/**
 * Seed the FULL FK chain reapStuckRuns + its audit emit need: installation → repository (the audit FK
 * resolves installation_id via review_id → pull_request_reviews.repo_id (github_repo_id) →
 * repositories.installation_id, matching the reviewRunReaperActivity LEFT JOIN) PLUS the review chain
 * (pull_request_reviews → review_runs in `lifecycleState`) so review_jobs.run_id FK holds.
 */
async function seedTenant(lifecycleState: string, prNumber = 11): Promise<Seed> {
  const installationId = randomUUID();
  const repositoryId = randomUUID();
  const runId = randomUUID();
  const reviewId = randomUUID();
  const ghInstall = uniqueBigint();
  const ghRepo = uniqueBigint();

  await sql`INSERT INTO core.installations
      (installation_id, github_installation_id, account_login, account_type)
    VALUES (${installationId}, ${ghInstall}, ${`acct-${ghInstall}`}, 'Organization')`.execute(db);
  await sql`INSERT INTO core.repositories
      (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
    VALUES (${repositoryId}, ${installationId}, ${ghRepo}, ${`org/repo-${ghRepo}`}, 'main', true)`.execute(db);

  // pull_request_reviews.repo_id must equal the repositories.github_repo_id so the audit FK chain resolves.
  await sql`INSERT INTO core.pull_request_reviews
      (review_id, provider, repo_id, pr_number, provider_pr_id, status, created_at)
    VALUES (${reviewId}, 'github', ${ghRepo}, ${prNumber}, ${`gh-${reviewId}`}, 'open', now())`.execute(db);
  await sql`INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, attempt_number, lifecycle_state, is_ephemeral, started_at, created_at)
    VALUES (${runId}, ${reviewId}, 'pr_opened', 1, ${lifecycleState}, false, now(), now())`.execute(db);

  return { installationId, repositoryId, runId, reviewId, prNumber };
}

/** Insert a LIVE held mutex row for the seed and return its mutex_id (released_at NULL, future lease). */
async function seedHeldMutex(seed: Seed): Promise<string> {
  const mutexId = randomUUID();
  await sql`INSERT INTO core.pr_review_mutex
      (mutex_id, installation_id, repository_id, pr_number, holder_workflow_id, acquired_at, lease_expires_at)
    VALUES (${mutexId}, ${seed.installationId}, ${seed.repositoryId}, ${seed.prNumber}, 'wf-holder',
            now(), now() + interval '1 hour')`.execute(db);
  return mutexId;
}

/** Stamp a mutex_id onto a job row by PK (test helper; reapStuckRuns reads it to release the mutex). */
async function setJobMutexId(jobId: string, mutexId: string): Promise<void> {
  // tenant:exempt reason=test-set-mutex-id-by-pk follow_up=FOLLOW-UP-gf3-error-mode
  await sql`UPDATE core.review_jobs SET mutex_id = ${mutexId} WHERE job_id = ${jobId}`.execute(db);
}

/** Force a claimed job's lease into the PAST so the stuck-detection scan matches it. */
async function expireLease(jobId: string): Promise<void> {
  // tenant:exempt reason=test-expire-lease-by-pk follow_up=FOLLOW-UP-gf3-error-mode
  await sql`UPDATE core.review_jobs SET leased_until = now() - interval '1 minute' WHERE job_id = ${jobId}`
    .execute(db);
}

async function readJob(jobId: string): Promise<Record<string, unknown>> {
  // tenant:exempt reason=test-read-job-by-pk follow_up=FOLLOW-UP-gf3-error-mode
  const r = await sql<Record<string, unknown>>`SELECT * FROM core.review_jobs WHERE job_id = ${jobId}`.execute(db);
  return r.rows[0]!;
}

async function readRunRow(
  runId: string,
): Promise<{ lifecycle_state: string; cancel_reason: string | null; cancelled_at: string | null }> {
  const r = await sql<{ lifecycle_state: string; cancel_reason: string | null; cancelled_at: string | null }>`
    SELECT lifecycle_state, cancel_reason, cancelled_at FROM core.review_runs WHERE run_id = ${runId}`.execute(db);
  return r.rows[0]!;
}

async function readMutexReleasedAt(mutexId: string): Promise<string | null> {
  const r = await sql<{ released_at: string | null }>`
    SELECT released_at FROM core.pr_review_mutex WHERE mutex_id = ${mutexId}`.execute(db);
  return r.rows[0]!.released_at;
}

async function reapedAuditCount(installationId: string, runId: string): Promise<number> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit.audit_events
      WHERE installation_id = ${installationId} AND action = 'review_run.reaped' AND target_id = ${runId}`
    .execute(db);
  return r.rows[0]!.n;
}

async function cleanup(seed: Seed): Promise<void> {
  await sql`DELETE FROM core.review_jobs WHERE run_id = ${seed.runId}`.execute(db);
  await sql`DELETE FROM core.review_runs WHERE run_id = ${seed.runId}`.execute(db);
  await sql`DELETE FROM core.pull_request_reviews WHERE review_id = ${seed.reviewId}`.execute(db);
  await sql`DELETE FROM audit.audit_events WHERE installation_id = ${seed.installationId}`.execute(db);
  await sql`DELETE FROM core.installations WHERE installation_id = ${seed.installationId}`.execute(db);
}

describeDb("ReviewJobsRepo.reapStuckRuns", () => {
  it("reaps a stuck job+run+mutex atomically and records exactly ONE audit event", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant("RUNNING", 11);
    try {
      const jobId = await repo.enqueue({
        runId: seed.runId, reviewId: seed.reviewId, installationId: seed.installationId,
        maxAttempts: 1, payload: minimalReviewPayload(seed),
      });
      // Claim (attempts → 1 = max_attempts: exhausted), then expire its lease so it is STUCK.
      const claimed = await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 600_000 });
      expect(claimed!.job_id).toBe(jobId);
      const mutexId = await seedHeldMutex(seed);
      await setJobMutexId(jobId, mutexId);
      await expireLease(jobId);

      const reaped = await repo.reapStuckRuns();
      expect(reaped).toBeGreaterThanOrEqual(1);

      // (1) job → dead, lease metadata cleared.
      const job = await readJob(jobId);
      expect(job["state"]).toBe("dead");
      expect(job["attempt_token"]).toBeNull();
      expect(job["lease_owner"]).toBeNull();
      expect(job["finished_at"]).toBeTruthy();
      // (2) run → CANCELLED with cancel_reason='timeout', cancelled_at set.
      const run = await readRunRow(seed.runId);
      expect(run.lifecycle_state).toBe("CANCELLED");
      expect(run.cancel_reason).toBe("timeout");
      expect(run.cancelled_at).not.toBeNull();
      // (3) mutex released.
      expect(await readMutexReleasedAt(mutexId)).not.toBeNull();
      // (4) exactly ONE audit event for the reaped run.
      expect(await reapedAuditCount(seed.installationId, seed.runId)).toBe(1);
    } finally {
      await cleanup(seed);
    }
  });

  it("NEGATIVE: a LIVE lease (leased_until in the future) leaves job+run+mutex untouched", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant("RUNNING", 12);
    try {
      const jobId = await repo.enqueue({
        runId: seed.runId, reviewId: seed.reviewId, installationId: seed.installationId,
        maxAttempts: 1, payload: minimalReviewPayload(seed),
      });
      // Claim with a LONG lease — leased_until is in the FUTURE (live), so NOT stuck.
      await repo.claim({ owner: "w1", leaseMs: 600_000, maxRuntimeMs: 600_000 });
      const mutexId = await seedHeldMutex(seed);
      await setJobMutexId(jobId, mutexId);

      await repo.reapStuckRuns();

      expect((await readJob(jobId))["state"]).toBe("leased");
      expect((await readRunRow(seed.runId)).lifecycle_state).toBe("RUNNING");
      expect(await readMutexReleasedAt(mutexId)).toBeNull();
      expect(await reapedAuditCount(seed.installationId, seed.runId)).toBe(0);
    } finally {
      await cleanup(seed);
    }
  });

  it("NEGATIVE: an expired lease with attempts REMAINING is NOT reaped (left for claim() to reclaim)", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant("RUNNING", 13);
    try {
      // maxAttempts=3, claim once (attempts → 1 < 3: attempts REMAIN), then expire the lease.
      const jobId = await repo.enqueue({
        runId: seed.runId, reviewId: seed.reviewId, installationId: seed.installationId,
        maxAttempts: 3, payload: minimalReviewPayload(seed),
      });
      await repo.claim({ owner: "w1", leaseMs: 60_000, maxRuntimeMs: 600_000 });
      const mutexId = await seedHeldMutex(seed);
      await setJobMutexId(jobId, mutexId);
      await expireLease(jobId);

      await repo.reapStuckRuns();

      expect((await readJob(jobId))["state"]).toBe("leased"); // attempts remain → reclaimable, NOT reaped
      expect((await readRunRow(seed.runId)).lifecycle_state).toBe("RUNNING");
      expect(await readMutexReleasedAt(mutexId)).toBeNull();
      expect(await reapedAuditCount(seed.installationId, seed.runId)).toBe(0);
    } finally {
      await cleanup(seed);
    }
  });
});
