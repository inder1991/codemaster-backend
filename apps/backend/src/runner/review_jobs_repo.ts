import { Kysely, sql } from "kysely";
import { uuid4 } from "#platform/randomness.js";
import { ReviewJobV1 } from "#contracts/review_jobs.v1.js";

export type EnqueueArgs = { runId: string; reviewId: string; installationId: string;
  deliveryId?: string | null; priority?: number; maxAttempts?: number };
export type FencedResult = { applied: boolean };

export class ReviewJobsRepo {
  constructor(private db: Kysely<unknown>) {}

  async enqueue(a: EnqueueArgs): Promise<string> {
    const jobId = uuid4();
    // The INSERT lists installation_id ⇒ raw-SQL tenancy gate escape hatch (a) is satisfied (no marker needed).
    await sql`INSERT INTO core.review_jobs
        (job_id, run_id, review_id, installation_id, delivery_id, priority, max_attempts)
      VALUES (${jobId}, ${a.runId}, ${a.reviewId}, ${a.installationId},
        ${a.deliveryId ?? null}, ${a.priority ?? 0}, ${a.maxAttempts ?? 3})`.execute(this.db);
    return jobId;
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
}
