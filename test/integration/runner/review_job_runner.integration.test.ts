import { afterAll, beforeEach, expect, it } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { runOneJob, TerminalCancelError } from "#backend/runner/review_job_runner.js";
import { WallClock } from "#platform/clock.js";
import { minimalReviewPayload, readRun, seedRun, seedRunWithState } from "./_fixtures.js";

const clock = new WallClock();

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation): vitest.config.ts shuffles test order, and claim()/reapStuckRuns()
// are CROSS-TENANT scans over ALL core.review_jobs rows. Without per-test cleanup a prior (shuffled) test's
// leftover 'ready'/'leased' job gets claimed instead of the just-enqueued one and flakes the outcome assertions.
// Safe because test:integration runs --no-file-parallelism (no other file writes core.review_jobs concurrently)
// and only the runner tests write this brand-new table.
beforeEach(async () => { if (INTEGRATION_DSN) await sql`DELETE FROM core.review_jobs`.execute(db); });

describeDb("runOneJob", () => {
  it("runs the handler and reports done", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60, handler: async () => {} });
    expect(res.outcome).toBe("done");
  });
  it("reports failed→dead when the handler throws on its last attempt", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); const id = await repo.enqueue({ ...s, maxAttempts: 1, payload: minimalReviewPayload(s) });
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60, handler: async () => { throw new Error("boom"); } });
    expect(res.outcome).toBe("failed"); expect((await repo.getById(id))!.state).toBe("dead");
  });
  it("HARD-stops a handler that ignores the signal and hangs (slot returns)", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); const id = await repo.enqueue({ ...s, maxAttempts: 1, payload: minimalReviewPayload(s) });
    const t = Date.now();
    // heartbeatS huge → the heartbeat NEVER refuses within the test, so the hard race is the SOLE guarantee:
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 2, heartbeatS: 999, maxRuntimeS: 0.2,
      handler: () => new Promise(() => {}) }); // never resolves, ignores the signal
    expect(res.outcome).toBe("failed");
    expect(Date.now() - t).toBeLessThan(2000);             // returned ~maxRuntimeS, not hung
    expect((await repo.getById(id))!.state).toBe("dead");
  });
});

// ─── W0.3: TerminalCancelError → 'cancelled' outcome (E3) — supersede losers settle cancelled, NEVER re-enqueue ───
describeDb("runOneJob — terminal cancel", () => {
  it("a handler that throws TerminalCancelError settles 'cancelled' (NOT ready, NOT dead); attempts are NOT re-driven", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); const id = await repo.enqueue({ ...s, maxAttempts: 3, payload: minimalReviewPayload(s) });
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60,
      handler: async () => { throw new TerminalCancelError("superseded", new Error("flipCurrentRun")); } });
    expect(res.outcome).toBe("cancelled");
    const job = await repo.getById(id);
    expect(job!.state).toBe("cancelled");                  // NOT 'ready' (re-enqueue) and NOT 'dead' (failure exhaustion)
    expect((job as Record<string, unknown>).cancel_reason).toBe("superseded");
    // Terminal: even with attempts remaining (maxAttempts=3, attempts=1), claim() does NOT re-drive a cancelled job.
    expect(await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 })).toBeNull();
  });
});

// ─── W5.1b: runOneJob routes its terminal paths through terminalSettle (atomic job+run; F4) ───────────
describeDb("runOneJob — atomic terminal settlement (terminalSettle)", () => {
  it("a TerminalCancelError settles job→cancelled AND run→CANCELLED atomically; outcome 'cancelled'", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRunWithState(db, "RUNNING");
    const id = await repo.enqueue({ ...s, maxAttempts: 3, payload: minimalReviewPayload(s) });
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60,
      handler: async () => { throw new TerminalCancelError("superseded", new Error("flipCurrentRun")); } });
    expect(res.outcome).toBe("cancelled");
    const job = await repo.getById(id);
    expect(job!.state).toBe("cancelled");
    expect((job as Record<string, unknown>).cancel_reason).toBe("superseded");
    const run = await readRun(db, s.runId);
    expect(run.lifecycle_state).toBe("CANCELLED");          // run moved IN LOCKSTEP — no split-brain
    expect(run.cancelled_at).toBeTruthy();
  });

  it("the markFailed→dead path settles job→dead AND run→FAILED atomically; outcome 'failed'", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRunWithState(db, "RUNNING");
    const id = await repo.enqueue({ ...s, maxAttempts: 1, payload: minimalReviewPayload(s) });
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60,
      handler: async () => { throw new Error("boom"); } });
    expect(res.outcome).toBe("failed");
    expect((await repo.getById(id))!.state).toBe("dead");
    const run = await readRun(db, s.runId);
    expect(run.lifecycle_state).toBe("FAILED");
    expect(run.failed_at).toBeTruthy();
  });

  it("the retry (markFailed→ready) path leaves the run RUNNING (run unchanged)", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRunWithState(db, "RUNNING");
    const id = await repo.enqueue({ ...s, maxAttempts: 2, payload: minimalReviewPayload(s) });
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60,
      handler: async () => { throw new Error("transient"); } });
    expect(res.outcome).toBe("failed");
    expect((await repo.getById(id))!.state).toBe("ready");  // re-enqueued (attempts remain)
    expect((await readRun(db, s.runId)).lifecycle_state).toBe("RUNNING"); // run stays RUNNING on retry
  });
});

// ─── W5.1b (c): CONVERGENCE chaos — a terminalSettle txn failure rolls back ATOMICALLY, then converges ──
describeDb("runOneJob — terminalSettle convergence chaos (no age-sweep)", () => {
  it("inject a terminalSettle failure on attempt 1 → atomic rollback (job leased, run RUNNING) → reclaim/re-run converges", async () => {
    const s = await seedRunWithState(db, "RUNNING");
    // A repo that throws on the FIRST terminalSettle (simulating a txn-level failure mid-settle), then
    // delegates normally so the re-run converges. The atomic rollback means NEITHER row was settled.
    let failNext = true;
    const base = new ReviewJobsRepo(db);
    const repo = Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
      async terminalSettle(a: Parameters<ReviewJobsRepo["terminalSettle"]>[0]) {
        if (failNext) { failNext = false; throw new Error("injected terminalSettle txn failure (attempt 1)"); }
        return base.terminalSettle(a);
      },
    }) as ReviewJobsRepo;

    const id = await repo.enqueue({ ...s, maxAttempts: 1, payload: minimalReviewPayload(s) });

    // Attempt 1: the handler throws → runOneJob tries terminalSettle(dead/FAILED) → it THROWS → the
    // outcome cannot settle the job. The job lease remains; the run remains RUNNING (atomic rollback).
    await expect(runOneJob({ repo, clock, owner: "w1", leaseS: 0.05, heartbeatS: 999, maxRuntimeS: 60,
      handler: async () => { throw new Error("boom"); } })).rejects.toThrow("injected terminalSettle txn failure");
    // SPLIT-BRAIN CHECK: neither side moved — job still leased, run still RUNNING (NOT a cancelled/dead job
    // with a stranded RUNNING run, and NOT a CANCELLED run under a still-leased job).
    expect((await repo.getById(id))!.state).toBe("leased");
    expect((await readRun(db, s.runId)).lifecycle_state).toBe("RUNNING");

    // Convergence WITHOUT the age-sweep: the lease expires, the runner reclaims (attempts < max again? no —
    // maxAttempts=1 was reached). So bump max_attempts so claim() can reclaim the expired lease and re-run.
    await new Promise((r) => setTimeout(r, 80));            // lease (50ms) expires
    // tenant:exempt reason=test-bump-max-attempts-by-pk follow_up=FOLLOW-UP-gf3-error-mode
    await sql`UPDATE core.review_jobs SET max_attempts = 2 WHERE job_id = ${id}`.execute(db);

    // Attempt 2: terminalSettle now succeeds → BOTH rows converge terminal.
    const res2 = await runOneJob({ repo, clock, owner: "w2", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60,
      handler: async () => { throw new Error("boom again"); } });
    expect(res2.outcome).toBe("failed");
    expect((await repo.getById(id))!.state).toBe("dead");
    const run = await readRun(db, s.runId);
    expect(run.lifecycle_state).toBe("FAILED");             // converged terminal, no age-sweep needed
    expect(run.failed_at).toBeTruthy();
  });
});

describeDb("runOneJob — chaos", () => {
  it("a stolen lease completes once; the loser reports lease_lost, not success", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); const id = await repo.enqueue({ ...s, payload: minimalReviewPayload(s) });
    // w1: attempt 1 hangs past its 100ms lease, no heartbeat (heartbeatS huge) → its later markDone is fenced out
    const w1 = runOneJob({ repo, clock, owner: "w1", leaseS: 0.1, heartbeatS: 999, maxRuntimeS: 60,
      handler: async () => { await new Promise((r) => setTimeout(r, 700)); } });
    await new Promise((r) => setTimeout(r, 200));    // w1's lease expires
    const w2 = await runOneJob({ repo, clock, owner: "w2", leaseS: 2, heartbeatS: 0.2, maxRuntimeS: 60, handler: async () => {} });
    const r1 = await w1;
    expect(w2.outcome).toBe("done");
    expect(r1.outcome).toBe("lease_lost");           // fenced: w1's markDone affected 0 rows
    expect((await repo.getById(id))!.state).toBe("done");
  });
});
