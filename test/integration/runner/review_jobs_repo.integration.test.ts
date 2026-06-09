import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { seedRun } from "./_fixtures.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation): vitest.config.ts shuffles test order, and claim()/reapCrashLooped()
// are CROSS-TENANT scans over ALL core.review_jobs rows. Without per-test cleanup a prior (shuffled) test's
// leftover 'ready'/'leased' job gets claimed/reaped instead of the just-enqueued one and flakes 'attempts===1'.
// Safe because test:integration runs --no-file-parallelism (no other file writes core.review_jobs concurrently)
// and only the runner tests write this brand-new table.
beforeEach(async () => { if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db); });

describeDb("ReviewJobsRepo.enqueue", () => {
  it("enqueues + reads back", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const id = await repo.enqueue(s);
    expect((await repo.getById(id))?.state).toBe("ready");
  });
});

describeDb("ReviewJobsRepo.claim", () => {
  it("claims, mints a token, sets timeout_at; a 2nd claimer gets nothing", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue(s);
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    expect(c?.attempt_token).toBeTruthy(); expect(c?.attempts).toBe(1);
    expect((c as any).timeout_at).toBeTruthy();
    expect(await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 })).toBeNull();
  });
  it("reclaims an expired lease with a NEW token while attempts remain", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue({ ...s, maxAttempts: 3 });
    const c1 = await repo.claim({ owner: "w1", leaseMs: 1, maxRuntimeMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    const c2 = await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 });
    expect(c2?.job_id).toBe(c1!.job_id); expect(c2!.attempt_token).not.toBe(c1!.attempt_token); expect(c2!.attempts).toBe(2);
  });
  it("does NOT reclaim an expired lease whose attempts are exhausted (v3 #2)", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue({ ...s, maxAttempts: 1 });
    await repo.claim({ owner: "w1", leaseMs: 1, maxRuntimeMs: 60_000 }); // attempts → 1 (== max)
    await new Promise((r) => setTimeout(r, 50));                          // lease expires; worker "crashed"
    expect(await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 })).toBeNull(); // not re-run
  });
});

describeDb("ReviewJobsRepo.heartbeat", () => {
  it("extends for the owning token; refuses a stale token; refuses past timeout_at", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue(s);
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 30 }); // 30ms runtime ceiling
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, leaseMs: 1000 })).toBe(true);
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: crypto.randomUUID(), leaseMs: 1000 })).toBe(false);
    await new Promise((r) => setTimeout(r, 60)); // exceed timeout_at
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, leaseMs: 1000 })).toBe(false);
  });
});

describeDb("ReviewJobsRepo.markDone", () => {
  it("completes for the owning token and clears the lease; a stale token is applied:false", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue(s);
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    expect((await repo.markDone({ jobId: c!.job_id, owner: "w1", token: crypto.randomUUID() })).applied).toBe(false);
    expect((await repo.getById(c!.job_id))!.state).toBe("leased");
    expect((await repo.markDone({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token! })).applied).toBe(true);
    const done = await repo.getById(c!.job_id);
    expect(done!.state).toBe("done");
    expect((done as any).attempt_token).toBeNull();          // lease metadata cleared (v3 #9)
    expect((done as any).lease_owner).toBeNull();
  });
});
