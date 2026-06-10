import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { RunnerLoop } from "#backend/runner/review_job_runner.js";
import { WallClock } from "#platform/clock.js";
import { minimalReviewPayload, seedRun } from "./_fixtures.js";

const clock = new WallClock();

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation): vitest.config.ts shuffles test order, and the RunnerLoop's
// claim()/reapStuckRuns() are CROSS-TENANT scans over ALL core.review_jobs rows. Without per-test cleanup
// a prior (shuffled) test's leftover 'ready'/'leased' job gets claimed instead of the just-enqueued one and
// flakes the drain/idle assertions. Safe because test:integration runs --no-file-parallelism (no other file
// writes core.review_jobs concurrently) and only the runner tests write this brand-new table.
beforeEach(async () => { if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db); });

describeDb("RunnerLoop", () => {
  it("drains the in-flight job and stops claiming new ones on stop()", async () => {
    const repo = new ReviewJobsRepo(db);
    const s1 = await seedRun(db); const id1 = await repo.enqueue({ ...s1, payload: minimalReviewPayload(s1) });
    const s2 = await seedRun(db); const id2 = await repo.enqueue({ ...s2, payload: minimalReviewPayload(s2) });
    let started = 0;
    const loop = new RunnerLoop({ repo, clock, owner: "w1", leaseS: 2, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 0.05,
      handler: async () => { started++; await new Promise((r) => setTimeout(r, 300)); } });
    const run = loop.run();
    await new Promise((r) => setTimeout(r, 100)); // first job is in flight
    loop.stop();
    await run;
    expect(started).toBe(1);
    const states = [ (await repo.getById(id1))!.state, (await repo.getById(id2))!.state ].sort();
    expect(states).toEqual(["done", "ready"]); // one finished, the other never claimed
  });
  it("stop() interrupts the idle wait promptly (no jobs)", async () => {
    const repo = new ReviewJobsRepo(db);
    const loop = new RunnerLoop({ repo, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 30,
      handler: async () => {} });
    const t = Date.now(); const run = loop.run();
    await new Promise((r) => setTimeout(r, 100)); // loop is in its idle sleep
    loop.stop();
    await run;
    expect(Date.now() - t).toBeLessThan(2000); // did NOT wait the full 30s idleS
  });
});
