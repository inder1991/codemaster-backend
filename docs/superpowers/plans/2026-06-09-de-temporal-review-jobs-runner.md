# De-Temporal `review_jobs` Runner — Phase 1 (Runner Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **SCOPE (v4):** This document is **implementation-ready for Phase 1 only** (the runner foundation). Phases 0 and 2–6 are the **roadmap** with explicit "must detail before coding" gates — do **not** let agents start them until each is detailed into its own bite-sized plan.

**Goal:** Replace Temporal with a coarse-grained Postgres job runner — *one durable `review_jobs` row per whole review attempt, executed in one process* — per ADR-0077 v8, without re-decomposing the review into per-step jobs.

**Architecture:** A `review_jobs` table (lease + fence + state machine) drained by worker pods; each worker claims one review, runs the existing `orchestrate()` **unchanged in-process** inside a non-Temporal *review-job shell* (Phase 2), heartbeats its lease, and re-runs the whole review from scratch on a hard crash (the LLM ledger replays paid calls). Phase 1 builds the runner mechanics with a *pluggable* handler.

**Tech Stack:** TypeScript (ESM, Node 22), Kysely + raw `sql\`…\``, **Zod ^3.23.0**, PostgreSQL 16, `node-pg-migrate` (up-only), vitest. **All timing goes through the injected `Clock` seam (`libs/platform/src/clock.ts` → `#platform/clock.js`) and all randomness through the `Random` seam (`#platform/randomness.js`); raw `setTimeout`/`setInterval` AND `Math.random()` are banned in production `src/` by `scripts/gates/check_clock_random.ts` — `clock.sleep(seconds)` and `SystemRandom`/`SeededRandom` only.** DB tests run against the disposable Postgres on **`:5434/codemaster`** (`CODEMASTER_PG_CORE_DSN=postgresql://postgres:postgres@localhost:5434/codemaster`) — **never the cluster**. The `:5434/codemaster` instance is the same one the existing integration tier uses (`test/integration/_db.ts` → `describeDb`/`INTEGRATION_DSN`); tests **skip** when `CODEMASTER_PG_CORE_DSN` is unset.

**Source of truth:** `docs/adr/0077-temporal-removal-postgres-job-runner.md` (present on this branch; the v7 hazards register + v8 deliverables checklist are authoritative over any v4–v6 prose). This plan branch also tracks PR #11 (the ADR).

### v3 changelog (resolves the 9 v2-review findings)
| # | Sev | Finding | Fix (task) |
|---|---|---|---|
| 1 | **CRITICAL** | `Math.random()` in `run_with_retry.ts` fails `check_clock_random` (banned in `src/`) | Inject the `Random` seam; jitter via `random.uniform(0.75,1.25)` (Task 1.9) |
| 2 | **CRITICAL** | Hard crashes reclaim forever + repay LLM — `claim` reclaimed any expired lease and incremented attempts without a `max_attempts` cap | `claim` reclaim branch guards `attempts < max_attempts`; new `reapCrashLooped()` dead-letters maxed-out crashes (Tasks 1.4, 1.7b) |
| 3 | HIGH | `seedRun` not executable (`review_runs.trigger_type` NOT NULL; `review_id` FKs `pull_request_reviews`) | Real shared fixture inserts `pull_request_reviews` + `review_runs` with the verified NOT-NULL/CHECK columns (`test/integration/runner/_fixtures.ts`) |
| 4 | HIGH | Tenant marker unrecognized (gap between marker + `sql` line) + table never registered | Register `core.review_jobs` in `scripts/gates/_registry.ts` + the runtime set; inline `-- tenant:exempt …` on every table-ref line (Tasks 1.1b, 1.3–1.7b) |
| 5 | HIGH | `runOneJob` had no hard job timeout — a handler that ignores the signal hangs the slot | `Promise.race` against a `maxRuntimeS` hard ceiling; classify as `failed` (Task 1.10) |
| 6 | MED | `RunnerLoop.stop()` could hang during idle `clock.sleep(idleS)` | Loop-level stop `AbortController` + `cancellableSleep` (Task 1.13) |
| 7 | MED | FK rationale inaccurate; `repo_id` typed `uuid` but is a GitHub `bigint` | Drop `repo_id`/`provider` from `review_jobs` (derive via join); correct the rationale; `installation_id` documented denormalized (Tasks 1.1, 1.2, 1.3) |
| 8 | MED | `cancelled` state had no Phase-1 transition | Keep the vocabulary in the CHECK; scope cancellation to Phase 2; drop the `→cancelled` exit claim |
| 9 | LOW | Final/ready states kept stale lease metadata | `markDone`/`markFailed`/`reapCrashLooped` clear `lease_owner`/`attempt_token`/`leased_until`/`timeout_at`/`heartbeat_at` |

Plus a correction the v2 draft carried: the integration DSN is **`:5434/codemaster`** (the existing harness), not `:5439`.

### v4 changelog (resolves the 6 v3-review findings)
| # | Sev | Finding | Fix (task) |
|---|---|---|---|
| 1 | HIGH | `claim()`'s inline `-- tenant:exempt …` markers sit on internal SQL lines, but the gate keys the violation line on `tpl.getStartLineNumber()` and only checks that line + the one above it (`check_tenant_scoped_raw_sql.ts:56,71`) → not recognized | One `// tenant:exempt …` JS comment on the line **immediately above** `const r = await sql…`; it covers every table ref in the template (Task 1.4) |
| 2 | HIGH | Migration didn't enforce the attempt invariants the crash-loop cap relies on | `CHECK (attempts >= 0)`, `CHECK (max_attempts >= 1)`, `CHECK (priority >= 0)` (new table → inline CHECKs, no expand-contract) (Task 1.1) |
| 3 | HIGH | Hard timeout frees the runner slot but doesn't stop the underlying work — the orphaned handler can still post/write externally | Phase-2 **hard contract**: handlers MUST be abort-aware and MUST NOT perform external side effects after `signal.aborted`; DB fence protects `core.*`, post-claim idempotency backstops GitHub (Phase-2 checklist + Task 1.10 note) |
| 4 | MED | `scripts/gates/_registry.ts` only **re-exports** `TENANT_SCOPED_TABLES` from the platform module (`_registry.ts:10`) — it has no own list to edit | Add `"core.review_jobs"` to `libs/platform/src/db/tenant_scoped_tables.ts` **only** (feeds both gate + plugin) (Task 1.1b) |
| 5 | MED | Fixture `provider_pr_id = pr-${prNumber}` (100k values) can collide on the real `uq (provider, provider_pr_id)` index | Tie both unique indexes to the globally-unique `reviewId`: `provider_pr_id = gh-${reviewId}`, `repo_id` = 48 bits of `reviewId` (Task 1.3) |
| 6 | LOW | `delivery_id` documented for audit/dedup/rollback but no index + no Phase-1 consumer | Clarify it is **write-only correlation metadata** in Phase 1 (no consumer → no index per schema-with-consumer discipline); the lookup index lands in Phase 4 cutover with its redelivery-dedup consumer (Task 1.1) |

---

## Program decomposition (~8–12-week program; this plan details Phase 1 only)

| Phase | Deliverable | Gate | Must-detail-before-coding |
|---|---|---|---|
| **0 (build-gate)** | Cost-accounting **compensating journal** | must land before Phase 4 (prod reviews) | ✔ checklist below |
| **1 (this plan)** | **Runner foundation** — `review_jobs`, repo (claim/lease/fence/heartbeat/timeout/reap/state-machine), `runWithRetry`, worker loop + drain | none | detailed below |
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
- the **5 supersede checkpoints** (mutex-lease fail-open inline + `current_run_id` fail-closed at write boundaries) and `mapFailure` → `StateDrift(CANCELLED)`/`StaleWriteError` = terminal-cancelled (never re-enqueue) — **this is where `review_jobs.state='cancelled'` first gets a writer.**
- the **finalizer protocol** + **two-reaper unification** (one liveness clock = the job lease; disable the `review_run_reaper` for runs with a live `review_jobs` row; fold Phase-1's `reapCrashLooped` into the unified reaper).
- **HARD CONTRACT: the handler must actually STOP on abort, not merely be abandonable (v4 #3).** Phase 1's `runOneJob` hard runtime ceiling (Task 1.10) guarantees the *worker slot* returns when a handler overruns, but the abandoned handler promise keeps running. The DB fence protects `core.*` writes (a stale completion affects 0 rows), but it does **NOT** protect *external* side effects. So the Phase-2 shell MUST: (a) thread `signal` into every abortable call — `fetch` (pass `signal`), subprocess (process-group kill on abort), the Bedrock/LLM client, and the GitHub post — via the `runWithRetry` `signal` contract; (b) **re-check `signal.aborted` immediately before any external write** (the GitHub review post in particular) and bail rather than post; (c) rely on the post-claim idempotency (`comment_ids`/fix-prompt keyed on `review_id`, ADR-0068 ledger) as the backstop so that even a racing late post is deduped. Without (a)+(b)+(c), a hard-timed-out review could still be posting to GitHub while the runner has already started the next job on another pod. This is a Phase-2 acceptance gate, not optional.

---

## Phase 1 — Runner foundation

### File structure (Phase 1)
- Create `migrations/0036_review_jobs.sql` — `core.review_jobs` (FK to `core.review_runs`; **no** `repo_id`/`provider`).
- Modify `libs/platform/src/db/tenant_scoped_tables.ts` — register `core.review_jobs` as tenant-scoped (single canonical source; `scripts/gates/_registry.ts` re-exports it).
- Create `libs/contracts/src/review_jobs.v1.ts` — `ReviewJobV1`, `JobState`, `JOB_STATES`.
- Create `apps/backend/src/runner/review_jobs_repo.ts` — `ReviewJobsRepo` (enqueue/getById/claim/heartbeat/markDone/markFailed/reapCrashLooped) — fenced; lease via SQL `now()`.
- Create `apps/backend/src/runner/clock_async.ts` — `cancellableSleep(clock, seconds, signal)` (clock-gate-clean cancellable wait).
- Create `apps/backend/src/runner/run_with_retry.ts` — `runWithRetry(clock, random, policy, fn)` (hard timeout + AbortSignal + classification + seam-sourced jitter).
- Create `apps/backend/src/runner/review_job_runner.ts` — `runOneJob(...)` (fenced outcome + cancellable heartbeat + **hard runtime ceiling**) and `RunnerLoop` (claim loop + cancellable idle + SIGTERM drain + reap).
- Create `apps/backend/src/runner/runner_metrics.ts` — OTel counters/histograms.
- Create `test/integration/runner/_fixtures.ts` — the real `seedRun(db)` chain fixture.
- Tests under `test/integration/runner/*` and `test/unit/runner/*`.

> **Verify before Task 1.3** (mirror a working integration test, e.g. `test/integration/activities/review_run_reaper.activity.integration.test.ts` and `test/integration/repos/*.integration.test.ts`): the `#platform/clock.js` / `#platform/randomness.js` import paths (`Clock`, `WallClock`; `Random`, `SystemRandom`, `SeededRandom`, `uuid4`), the `test/integration/_db.ts` harness (`describeDb`, `INTEGRATION_DSN`), the Kysely-over-`pg`-Pool construction idiom, and the Kysely `sql\`\`` result field for affected rows (`numAffectedRows: bigint`). Confirm `core.review_jobs` does **not** yet exist on `:5434/codemaster` (`SELECT to_regclass('core.review_jobs')` → NULL) before applying Task 1.1.

---

### Task 1.1: Migration — `core.review_jobs` (FK; state CHECK without `failed`; no `repo_id`/`provider`; outbox correlation)

**Files:** Create `migrations/0036_review_jobs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0036_review_jobs.sql — coarse-grained review runner: one row per whole review attempt (ADR-0077).
CREATE TABLE core.review_jobs (
  job_id          uuid PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES core.review_runs(run_id),  -- the ONLY integrity anchor
  review_id       uuid NOT NULL,                     -- grouping key (the Phase-2 shell loads context by review_id)
  installation_id uuid NOT NULL,                     -- DENORMALIZED at enqueue (review_runs does NOT carry it):
                                                     -- tenancy + future per-installation fairness. Not FK-anchored.
  delivery_id     text,                              -- WRITE-ONLY correlation metadata in Phase 1 (no reader yet):
                                                     -- the lookup index lands in Phase 4 cutover with its redelivery-dedup consumer.
  -- 'cancelled' is reachable only in Phase 2 (supersede gets the first writer); Phase 1 ships the vocabulary
  --   and exercises ready/leased/done/dead only.
  -- 'failed' is TRANSIENT (markFailed maps it to ready|dead); it is NOT a persisted resting state:
  state           text NOT NULL DEFAULT 'ready'
                  CHECK (state IN ('ready','leased','done','dead','cancelled')),
  -- attempt invariants the crash-loop cap RELIES ON (v3 #2 / v4 #2) — enforced at the DB, not just in app code:
  priority        int  NOT NULL DEFAULT 0  CHECK (priority >= 0),
  attempts        int  NOT NULL DEFAULT 0  CHECK (attempts >= 0),
  max_attempts    int  NOT NULL DEFAULT 3  CHECK (max_attempts >= 1),
  lease_owner     text,
  attempt_token   uuid,                              -- fencing: minted fresh on every claim; CLEARED on every terminal/ready transition
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

> **Denormalization is explicit, not FK-anchored (v3 #7).** Only `run_id` is integrity-anchored (`→ core.review_runs`, which itself FKs the review). `installation_id` is *denormalized at enqueue* from the webhook context — `core.review_runs` does **not** carry `installation_id`, so there is nothing to FK without joining through `pull_request_reviews → repositories`; the enqueuer (Phase 2/4) already holds it. `repo_id` and `provider` are **not stored** on `review_jobs` (the v2 draft wrongly typed `repo_id` as `uuid`; `core.pull_request_reviews.repo_id` is a **GitHub `bigint`** surrogate) — derive them via the `run_id → review_id → pull_request_reviews` join when the Phase-2 shell needs them. Document this in the commit body.

- [ ] **Step 2: Apply** — `CODEMASTER_PG_CORE_DSN=postgresql://postgres:postgres@localhost:5434/codemaster npm run migrate:up`
  Expected: `Migrations complete!`; `\d core.review_jobs` shows the FK `run_id → core.review_runs`, the two partial indexes + the installation index, the 5-value state CHECK, the three attempt-invariant CHECKs (`attempts >= 0`, `max_attempts >= 1`, `priority >= 0`), and **no** `repo_id`/`provider` columns.
- [ ] **Step 3: Commit** — `git add migrations/0036_review_jobs.sql && git commit -m "feat(runner): review_jobs table (FK run_id, DB-now lease, transient-failed state machine, denormalized installation_id)"`

### Task 1.1b: Register `core.review_jobs` as tenant-scoped (single canonical source)

**Files:** Modify **only** `libs/platform/src/db/tenant_scoped_tables.ts`

> **One source, two consumers (v4 #4).** Since the 2026-06-04 consolidation, the tenant-scoped table list lives **once** at `libs/platform/src/db/tenant_scoped_tables.ts`; `scripts/gates/_registry.ts:10` is a thin `export { TENANT_SCOPED_TABLES } from "#platform/db/tenant_scoped_tables.js"` (it has **no** own `Set` literal to edit — do NOT touch it). Adding the table to the platform set feeds **both** the PR-time raw-SQL gate (`check_tenant_scoped_raw_sql.ts`, via that re-export) **and** the runtime Kysely tenancy plugin (`tenancy_plugin.ts`). `review_jobs` carries `installation_id`, so it is tenant data and must be documented as such; the gate is **WARN-mode** (exit 0, won't block `validate-fast`) but registering arms the `// tenant:exempt` markers for the tracked ERROR-mode flip. The runtime plugin only fires on **Kysely ORM** statements — our repo uses raw `sql\`\``, so this is **inert today** but guards future query-builder access. No existing query touches the new table, so this cannot break a call site.

- [ ] **Step 1: Add to the canonical set** — in `libs/platform/src/db/tenant_scoped_tables.ts`, add `"core.review_jobs"` to the exported `TENANT_SCOPED_TABLES` set (alongside `"core.review_runs"`; keep the existing ordering convention).
- [ ] **Step 2: Verify** — `npm run gates` (the tenant gate prints `[INFO] … WARN-mode … Exit 0`; the gate sees the new table via the re-export). `npm run typecheck` clean; if a registry-parity unit test exists, it stays green.
- [ ] **Step 3: Commit** — `git add libs/platform/src/db/tenant_scoped_tables.ts && git commit -m "chore(tenancy): register core.review_jobs as tenant-scoped (canonical set; re-exported to gate + plugin)"`

### Task 1.2: Contracts — `review_jobs.v1`

**Files:** Create `libs/contracts/src/review_jobs.v1.ts`; Test `test/unit/contracts/review_jobs.v1.test.ts`

- [ ] **Step 1: Failing test**

```typescript
import { describe, expect, it } from "vitest";
import { ReviewJobV1, JOB_STATES } from "#contracts/review_jobs.v1.js";
describe("ReviewJobV1", () => {
  it("parses a ready job, rejects unknown/transient state", () => {
    const base = { job_id: crypto.randomUUID(), run_id: crypto.randomUUID(), review_id: crypto.randomUUID(),
      installation_id: crypto.randomUUID(), state: "ready", priority: 0, attempts: 0, max_attempts: 3 };
    expect(ReviewJobV1.parse(base).state).toBe("ready");
    expect(() => ReviewJobV1.parse({ ...base, state: "failed" })).toThrow(); // 'failed' is not a persisted state
    expect(JOB_STATES).toEqual(["ready", "leased", "done", "dead", "cancelled"]);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `npx vitest run test/unit/contracts/review_jobs.v1.test.ts`
- [ ] **Step 3: Implement** (Zod 3 syntax; **no `repo_id`/`provider`**)

```typescript
import { z } from "zod";
export const JOB_STATES = ["ready", "leased", "done", "dead", "cancelled"] as const;
export const JobState = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobState>;
export const ReviewJobV1 = z.object({
  job_id: z.string().uuid(), run_id: z.string().uuid(), review_id: z.string().uuid(),
  installation_id: z.string().uuid(),
  delivery_id: z.string().nullable().optional(),
  state: JobState, priority: z.number().int(), attempts: z.number().int(), max_attempts: z.number().int(),
  attempt_token: z.string().uuid().nullable().optional(),
}).passthrough();
export type ReviewJobV1 = z.infer<typeof ReviewJobV1>;
```

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git add libs/contracts/src/review_jobs.v1.ts test/unit/contracts/review_jobs.v1.test.ts && git commit -m "feat(runner): review_jobs.v1 contracts"`

### Task 1.3: Shared fixture + `ReviewJobsRepo.enqueue` + `getById`

**Files:** Create `test/integration/runner/_fixtures.ts`; Create `apps/backend/src/runner/review_jobs_repo.ts`; Test `test/integration/runner/review_jobs_repo.integration.test.ts`

- [ ] **Step 1: Write the real `seedRun` fixture** (verified against `:5434/codemaster`):

```typescript
// test/integration/runner/_fixtures.ts
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { Kysely, sql } from "kysely";

/**
 * Seed a real review chain (pull_request_reviews → review_runs) so review_jobs.run_id FK holds.
 * Column sets + UNIQUE indexes verified against :5434/codemaster:
 *  - core.pull_request_reviews NOT NULL: review_id, provider, repo_id(bigint), pr_number, provider_pr_id,
 *    status(CHECK ∈ open|closed|merged), created_at. (repo_id is a GitHub bigint, NOT a hard FK — orphans allowed.)
 *    UNIQUE (provider, provider_pr_id) AND UNIQUE (provider, repo_id, pr_number) — the fixture ties BOTH to the
 *    globally-unique reviewId so parallel/repeated seeds cannot collide (v4 #5).
 *  - core.review_runs NOT NULL: run_id, review_id(FK→pull_request_reviews.review_id), trigger_type
 *    (CHECK ∈ pr_opened|pr_synchronize|manual_rerun|comment_trigger|retry|scheduled), attempt_number(≥1),
 *    lifecycle_state(CHECK ∈ PENDING|RUNNING|WAITING_RETRY|COMPLETED|FAILED|CANCELLED|PARTIAL), is_ephemeral,
 *    started_at, created_at.
 */
export async function seedRun(db: Kysely<unknown>): Promise<{ runId: string; reviewId: string; installationId: string }> {
  const runId = randomUUID(), reviewId = randomUUID(), installationId = randomUUID();
  // Derive uniqueness from the globally-unique reviewId so NEITHER unique index can flake:
  //   provider_pr_id carries the full reviewId  → UNIQUE (provider, provider_pr_id) holds.
  //   repo_id = 48 bits of the reviewId         → UNIQUE (provider, repo_id, pr_number) holds (collision-proof for tests;
  //   48-bit birthday bound ≈ 16M rows, exact as a JS integer < 2^53, fits the bigint column). pr_number is fixed at 1.
  const repoId = parseInt(reviewId.replace(/-/g, "").slice(0, 12), 16);
  await sql`INSERT INTO core.pull_request_reviews
      (review_id, provider, repo_id, pr_number, provider_pr_id, status, created_at)
    VALUES (${reviewId}, 'github', ${repoId}, 1, ${`gh-${reviewId}`}, 'open', now())`.execute(db);
  await sql`INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, attempt_number, lifecycle_state, is_ephemeral, started_at, created_at)
    VALUES (${runId}, ${reviewId}, 'pr_opened', 1, 'PENDING', false, now(), now())`.execute(db);
  return { runId, reviewId, installationId };
}
```

- [ ] **Step 2: Failing test** (own `pg` Pool wrapped in Kysely → no shared-pool double-free; skips without a DSN):

```typescript
import { afterAll, expect, it } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { describeDb, INTEGRATION_DSN } from "../_db.js";
import { ReviewJobsRepo } from "#backend/runner/review_jobs_repo.js";
import { seedRun } from "./_fixtures.js";

let db: Kysely<unknown>; let pool: Pool;
if (INTEGRATION_DSN) { pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) }); }
afterAll(async () => { await db?.destroy(); });          // destroys the OWN pool; no disposePool double-end

describeDb("ReviewJobsRepo.enqueue", () => {
  it("enqueues + reads back", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db);
    const id = await repo.enqueue(s);
    expect((await repo.getById(id))?.state).toBe("ready");
  });
});
```

- [ ] **Step 3: Run → FAIL** — `CODEMASTER_PG_CORE_DSN=postgresql://postgres:postgres@localhost:5434/codemaster npx vitest run test/integration/runner/review_jobs_repo.integration.test.ts`
- [ ] **Step 4: Implement** — `enqueue` lists `installation_id` (satisfies the gate's installation_id escape hatch); `getById` is a PK lookup (marker on the line immediately above the `sql` template):

```typescript
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
}
```

- [ ] **Step 5: Run → PASS** ; **Step 6: Commit** — `git add apps/backend/src/runner/review_jobs_repo.ts test/integration/runner/_fixtures.ts test/integration/runner/review_jobs_repo.integration.test.ts && git commit -m "feat(runner): ReviewJobsRepo.enqueue + getById + real seedRun fixture"`

### Task 1.4: `claim` — DB-`now()` lease + fence token + `SKIP LOCKED` + reclaim (**max-attempts-guarded**) + `timeout_at` + tenant markers

**Files:** Modify the repo + test

- [ ] **Step 1: Failing test** (claim mints a token + sets `timeout_at`; second claimer gets nothing; expired lease reclaims with a new token **while attempts remain**):

```typescript
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
```

> Note: `setTimeout` in **test** files is allowed (the clock gate scans production `src/**` only, never `test/`).

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** — the claim is a privileged cross-tenant path; one `// tenant:exempt …` marker on the line **immediately above** `const r = await sql…` covers BOTH `core.review_jobs` references in the template (the `UPDATE` and the subquery `FROM`):

```typescript
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
```

> **Marker placement (v4 #1).** `check_tenant_scoped_raw_sql.ts` reports each violation at `tpl.getStartLineNumber()` (the line where the `sql\`` tagged template begins) and `hasExemptMarker` checks only that line + the line above it (`:56,71`) — it does **not** look at the internal SQL line where `UPDATE`/`FROM` matched. So a single `// tenant:exempt …` comment immediately above `const r = await sql…` satisfies the gate for **every** table ref inside the template (all matches share the same start-line). The v3 inline `-- …` comments sat on internal SQL lines and would NOT have been recognized. The `ready` branch needs no attempts guard — a `ready` row always has `attempts < max_attempts` by construction (initial enqueue is 0; `markFailed`'s ready branch only fires when `attempts < max_attempts`). An expired lease at `attempts == max_attempts` is left for `reapCrashLooped` (Task 1.7b) to dead-letter.

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): claim (DB-now lease + fence + SKIP LOCKED + max-attempts-guarded reclaim + timeout_at + tenant markers)"`

### Task 1.5: `heartbeat` — fenced, refuses past `timeout_at`

**Files:** Modify repo + test

- [ ] **Step 1: Failing test**

```typescript
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
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** (PK lookup → marker on the preceding line):

```typescript
  async heartbeat(a: { jobId: string; owner: string; token: string; leaseMs: number }): Promise<boolean> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql`UPDATE core.review_jobs
        SET leased_until = now() + (${a.leaseMs}::double precision / 1000) * interval '1 second', heartbeat_at = now()
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}
        AND (timeout_at IS NULL OR now() < timeout_at)`.execute(this.db);
    return Number(r.numAffectedRows ?? 0n) === 1;
  }
```

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): fenced heartbeat (refuses stale token + past timeout_at)"`

### Task 1.6: `markDone` (fenced; clears lease metadata; returns `FencedResult`)

**Files:** Modify repo + test

- [ ] **Step 1: Failing test**

```typescript
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
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** (clear `lease_owner`/`attempt_token`/`leased_until`/`timeout_at`/`heartbeat_at`):

```typescript
  async markDone(a: { jobId: string; owner: string; token: string }): Promise<FencedResult> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql`UPDATE core.review_jobs
        SET state = 'done', finished_at = now(),
            leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}`
      .execute(this.db);
    return { applied: Number(r.numAffectedRows ?? 0n) === 1 };
  }
```

> The `WHERE` fences on the *pre-update* `lease_owner`/`attempt_token`, so clearing them in the same `SET` is safe.

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): fenced markDone (clears lease metadata; returns FencedResult)"`

### Task 1.7: `markFailed` (fenced; state machine ready+backoff+jitter | dead; clears lease metadata; returns `{applied, terminal}`)

**Files:** Modify repo + test

- [ ] **Step 1: Failing test**

```typescript
describeDb("ReviewJobsRepo.markFailed", () => {
  it("re-enqueues with backoff then dead-letters; clears lease; a stale token is applied:false", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); await repo.enqueue({ ...s, maxAttempts: 2 });
    const c1 = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    const r1 = await repo.markFailed({ jobId: c1!.job_id, owner: "w1", token: c1!.attempt_token!, error: "boom", baseBackoffMs: 1 });
    expect(r1).toEqual({ applied: true, terminal: false });
    const requeued = await repo.getById(c1!.job_id);
    expect(requeued!.state).toBe("ready");
    expect((requeued as any).attempt_token).toBeNull();      // lease metadata cleared on requeue (v3 #9)
    await new Promise((r) => setTimeout(r, 30));
    const c2 = await repo.claim({ owner: "w1", leaseMs: 1000, maxRuntimeMs: 60_000 });
    const r2 = await repo.markFailed({ jobId: c2!.job_id, owner: "w1", token: c2!.attempt_token!, error: "boom2", baseBackoffMs: 1 });
    expect(r2).toEqual({ applied: true, terminal: true });
    const dead = await repo.getById(c2!.job_id); expect(dead!.state).toBe("dead"); expect((dead as any).dead_reason).toContain("boom2");
    expect((await repo.markFailed({ jobId: c2!.job_id, owner: "w1", token: crypto.randomUUID(), error: "x", baseBackoffMs: 1 })).applied).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** — jitter via SQL `random()` (a string inside the template, **not** JS `Math.random` — `check_clock_random` scopes `src/**` only and treats the SQL literal as text); clear lease metadata on both branches:

```typescript
  async markFailed(a: { jobId: string; owner: string; token: string; error: string; baseBackoffMs: number }):
    Promise<{ applied: boolean; terminal: boolean }> {
    // tenant:exempt reason=PK-lookup-by-job_id follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql<{ terminal: boolean }>`UPDATE core.review_jobs SET
        last_error  = left(${a.error}, 2000),
        state       = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'ready' END,
        dead_reason = CASE WHEN attempts >= max_attempts THEN left(${a.error}, 2000) ELSE dead_reason END,
        finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE finished_at END,
        -- exponential backoff with ±25% jitter (avoid a herd re-claiming after an LLM/GitHub incident):
        run_after   = now() + ((${a.baseBackoffMs}::double precision * power(2, attempts - 1)) * (0.75 + random() * 0.5) / 1000) * interval '1 second',
        lease_owner = NULL, attempt_token = NULL, leased_until = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE job_id = ${a.jobId} AND state = 'leased' AND lease_owner = ${a.owner} AND attempt_token = ${a.token}
      RETURNING (state = 'dead') AS terminal`.execute(this.db);
    return { applied: r.rows.length === 1, terminal: r.rows[0]?.terminal ?? false };
  }
```

> `RETURNING (state = 'dead')` reflects the *post-update* state, so `terminal` is correct. Clearing `attempt_token` on the ready branch means the next claim mints a fresh token (the stale-token `markFailed` then fails the `state='leased'` fence — `applied:false`).

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): fenced markFailed (state machine + jittered backoff + clears lease metadata)"`

### Task 1.7b: `reapCrashLooped` — watchdog dead-letters expired leases whose attempts are exhausted (v3 #2)

**Files:** Modify repo + test

> This closes the crash-loop liveness gap: a worker that dies *during* the paid section (before `markFailed` runs) leaves the row `leased` with `attempts` incremented. Task 1.4's reclaim guard stops it from being re-run once `attempts == max_attempts` (so no further LLM spend), but it would sit `leased` forever. `reapCrashLooped` transitions those rows to `dead`. In Phase 1 the `RunnerLoop` calls it once per idle cycle (Task 1.13); Phase 2 folds it into the unified reaper.

- [ ] **Step 1: Failing test**

```typescript
describeDb("ReviewJobsRepo.reapCrashLooped", () => {
  it("dead-letters an expired lease with attempts exhausted; leaves a live lease alone", async () => {
    const repo = new ReviewJobsRepo(db);
    // (A) crash-looped job: maxAttempts=1, claimed (attempts→1), lease expires, never markFailed'd
    const a = await seedRun(db); await repo.enqueue({ ...a, maxAttempts: 1 });
    const ca = await repo.claim({ owner: "w1", leaseMs: 1, maxRuntimeMs: 60_000 });
    await new Promise((r) => setTimeout(r, 50));
    // (B) live job: freshly claimed with a long lease — must NOT be reaped
    const b = await seedRun(db); await repo.enqueue(b);
    const cb = await repo.claim({ owner: "w2", leaseMs: 60_000, maxRuntimeMs: 60_000 });
    expect(await repo.reapCrashLooped()).toBe(1);
    const dead = await repo.getById(ca!.job_id);
    expect(dead!.state).toBe("dead"); expect((dead as any).dead_reason).toContain("crash loop");
    expect((dead as any).attempt_token).toBeNull();          // lease metadata cleared (v3 #9)
    expect((await repo.getById(cb!.job_id))!.state).toBe("leased"); // live lease untouched
  });
});
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** (cross-tenant sweep → marker on the preceding line; clears lease metadata):

```typescript
  async reapCrashLooped(): Promise<number> {
    // tenant:exempt reason=watchdog-sweep-across-tenants follow_up=FOLLOW-UP-gf3-error-mode
    const r = await sql`UPDATE core.review_jobs
        SET state = 'dead', dead_reason = COALESCE(dead_reason, 'lease expired with attempts exhausted (crash loop)'),
            finished_at = now(),
            leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
      WHERE state = 'leased' AND leased_until < now() AND attempts >= max_attempts`.execute(this.db);
    return Number(r.numAffectedRows ?? 0n);
  }
```

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): reapCrashLooped (dead-letter maxed-out crashed leases)"`

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

### Task 1.9: `runWithRetry(clock, random, policy, fn)` — HARD timeout + AbortSignal + classification + seam jitter (v3 #1)

**Files:** Create `apps/backend/src/runner/run_with_retry.ts`; Test `test/unit/runner/run_with_retry.test.ts`

- [ ] **Step 1: Failing test** (retries; non-retryable short-circuits; a handler that **ignores** the signal is still hard-killed by the timeout; jitter sourced from a seeded `Random`):

```typescript
import { describe, expect, it } from "vitest";
import { WallClock } from "#platform/clock.js";
import { SystemRandom } from "#platform/randomness.js";
import { runWithRetry, type RetryPolicy } from "#backend/runner/run_with_retry.js";
const clock = new WallClock(); const random = new SystemRandom();
const P: RetryPolicy = { startToCloseS: 0.05, initialIntervalS: 0.001, maxIntervalS: 0.005, backoff: 2, maxAttempts: 3,
  nonRetryable: (e) => (e as Error).name === "Terminal" };
describe("runWithRetry", () => {
  it("retries transient then succeeds", async () => {
    let n = 0; expect(await runWithRetry(clock, random, P, async () => { if (++n < 3) throw new Error("t"); return "ok"; })).toBe("ok"); expect(n).toBe(3);
  });
  it("does not retry non-retryable", async () => {
    let n = 0; const err = Object.assign(new Error("x"), { name: "Terminal" });
    await expect(runWithRetry(clock, random, P, async () => { n++; throw err; })).rejects.toThrow("x"); expect(n).toBe(1);
  });
  it("HARD-times-out an attempt that ignores the abort signal", async () => {
    // fn never resolves and ignores signal → the timeout must still reject the attempt:
    await expect(runWithRetry(clock, random, { ...P, maxAttempts: 1 }, () => new Promise(() => {}))).rejects.toThrow(/timeout/i);
  });
});
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** — `Promise.race(fn, timeout)` is the *hard* stop (returns even if `fn` ignores the abort); `abort()` is the *cooperative* stop; jitter comes from the injected `Random` seam (**no `Math.random` — `check_clock_random` bans it in `src/`**):

```typescript
import type { Clock } from "#platform/clock.js";
import type { Random } from "#platform/randomness.js";
export type RetryPolicy = { startToCloseS: number; initialIntervalS: number; maxIntervalS: number; backoff: number;
  maxAttempts: number; nonRetryable: (e: unknown) => boolean };
// CONTRACT: every wrapped operation MUST honor `signal` — abort in-flight fetches (pass to fetch), kill subprocesses
// (process-group kill on abort). The Promise.race below guarantees the WRAPPER returns on timeout; honoring `signal`
// guarantees the underlying WORK actually stops (no orphaned subprocess / socket). Both are required.
export async function runWithRetry<T>(clock: Clock, random: Random, policy: RetryPolicy,
  fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let interval = policy.initialIntervalS; let lastErr: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const ac = new AbortController();
    const timeout = clock.sleep(policy.startToCloseS).then(() => "__timeout__" as const);
    let res: T | "__timeout__";
    try { res = await Promise.race([fn(ac.signal), timeout]); }
    catch (e) {
      lastErr = e;
      if (policy.nonRetryable(e) || attempt === policy.maxAttempts) throw e;
      await clock.sleep(interval * random.uniform(0.75, 1.25)); // jitter via the randomness seam (avoids herd)
      interval = Math.min(interval * policy.backoff, policy.maxIntervalS); continue;
    }
    if (res === "__timeout__") {
      ac.abort(new Error(`startToClose ${policy.startToCloseS}s exceeded`)); // cooperative stop of the underlying work
      lastErr = new Error(`timeout after ${policy.startToCloseS}s`);
      if (attempt === policy.maxAttempts) throw lastErr;
      await clock.sleep(interval * random.uniform(0.75, 1.25));
      interval = Math.min(interval * policy.backoff, policy.maxIntervalS); continue;
    }
    return res;
  }
  throw lastErr;
}
```

> The Phase-2 adapter maps `RETRY_POLICIES` (`review/pipeline/activity_ports.ts`, durations→seconds; `nonRetryable` = `nonRetryableErrorTypes.includes(err.constructor.name)`) onto `RetryPolicy`, and injects `SystemRandom` in production / `SeededRandom` in tests for deterministic jitter.

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): runWithRetry (hard clock timeout + AbortSignal contract + seam-sourced jitter)"`

### Task 1.10: `runOneJob` — fenced outcome + cancellable heartbeat + **hard runtime ceiling** (v3 #5)

**Files:** Create `apps/backend/src/runner/review_job_runner.ts`; Test `test/integration/runner/review_job_runner.integration.test.ts`

- [ ] **Step 1: Failing test** (happy → `done`; throw → `dead` at maxAttempts; **handler that ignores the signal + hangs → `failed` within the runtime ceiling, slot returns**):

```typescript
// (imports + Kysely/pool setup as in Task 1.3) ...
import { runOneJob } from "#backend/runner/review_job_runner.js";
import { WallClock } from "#platform/clock.js";
import { seedRun } from "./_fixtures.js";
const clock = new WallClock();
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
```

- [ ] **Step 2: Run → FAIL** ; **Step 3: Implement** — capture the outcome from a `Promise.race` of (handler) vs (hard runtime ceiling); the `finally` only stops the helpers (cancellably) and never overwrites the outcome:

```typescript
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
```

> When the handler settles first, `stop.abort()` in the `finally` wakes both helpers' `cancellableSleep` (no dangling timers). A handler that truly ignores `work.signal` leaves an orphaned promise behind — the hard race frees the worker *slot*, but the abandoned work can keep running. The DB fence makes a late `markDone`/`markFailed` a no-op (affects 0 rows), so `core.*` is safe — but **external** side effects (a GitHub post) are NOT fenced. That is why the **Phase-2 shell carries a HARD CONTRACT** (see the Phase-2 checklist): every handler path must be abort-aware (`signal` threaded into fetch/subprocess/LLM/GitHub), must re-check `signal.aborted` immediately before any external write, and must rely on post-claim idempotency (`comment_ids`/fix-prompt keyed on `review_id`) as the backstop. Phase 1's hard ceiling protects the runner; Phase 2 must protect the outside world.

- [ ] **Step 4: Run → PASS** ; **Step 5: Commit** — `git commit -m "feat(runner): runOneJob (fenced outcome + cancellable heartbeat + hard runtime ceiling)"`

### Task 1.11: Chaos — lease-steal fenced; completes once; loser reports `lease_lost`

**Files:** Modify `test/integration/runner/review_job_runner.integration.test.ts`

- [ ] **Step 1: Test**

```typescript
describeDb("runOneJob — chaos", () => {
  it("a stolen lease completes once; the loser reports lease_lost, not success", async () => {
    const repo = new ReviewJobsRepo(db); const s = await seedRun(db); const id = await repo.enqueue(s);
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

- [ ] **Step 1: Failing test** — assert the metric surface exists and `runOneJob` records claim latency + the outcome (mirror an existing OTel metrics test idiom in the repo). Counters/histograms: `codemaster_runner_claim_latency_ms`, `..._lease_steals_total`, `..._heartbeat_failures_total`, `..._stale_token_writes_total{op}`, `..._jobs_total{outcome}`, `..._handler_duration_ms`, `..._retry_attempts_total`, `..._crash_loop_reaped_total`.
- [ ] **Step 2–4:** implement the metric module + record points in `runOneJob` (claim latency around claim; `lease_steals_total` when a reclaim mints `attempts > 1`; `stale_token_writes_total` when an outcome is `lease_lost`; `jobs_total{outcome}`; `handler_duration_ms`) and in `RunnerLoop` (`crash_loop_reaped_total` += `reapCrashLooped()`'s return). Run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(runner): OTel metrics (claim latency, lease steals, stale-token writes, crash-loop reaps, outcomes, durations)"`

### Task 1.13: `RunnerLoop` + cancellable idle + SIGTERM graceful drain (v3 #6)

**Files:** Modify `apps/backend/src/runner/review_job_runner.ts`; Test `test/integration/runner/runner_loop.integration.test.ts`

- [ ] **Step 1: Failing tests** — (a) drain: enqueue 2 jobs, start the loop with a slow handler, call `stop()` mid-first-job → the first finishes `done`, the second is **not** claimed (stays `ready`); (b) **idle interrupt**: with no jobs enqueued, start the loop, call `stop()` during the idle wait → `run()` resolves in well under `idleS`:

```typescript
describeDb("RunnerLoop", () => {
  it("drains the in-flight job and stops claiming new ones on stop()", async () => {
    const repo = new ReviewJobsRepo(db);
    const s1 = await seedRun(db); const id1 = await repo.enqueue(s1);
    const s2 = await seedRun(db); const id2 = await repo.enqueue(s2);
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
```

- [ ] **Step 2–4:** implement — a loop-level stop `AbortController` wakes the idle `cancellableSleep`; reap crash-looped jobs on idle:

```typescript
export class RunnerLoop {
  #stopped = false;
  readonly #stop = new AbortController();                  // wakes the idle sleep immediately on stop()
  constructor(private o: { repo: ReviewJobsRepo; clock: Clock; owner: string; leaseS: number; heartbeatS: number;
    maxRuntimeS: number; idleS: number; handler: JobHandler }) {}
  stop() { this.#stopped = true; this.#stop.abort(); }     // wire to process.on('SIGTERM', () => loop.stop())
  async run(): Promise<void> {
    while (!this.#stopped) {
      const { outcome } = await runOneJob(this.o);          // an in-flight job ALWAYS runs to completion (drain)
      if (outcome === "idle" && !this.#stopped) {
        await this.o.repo.reapCrashLooped();                // bounded cleanup of maxed-out crashed leases (v3 #2)
        await cancellableSleep(this.o.clock, this.o.idleS, this.#stop.signal); // stop() interrupts this wait (v3 #6)
      }
    }
  }
}
```

> SIGTERM handler lives in the dedicated runner process (Phase 3): `process.on("SIGTERM", () => loop.stop())`, then `await loop.run()`'s in-flight job completes within the pod's `terminationGracePeriodSeconds`; if grace is exceeded, the lease simply expires and another pod reclaims (no special-casing).

- [ ] **Step 5: Commit** — `git commit -m "feat(runner): RunnerLoop + cancellable idle + SIGTERM drain + idle reap"`

### Phase 1 exit criteria
- `npm run typecheck` + `npm run lint` (0 errors) + `npm run gates` clean (incl. `check_clock_random` — **no raw timers AND no `Math.random()` in `src/`**; `check_tenant_scoped_raw_sql` WARN-mode prints exit-0 with `core.review_jobs` registered + every raw-SQL ref marked or installation_id-filtered) on changed files.
- All Phase-1 tests green against `:5434/codemaster` (set `CODEMASTER_PG_CORE_DSN`).
- Demonstrated: DB-`now()` lease + fencing (loser → `lease_lost`, state correct under two workers); the state machine `ready → leased → done | → ready+backoff | → dead` (**`→ cancelled` is Phase 2 (supersede) — the column vocabulary ships now but no Phase-1 transition exercises it**); `timeout_at` **and** the **hard runtime ceiling** stop a stuck-but-alive / signal-ignoring worker; the **max-attempts crash-loop cap** (reclaim guard + `reapCrashLooped` dead-letter); cancellable heartbeat; **cancellable idle** + SIGTERM drain; lease-metadata cleared on every terminal/ready transition; and the metric surface. **Phase 1 proves the runner mechanics; making the review *work* idempotent under re-run (ledger, post-claim, supersede) is Phase 2.**

---

## Phases 3–6 (outlines; detail just-in-time)

- **Phase 3** — `core.background_jobs` (generic coarse table, reusing the Phase-1 skeleton); the dedicated always-on runner process (poller + scheduler-leader; `clock.sleep`, never `setInterval`; poller N-pods via `SKIP LOCKED`, scheduler-leader single via `pg_advisory_lock`); the scheduler (cron + interval cadences anchored to **DB `now()`** in the emit txn; deterministic tick key; overlap=skip; missed-tick + failover); **admin-command rows** (replacing `signalWorkflow`); migrate non-review workloads, **confluence per-space** (one row/space; embed gated on `(page_id,version,content_hash)`; F-40 reconcile only on a complete page loop).
- **Phase 4** — cutover: `review_job_enqueue` outbox sink + `ReviewJobEnqueuePayloadV1`; `target_engine` in `persistWebhook`, one dispatcher branches; content-key redelivery dedup; drain + `runner_paused` + shadow-parity harness (one engine posts; LLM via shared ledger; `core.*` isolated by `run_kind`; pin-LLM + fuzzy oracle); rollback-as-drain.
- **Phase 5** — operator UI/API: per-job state/attempts/lease_owner/heartbeat-age/run_id/last_error/dead|cancel_reason/finalizer/engine + retry/cancel/force-release/**reconcile-delivery-outcome**, RBAC + audit.
- **Phase 6** — Temporal teardown after Phase 4 soaked ≥1 week (delete bundles/converter/gates/`patched`/two-worker/helmchart/`@temporalio/*`; assert zero imports).

---

## Self-review (writing-plans)
- **Spec coverage (Phase 1):** runner table (FK, DB-`now()` lease, 5-state machine, **no `repo_id`/`provider`**), tenant registration (gate + runtime set), repo (enqueue/getById/claim/heartbeat/markDone/markFailed/**reapCrashLooped** — all fenced; lease metadata cleared on terminal/ready), `timeout_at` semantics (set on claim, enforced in heartbeat, abort in runOneJob), the **hard runtime ceiling** in runOneJob, the **max-attempts crash-loop cap** (claim reclaim guard + reapCrashLooped), `runWithRetry` (hard timeout + AbortSignal contract + **seam jitter**), `cancellableSleep`, `runOneJob`, chaos, metrics, RunnerLoop (**cancellable idle** + SIGTERM drain + idle reap), plus the migration's attempt-invariant CHECKs (`attempts>=0`, `max_attempts>=1`, `priority>=0`) and the abort-aware Phase-2 hard contract. Each of the 9 v2-review findings maps to a task per the v3 changelog table; each of the 6 v3-review findings maps per the v4 changelog table above.
- **Placeholder scan:** Phase-1 tasks carry complete test + impl code + exact commands; Tasks 1.12/1.13 reference an existing OTel test idiom + the process SIGTERM hook to mirror (named, not vague). Phases 0/2–6 are explicitly *outlines/checklists*, not in-phase placeholders.
- **Type consistency:** `ReviewJobsRepo` (`enqueue(EnqueueArgs)`/`getById`/`claim`/`heartbeat`/`markDone`→`FencedResult`/`markFailed`→`{applied,terminal}`/`reapCrashLooped`→`number`), `EnqueueArgs` (no `repoId`/`provider`), `RetryPolicy` (seconds), `runWithRetry(clock,random,policy,fn)`, `cancellableSleep(clock,seconds,signal)`, `runOneJob`/`RunOutcome`/`RunnerLoop`, and `seedRun(db) → {runId,reviewId,installationId}` are consistent across Tasks 1.3–1.13. Every integration test calls `seedRun(db)` and `repo.enqueue(s)` (or `{...s, maxAttempts}`).
- **Verify-against-code (grounded for v3 + v4):** `core.review_runs`/`core.pull_request_reviews` NOT-NULL + CHECK columns + the two real UNIQUE indexes `(provider, provider_pr_id)` and `(provider, repo_id, pr_number)` (fixture verified vs `:5434/codemaster`), `repo_id` is a GitHub `bigint`, the `#platform/clock.js`/`#platform/randomness.js` exports (`WallClock`, `SystemRandom`/`SeededRandom`, `uuid4`), the `test/integration/_db.ts` harness (`describeDb`/`INTEGRATION_DSN`, no DSN default), `migrate:up` reads `CODEMASTER_PG_CORE_DSN`, `check_clock_random` bans `Math.random()` in `src/`, and `check_tenant_scoped_raw_sql` (WARN-mode; the table list lives once in `libs/platform/src/db/tenant_scoped_tables.ts` and `scripts/gates/_registry.ts:10` re-exports it; the gate keys each violation at `tpl.getStartLineNumber()` and checks that line + the one above — so one marker above `const r = await sql…` covers a whole multi-ref template).
