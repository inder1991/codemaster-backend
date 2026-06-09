import type { Clock } from "#platform/clock.js";
import type { ReviewJobsRepo } from "./review_jobs_repo.js";
import type { ReviewJobV1 } from "#contracts/review_jobs.v1.js";
import { cancellableSleep } from "./clock_async.js";
export type JobHandler = (job: ReviewJobV1, signal: AbortSignal) => Promise<void>;
export type RunOutcome = "idle" | "done" | "failed" | "lease_lost";
/** Sentinel the hard-runtime race resolves to when the handler overran `maxRuntimeS`. */
const HARD_TIMEOUT = Symbol("hard-timeout");
export async function runOneJob(o: { repo: ReviewJobsRepo; clock: Clock; owner: string; leaseS: number;
  heartbeatS: number; maxRuntimeS: number; handler: JobHandler }): Promise<{ outcome: RunOutcome; jobId?: string }> {
  const leaseMs = o.leaseS * 1000;
  const job = await o.repo.claim({ owner: o.owner, leaseMs, maxRuntimeMs: o.maxRuntimeS * 1000 });
  if (!job) return { outcome: "idle" };
  const token = job.attempt_token!;
  const work = new AbortController();   // cooperative stop of the handler (lease-loss OR runtime ceiling)
  const stop = new AbortController();    // stops the heartbeat + hard-timeout helpers once the job settles
  const hb = (async () => {
    try {
      while (!stop.signal.aborted) {
        await cancellableSleep(o.clock, o.heartbeatS, stop.signal);
        if (stop.signal.aborted) break;
        const held = await o.repo.heartbeat({ jobId: job.job_id, owner: o.owner, token, leaseMs }); // false past timeout_at too
        if (!held) { work.abort(new Error("lease lost or timed out")); break; }
      }
    } catch { work.abort(new Error("heartbeat error")); }   // never let the hb loop throw out
  })();
  // HARD runtime ceiling — guarantees the worker slot returns even if the handler ignores `work.signal`.
  const hardTimeout = (async (): Promise<typeof HARD_TIMEOUT | undefined> => {
    await cancellableSleep(o.clock, o.maxRuntimeS, stop.signal);
    if (stop.signal.aborted) return undefined;            // job settled first → no timeout
    work.abort(new Error("max runtime exceeded"));         // cooperative nudge for well-behaved handlers
    return HARD_TIMEOUT;
  })();
  let outcome: RunOutcome;
  try {
    const handlerDone: Promise<undefined> = o.handler(job, work.signal).then(() => undefined);
    const raced = await Promise.race([handlerDone, hardTimeout]);
    if (raced === HARD_TIMEOUT) {
      // Handler overran the ceiling (and may still be running, orphaned — it violated the honor-`signal`
      // contract). Settle as failed; the fence guards against any late completion write.
      const r = await o.repo.markFailed({ jobId: job.job_id, owner: o.owner, token,
        error: `max runtime ${o.maxRuntimeS}s exceeded`, baseBackoffMs: 1000 });
      outcome = r.applied ? "failed" : "lease_lost";
    } else {
      outcome = (await o.repo.markDone({ jobId: job.job_id, owner: o.owner, token })).applied ? "done" : "lease_lost";
    }
  } catch (e) {
    const r = await o.repo.markFailed({ jobId: job.job_id, owner: o.owner, token,
      error: e instanceof Error ? e.message : String(e), baseBackoffMs: 1000 });
    outcome = r.applied ? "failed" : "lease_lost";
  } finally { stop.abort(); await hb; await hardTimeout; }   // immediate stop (cancellableSleep wakes); helpers never mask `outcome`
  return { outcome, jobId: job.job_id };
}
