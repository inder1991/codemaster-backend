// test/integration/runner/review_runner_boot.integration.test.ts
//
// CS2.1 (cutover-safety plan, finding CS2 — closes audit C6/OC4): the REVIEW-JOBS RunnerLoop is COMPOSED
// into the Postgres runtime. The cutover routes reviewPullRequest onto core.review_jobs — but until this
// task NOTHING drained that table (buildBackgroundRunner composed only the background/scheduler/outbox
// loops), so an enqueued review job would sit 'ready' forever. Proves, against the REAL composition seam:
//
//   (1) BOOT + DRAIN: buildBackgroundRunner (non-shadow) returns `reviewLoop` (the review_job_runner
//       RunnerLoop over a ReviewJobsRepo) + the single-cycle drive seam `runReviewCycleOnce()`; ONE cycle
//       CLAIMS an enqueued core.review_jobs row and drives the injected handler (the CS2.1 test seam —
//       the production default is the REAL runReviewJob; the stub records the job so the test runs
//       without GitHub/LLM side effects) and settles it 'done'.
//   (2) REAPER: an IDLE review cycle runs the UNIFIED reapStuckRuns — a stuck row (leased, lease expired,
//       attempts exhausted) flips dead atomically (job → dead, run → CANCELLED/'timeout', mutex released,
//       exactly ONE audit event) and the handler is NEVER driven (exhausted rows are not claimable).
//   (3) SHADOW: buildBackgroundRunner({shadow: true}) composes NO review loop — `reviewLoop` and
//       `runReviewCycleOnce` are ABSENT from the handles, so the supervised set can never start it. The
//       review pipeline performs heavy GitHub/LLM side effects; the shadow posture OMITS it entirely
//       (shadow observes background/scheduler/outbox + the would-enqueue, never the review pipeline).
//
// DB-gated (describeDb) against the DISPOSABLE Postgres only — NEVER the cluster. The suite-wide
// beforeEach DELETE on core.review_jobs isolates the cross-tenant claim()/reap scans (runs under
// --no-file-parallelism). The reaper's audit emit needs a dev KeyRegistry (no Vault) — installed in
// beforeAll, 1:1 with reap_stuck_runs.integration.test.ts.

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope

import { describeDb, INTEGRATION_DSN } from "../_db.js";
import {
  buildBackgroundRunner,
  type BackgroundRunnerConfig,
} from "#backend/runner/background_runner_main.js";
import { RunnerLoop, type JobHandler } from "#backend/runner/review_job_runner.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import {
  resetAuditKeyRegistryForTesting,
  setAuditKeyRegistry,
} from "#backend/security/audit_field_codec.js";
import { WallClock } from "#platform/clock.js";
import { disposePool } from "#platform/db/database.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";
import type { ReviewJobV1 } from "#contracts/review_jobs.v1.js";

import { seedTenant, payloadFor, cleanup, type Seed } from "./_fixtures.js";

const clock = new WallClock();

let db: Kysely<unknown>;
let pool: Pool;
if (INTEGRATION_DSN) {
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 6 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

/** Install a deterministic dev key registry so the reaper's audit before/after encryption has a key
 *  (no Vault) — 1:1 with reap_stuck_runs.integration.test.ts. */
beforeAll(() => {
  const reg = new KeyRegistry();
  reg.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(0x42)]]) }));
  setAuditKeyRegistry(reg);
});

afterAll(async () => {
  resetAuditKeyRegistryForTesting();
  await db?.destroy();
  // reapStuckRuns resolves the shared (ADR-0062) pool from the injected dsn via getPool — end it too.
  if (INTEGRATION_DSN) await disposePool(INTEGRATION_DSN);
});

// Cross-tenant scan isolation (vitest shuffles file order; claim() + reapStuckRuns scan ALL rows).
beforeEach(async () => {
  if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db);
});

/** Loop tunables for the composed runtime under test (mirrors the sibling integration TEST_CONFIGs;
 *  the scheduler/outbox loops are composed but never driven here). */
const TEST_CONFIG: BackgroundRunnerConfig = {
  owner: "review-boot-test", leaseS: 30, heartbeatS: 5, maxRuntimeS: 300, idleS: 30,
  pollIntervalS: 600, outboxIdleS: 600, outboxMaxAttempts: 5,
};

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

async function readJobState(jobId: string): Promise<string> {
  // tenant:exempt reason=test-read-job-by-pk follow_up=FOLLOW-UP-gf3-error-mode
  const r = await sql<{ state: string }>`SELECT state FROM core.review_jobs WHERE job_id = ${jobId}`
    .execute(db);
  return r.rows[0]!.state;
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

describeDb("CS2.1 — the REVIEW-JOBS RunnerLoop is composed into the Postgres runtime", () => {
  it("(1) non-shadow boot composes reviewLoop; runReviewCycleOnce CLAIMS an enqueued job and drives the handler", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(db, 211);
    try {
      const jobId = await repo.enqueue({
        runId: seed.runId,
        reviewId: seed.reviewId,
        installationId: seed.installationId,
        payload: payloadFor(seed),
      });

      // The CS2.1 test seam: a RECORDING stub handler replaces the real runReviewJob (no GitHub/LLM).
      const seen: Array<ReviewJobV1> = [];
      const stub: JobHandler = async (job) => {
        seen.push(job);
      };
      const handles = buildBackgroundRunner({
        db, clock, config: TEST_CONFIG, dsn: INTEGRATION_DSN!, reviewHandler: stub,
      });

      // The review loop is COMPOSED into the non-shadow runtime handles (audit C6/OC4 closed).
      expect(handles.reviewLoop).toBeInstanceOf(RunnerLoop);
      expect(typeof handles.runReviewCycleOnce).toBe("function");

      // ONE cycle: claim → handler → settle 'done' over the SAME pieces the loop owns.
      const res = await handles.runReviewCycleOnce!();
      expect(res.outcome).toBe("done");
      expect(res.jobId).toBe(jobId);

      // The stub SAW the claimed job (the loop drove the handler with the real row).
      expect(seen).toHaveLength(1);
      expect(seen[0]!.job_id).toBe(jobId);
      expect(seen[0]!.run_id).toBe(seed.runId);

      // The row settled 'done' on disk.
      expect(await readJobState(jobId)).toBe("done");
    } finally {
      await cleanup(db, seed);
    }
  });

  it("(2) an IDLE review cycle runs the unified reaper: stuck row → job dead + run CANCELLED + mutex released", async () => {
    const repo = new ReviewJobsRepo(db);
    const seed = await seedTenant(db, 212);
    try {
      // A STUCK row: maxAttempts=1, claimed by a "crashed" owner (attempts → 1 = max: exhausted), lease
      // expired, a live mutex stamped on it. claim() must NOT reclaim it (attempts exhausted) — only the
      // idle cycle's reapStuckRuns may flip it dead.
      const jobId = await repo.enqueue({
        runId: seed.runId,
        reviewId: seed.reviewId,
        installationId: seed.installationId,
        maxAttempts: 1,
        payload: payloadFor(seed),
      });
      const claimed = await repo.claim({ owner: "crashed-owner", leaseMs: 60_000, maxRuntimeMs: 600_000 });
      expect(claimed!.job_id).toBe(jobId);
      const mutexId = await seedHeldMutex(seed);
      await setJobMutexId(jobId, mutexId);
      await expireLease(jobId);

      let handlerCalls = 0;
      const stub: JobHandler = async () => {
        handlerCalls += 1;
      };
      const handles = buildBackgroundRunner({
        db, clock, config: TEST_CONFIG, dsn: INTEGRATION_DSN!, reviewHandler: stub,
      });

      // The queue holds ONLY the exhausted-stuck row → the cycle is IDLE → idle maintenance reaps.
      const res = await handles.runReviewCycleOnce!();
      expect(res.outcome).toBe("idle");
      expect(handlerCalls).toBe(0);

      // The UNIFIED reaper flipped job + run + mutex atomically (+ exactly ONE audit event).
      expect(await readJobState(jobId)).toBe("dead");
      const run = await readRunRow(seed.runId);
      expect(run.lifecycle_state).toBe("CANCELLED");
      expect(run.cancel_reason).toBe("timeout");
      expect(run.cancelled_at).not.toBeNull();
      expect(await readMutexReleasedAt(mutexId)).not.toBeNull();
      expect(await reapedAuditCount(seed.installationId, seed.runId)).toBe(1);
    } finally {
      // The reaper's audit emit FKs installation_id — clear it before cleanup() drops the installation.
      await sql`DELETE FROM audit.audit_events WHERE installation_id = ${seed.installationId}`.execute(db);
      await cleanup(db, seed);
    }
  });

  it("(3) SHADOW boot composes NO review loop: reviewLoop + runReviewCycleOnce are ABSENT from the handles", async () => {
    const shadowHandles = buildBackgroundRunner({
      db, clock, config: TEST_CONFIG, dsn: INTEGRATION_DSN!, shadow: true,
    });
    // The review pipeline performs heavy GitHub/LLM side effects — shadow OMITS the loop entirely, so
    // the supervised set structurally cannot start it (no run() handle exists to start).
    expect(shadowHandles.reviewLoop).toBeUndefined();
    expect(shadowHandles.runReviewCycleOnce).toBeUndefined();

    // Contrast: the SAME composition without shadow DOES carry the loop (the production default needs
    // no reviewHandler override — runReviewJob over the shared pool is the default; never driven here).
    const realHandles = buildBackgroundRunner({
      db, clock, config: TEST_CONFIG, dsn: INTEGRATION_DSN!,
    });
    expect(realHandles.reviewLoop).toBeInstanceOf(RunnerLoop);
    expect(typeof realHandles.runReviewCycleOnce).toBe("function");
  });
});
