# De-Temporal `review_jobs` Runner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Temporal with a coarse-grained Postgres job runner — *one durable `review_jobs` row per whole review attempt, executed in one process* — per ADR-0077 v8, without re-decomposing the review into per-step jobs.

**Architecture:** A `review_jobs` table (lease + fence + state machine) drained by worker pods; each worker claims one review, runs the existing `orchestrate()` **unchanged in-process** inside a new non-Temporal *review-job shell* (gate → mutex → workspace → placeholder → orchestrate → finalizers), heartbeats its lease, and re-runs the whole review from scratch on a hard crash (the LLM ledger replays paid calls). Determinism/replay machinery from Temporal is deleted; the existing primitives (PR mutex, supersede + `current_run_id`, the ADR-0068 ledger, the reaper, the outbox claim pattern) are reused.

**Tech Stack:** TypeScript (ESM, Node 22), Fastify, Kysely + raw `sql\`…\``, Zod v4, PostgreSQL 16, `node-pg-migrate` (up-only), vitest. Disposable Postgres on `:5439` (`CODEMASTER_PG_CORE_DSN=postgresql://postgres:devpass@localhost:5439/postgres`) for all DB tests — **never the cluster**.

**Source of truth:** `docs/adr/0077-temporal-removal-postgres-job-runner.md` (esp. the v7 "Implementation hazards & corrections" register and the v8 "Implementation-plan required deliverables" checklist — those are authoritative over any v4–v6 prose).

---

## Program decomposition (this is a multi-subsystem, ~8–12-week program)

Per the writing-plans scope-check, this is **not** one monolithic plan. It is a sequence of phase sub-plans; **Phase 1 is detailed bite-sized below; Phases 0 and 2–6 are scoped outlines, refined just-in-time** (matching the repo's per-sprint refinement convention) once their predecessor lands and its learnings are in hand.

| Phase | Deliverable | Gate / dependency | Exit criteria |
|---|---|---|---|
| **0 (build-gate)** | **Cost-accounting compensating journal** (ADR §v7-#3 / deliverable #1) | none; **must be DESIGNED before the runner runs real reviews in prod** | signed per-call journal; daily total derived/checked from it; orphan healed by *appending* a release row (never a blind subtract); migration + parity tests vs `checkOrRaise`/`recordCallCost` green |
| **1 (this plan)** | **Runner foundation** — `review_jobs` table, `ReviewJobsRepo` (claim/lease/fence/heartbeat/state-machine), `runWithRetry`, the worker-loop skeleton with a pluggable handler | none (does not touch the cost enforcer) | chaos tests green: lease-steal fenced, state machine correct, crash-recovery re-runs an injected handler exactly once |
| **2** | **Review-job shell + in-flight ledger + supersede** — the non-Temporal shell around `orchestrate()`, the in-flight LLM ledger protocol, the 5 supersede checkpoints, the de-Temporal seam (`isCancelled`/`classifyFailure`/`Metrics`), finalizer protocol, reaper unification | Phase 1; Phase 0 before prod | a real review runs end-to-end on the runner against `:5439`; supersede/lost-claim/post-idempotency chaos cases green |
| **3** | **`background_jobs` + scheduler + dedicated runner process** — the generic coarse table for non-review workloads, the in-app advisory-lock scheduler, the always-on poller process | Phase 1 (shares the skeleton) | crons fire via the scheduler; confluence runs per-space; the dispatcher poller runs in its own process (no `setInterval`, `clock.sleep` only) |
| **4** | **Cutover** — `review_job_enqueue` outbox sink, `target_engine` routing, redelivery dedup, drain + kill-switch + shadow parity harness | Phases 1–3; Phase 0 in prod | shadow run matches Temporal on a corpus; one install cut over behind a flag with a working rollback |
| **5** | **Operator UI/API** — per-job state/attempts/lease/heartbeat/finalizer/engine views + retry/cancel/reconcile-delivery controls, RBAC + audit | Phase 2 (data) | the admin frontend lists/inspects/controls review jobs |
| **6** | **Temporal teardown** — delete the workflow bundles, the data converter, the sandbox/bundle gates, `workflow.patched`, the two-worker split, the temporal-helmchart, `@temporalio/*` | Phase 4 fully cut over + soaked ≥1 week | repo builds + boots with zero `@temporalio` imports |

**Cost decision (resolves the ADR fork):** Phase 0 uses the **compensating signed journal**, not a re-architecture of `checkOrRaise`/`recordCallCost` to per-reservation rows. Rationale: the journal is additive (a new table + derive/check), heals orphans by *appending* (never a destructive subtract against the shared aggregate), and avoids a Pattern-D change to the parity-critical spine enforcer. (Recorded here so Phase 0 can be detailed without re-opening the fork.)

> **Build-gate note:** Phase 1 is safe to build first — it is a new table + repo + loop with a *pluggable* handler, touches neither the cost enforcer nor `orchestrate()`, and runs only against `:5439`. The ADR's "do not start the runner until cost is designed" bars running **real reviews through it in production** (Phase 4), not building/testing the foundation. Phase 0 proceeds in parallel and must land before Phase 4.

---

## Phase 1 — Runner foundation

### File structure (Phase 1)

- Create `migrations/0036_review_jobs.sql` — the `core.review_jobs` table + indexes.
- Create `libs/contracts/src/review_jobs.v1.ts` — `ReviewJobV1`, `JobState`, claim/result contracts.
- Create `apps/backend/src/runner/review_jobs_repo.ts` — `ReviewJobsRepo`: `enqueue`/`getById`/`claim`/`heartbeat`/`markDone`/`markFailed` (lease + fence + state machine). New `runner/` dir = the new subsystem's home.
- Create `apps/backend/src/runner/run_with_retry.ts` — `runWithRetry(policy, fn)` + `RetryPolicy` + retryable/terminal classification + per-attempt timeout + `AbortSignal`.
- Create `apps/backend/src/runner/review_job_worker.ts` — the worker loop skeleton (`claim → heartbeat → handler(job, signal) → markDone/markFailed`, `finally` stop heartbeat), with a pluggable `JobHandler`.
- Tests: `test/integration/runner/review_jobs_repo.integration.test.ts`, `test/unit/runner/run_with_retry.test.ts`, `test/integration/runner/review_job_worker.chaos.test.ts`.

> Implementers: verify the exact `Clock`/`uuid7` import paths (`#platform/clock.js`, `#platform/randomness.js`) and the integration-test harness (`test/integration/_db.ts` — `describeDb`, the `:5439` DSN, the Kysely `Pool` setup) against a working integration test before Task 1.3; mirror that harness.

---

### Task 1.1: Migration — `core.review_jobs`

**Files:** Create `migrations/0036_review_jobs.sql`

- [ ] **Step 1: Write the migration** (DB `now()` is the sole lease clock — the v7 correction; **not** a worker timestamp):

```sql
-- 0036_review_jobs.sql — coarse-grained review runner: one row per whole review attempt (ADR-0077).
CREATE TABLE core.review_jobs (
  job_id          uuid PRIMARY KEY,
  run_id          uuid NOT NULL,                     -- execution identity (core.review_runs.run_id)
  review_id       uuid NOT NULL,
  installation_id uuid NOT NULL,
  repo_id         uuid NOT NULL,
  provider        text NOT NULL,
  state           text NOT NULL DEFAULT 'ready'
                  CHECK (state IN ('ready','leased','done','failed','dead','cancelled')),
  priority        int  NOT NULL DEFAULT 0,
  attempts        int  NOT NULL DEFAULT 0,
  max_attempts    int  NOT NULL DEFAULT 3,
  lease_owner     text,
  attempt_token   uuid,                              -- fencing: minted fresh on every claim
  leased_until    timestamptz,
  heartbeat_at    timestamptz,
  timeout_at      timestamptz,
  run_after       timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  cancel_reason   text,
  dead_reason     text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- at most one ACTIVE job per RUN (per-run only; review-level ownership is current_run_id + the PR mutex):
CREATE UNIQUE INDEX uq_review_jobs_active_run ON core.review_jobs (run_id)
  WHERE state IN ('ready','leased');
-- claim index: claimable = ready (run_after due) OR leased (lease expired):
CREATE INDEX ix_review_jobs_claimable ON core.review_jobs (priority DESC, run_after)
  WHERE state IN ('ready','leased');
CREATE INDEX ix_review_jobs_installation ON core.review_jobs (installation_id);
```

- [ ] **Step 2: Apply it** — `CODEMASTER_PG_CORE_DSN=postgresql://postgres:devpass@localhost:5439/postgres npm run migrate:up` / Expected: `Migrations complete!`; `\d core.review_jobs` shows the columns + the two partial indexes.
- [ ] **Step 3: Commit** — `git add migrations/0036_review_jobs.sql && git commit -m "feat(runner): review_jobs table (coarse-grained runner foundation)"`

### Task 1.2: Contracts — `review_jobs.v1`

**Files:** Create `libs/contracts/src/review_jobs.v1.ts`; Test `test/unit/contracts/review_jobs.v1.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { ReviewJobV1, JOB_STATES } from "#contracts/review_jobs.v1.js";

describe("ReviewJobV1", () => {
  it("parses a ready job and rejects an unknown state", () => {
    const row = { job_id: crypto.randomUUID(), run_id: crypto.randomUUID(), review_id: crypto.randomUUID(),
      installation_id: crypto.randomUUID(), repo_id: crypto.randomUUID(), provider: "github",
      state: "ready", priority: 0, attempts: 0, max_attempts: 3 };
    expect(ReviewJobV1.parse(row).state).toBe("ready");
    expect(() => ReviewJobV1.parse({ ...row, state: "bogus" })).toThrow();
    expect(JOB_STATES).toContain("dead");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/contracts/review_jobs.v1.test.ts` / Expected: FAIL (module not found).
- [ ] **Step 3: Implement**

```typescript
import { z } from "zod";
export const JOB_STATES = ["ready", "leased", "done", "failed", "dead", "cancelled"] as const;
export const JobState = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobState>;
export const ReviewJobV1 = z.object({
  job_id: z.string().uuid(), run_id: z.string().uuid(), review_id: z.string().uuid(),
  installation_id: z.string().uuid(), repo_id: z.string().uuid(), provider: z.string(),
  state: JobState, priority: z.number().int().default(0),
  attempts: z.number().int().default(0), max_attempts: z.number().int().default(3),
  attempt_token: z.string().uuid().nullable().optional(),
}).passthrough();
export type ReviewJobV1 = z.infer<typeof ReviewJobV1>;
```

- [ ] **Step 4: Run to verify it passes** — same command / Expected: PASS.
- [ ] **Step 5: Commit** — `git add libs/contracts/src/review_jobs.v1.ts test/unit/contracts/review_jobs.v1.test.ts && git commit -m "feat(runner): review_jobs.v1 contracts"`

### Task 1.3: `ReviewJobsRepo.enqueue` + `getById`

**Files:** Create `apps/backend/src/runner/review_jobs_repo.ts`; Test `test/integration/runner/review_jobs_repo.integration.test.ts`

- [ ] **Step 1: Write the failing test** (mirror `test/integration/_db.ts` `describeDb` + Kysely setup):

```typescript
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";

let db: Kysely<unknown>; let pool: Pool;
beforeAll(() => { if (!INTEGRATION_DSN) return; pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); });
afterAll(async () => { await db?.destroy(); });

function seed() { return { runId: crypto.randomUUID(), reviewId: crypto.randomUUID(),
  installationId: crypto.randomUUID(), repoId: crypto.randomUUID(), provider: "github" }; }

describeDb("ReviewJobsRepo.enqueue", () => {
  it("enqueues a ready job and reads it back", async () => {
    const repo = new ReviewJobsRepo(db); const s = seed();
    const jobId = await repo.enqueue(s);
    const job = await repo.getById(jobId);
    expect(job?.state).toBe("ready"); expect(job?.run_id).toBe(s.runId);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `CODEMASTER_PG_CORE_DSN=postgresql://postgres:devpass@localhost:5439/postgres npx vitest run test/integration/runner/review_jobs_repo.integration.test.ts` / Expected: FAIL (module not found).
- [ ] **Step 3: Implement `enqueue` + `getById`**

```typescript
import { Kysely, sql } from "kysely";
import { uuid4 } from "#platform/randomness.js";
import { ReviewJobV1, type JobState } from "#contracts/review_jobs.v1.js";

export type EnqueueArgs = { runId: string; reviewId: string; installationId: string;
  repoId: string; provider: string; priority?: number; maxAttempts?: number };

export class ReviewJobsRepo {
  constructor(private db: Kysely<unknown>) {}

  async enqueue(a: EnqueueArgs): Promise<string> {
    const jobId = uuid4();
    await sql`INSERT INTO core.review_jobs
        (job_id, run_id, review_id, installation_id, repo_id, provider, priority, max_attempts)
      VALUES (${jobId}, ${a.runId}, ${a.reviewId}, ${a.installationId}, ${a.repoId}, ${a.provider},
        ${a.priority ?? 0}, ${a.maxAttempts ?? 3})`.execute(this.db);
    return jobId;
  }

  async getById(jobId: string): Promise<ReviewJobV1 | null> {
    const r = await sql<ReviewJobV1>`SELECT * FROM core.review_jobs WHERE job_id = ${jobId}`.execute(this.db);
    return r.rows[0] ? ReviewJobV1.parse(r.rows[0]) : null;
  }
}
```

- [ ] **Step 4: Run to verify it passes** — same command / Expected: PASS.
- [ ] **Step 5: Commit** — `git add apps/backend/src/runner/review_jobs_repo.ts test/integration/runner/review_jobs_repo.integration.test.ts && git commit -m "feat(runner): ReviewJobsRepo.enqueue + getById"`

### Task 1.4: `ReviewJobsRepo.claim` (DB-`now()` lease + fresh fence token + `SKIP LOCKED` + reclaim-expired)

**Files:** Modify `apps/backend/src/runner/review_jobs_repo.ts`; Test (same integration file)

- [ ] **Step 1: Write the failing test**

```typescript
describeDb("ReviewJobsRepo.claim", () => {
  it("claims a ready job, mints a fresh attempt_token, and a second claimer gets nothing", async () => {
    const repo = new ReviewJobsRepo(db); const s = seed(); await repo.enqueue(s);
    const c1 = await repo.claim({ owner: "w1", leaseMs: 1000 });
    expect(c1?.run_id).toBe(s.runId); expect(c1?.attempt_token).toBeTruthy(); expect(c1?.attempts).toBe(1);
    const c2 = await repo.claim({ owner: "w2", leaseMs: 1000 });   // only one ready job → none left
    expect(c2).toBeNull();
  });

  it("reclaims a job whose lease expired and mints a NEW token (crash recovery)", async () => {
    const repo = new ReviewJobsRepo(db); const s = seed(); await repo.enqueue(s);
    const c1 = await repo.claim({ owner: "w1", leaseMs: 1 });      // 1ms lease
    await new Promise((r) => setTimeout(r, 50));                    // lease expires
    const c2 = await repo.claim({ owner: "w2", leaseMs: 1000 });
    expect(c2?.job_id).toBe(c1!.job_id); expect(c2!.attempt_token).not.toBe(c1!.attempt_token);
    expect(c2!.attempts).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL (`claim` not a function).
- [ ] **Step 3: Implement `claim`** (lease + expiry evaluated entirely in SQL via `now()`):

```typescript
  async claim(a: { owner: string; leaseMs: number }): Promise<ReviewJobV1 | null> {
    const r = await sql<ReviewJobV1>`
      UPDATE core.review_jobs SET state = 'leased', lease_owner = ${a.owner},
             attempt_token = gen_random_uuid(),
             leased_until = now() + (${a.leaseMs}::double precision / 1000) * interval '1 second',
             heartbeat_at = now(), started_at = COALESCE(started_at, now()), attempts = attempts + 1
        WHERE job_id = (
          SELECT job_id FROM core.review_jobs
            WHERE (state = 'ready'  AND run_after <= now())
               OR (state = 'leased' AND leased_until < now())   -- expired lease ⇒ reclaim (crash recovery)
            ORDER BY priority DESC, run_after
            FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`.execute(this.db);
    return r.rows[0] ? ReviewJobV1.parse(r.rows[0]) : null;
  }
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS (both cases).
- [ ] **Step 5: Commit** — `git add -p` the repo + test / `git commit -m "feat(runner): ReviewJobsRepo.claim (DB-now lease + fence token + SKIP LOCKED + reclaim)"`

### Task 1.5: `ReviewJobsRepo.heartbeat` (fenced lease extend)

**Files:** Modify the repo + test

- [ ] **Step 1: Write the failing test**

```typescript
describeDb("ReviewJobsRepo.heartbeat", () => {
  it("extends the lease for the owning token and refuses a stale token", async () => {
    const repo = new ReviewJobsRepo(db); const s = seed(); await repo.enqueue(s);
    const c = await repo.claim({ owner: "w1", leaseMs: 1000 });
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, leaseMs: 1000 })).toBe(true);
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: crypto.randomUUID(), leaseMs: 1000 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Implement**

```typescript
  async heartbeat(a: { jobId: string; owner: string; token: string; leaseMs: number }): Promise<boolean> {
    const r = await sql`UPDATE core.review_jobs
        SET leased_until = now() + (${a.leaseMs}::double precision / 1000) * interval '1 second', heartbeat_at = now()
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
      .execute(this.db);
    return Number(r.numAffectedRows ?? 0n) === 1;
  }
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(runner): fenced heartbeat (lease extend on owning token)"`

### Task 1.6: `ReviewJobsRepo.markDone` (fenced)

**Files:** Modify the repo + test

- [ ] **Step 1: Write the failing test**

```typescript
describeDb("ReviewJobsRepo.markDone", () => {
  it("completes for the owning token; a stale token is a no-op", async () => {
    const repo = new ReviewJobsRepo(db); const s = seed(); await repo.enqueue(s);
    const c = await repo.claim({ owner: "w1", leaseMs: 1000 });
    expect(await repo.markDone({ jobId: c!.job_id, owner: "w1", token: crypto.randomUUID() })).toBe(false); // stale
    expect((await repo.getById(c!.job_id))!.state).toBe("leased");
    expect(await repo.markDone({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token! })).toBe(true);
    expect((await repo.getById(c!.job_id))!.state).toBe("done");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Implement**

```typescript
  async markDone(a: { jobId: string; owner: string; token: string }): Promise<boolean> {
    const r = await sql`UPDATE core.review_jobs SET state = 'done', finished_at = now(), leased_until = NULL
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
      .execute(this.db);
    return Number(r.numAffectedRows ?? 0n) === 1;
  }
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(runner): fenced markDone"`

### Task 1.7: `ReviewJobsRepo.markFailed` (state machine: → `ready`+backoff, else `dead`)

**Files:** Modify the repo + test

- [ ] **Step 1: Write the failing test**

```typescript
describeDb("ReviewJobsRepo.markFailed", () => {
  it("re-enqueues with backoff while attempts remain, then dead-letters", async () => {
    const repo = new ReviewJobsRepo(db); const s = seed(); await repo.enqueue({ ...s, maxAttempts: 2 });
    const c1 = await repo.claim({ owner: "w1", leaseMs: 1000 });            // attempts=1
    await repo.markFailed({ jobId: c1!.job_id, owner: "w1", token: c1!.attempt_token!, error: "boom", backoffMs: 5 });
    expect((await repo.getById(c1!.job_id))!.state).toBe("ready");
    await new Promise((r) => setTimeout(r, 20));
    const c2 = await repo.claim({ owner: "w1", leaseMs: 1000 });            // attempts=2 == max
    await repo.markFailed({ jobId: c2!.job_id, owner: "w1", token: c2!.attempt_token!, error: "boom2", backoffMs: 5 });
    const dead = await repo.getById(c2!.job_id);
    expect(dead!.state).toBe("dead"); expect((dead as any).dead_reason).toContain("boom2");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.
- [ ] **Step 3: Implement** (fenced; the CASE encodes the state machine):

```typescript
  async markFailed(a: { jobId: string; owner: string; token: string; error: string; backoffMs: number }): Promise<void> {
    await sql`UPDATE core.review_jobs SET
        last_error = left(${a.error}, 2000), leased_until = NULL,
        state      = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'ready' END,
        dead_reason = CASE WHEN attempts >= max_attempts THEN left(${a.error}, 2000) ELSE dead_reason END,
        finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE finished_at END,
        run_after  = now() + (${a.backoffMs}::double precision / 1000) * interval '1 second'
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
      .execute(this.db);
  }
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(runner): markFailed state machine (ready+backoff | dead)"`

### Task 1.8: `runWithRetry(policy, fn)` — timeout + AbortSignal + retryable/terminal classification

**Files:** Create `apps/backend/src/runner/run_with_retry.ts`; Test `test/unit/runner/run_with_retry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { runWithRetry, type RetryPolicy } from "#backend/runner/run_with_retry.js";

const P: RetryPolicy = { startToCloseMs: 50, initialIntervalMs: 1, maxIntervalMs: 5, backoff: 2,
  maxAttempts: 3, nonRetryable: (e) => (e as Error).name === "Terminal" };

describe("runWithRetry", () => {
  it("retries transient failures up to maxAttempts then succeeds", async () => {
    let n = 0; const r = await runWithRetry(P, async () => { if (++n < 3) throw new Error("transient"); return "ok"; });
    expect(r).toBe("ok"); expect(n).toBe(3);
  });
  it("does not retry a non-retryable error", async () => {
    let n = 0; const err = Object.assign(new Error("x"), { name: "Terminal" });
    await expect(runWithRetry(P, async () => { n++; throw err; })).rejects.toThrow("x"); expect(n).toBe(1);
  });
  it("aborts an attempt that exceeds startToCloseMs", async () => {
    await expect(runWithRetry({ ...P, maxAttempts: 1 }, async (signal) =>
      new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/runner/run_with_retry.test.ts` / Expected: FAIL.
- [ ] **Step 3: Implement**

```typescript
export type RetryPolicy = { startToCloseMs: number; initialIntervalMs: number; maxIntervalMs: number;
  backoff: number; maxAttempts: number; nonRetryable: (e: unknown) => boolean };

export async function runWithRetry<T>(policy: RetryPolicy, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let interval = policy.initialIntervalMs; let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`startToClose ${policy.startToCloseMs}ms exceeded`)), policy.startToCloseMs);
    try { return await fn(ac.signal); }
    catch (e) {
      lastErr = e;
      if (policy.nonRetryable(e) || attempt === policy.maxAttempts) throw e;
      await new Promise((r) => setTimeout(r, interval));
      interval = Math.min(interval * policy.backoff, policy.maxIntervalMs);
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}
```

> The eventual `RETRY_POLICIES` (`review/pipeline/activity_ports.ts`) maps onto `RetryPolicy` (durations parsed to ms; `nonRetryable` checks the activity's `nonRetryableErrorTypes` by `err.constructor.name`); a thin adapter is built in Phase 2 where the activities are wired. Phase 1 only needs the wrapper itself.

- [ ] **Step 4: Run to verify it passes** — Expected: PASS (3 tests).
- [ ] **Step 5: Commit** — `git add apps/backend/src/runner/run_with_retry.ts test/unit/runner/run_with_retry.test.ts && git commit -m "feat(runner): runWithRetry (timeout + AbortSignal + classification)"`

### Task 1.9: The worker-loop skeleton (`review_job_worker`) with a pluggable handler

**Files:** Create `apps/backend/src/runner/review_job_worker.ts`; Test `test/integration/runner/review_job_worker.chaos.test.ts`

- [ ] **Step 1: Write the failing test** (happy path + handler-throws path, injected handler):

```typescript
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Kysely, PostgresDialect } from "kysely"; import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { runOneJob } from "#backend/runner/review_job_worker.js";

let db: Kysely<unknown>; let pool: Pool;
beforeAll(() => { if (!INTEGRATION_DSN) return; pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); });
afterAll(async () => { await db?.destroy(); });
const seed = () => ({ runId: crypto.randomUUID(), reviewId: crypto.randomUUID(),
  installationId: crypto.randomUUID(), repoId: crypto.randomUUID(), provider: "github" });

describeDb("runOneJob", () => {
  it("runs the handler and marks the job done", async () => {
    const repo = new ReviewJobsRepo(db); await repo.enqueue(seed());
    let ran = 0;
    const claimed = await runOneJob({ repo, owner: "w1", leaseMs: 1000, heartbeatMs: 200,
      handler: async () => { ran++; } });
    expect(claimed).toBe(true); expect(ran).toBe(1);
  });
  it("marks failed when the handler throws", async () => {
    const repo = new ReviewJobsRepo(db); const jobId = await repo.enqueue({ ...seed(), maxAttempts: 1 });
    await runOneJob({ repo, owner: "w1", leaseMs: 1000, heartbeatMs: 200,
      handler: async () => { throw new Error("handler boom"); } });
    expect((await repo.getById(jobId))!.state).toBe("dead");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** (claim → background heartbeat → handler(job, signal) → markDone/markFailed; `finally` stop heartbeat):

```typescript
import type { ReviewJobsRepo } from "./review_jobs_repo.js";
import type { ReviewJobV1 } from "#contracts/review_jobs.v1.js";

export type JobHandler = (job: ReviewJobV1, signal: AbortSignal) => Promise<void>;

export async function runOneJob(o: { repo: ReviewJobsRepo; owner: string; leaseMs: number;
  heartbeatMs: number; handler: JobHandler }): Promise<boolean> {
  const job = await o.repo.claim({ owner: o.owner, leaseMs: o.leaseMs });
  if (!job) return false;
  const token = job.attempt_token!;
  const ac = new AbortController();
  let alive = true;
  const hb = (async () => { while (alive) {
    await new Promise((r) => setTimeout(r, o.heartbeatMs)); if (!alive) break;
    const held = await o.repo.heartbeat({ jobId: job.job_id, owner: o.owner, token, leaseMs: o.leaseMs });
    if (!held) ac.abort(new Error("lease lost")); // cooperative abort — the handler checks signal at safe points
  } })();
  try {
    await o.handler(job, ac.signal);
    await o.repo.markDone({ jobId: job.job_id, owner: o.owner, token });
  } catch (e) {
    await o.repo.markFailed({ jobId: job.job_id, owner: o.owner, token,
      error: e instanceof Error ? e.message : String(e), backoffMs: 1000 });
  } finally { alive = false; await hb; }
  return true;
}
```

- [ ] **Step 4: Run to verify it passes** — Expected: PASS (2 tests).
- [ ] **Step 5: Commit** — `git add apps/backend/src/runner/review_job_worker.ts test/integration/runner/review_job_worker.chaos.test.ts && git commit -m "feat(runner): worker-loop skeleton with pluggable handler"`

### Task 1.10: Chaos — multi-worker lease-steal + fence + crash-recovery

**Files:** Modify `test/integration/runner/review_job_worker.chaos.test.ts`

- [ ] **Step 1: Write the failing test** (a handler that hard-"crashes" on attempt 1 by hanging past its lease; a second worker reclaims and completes; the first's late completion is fenced):

```typescript
describeDb("runOneJob — chaos", () => {
  it("a stolen lease is fenced; the review completes exactly once under two workers", async () => {
    const repo = new ReviewJobsRepo(db); const jobId = await repo.enqueue(seed());
    let realRuns = 0;
    // worker-1: attempt 1 hangs past its 100ms lease (simulated crash), never completes its handler body
    const w1 = runOneJob({ repo, owner: "w1", leaseMs: 100, heartbeatMs: 10_000 /* no heartbeat */,
      handler: async () => { await new Promise((r) => setTimeout(r, 800)); realRuns++; } });
    await new Promise((r) => setTimeout(r, 200));   // w1's lease expires
    // worker-2: reclaims (fresh token), runs fast, completes
    const w2 = await runOneJob({ repo, owner: "w2", leaseMs: 1000, heartbeatMs: 200,
      handler: async () => { realRuns++; } });
    await w1;
    expect(w2).toBe(true);
    const job = await repo.getById(jobId);
    expect(job!.state).toBe("done");               // fencing: w1's late markDone affected 0 rows
    // w1's body did run (realRuns includes it) — Phase 2 makes the WORK idempotent (ledger/post-claim);
    // Phase 1 proves the DB STATE is correct under the steal.
  });
});
```

- [ ] **Step 2: Run to verify it fails / then passes** — `CODEMASTER_PG_CORE_DSN=…:5439… npx vitest run test/integration/runner/review_job_worker.chaos.test.ts` / Expected: PASS (state is `done`, set by w2; w1 fenced). If it fails, the fence in `markDone`/`markFailed` (Tasks 1.6/1.7) is the bug, not the test.
- [ ] **Step 3: Commit** — `git commit -m "test(runner): chaos — lease-steal fenced, completes once under two workers"`

### Phase 1 exit criteria

- `npm run typecheck` + `npm run lint` (0 errors) + `npm run gates` clean on changed files.
- All Phase-1 tests green against `:5439`.
- Demonstrated: lease-steal is fenced (DB state correct under two workers), the state machine (ready→leased→done|failed→ready/dead) holds, and crash-recovery re-runs an injected handler. **Note:** Phase 1 proves the *runner mechanics*; making the review *work* idempotent under re-run (ledger, post-claim) is Phase 2.

---

## Phase 0 — Cost-accounting compensating journal (outline; build-gate; detail just-in-time)

**Scope:** add `telemetry.cost_journal (call_id, scope, scope_id, day, signed_cents, kind ∈ {reserve,settle,release}, created_at)`; `checkOrRaise` appends a `reserve` row + checks the day's derived sum against the cap; `recordCallCost` appends a `settle` (the actual−estimated diff or the actual); a reconcile job appends a `release` for any `reserve` with no `settle`/`release` whose owning ledger row is `failed`/absent past a **derived** window (= `RETRY_POLICIES` worst-case wall-time) — **never a subtract**. **Parity tests** vs the existing aggregate `checkOrRaise`/`recordCallCost` (same cap decisions on the same call sequences). **Migration-safety** review (new table, additive). Detail to ~8 bite-sized tasks when reached. **Must land before Phase 4.**

## Phase 2 — Review-job shell + in-flight ledger + supersede (outline)

**Scope:** the non-Temporal **shell** (gate `startReviewForWebhook` → acquire/`renew` PR mutex *as a synchronous `ctx.claimCheck`* → allocate workspace → post placeholder → `orchestrate()` → `runLifecycleBookkeeping` → finalizers); the **de-Temporal seam** (`isCancelled`/`classifyFailure`/`Metrics`→OTel so `degradation.ts`/`posting.ts` drop `@temporalio`); the **in-flight LLM ledger** (status/owner/lease/attempt_token; poll-with-backoff *no held txn*; takeover fenced; lease TTL > worst-case + heartbeat across retries); the **5 supersede checkpoints** (mutex-lease fail-open inline + `current_run_id` fail-closed at write boundaries; `mapFailure` maps `StateDrift(CANCELLED)`/`StaleWriteError` → terminal-cancelled, never re-enqueue); the **finalizer protocol** (mutex/workspace/placeholder/cost-release/lifecycle, reaper-healed); **two-reaper unification**; the **comment_ids-on-lost-claim** fix + the **fix-prompt `review_id`-keyed DB-fenced claim**. Chaos cases: supersede-during-review, lost-claim-bookkeeping, post-idempotency.

## Phase 3 — `background_jobs` + scheduler + dedicated runner process (outline)

**Scope:** `core.background_jobs` (generic coarse table, same lease/fence/state shape); the **dedicated always-on runner process** (poller + scheduler-leader; `clock.sleep`, never `setInterval`; poller N-pods via SKIP LOCKED, scheduler-leader single via `pg_advisory_lock`); the **scheduler** (cron + interval cadences anchored to **DB `now()`** in the emit txn; deterministic tick key; overlap=skip; missed-tick + failover); migrate the non-review workloads (reconcile/repair, sync_code_owners, refresh_semantic_docs, retention) — **confluence per-space** (one row per space; embed gated on `(page_id,version,content_hash)`; F-40 reconcile only on a complete page loop).

## Phase 4 — Cutover (outline)

**Scope:** new outbox sink `review_job_enqueue` + `ReviewJobEnqueuePayloadV1`; `target_engine` resolved inside `persistWebhook`, one dispatcher branches; **content-key** redelivery dedup (head_sha), engine pinned per `current_run_id`; drain check; `runner_paused` flag; **shadow parity harness** (one engine posts; LLM via shared ledger / cassettes; `core.*` writes isolated by `run_kind`; pin-the-LLM + fuzzy-structural-diff oracle); rollback-as-drain.

## Phase 5 — Operator UI/API (outline)

**Scope:** per-job read (state/attempts/lease_owner/heartbeat-age/run_id/last_error/dead|cancel_reason/finalizer status/engine target/timeline) + list/filter (running/stuck/dead) + controls (retry/cancel/force-release/**reconcile-delivery-outcome**), RBAC + `audit.audit_events` on every action; in the admin frontend.

## Phase 6 — Temporal teardown (outline)

**Scope:** after Phase 4 is fully cut over + soaked ≥1 week — delete the workflow bundles, `data_converter`, `check_workflow_bundle`, the workflow clock/random sandbox constraints, `workflow.patched` markers, the two-worker bootstrap, the temporal-helmchart, and `@temporalio/*`; assert zero `@temporalio` imports.

---

## Self-review (writing-plans)

- **Spec coverage:** Phase 1 covers the ADR's runner foundation (schema, fence, lease, DB-`now()` clock, state machine, retry wrapper, worker loop) + the v7 corrections it touches (DB-`now()` lease, per-run uniqueness, fencing). The v7/v8 register items map to Phases 0/2–5 (cost-journal→0; ledger/shell/supersede/finalizer/reaper/lost-claim/fix-prompt→2; background_jobs/scheduler/process/confluence→3; cutover/outbox/shadow→4; operator UI→5). No Phase-1 gap.
- **Placeholder scan:** Phase 1 tasks contain complete test + impl code and exact commands; Phases 0/2–6 are explicitly *outlines to detail just-in-time* (not placeholders within an active phase).
- **Type consistency:** `ReviewJobV1`/`JobState`/`ReviewJobsRepo` method names (`enqueue`/`claim`/`heartbeat`/`markDone`/`markFailed`) + `runWithRetry`/`RetryPolicy`/`JobHandler`/`runOneJob` are used consistently across Tasks 1.2–1.10.
- **Verify-against-code seams (flagged for the implementer):** the `#platform/clock.js`/`#platform/randomness.js` import paths, the `test/integration/_db.ts` harness shape, and `numAffectedRows` (Kysely `sql\`\``) result field — confirm against a working test before relying on them.
