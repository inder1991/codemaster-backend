import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { runOneJob } from "#backend/runner/review_job_runner.js";
import { WallClock } from "#platform/clock.js";
import { seedRun } from "./_fixtures.js";

const clock = new WallClock();

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation): vitest.config.ts shuffles test order, and claim()/reapCrashLooped()
// are CROSS-TENANT scans over ALL core.review_jobs rows. Without per-test cleanup a prior (shuffled) test's
// leftover 'ready'/'leased' job gets claimed instead of the just-enqueued one and flakes the outcome assertions.
// Safe because test:integration runs --no-file-parallelism (no other file writes core.review_jobs concurrently)
// and only the runner tests write this brand-new table.
beforeEach(async () => { if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db); });

describeDb("runOneJob", () => {
  it("runs the handler and reports done", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue(s);
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60, handler: async () => {} });
    expect(res.outcome).toBe("done");
  });
  it("reports failed→dead when the handler throws on its last attempt", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); const id = await repo.enqueue({ ...s, maxAttempts: 1 });
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60, handler: async () => { throw new Error("boom"); } });
    expect(res.outcome).toBe("failed"); expect((await repo.getById(id))!.state).toBe("dead");
  });
  it("HARD-stops a handler that ignores the signal and hangs (slot returns)", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); const id = await repo.enqueue({ ...s, maxAttempts: 1 });
    const t = Date.now();
    // heartbeatS huge → the heartbeat NEVER refuses within the test, so the hard race is the SOLE guarantee:
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 2, heartbeatS: 999, maxRuntimeS: 0.2,
      handler: () => new Promise(() => {}) }); // never resolves, ignores the signal
    expect(res.outcome).toBe("failed");
    expect(Date.now() - t).toBeLessThan(2000);             // returned ~maxRuntimeS, not hung
    expect((await repo.getById(id))!.state).toBe("dead");
  });
});
