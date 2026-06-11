// Phase 4b W4b.2 (review blocker #3): per-loop SUPERVISION in the background-runner composition
// (background_runner_main.ts::runSupervisedLoops). Pre-W4b.2 the composition tied the three loops
// into a fail-fast race — ANY loop's escaped error fired stopAll(), so e.g. a scheduler fault
// stopped background-job execution AND outbox draining. Proves:
//   (1) ISOLATION: one loop rigged to throw on its FIRST cycle (a pass-level fault injected via a
//       poisoned dependency) crashes ALONE — the bounded crash metric fires
//       (codemaster_runner_loop_crashed_total{loop}), the OTHER TWO loops KEEP RUNNING (the runner
//       still claims + completes a job enqueued AFTER the crash; the outbox loop keeps claiming),
//       NO loop's stop() was called as a side effect (the stopAll-on-crash anti-pattern), and the
//       supervised composition stays PENDING; then a REAL stop() (the SIGTERM analogue) drains the
//       survivors and the composition resolves with exactly the one observed crash.
//   (2) GRACEFUL: with all three loops healthy, stop() resolves the composition with ZERO crashes
//       and the crash metric never fires (a graceful stop is not misreported as a crash).
//   (3) TOTAL LOSS: when EVERY loop crashes, the composition resolves on its own (no stop() ever
//       called) naming all the crashes — the entrypoint's fail-loud exit path fires and the
//       platform restarts the pod (no zombie process lingering with zero live loops).
//
// CS3.1 (cutover-safety finding CS3 — audit C5/H7/XH11/RT2) layers the QUERYABLE liveness signal
// onto the same seam: runSupervisedLoops registers every supervised loop on the threaded
// LoopHealthRegistry BEFORE start (initially "up"), and a loop's escaped crash marks THAT loop
// down (with the crash reason) IN ADDITION to the existing metric + log — so a dead required loop
// is no longer invisible (the counter is a no-op meter in an unwired pod; /readyz is hardcoded
// ready). Each scenario asserts the registry alongside the existing supervision contract:
//   (1) ISOLATION  → the rigged loop is DOWN with its reason, the survivors stay UP,
//       allRequiredUp() false, and the crash metric STILL fires;
//   (2) GRACEFUL   → a stop()-drained run leaves every loop UP (a graceful stop is not a crash);
//   (3) TOTAL LOSS → every supervised loop (review included) is DOWN.
//
// Runs ONLY against an explicitly-set CODEMASTER_PG_CORE_DSN (the disposable :5434 DB) — never a
// shared cluster (test skips when the DSN is absent, per test/integration/_db.ts).
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { WallClock } from "#platform/clock.js";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { BackgroundJobsRepo } from "#backend/runner/background_jobs_repo.js";
import { BackgroundRunnerLoop } from "#backend/runner/background_runner.js";
import { HandlerRegistry } from "#backend/runner/handler_registry.js";
import { LoopHealthRegistry } from "#backend/runner/loop_health.js";
import { OutboxDispatcherLoop, type OutboxActivityFns } from "#backend/runner/outbox_dispatcher_loop.js";
import { SchedulerLoop } from "#backend/runner/scheduler.js";
import { runSupervisedLoops } from "#backend/runner/background_runner_main.js";

// ── Metric spy (vi.mock is hoisted; the supervisor imports by name, so overriding the module
// export lets the tests PROVE the bounded crash counter fired with its {loop} label — same idiom
// as scheduler.integration.test.ts). ──
const { loopCrashSpy } = vi.hoisted(() => ({ loopCrashSpy: vi.fn() }));
vi.mock("#backend/runner/runner_metrics.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>(); // pass-through; only the one spy is overridden
  return { ...actual, recordRunnerLoopCrashed: loopCrashSpy };
});

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

// AUTHORIZED DEVIATION (test isolation — same rationale as background_runner_main.integration.test.ts):
// vitest.config.ts shuffles test order, and claim() is a cross-job_type scan over ALL
// core.background_jobs rows; the per-test wipe keeps claim targets exact. Safe because
// test:integration runs --no-file-parallelism and the other suites clean their own rows.
beforeEach(async () => {
  loopCrashSpy.mockClear();
  if (INTEGRATION_DSN) {
    await sql`DELETE FROM core.background_jobs`.execute(db);
    await sql`DELETE FROM core.scheduled_jobs`.execute(db);
  }
});

/** A SchedulerLoop whose FIRST poll pass throws at the pass level (the due-SELECT txn machinery) —
 *  the W4a.2 per-SCHEDULE isolation cannot catch it, so the error escapes run() (the documented
 *  fail-loud contract the supervisor must contain). */
function riggedSchedulerLoop(message: string): SchedulerLoop {
  const poisonedDb = {
    transaction: () => ({
      execute: async (): Promise<never> => { throw new Error(message); },
    }),
  } as unknown as Kysely<unknown>;
  const unreachableRepo = { enqueue: async (): Promise<never> => { throw new Error("unreachable"); } };
  return new SchedulerLoop({ repo: unreachableRepo, db: poisonedDb, clock: new WallClock(), pollIntervalS: 600 });
}

/** Healthy stub outbox activities: empty claims (idle loop), counting each claim pass. */
function stubOutboxActivities(onClaim: () => void): OutboxActivityFns {
  return {
    claimPendingRows: async () => { onClaim(); return []; },
    dispatchRow: async () => undefined,
    markDispatched: async () => undefined,
    markAttemptFailed: async () => undefined,
  };
}

describeDb("runSupervisedLoops — per-loop supervision (Phase 4b W4b.2, review blocker #3)", () => {
  it("(1) ISOLATION: a crashed scheduler is metered + marked DOWN on the health registry + stops ALONE; runner + outbox KEEP RUNNING until a real stop()", async () => {
    const clock = new WallClock();
    const repo = new BackgroundJobsRepo(db);

    // Healthy RUNNER loop over the real DB — tiny idleS so it visibly keeps claiming post-crash.
    const registry = new HandlerRegistry();
    const jobType = `w4b2-job-${randomUUID()}`;
    const handled: Array<string> = [];
    registry.register(jobType, async (payload) => { handled.push((payload as { tag: string }).tag); });
    const runnerLoop = new BackgroundRunnerLoop({
      repo, registry, clock, owner: "w4b2-supervision-test",
      leaseS: 2, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 0.05,
    });

    // Healthy OUTBOX loop (stub activities — empty claims; driving the REAL dispatchRow would route
    // rows into the real sink registry) — claim count proves it keeps cycling post-crash.
    let outboxClaims = 0;
    const outboxLoop = new OutboxDispatcherLoop({
      activities: stubOutboxActivities(() => { outboxClaims += 1; }), clock, idleS: 0.05,
    });

    // RIGGED scheduler: throws a pass-LEVEL error on its first poll (escapes run() by contract).
    const schedulerLoop = riggedSchedulerLoop("rigged: scheduler pass-level failure");

    // No supervisor may call stop() on ANY loop as a crash side effect (the pre-W4b.2 stopAll tie).
    const stopSpies = [
      vi.spyOn(runnerLoop, "stop"), vi.spyOn(schedulerLoop, "stop"), vi.spyOn(outboxLoop, "stop"),
    ];

    // CS3.1: the queryable liveness registry the supervisor feeds — registered before start, fed on crash.
    const health = new LoopHealthRegistry({ clock });

    let settled = false;
    const supervised = runSupervisedLoops({ runnerLoop, schedulerLoop, outboxLoop, health })
      .then((crashes) => { settled = true; return crashes; });

    // The supervisor registered EXACTLY the supervised set as REQUIRED loops (no review loop here).
    expect(Object.keys(health.snapshot()).sort()).toEqual(["outbox", "runner", "scheduler"]);

    // The scheduler crashes on its first poll → the bounded crash metric fires for IT alone.
    await vi.waitFor(() => { expect(loopCrashSpy).toHaveBeenCalledWith({ loop: "scheduler" }); });
    expect(loopCrashSpy).toHaveBeenCalledTimes(1);

    // CS3.1: the crash is now a QUERYABLE readiness signal — the dead loop is DOWN with its reason
    // (in ADDITION to the metric above, which is a no-op meter in an unwired pod), the survivors
    // stay UP, and the aggregate flips.
    expect(health.allRequiredUp()).toBe(false);
    const snap = health.snapshot();
    expect(snap["scheduler"]).toMatchObject({
      status: "down",
      reason: expect.stringContaining("rigged: scheduler pass-level failure") as unknown,
    });
    expect(snap["runner"]).toMatchObject({ status: "up" });
    expect(snap["outbox"]).toMatchObject({ status: "up" });

    // The RUNNER is still alive: a job enqueued AFTER the crash is claimed + completed.
    const jobId = await repo.enqueue({ jobType, payload: { tag: "post-crash" } });
    await vi.waitFor(() => { expect(handled).toEqual(["post-crash"]); }, { timeout: 5000 });
    expect((await repo.getById(jobId))!.state).toBe("done");

    // The OUTBOX loop is still alive: its claim passes keep advancing.
    const claimsAtCrash = outboxClaims;
    await vi.waitFor(() => { expect(outboxClaims).toBeGreaterThan(claimsAtCrash); }, { timeout: 5000 });

    // The composition is still PENDING (survivors run) and NOBODY called any loop's stop().
    expect(settled).toBe(false);
    for (const spy of stopSpies) expect(spy).not.toHaveBeenCalled();

    // The SIGTERM analogue — a REAL stop() drains the survivors; the composition resolves with
    // exactly the one observed crash.
    runnerLoop.stop(); schedulerLoop.stop(); outboxLoop.stop();
    const crashes = await supervised;
    expect(settled).toBe(true);
    expect(crashes).toEqual([{ loop: "scheduler", error: expect.any(Error) }]);
    expect(crashes[0]!.error.message).toMatch(/rigged: scheduler pass-level failure/);

    // CS3.1: a GRACEFUL stop() is not a crash — the drained survivors stay UP; only the genuinely
    // crashed loop reads down after the run ends.
    const finalSnap = health.snapshot();
    expect(finalSnap["runner"]).toMatchObject({ status: "up" });
    expect(finalSnap["outbox"]).toMatchObject({ status: "up" });
    expect(finalSnap["scheduler"]).toMatchObject({ status: "down" });
  }, 15_000);

  it("(2) GRACEFUL: healthy loops stopped via stop() report ZERO crashes, never fire the crash metric, and stay UP on the health registry", async () => {
    const clock = new WallClock();
    const repo = new BackgroundJobsRepo(db);
    const runnerLoop = new BackgroundRunnerLoop({
      repo, registry: new HandlerRegistry(), clock, owner: "w4b2-graceful-test",
      leaseS: 2, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 30,
    });
    const schedulerLoop = new SchedulerLoop({ repo, db, clock, pollIntervalS: 600 });
    const outboxLoop = new OutboxDispatcherLoop({ activities: stubOutboxActivities(() => undefined), clock, idleS: 600 });
    const health = new LoopHealthRegistry({ clock });

    const t = Date.now();
    const supervised = runSupervisedLoops({ runnerLoop, schedulerLoop, outboxLoop, health });
    await new Promise((r) => setTimeout(r, 100)); // all loops are inside their idle/poll sleeps
    runnerLoop.stop(); schedulerLoop.stop(); outboxLoop.stop();
    expect(await supervised).toEqual([]);
    expect(Date.now() - t).toBeLessThan(2000); // interrupted the huge sleeps, not waited out
    expect(loopCrashSpy).not.toHaveBeenCalled();
    // CS3.1: a graceful stop is never misreported as a degradation — every loop stays UP.
    expect(health.allRequiredUp()).toBe(true);
  }, 10_000);
});

// ── (3) TOTAL LOSS — pure-composition behavior, no DB needed ────────────────────────────────────
describe("runSupervisedLoops — every loop crashed (the fail-loud exit path)", () => {
  it("resolves ON ITS OWN (no stop() ever called) naming all four crashes — every loop DOWN on the registry, no zombie wait", async () => {
    const clock = new WallClock();
    loopCrashSpy.mockClear();
    const runnerLoop = new BackgroundRunnerLoop({
      // Poisoned repo: the claim() throw escapes run() (no W4a.2-style per-iteration isolation).
      repo: { claim: async (): Promise<never> => { throw new Error("rigged: runner claim failure"); } } as unknown as BackgroundJobsRepo,
      registry: new HandlerRegistry(), clock, owner: "w4b2-total-loss-test",
      leaseS: 2, heartbeatS: 0.2, maxRuntimeS: 60, idleS: 600,
    });
    const schedulerLoop = riggedSchedulerLoop("rigged: scheduler pass-level failure");
    const outboxLoop = new OutboxDispatcherLoop({
      activities: {
        claimPendingRows: async (): Promise<never> => { throw new Error("rigged: outbox claim failure"); },
        dispatchRow: async () => undefined, markDispatched: async () => undefined, markAttemptFailed: async () => undefined,
      },
      clock, idleS: 600,
    });
    // CS2.1's optional fourth loop joins the supervised set structurally ({ run() }) — rigging it
    // too pins that `review` is registered + health-fed exactly like the always-present three.
    const reviewLoop = { run: async (): Promise<never> => { throw new Error("rigged: review claim failure"); } };
    const health = new LoopHealthRegistry({ clock });

    const crashes = await runSupervisedLoops({ runnerLoop, schedulerLoop, outboxLoop, reviewLoop, health });
    expect(crashes.map((c) => c.loop).sort()).toEqual(["outbox", "review", "runner", "scheduler"]);
    expect(crashes.every((c) => c.error.message.startsWith("rigged:"))).toBe(true);
    expect(loopCrashSpy).toHaveBeenCalledTimes(4);

    // CS3.1: total loss is fully queryable — EVERY supervised loop reads down with its own reason.
    expect(health.allRequiredUp()).toBe(false);
    const snap = health.snapshot();
    expect(Object.keys(snap).sort()).toEqual(["outbox", "review", "runner", "scheduler"]);
    for (const [loop, state] of Object.entries(snap)) {
      expect(state, `loop=${loop}`).toMatchObject({
        status: "down",
        reason: expect.stringContaining("rigged:") as unknown,
      });
    }
  }, 10_000);
});
