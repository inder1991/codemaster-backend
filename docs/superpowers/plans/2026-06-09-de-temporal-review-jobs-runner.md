# De-Temporal `review_jobs` Runner — Phase 1 (Runner Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **SCOPE (v2):** This document is **implementation-ready for Phase 1 only** (the runner foundation). Phases 0 and 2–6 are the **roadmap** with explicit "must detail before coding" gates — do **not** let agents start them until each is detailed into its own bite-sized plan. (Renamed/rescoped per the v1 review.)

**Goal:** Replace Temporal with a coarse-grained Postgres job runner — *one durable `review_jobs` row per whole review attempt, executed in one process* — per ADR-0077 v8, without re-decomposing the review into per-step jobs.

**Architecture:** A `review_jobs` table (lease + fence + state machine) drained by worker pods; each worker claims one review, runs the existing `orchestrate()` **unchanged in-process** inside a non-Temporal *review-job shell* (Phase 2), heartbeats its lease, and re-runs the whole review from scratch on a hard crash (the LLM ledger replays paid calls). Phase 1 builds the runner mechanics with a *pluggable* handler.

**Tech Stack:** TypeScript (ESM, Node 22), Kysely + raw `sql\`…\``, **Zod ^3.23.0**, PostgreSQL 16, `node-pg-migrate` (up-only), vitest. **All timing goes through the injected `Clock` seam (`libs/platform/src/clock.ts` → `#platform/clock.js`); raw `setTimeout`/`setInterval` are banned in production files by `scripts/gates/check_clock_random.ts` — `clock.sleep(seconds)` only.** DB tests run against the disposable Postgres on `:5439` (`CODEMASTER_PG_CORE_DSN=postgresql://postgres:devpass@localhost:5439/postgres`) — **never the cluster**.

**Source of truth:** `docs/adr/0077-temporal-removal-postgres-job-runner.md` (now present on this branch; the v7 hazards register + v8 deliverables checklist are authoritative over any v4–v6 prose). This plan branch also tracks PR #11 (the ADR).

---

## Program decomposition (~8–12-week program; this plan details Phase 1 only)

| Phase | Deliverable | Gate | Must-detail-before-coding |
|---|---|---|---|
| **0 (build-gate)** | Cost-accounting **compensating journal** | must land before Phase 4 (prod reviews) | ✔ checklist below |
| **1 (this plan)** | **Runner foundation** — `review_jobs`, repo (claim/lease/fence/heartbeat/timeout/state-machine), `runWithRetry`, worker loop + drain | none | detailed below |
| **2** | Review-job **shell** + in-flight **ledger** + supersede + finalizers + reaper-unify + lost-claim/fix-prompt fixes | Phase 1; Phase 0 before prod | ✔ checklist below |
| **3** | `background_jobs` + **scheduler** + dedicated runner process + **admin-command rows** + non-review migration (confluence per-space) | Phase 1 | detail just-in-time |
| **4** | Cutover (outbox sink, `target_engine`, redelivery, shadow parity, kill-switch) | 1–3; Phase 0 in prod | detail just-in-time |
| **5** | Operator UI/API (incl. reconcile-delivery-outcome) | Phase 2 | detail just-in-time |
| **6** | Temporal teardown | Phase 4 soaked ≥1wk | detail just-in-time |

**Cost decision (resolves the ADR fork):** Phase 0 = **compensating signed journal** (additive; heals orphans by *appending* a release row, never a destructive subtract against the shared aggregate; no Pattern-D rewrite of the parity-critical enforcer).

**Admin-command replacement (v1-review #10):** Phase 3 adds **durable admin-command rows** to replace `AdminTemporalPort.signalWorkflow` — `core.admin_commands (command_id, target_type, target_id, actor_user_id, requested_state, idempotency_key, audit_id, consumed_at, failed_at)`, consumed idempotently at checked safe points: knowledge approve/reject, embedder cancel (a `cancel_requested` flag the embedder job checks), review cancel (sets `review_jobs.cancel_reason` + supersede). RBAC + `audit.audit_events` on every command.

### Phase 0 — "must detail before coding" checklist
- `telemetry.cost_journal` schema (signed per-call rows: `reserve`/`settle`/`release`); `call_id` derivation (= the ADR-0068 ledger `idempotency_key`).
- reserve/settle/release **invariants** (daily total = SUM(journal) per (day, scope[, scope_id]); cap checked against the SUM; release = append, never subtract).
- the **reconcile window** = derived from `RETRY_POLICIES` worst-case wall-time (≈6 min for `reviewChunk`), or gated on the ledger lease-expiry.
- **backfill/dual-read** strategy (run the journal alongside the existing aggregate; compare; cut over).
- **parity tests** vs aggregate `checkOrRaise`/`recordCallCost` on the same call sequences (same cap decisions).
- migration-safety review (new table, additive).

### Phase 2 — "must detail before coding" checklist
- the **shell** stages (gate → mutex *as synchronous `ctx.claimCheck`* → workspace → placeholder → `orchestrate()` → bookkeeping → finalizers).
- the **in-flight ledger** protocol (status/owner/lease/`attempt_token`; **poll-with-backoff, NO held txn**; fenced takeover; lease TTL > worst-case + heartbeat across provider retries).
- the **lost-claim `comment_ids`** fix (persist on `posted_reviews`, return on the `PUT` path) + the **`delivery_outcome=NULL` reconcile** action.
- the **fix-prompt** marker keyed on **`review_id`** + a DB-fenced claim (`ON CONFLICT(review_id)`).
- the **5 supersede checkpoints** (mutex-lease fail-open inline + `current_run_id` fail-closed at write boundaries) and `mapFailure` → `StateDrift(CANCELLED)`/`StaleWriteError` = terminal-cancelled (never re-enqueue).
- the **finalizer protocol** + **two-reaper unification** (one liveness clock = the job lease; disable the `review_run_reaper` for runs with a live `review_jobs` row).

---

## Phase 1 — Runner foundation

### File structure (Phase 1)
- Create `migrations/0036_review_jobs.sql` — `core.review_jobs` (FK to `core.review_runs`).
- Create `libs/contracts/src/review_jobs.v1.ts` — `ReviewJobV1`, `JobState`.
- Create `apps/backend/src/runner/review_jobs_repo.ts` — `ReviewJobsRepo` (enqueue/claim/heartbeat/markDone/markFailed) — fenced; lease via SQL `now()`.
- Create `apps/backend/src/runner/clock_async.ts` — `cancellableSleep(clock, seconds, signal)` (clock-gate-clean cancellable wait).
- Create `apps/backend/src/runner/run_with_retry.ts` — `runWithRetry(clock, policy, fn)` (hard timeout + AbortSignal + classification).
- Create `apps/backend/src/runner/review_job_runner.ts` — `runOneJob(...)` (fenced outcome + cancellable heartbeat + `timeout_at`) and `RunnerLoop` (claim loop + SIGTERM drain).
- Create `apps/backend/src/runner/runner_metrics.ts` — OTel counters/histograms.
- Tests under `test/integration/runner/*` and `test/unit/runner/*`.

> Verify before Task 1.3: the `#platform/clock.js` / `#platform/randomness.js` import paths, the `test/integration/_db.ts` harness (`describeDb`, the `:5439` DSN, the Kysely `Pool`), and the Kysely `sql\`\`` result field for affected rows (`numAffectedRows`) — confirm against a working integration test and mirror it.

---

### Task 1.1: Migration — `core.review_jobs` (FK + state CHECK without `failed` + outbox correlation)

**Files:** Create `migrations/0036_review_jobs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0036_review_jobs.sql — coarse-grained review runner: one row per whole review attempt (ADR-0077).
CREATE TABLE core.review_jobs (
  job_id          uuid PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES core.review_runs(run_id),  -- integrity: no orphan jobs
  review_id       uuid NOT NULL,
  installation_id uuid NOT NULL,
  repo_id         uuid NOT NULL,
  provider        text NOT NULL,
  delivery_id     text,                              -- correlation to the webhook/outbox row (audit/dedup/rollback)
  -- 'failed' is TRANSIENT (handled in-memory by markFailed → ready|dead); it is NOT a persisted resting state:
  state           text NOT NULL DEFAULT 'ready'
                  CHECK (state IN ('ready','leased','done','dead','cancelled')),
  priority        int  NOT NULL DEFAULT 0,
  attempts        int  NOT NULL DEFAULT 0,
  max_attempts    int  NOT NULL DEFAULT 3,
  lease_owner     text,
  attempt_token   uuid,                              -- fencing: minted fresh on every claim
  leased_until    timestamptz,
  heartbeat_at    timestamptz,
  timeout_at      timestamptz,                       -- job-level hard ceiling, set on claim (§Task 1.4)
  run_after       timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  cancel_reason   text,
  dead_reason     text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- at most one ACTIVE job per RUN (per-run only; review-level ownership is current_run_id + the PR mutex):
CREATE UNIQUE INDEX uq_review_jobs_active_run ON core.review_jobs (run_id) WHERE state IN ('ready','leased');
CREATE INDEX ix_review_jobs_claimable ON core.review_jobs (priority DESC, run_after) WHERE state IN ('ready','leased');
CREATE INDEX ix_review_jobs_installation ON core.review_jobs (installation_id);
```

> FK omitted for `review_id`/`installation_id`/`repo_id` on purpose: `run_id`→`review_runs` already anchors the row to a valid run (which itself FKs the review/installation/repo); a second FK chain is redundant and risks insert-ordering coupling. Document this in the commit body.

- [ ] **Step 2: Apply** — `CODEMASTER_PG_CORE_DSN=postgresql://postgres:devpass@localhost:5439/postgres npm run migrate:up` / Expected: `Migrations complete!`; `\d core.review_jobs` shows the FK + the two partial indexes + the 5-value state CHECK.
- [ ] **Step 3: Commit** — `git add migrations/0036_review_jobs.sql && git commit -m "feat(runner): review_jobs table (FK run_id, DB-now lease, transient-failed state machine)"`

### Task 1.2: Contracts — `review_jobs.v1`

**Files:** Create `libs/contracts/src/review_jobs.v1.ts`; Test `test/unit/contracts/review_jobs.v1.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, expect, it } from "vitest";
import { ReviewJobV1, JOB_STATES } from "#contracts/review_jobs.v1.js";
describe("ReviewJobV1", () => {
  it("parses a ready job, rejects unknown/transient state", () => {
    const base = { job_id: crypto.randomUUID(), run_id: crypto.randomUUID(), review_id: crypto.randomUUID(),
      installation_id: crypto.randomUUID(), repo_id: crypto.randomUUID(), provider: "github",
      state: "ready", priority: 0, attempts: 0, max_attempts: 3 };
    expect(ReviewJobV1.parse(base).state).toBe("ready");
    expect(() => ReviewJobV1.parse({ ...base, state: "failed" })).toThrow(); // 'failed' is not a persisted state
    expect(JOB_STATES).toEqual(["ready", "leased", "done", "dead", "cancelled"]);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `npx vitest run test/unit/contracts/review_jobs.v1.test.ts`
- [ ] **Step 3: Implement** (Zod 3 syntax)

```typescript
import { z } from "zod";
export const JOB_STATES = ["ready", "leased", "done", "dead", "cancelled"] as const;
export const JobState = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobState>;
export const ReviewJobV1 = z.object({
  job_id: z.string().uuid(), run_id: z.string().uuid(), review_id: z.string().uuid(),
  installation_id: z.string().uuid(), repo_id: z.string().uuid(), provider: z.string(),
  delivery_id: z.string().nullable().optional(),
  state: JobState, priority: z.number().int(), attempts: z.number().int(), max_attempts: z.number().int(),
  attempt_token: z.string().uuid().nullable().optional(),
}).passthrough();
export type ReviewJobV1 = z.infer<typeof ReviewJobV1>;
```

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): review_jobs.v1 contracts"`

### Task 1.3: `ReviewJobsRepo.enqueue` + `getById`

**Files:** Create `apps/backend/src/runner/review_jobs_repo.ts`; Test `test/integration/runner/review_jobs_repo.integration.test.ts`

- [ ] **Step 1: Failing test** — seed a real `core.review_runs` row first (the FK requires it):

```typescript
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Kysely, PostgresDialect, sql } from "kysely"; import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
let db: Kysely<unknown>; let pool: Pool;
beforeAll(() => { if (!INTEGRATION_DSN) return; pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); });
afterAll(async () => { await db?.destroy(); });
// Insert a minimal core.review_runs row so the FK holds; verify the real NOT NULL columns with \d core.review_runs.
async function seedRun(): Promise<{ runId: string; reviewId: string; installationId: string; repoId: string }> {
  const runId = crypto.randomUUID(), reviewId = crypto.randomUUID(),
    installationId = crypto.randomUUID(), repoId = crypto.randomUUID();
  await sql`INSERT INTO core.review_runs (run_id, review_id, lifecycle_state, started_at, created_at)
            VALUES (${runId}, ${reviewId}, 'PENDING', now(), now())`.execute(db); // adjust cols to the real schema
  return { runId, reviewId, installationId, repoId };
}
describeDb("ReviewJobsRepo.enqueue", () => {
  it("enqueues + reads back", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun();
    const id = await repo.enqueue({ ...s, provider: "github" });
    expect((await repo.getById(id))?.state).toBe("ready");
  });
});
```

- [ ] **Step 2: Run → FAIL** — `CODEMASTER_PG_CORE_DSN=…:5439… npx vitest run test/integration/runner/review_jobs_repo.integration.test.ts`
- [ ] **Step 3: Implement**

```typescript
import { Kysely, sql } from "kysely";
import { uuid4 } from "#platform/randomness.js";
import { ReviewJobV1 } from "#contracts/review_jobs.v1.js";
export type EnqueueArgs = { runId: string; reviewId: string; installationId: string; repoId: string;
  provider: string; deliveryId?: string | null; priority?: number; maxAttempts?: number };
export type FencedResult = { applied: boolean };
export class ReviewJobsRepo {
  constructor(private db: Kysely<unknown>) {}
  async enqueue(a: EnqueueArgs): Promise<string> {
    const jobId = uuid4();
    await sql`INSERT INTO core.review_jobs
        (job_id, run_id, review_id, installation_id, repo_id, provider, delivery_id, priority, max_attempts)
      VALUES (${jobId}, ${a.runId}, ${a.reviewId}, ${a.installationId}, ${a.repoId}, ${a.provider},
        ${a.deliveryId ?? null}, ${a.priority ?? 0}, ${a.maxAttempts ?? 3})`.execute(this.db);
    return jobId;
  }
  async getById(jobId: string): Promise<ReviewJobV1 | null> {
    const r = await sql<ReviewJobV1>`SELECT * FROM core.review_jobs WHERE job_id = ${jobId}`.execute(this.db);
    return r.rows[0] ? ReviewJobV1.parse(r.rows[0]) : null;
  }
}
```

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): ReviewJobsRepo.enqueue + getById"`

### Task 1.4: `claim` — DB-`now()` lease + fence token + `SKIP LOCKED` + reclaim + `timeout_at` + tenant marker

**Files:** Modify the repo + test

- [ ] **Step 1: Failing test** (claim mints a token + sets `timeout_at`; second claimer gets nothing; expired lease reclaims with a new token):

```typescript
describeDb("ReviewJobsRepo.claim", () => {
  it("claims, mints a token, sets timeout_at; a 2nd claimer gets nothing", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(); await repo.enqueue({ ...s, provider: "github" });
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    expect(c?.attempt_token).toBeTruthy(); expect(c?.attempts).toBe(1);
    expect((c as any).timeout_at).toBeTruthy();
    expect(await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 })).toBeNull();
  });
  it("reclaims an expired lease with a NEW token", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(); await repo.enqueue({ ...s, provider: "github" });
    const c1 = await repo.claim({ owner: "w1", leaseMs: 1, maxRuntimeMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    const c2 = await repo.claim({ owner: "w2", leaseMs: 1000, maxRuntimeMs: 60_000 });
    expect(c2?.job_id).toBe(c1!.job_id); expect(c2!.attempt_token).not.toBe(c1!.attempt_token); expect(c2!.attempts).toBe(2);
  });
});
```

> Note: `setTimeout` in **test** files is allowed (the clock gate scans `src/**` non-test only).

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** — the claim is a privileged cross-tenant path; carry the gate marker:

```typescript
  // tenant:exempt reason=worker-pool-claim-across-tenants follow_up=FOLLOW-UP-gf3-error-mode
  async claim(a: { owner: string; leaseMs: number; maxRuntimeMs: number }): Promise<ReviewJobV1 | null> {
    const r = await sql<ReviewJobV1>`
      UPDATE core.review_jobs SET state = 'leased', lease_owner = ${a.owner}, attempt_token = gen_random_uuid(),
             leased_until = now() + (${a.leaseMs}::double precision / 1000) * interval '1 second',
             timeout_at   = now() + (${a.maxRuntimeMs}::double precision / 1000) * interval '1 second',
             heartbeat_at = now(), started_at = COALESCE(started_at, now()), attempts = attempts + 1
        WHERE job_id = (
          SELECT job_id FROM core.review_jobs
            WHERE (state = 'ready' AND run_after <= now()) OR (state = 'leased' AND leased_until < now())
            ORDER BY priority DESC, run_after FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`.execute(this.db);
    return r.rows[0] ? ReviewJobV1.parse(r.rows[0]) : null;
  }
```

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): claim (DB-now lease + fence token + SKIP LOCKED + reclaim + timeout_at + tenant marker)"`

### Task 1.5: `heartbeat` — fenced, refuses past `timeout_at`

**Files:** Modify repo + test

- [ ] **Step 1: Failing test**

```typescript
describeDb("ReviewJobsRepo.heartbeat", () => {
  it("extends for the owning token; refuses a stale token; refuses past timeout_at", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(); await repo.enqueue({ ...s, provider: "github" });
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 30 }); // 30ms runtime ceiling
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, leaseMs: 1000 })).toBe(true);
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: crypto.randomUUID(), leaseMs: 1000 })).toBe(false);
    await new Promise((r) => setTimeout(r, 60)); // exceed timeout_at
    expect(await repo.heartbeat({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token!, leaseMs: 1000 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement**

```typescript
  async heartbeat(a: { jobId: string; owner: string; token: string; leaseMs: number }): Promise<boolean> {
    const r = await sql`UPDATE core.review_jobs
        SET leased_until = now() + (${a.leaseMs}::double precision / 1000) * interval '1 second', heartbeat_at = now()
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}
        AND (timeout_at IS NULL OR now() < timeout_at)`.execute(this.db);
    return Number(r.numAffectedRows ?? 0n) === 1;
  }
```

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): fenced heartbeat (refuses stale token + past timeout_at)"`

### Task 1.6: `markDone` (fenced; returns `FencedResult`)

**Files:** Modify repo + test

- [ ] **Step 1: Failing test**

```typescript
describeDb("ReviewJobsRepo.markDone", () => {
  it("completes for the owning token and returns applied; a stale token is applied:false", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(); await repo.enqueue({ ...s, provider: "github" });
    const c = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    expect((await repo.markDone({ jobId: c!.job_id, owner: "w1", token: crypto.randomUUID() })).applied).toBe(false);
    expect((await repo.getById(c!.job_id))!.state).toBe("leased");
    expect((await repo.markDone({ jobId: c!.job_id, owner: "w1", token: c!.attempt_token! })).applied).toBe(true);
    expect((await repo.getById(c!.job_id))!.state).toBe("done");
  });
});
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement**

```typescript
  async markDone(a: { jobId: string; owner: string; token: string }): Promise<FencedResult> {
    const r = await sql`UPDATE core.review_jobs SET state = 'done', finished_at = now(), leased_until = NULL
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
      .execute(this.db);
    return { applied: Number(r.numAffectedRows ?? 0n) === 1 };
  }
```

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): fenced markDone (returns FencedResult)"`

### Task 1.7: `markFailed` (fenced; state machine ready+backoff+jitter | dead; returns `{applied, terminal}`)

**Files:** Modify repo + test

- [ ] **Step 1: Failing test**

```typescript
describeDb("ReviewJobsRepo.markFailed", () => {
  it("re-enqueues with backoff then dead-letters; a stale token is applied:false", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(); await repo.enqueue({ ...s, provider: "github", maxAttempts: 2 });
    const c1 = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    const r1 = await repo.markFailed({ jobId: c1!.job_id, owner: "w1", token: c1!.attempt_token!, error: "boom", baseBackoffMs: 1 });
    expect(r1).toEqual({ applied: true, terminal: false });
    expect((await repo.getById(c1!.job_id))!.state).toBe("ready");
    await new Promise((r) => setTimeout(r, 30));
    const c2 = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    const r2 = await repo.markFailed({ jobId: c2!.job_id, owner: "w1", token: c2!.attempt_token!, error: "boom2", baseBackoffMs: 1 });
    expect(r2).toEqual({ applied: true, terminal: true });
    const dead = await repo.getById(c2!.job_id); expect(dead!.state).toBe("dead"); expect((dead as any).dead_reason).toContain("boom2");
    expect((await repo.markFailed({ jobId: c2!.job_id, owner: "w1", token: crypto.randomUUID(), error: "x", baseBackoffMs: 1 })).applied).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** — jitter via `random()` in SQL (deterministic-free is fine; not workflow code) avoids thundering herd:

```typescript
  async markFailed(a: { jobId: string; owner: string; token: string; error: string; baseBackoffMs: number }):
    Promise<{ applied: boolean; terminal: boolean }> {
    const r = await sql<{ terminal: boolean }>`
      UPDATE core.review_jobs SET
        last_error = left(${a.error}, 2000), leased_until = NULL,
        state       = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'ready' END,
        dead_reason = CASE WHEN attempts >= max_attempts THEN left(${a.error}, 2000) ELSE dead_reason END,
        finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE finished_at END,
        -- exponential backoff with ±25% jitter (avoid a herd re-claiming after an LLM/GitHub incident):
        run_after  = now() + ((${a.baseBackoffMs}::double precision * power(2, attempts - 1)) * (0.75 + random() * 0.5) / 1000) * interval '1 second'
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}
      RETURNING (state = 'dead') AS terminal`.execute(this.db);
    return { applied: r.rows.length === 1, terminal: r.rows[0]?.terminal ?? false };
  }
```

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): fenced markFailed (state machine + jittered backoff)"`

### Task 1.8: `cancellableSleep` (clock-gate-clean cancellable wait)

**Files:** Create `apps/backend/src/runner/clock_async.ts`; Test `test/unit/runner/clock_async.test.ts`

- [ ] **Step 1: Failing test** (resolves on signal abort before the sleep elapses):

```typescript
import { describe, expect, it } from "vitest";
import { WallClock } from "#platform/clock.js";
import { cancellableSleep } from "#backend/runner/clock_async.js";
describe("cancellableSleep", () => {
  it("resolves immediately when the signal aborts", async () => {
    const ac = new AbortController(); const t = Date.now();
    const p = cancellableSleep(new WallClock(), 10, ac.signal); // 10s sleep, but...
    ac.abort();                                                 // ...aborted now
    await p; expect(Date.now() - t).toBeLessThan(500);
  });
});
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** (no `setTimeout` — `clock.sleep` raced against the abort event):

```typescript
import type { Clock } from "#platform/clock.js";
export function cancellableSleep(clock: Clock, seconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return Promise.race([
    clock.sleep(seconds),
    new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
  ]);
}
```

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): cancellableSleep (clock.sleep raced against abort; no raw timer)"`

### Task 1.9: `runWithRetry(clock, policy, fn)` — HARD timeout + AbortSignal + classification

**Files:** Create `apps/backend/src/runner/run_with_retry.ts`; Test `test/unit/runner/run_with_retry.test.ts`

- [ ] **Step 1: Failing test** (retries; non-retryable short-circuits; a handler that **ignores** the signal is still hard-killed by the timeout):

```typescript
import { describe, expect, it } from "vitest";
import { WallClock } from "#platform/clock.js";
import { runWithRetry, type RetryPolicy } from "#backend/runner/run_with_retry.js";
const clock = new WallClock();
const P: RetryPolicy = { startToCloseS: 0.05, initialIntervalS: 0.001, maxIntervalS: 0.005, backoff: 2, maxAttempts: 3,
  nonRetryable: (e) => (e as Error).name === "Terminal" };
describe("runWithRetry", () => {
  it("retries transient then succeeds", async () => {
    let n = 0; expect(await runWithRetry(clock, P, async () => { if (++n < 3) throw new Error("t"); return "ok"; })).toBe("ok"); expect(n).toBe(3);
  });
  it("does not retry non-retryable", async () => {
    let n = 0; const err = Object.assign(new Error("x"), { name: "Terminal" });
    await expect(runWithRetry(clock, P, async () => { n++; throw err; })).rejects.toThrow("x"); expect(n).toBe(1);
  });
  it("HARD-times-out an attempt that ignores the abort signal", async () => {
    // fn never resolves and ignores signal → the timeout must still reject the attempt:
    await expect(runWithRetry(clock, { ...P, maxAttempts: 1 }, () => new Promise(() => {}))).rejects.toThrow(/timeout/i);
  });
});
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** — `Promise.race(fn, timeout)` is the *hard* stop (returns even if `fn` ignores the abort); `abort()` is the *cooperative* stop (the contract below):

```typescript
import type { Clock } from "#platform/clock.js";
export type RetryPolicy = { startToCloseS: number; initialIntervalS: number; maxIntervalS: number; backoff: number;
  maxAttempts: number; nonRetryable: (e: unknown) => boolean };
// CONTRACT: every wrapped operation MUST honor `signal` — abort in-flight fetches (pass to fetch), kill subprocesses
// (process-group kill on abort). The Promise.race below guarantees the WRAPPER returns on timeout; honoring `signal`
// guarantees the underlying WORK actually stops (no orphaned subprocess / socket). Both are required.
export async function runWithRetry<T>(clock: Clock, policy: RetryPolicy, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let interval = policy.initialIntervalS; let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const ac = new AbortController();
    const timeout = clock.sleep(policy.startToCloseS).then(() => "__timeout__" as const);
    let res: T | "__timeout__";
    try { res = await Promise.race([fn(ac.signal), timeout]); }
    catch (e) {
      lastErr = e;
      if (policy.nonRetryable(e) || attempt === policy.maxAttempts) throw e;
      const jitter = 0.75 + Math.random() * 0.5; await clock.sleep(interval * jitter); // jitter avoids herd
      interval = Math.min(interval * policy.backoff, policy.maxIntervalS); continue;
    }
    if (res === "__timeout__") {
      ac.abort(new Error(`startToClose ${policy.startToCloseS}s exceeded`)); // cooperative stop of the underlying work
      lastErr = new Error(`timeout after ${policy.startToCloseS}s`);
      if (attempt === policy.maxAttempts) throw lastErr;
      const jitter = 0.75 + Math.random() * 0.5; await clock.sleep(interval * jitter);
      interval = Math.min(interval * policy.backoff, policy.maxIntervalS); continue;
    }
    return res;
  }
  throw lastErr;
}
```

> The Phase-2 adapter maps `RETRY_POLICIES` (`review/pipeline/activity_ports.ts`, durations→seconds; `nonRetryable` = `nonRetryableErrorTypes.includes(err.constructor.name)`) onto `RetryPolicy`. `Math.random()` is permitted here (this is runtime, not workflow/replay code — confirm `check_clock_random` only bans timers + `Date.now`, not `Math.random`, in this path; if it flags, source jitter from the `Random` seam).

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): runWithRetry (hard clock timeout + AbortSignal contract + jitter)"`

### Task 1.10: `runOneJob` — fenced outcome + cancellable heartbeat + timeout abort

**Files:** Create `apps/backend/src/runner/review_job_runner.ts`; Test `test/integration/runner/review_job_runner.integration.test.ts`

- [ ] **Step 1: Failing test** (happy → `done`; throw → `dead` at maxAttempts; stale-token completion → `lease_lost`, NOT success):

```typescript
// (imports + seedRun as in Task 1.3) ...
import { runOneJob } from "#backend/runner/review_job_runner.js";
import { WallClock } from "#platform/clock.js";
const clock = new WallClock();
describeDb("runOneJob", () => {
  it("runs the handler and reports done", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(); await repo.enqueue({ ...s, provider: "github" });
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60, handler: async () => {} });
    expect(res.outcome).toBe("done");
  });
  it("reports failed→dead when the handler throws on its last attempt", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(); const id = await repo.enqueue({ ...s, provider: "github", maxAttempts: 1 });
    const res = await runOneJob({ repo, clock, owner: "w1", leaseS: 1, heartbeatS: 0.2, maxRuntimeS: 60, handler: async () => { throw new Error("boom"); } });
    expect(res.outcome).toBe("failed"); expect((await repo.getById(id))!.state).toBe("dead");
  });
});
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** — capture the outcome first; the `finally` only stops the heartbeat (cancellably) and never overwrites the outcome:

```typescript
import type { Clock } from "#platform/clock.js";
import type { ReviewJobsRepo } from "./review_jobs_repo.js";
import type { ReviewJobV1 } from "#contracts/review_jobs.v1.js";
import { cancellableSleep } from "./clock_async.js";
export type JobHandler = (job: ReviewJobV1, signal: AbortSignal) => Promise<void>;
export type RunOutcome = "idle" | "done" | "failed" | "lease_lost";
export async function runOneJob(o: { repo: ReviewJobsRepo; clock: Clock; owner: string; leaseS: number;
  heartbeatS: number; maxRuntimeS: number; handler: JobHandler }): Promise<{ outcome: RunOutcome; jobId?: string }> {
  const leaseMs = o.leaseS * 1000;
  const job = await o.repo.claim({ owner: o.owner, leaseMs, maxRuntimeMs: o.maxRuntimeS * 1000 });
  if (!job) return { outcome: "idle" };
  const token = job.attempt_token!;
  const work = new AbortController();      // aborts the handler on lease-loss/timeout
  const hbStop = new AbortController();     // stops the heartbeat loop immediately on completion
  const hb = (async () => {
    try {
      while (!hbStop.signal.aborted) {
        await cancellableSleep(o.clock, o.heartbeatS, hbStop.signal);
        if (hbStop.signal.aborted) break;
        const held = await o.repo.heartbeat({ jobId: job.job_id, owner: o.owner, token, leaseMs }); // false past timeout_at too
        if (!held) { work.abort(new Error("lease lost or timed out")); break; }
      }
    } catch { work.abort(new Error("heartbeat error")); }   // catch — never let hb throw out of the loop
  })();
  let outcome: RunOutcome;
  try {
    await o.handler(job, work.signal);
    outcome = (await o.repo.markDone({ jobId: job.job_id, owner: o.owner, token })).applied ? "done" : "lease_lost";
  } catch (e) {
    const r = await o.repo.markFailed({ jobId: job.job_id, owner: o.owner, token,
      error: e instanceof Error ? e.message : String(e), baseBackoffMs: 1000 });
    outcome = r.applied ? "failed" : "lease_lost";
  } finally { hbStop.abort(); await hb; }   // immediate stop (cancellableSleep wakes); hb is caught, never masks `outcome`
  return { outcome, jobId: job.job_id };
}
```

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): runOneJob (fenced outcome + cancellable heartbeat + timeout abort)"`

### Task 1.11: Chaos — lease-steal fenced; completes once; loser reports `lease_lost`

**Files:** Modify `test/integration/runner/review_job_runner.integration.test.ts`

- [ ] **Step 1: Failing/passing test**

```typescript
describeDb("runOneJob — chaos", () => {
  it("a stolen lease completes once; the loser reports lease_lost, not success", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(); const id = await repo.enqueue({ ...s, provider: "github" });
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
```

- [ ] **Step 2: Run → PASS** ; **Step 3: Commit** — `git commit -m "test(runner): chaos — lease-steal fenced, completes once, loser=lease_lost"`

### Task 1.12: Runner metrics (OTel)

**Files:** Create `apps/backend/src/runner/runner_metrics.ts`; wire into `runOneJob`; Test `test/unit/runner/runner_metrics.test.ts`

- [ ] **Step 1: Failing test** — assert the metric surface exists and `runOneJob` records claim latency + the outcome (use the repo's existing OTel test idiom; mirror an existing metrics test). Counters/histograms: `codemaster_runner_claim_latency_ms`, `..._lease_steals_total`, `..._heartbeat_failures_total`, `..._stale_token_writes_total{op}`, `..._jobs_total{outcome}`, `..._handler_duration_ms`, `..._retry_attempts_total`.
- [ ] **Step 2–4:** implement the metric module + record points in `runOneJob` (claim latency around claim; `lease_steals_total` when a reclaim mints attempts>1; `stale_token_writes_total` when an outcome is `lease_lost`; `jobs_total{outcome}`; `handler_duration_ms`). Run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(runner): OTel metrics (claim latency, lease steals, stale-token writes, outcomes, durations)"`

### Task 1.13: `RunnerLoop` + SIGTERM graceful drain

**Files:** Modify `apps/backend/src/runner/review_job_runner.ts`; Test `test/integration/runner/runner_loop.integration.test.ts`

- [ ] **Step 1: Failing test** — `RunnerLoop.run()` claims jobs until `stop()`; on `stop()` it stops claiming **new** jobs but lets the in-flight job finish (keeps heartbeating) within a grace; assert: enqueue 2 jobs, start the loop with a slow handler, call `stop()` mid-first-job → the first finishes `done`, the second is **not** claimed (stays `ready`).
- [ ] **Step 2–4:** implement:

```typescript
export class RunnerLoop {
  #stopped = false;
  constructor(private o: { repo: ReviewJobsRepo; clock: Clock; owner: string; leaseS: number; heartbeatS: number;
    maxRuntimeS: number; idleS: number; handler: JobHandler }) {}
  stop() { this.#stopped = true; }                         // wire to process.on('SIGTERM', () => loop.stop())
  async run(): Promise<void> {
    while (!this.#stopped) {
      const { outcome } = await runOneJob(this.o);         // an in-flight job ALWAYS runs to completion (drain)
      if (outcome === "idle" && !this.#stopped) await this.o.clock.sleep(this.o.idleS); // clock.sleep, not setInterval
    }
  }
}
```

> SIGTERM handler lives in the dedicated runner process (Phase 3): `process.on("SIGTERM", () => loop.stop())`, then `await loop.run()`'s in-flight job completes within the pod's `terminationGracePeriodSeconds`; if grace is exceeded, the lease simply expires and another pod reclaims (no special-casing).

- [ ] **Step 5: Commit** — `git commit -m "feat(runner): RunnerLoop + SIGTERM graceful drain (clock.sleep idle, in-flight finishes)"`

### Phase 1 exit criteria
- `npm run typecheck` + `npm run lint` (0 errors) + `npm run gates` clean (incl. `check_clock_random` — **no raw timers in `src/`**) on changed files.
- All Phase-1 tests green against `:5439`.
- Demonstrated: DB-`now()` lease + fencing (loser → `lease_lost`, state correct under two workers), the **5-state** machine (`ready→leased→done | →ready+backoff|dead | →cancelled`), `timeout_at` stops a stuck-but-alive worker's heartbeat, hard activity timeout, cancellable heartbeat, SIGTERM drain, and the metric surface. **Phase 1 proves the runner mechanics; making the review *work* idempotent under re-run (ledger, post-claim, supersede) is Phase 2.**

---

## Phases 3–6 (outlines; detail just-in-time)

- **Phase 3** — `core.background_jobs` (generic coarse table, reusing the Phase-1 skeleton); the dedicated always-on runner process (poller + scheduler-leader; `clock.sleep`, never `setInterval`; poller N-pods via `SKIP LOCKED`, scheduler-leader single via `pg_advisory_lock`); the scheduler (cron + interval cadences anchored to **DB `now()`** in the emit txn; deterministic tick key; overlap=skip; missed-tick + failover); **admin-command rows** (replacing `signalWorkflow`); migrate non-review workloads, **confluence per-space** (one row/space; embed gated on `(page_id,version,content_hash)`; F-40 reconcile only on a complete page loop).
- **Phase 4** — cutover: `review_job_enqueue` outbox sink + `ReviewJobEnqueuePayloadV1`; `target_engine` in `persistWebhook`, one dispatcher branches; content-key redelivery dedup; drain + `runner_paused` + shadow-parity harness (one engine posts; LLM via shared ledger; `core.*` isolated by `run_kind`; pin-LLM + fuzzy oracle); rollback-as-drain.
- **Phase 5** — operator UI/API: per-job state/attempts/lease_owner/heartbeat-age/run_id/last_error/dead|cancel_reason/finalizer/engine + retry/cancel/force-release/**reconcile-delivery-outcome**, RBAC + audit.
- **Phase 6** — Temporal teardown after Phase 4 soaked ≥1 week (delete bundles/converter/gates/`patched`/two-worker/helmchart/`@temporalio/*`; assert zero imports).

---

## Self-review (writing-plans)
- **Spec coverage (Phase 1):** runner table (FK, DB-`now()` lease, 5-state machine), repo (claim/heartbeat/markDone/markFailed — all fenced, `FencedResult`), `timeout_at` semantics (set on claim, enforced in heartbeat, abort in runOneJob), `runWithRetry` (hard timeout + AbortSignal contract + jitter), `cancellableSleep`, `runOneJob` (fenced outcome + cancellable heartbeat), chaos, metrics, SIGTERM drain. The v1-review's Phase-1 findings (#2 Clock, #3 hard timeout, #4 timeout_at, #5 fenced outcomes, #6 heartbeat, #7 tenant marker, #8 FK, #9 state machine, + zod/jitter/metrics/SIGTERM) are each a task or inline. #1 (ADR on branch) fixed by pulling the ADR in. #10/#11/#12 addressed via the phase map + the Phase-0/Phase-2 must-detail checklists.
- **Placeholder scan:** Phase-1 tasks carry complete test + impl code + exact commands; Tasks 1.12/1.13 reference an existing OTel test idiom + the process SIGTERM hook to mirror (named, not vague). Phases 0/2–6 are explicitly *outlines/checklists*, not in-phase placeholders.
- **Type consistency:** `ReviewJobsRepo` (`enqueue`/`claim`/`heartbeat`/`markDone`→`FencedResult`/`markFailed`→`{applied,terminal}`), `RetryPolicy` (seconds), `runWithRetry(clock,…)`, `cancellableSleep(clock,…)`, `runOneJob`/`RunOutcome`/`RunnerLoop` are consistent across Tasks 1.3–1.13.
- **Verify-against-code (flagged):** the real `core.review_runs` NOT NULL columns for `seedRun` (`\d core.review_runs`), the `#platform/clock.js`/`#platform/randomness.js` paths, the `test/integration/_db.ts` harness, the `numAffectedRows` Kysely field, and whether `check_clock_random` flags `Math.random()` in this path (fall back to the `Random` seam if so).
