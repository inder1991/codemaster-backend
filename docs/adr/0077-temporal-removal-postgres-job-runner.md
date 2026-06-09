# ADR-0077: Temporal removal — decision, and the right way to do it

- Status: **Proposed** (architecture direction approved in review; execution gaps below close it toward Accepted)
- Date: 2026-06-09
- **Recommendation:**
  - **Objection = operational weight** → **Stage 0**: Temporal on PostgreSQL-only persistence. ~zero code, ~zero risk.
  - **Objection = the Temporal dependency itself** → a **coarse-grained `review_jobs` runner** (one job = one whole review, executed in one process). Recommended at our scale. **DBOS** (a Postgres-only durable-execution *library*) is the alternative if fine-grained durable resume is wanted without owning runner code.
  - **Do NOT build a fine-grained, per-step job runner** (Appendix B).
- Revision: **v5** — closes the execution gaps from the v4 review. Specifically: (1) `orchestrate()` is reused *mostly* unchanged but needs a new non-Temporal **review-job shell**; (2) a small **cancellation/failure/metrics seam** to de-Temporalize `degradation.ts`/`posting.ts`; (3) **admin commands** (knowledge approve/reject, embedder cancel) replace `signalWorkflow`; (4) the **LLM-ledger guarantee is weakened** + a cost/ledger reconcile job; (5) the **post-tail side-effects** are enumerated with per-effect retry behavior; (6) **per-activity internal retries stay** so a whole-review re-run is only for hard crashes; (7) the **schema is expanded**; (8) a **finalizer protocol**; (9) the **scheduler default is fixed** (in-app + advisory lock); (10) **duplicate posting is a bug to prevent**, not an acceptable outcome; (11) the **cutover is detailed**; (12) a **chaos test plan**.
- Relates to: ADR-0066, ADR-0068 (LLM ledger — load-bearing), ADR-0074/0075/0076; `docs/architecture/temporal-workflow-integration.md`; spikes in `docs/adr/0077-spikes/`.

## Context

The decision hinges on one question: **is the objection Temporal's operational weight, or the dependency itself?** If the dependency must go, the **granularity** of the replacement matters more than "Postgres runner vs library": the three review passes (14 + 17 + 28 findings) showed a *fine-grained, per-step* runner is unbuildable-without-multi-quarter-pain, while a *coarse-grained* runner (the whole review as one in-process job) sidesteps the entire register.

**The decisive property: the bot is advisory** (comment-only; never blocks a merge — invariant 9). That lowers the **availability** bar (a missing or late review is tolerable) — but **not** the bar on *what gets posted*: a duplicate or superseded-review comment damages trust and is a **bug to prevent**, not a normal outcome (see §Correctness below).

What we already operate in Postgres: `core.outbox` (lease/attempts/dead-letter), `core.review_runs` (lifecycle + supersede + `current_run_id`), `audit.workflow_events`, the ADR-0068 ledger, `pr_review_mutex` + janitor/reaper. `orchestrate()` is a pure in-process async driver, unit-tested without Temporal.

## Decision

| Objection | Recommended path | Cost | Risk |
|---|---|---|---|
| operational weight | **Stage 0** (Temporal on Postgres-only) | an afternoon | ~none |
| the dependency itself | **Coarse-grained `review_jobs` runner** | ~4–6 weeks | low–moderate |
| dependency, prefer not to own runner code | **DBOS** (library) | ~6–9 weeks | moderate (young library on the core loop) |
| — | fine-grained per-step runner | multi-quarter | high — **do not build** (Appendix B) |

## The coarse-grained `review_jobs` runner (recommended, if No Temporal)

**One job = one whole review, in one process.** Reuse `orchestrate()` *mostly* unchanged, wrapped in a new **non-Temporal review-job shell** that replaces the Temporal workflow body.

### What is reused vs. built (correcting v4's "unchanged")

- **Reused mostly as-is:** `orchestrate()` (the 9-stage pipeline), all 52 activities (called as plain async functions), the in-process `fanOutReview`, the contracts/repos.
- **Built new — the review-job shell** (replacing `review_pull_request.workflow.ts`’s body): the start-review **gate**, **mutex lease renewal** during the run, **workspace allocate/release**, **placeholder post/delete**, run **lifecycle finalization**, and the **failed/cancelled mapping** the Temporal body did.
- **Built new — a small de-Temporal seam (finding #2):** `degradation.ts` and `posting.ts` currently reach for Temporal failure/cancellation types and the workflow **metric meter**. Introduce a tiny abstraction — `isCancelled(err)`, `classifyFailure(err)`, and a `Metrics` port (→ OTel directly) — so the pipeline helpers carry no `@temporalio` import.

### Schema (expanded — finding #7)

```sql
CREATE TABLE core.review_jobs (
  job_id          uuid PRIMARY KEY,
  run_id          uuid NOT NULL,        -- execution identity (FK core.review_runs.run_id)
  review_id       uuid NOT NULL,        -- PR-review grouping
  installation_id uuid NOT NULL,        -- tenancy + fairness
  repo_id         uuid NOT NULL,
  provider        text NOT NULL,        -- e.g. 'github'
  state           text NOT NULL DEFAULT 'ready',  -- ready|leased|done|failed|dead|cancelled
  priority        int  NOT NULL DEFAULT 0,         -- fair scheduling
  attempts        int  NOT NULL DEFAULT 0,
  max_attempts    int  NOT NULL DEFAULT 3,
  lease_owner     text,
  attempt_token   uuid,                 -- fencing: minted fresh on every claim
  leased_until    timestamptz,
  heartbeat_at    timestamptz,
  timeout_at      timestamptz,          -- per-review hard ceiling
  run_after       timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  cancel_reason   text,
  dead_reason     text,
  last_error      text,
  target_engine   text,                 -- cutover only: 'temporal' | 'review_jobs'
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- at most one active job per run/review:
CREATE UNIQUE INDEX uq_review_jobs_active ON core.review_jobs (run_id)
  WHERE state IN ('ready','leased');
```

### Worker loop & retry economics (finding #6)

1. **Claim** with `FOR UPDATE SKIP LOCKED` (fair by `priority, run_after`); set `lease_owner` + fresh `attempt_token` + `leased_until` (DB `now()` is the sole lease clock); `started_at = now()`.
2. **Run the shell + `orchestrate()` in-process.** **Each activity call keeps its existing `RETRY_POLICIES` retry/backoff internally** — so a transient late-stage failure (a flaky GitHub post) retries *locally and cheaply*. A whole-review re-run is reserved for a **hard process crash**, not a transient error; otherwise late failures become expensive full reruns.
3. **Heartbeat** the lease (and renew the PR mutex) while running; `timeout_at` bounds a stuck review.
4. **Finalize** via the finalizer protocol (below); set `finished_at`, `state`.
5. **Hard crash** → lease expires → re-claim (fresh `attempt_token`) → **whole-review re-run** (semantics below).

### Why the v1–v3 risk register vanishes (unchanged from v4)

| Fine-grained failure | Coarse-grained outcome |
|---|---|
| pod-local workspace; clone on A, classify on B finds empty dir | one process holds the clone for the whole review ✅ |
| no home for shared `ReviewWorkflowState` | stays in memory, as today ✅ |
| fan-in N=0 wedge; 11-stage tail as one step | it's all code inside `orchestrate()`, not a job graph ✅ |
| schema won't compile (partitioned unique index) | no per-chunk rows ✅ |
| lost query-vector cache / pinned generation; frozen clock | one in-process run; as today ✅ |

### Side effects & idempotency on re-run (finding #5)

A whole-review re-run replays the tail; each external effect needs a defined behavior:

| Side effect | On re-run | Mechanism |
|---|---|---|
| Bedrock LLM call | replay if the ledger write committed; else **re-pay** | ADR-0068 ledger (weakened guarantee below) |
| `post_review` (findings) | safe (no duplicate) | 2-phase atomic-claim + `comment_ids` invariant + stale-write guard |
| `post_check_run` | safe (upsert at head SHA) | neutral check-run keyed to head SHA |
| `update_pr_description` | **must be idempotent** (no re-append) | read-modify-write guarded by a marker block; needs a dedicated key |
| `fix_prompt` comment | **must not double-post** | needs a deterministic external key (GitHub has no native idempotency) |
| placeholder delete | safe | best-effort, marker-matched |
| delivery-lifecycle setters | safe (idempotent on rfid) | `record_delivery_*` keyed to finding ids |

### LLM-ledger guarantee (corrected — finding #4)

v4 over-claimed "replays instead of re-paying." Accurate statement: **the ledger replays a call only when its ledger write completed.** It does **not** cover: a crash *after the provider call but before the ledger write* (→ a re-run re-pays), *concurrent* duplicate provider calls (the `lookup` is a plain `SELECT`, no `FOR UPDATE`), or a crash *after the ledger write but before `recordCallCost`* (→ a leaked cost reservation). Mitigations: (a) make the ledger `lookup` acquire `FOR UPDATE`/an advisory lock on the idempotency key so a concurrent invoker blocks rather than races; (b) add a **cost/ledger reconcile job** that releases reservations with no matching completed call and reconciles ledger-without-recordCallCost rows. Net for an advisory tool: occasional small re-spend on a crash is acceptable; unbounded cost drift is not — the reconcile job bounds it.

### Finalizer protocol (finding #8)

Every terminal path (done / failed / dead / cancelled / superseded) runs **idempotent finalizers**:
- release the **PR mutex**;
- release the **workspace** (lease + disk);
- delete the **placeholder** where appropriate;
- **release/reconcile the cost reservation**;
- set the run **lifecycle** (`COMPLETED`/`FAILED`/`CANCELLED`) + `review_jobs.state`.

Graceful paths run finalizers in the shell's `finally`. **Hard crashes** (the process dies before `finally`) are healed by the **reaper/janitor**, which on lease-expiry runs the same idempotent finalizers before re-enqueueing — so mutex/workspace/cost are never leaked past one lease window.

### Scheduler (decided — finding #9)

The crons (mutex-janitor, review-run reaper, retention, confluence sync) run on an **in-app scheduler with a Postgres advisory-lock leader election** — **no new component.** `pg_cron` is optional and only if the platform explicitly approves the extension.

### Correctness vs availability (recalibrated — finding #10)

Advisory ⇒ the **availability** bar is relaxed: a late/missing/retried review is tolerable. It does **not** relax *posting correctness*: a duplicate, stale, or superseded-review comment erodes trust. Therefore the post-step idempotency (table above) and the supersede claim-checks are **hard requirements**, validated by the chaos tests below — not "cosmetic" outcomes.

### Crash & failure semantics

- **At-most-one running** per PR (the unique active-job index + the PR mutex). **Fencing** voids a stolen lease's late write.
- **Whole-review re-run** only on hard crash; transient failures retry per-activity in-process (finding #6).
- **Cost drift** from crashes is bounded + healed by the reconcile job (finding #4).

### Admin commands (finding #3 — replaces `signalWorkflow`)

`AdminTemporalPort.signalWorkflow` (knowledge approve/reject; embedder cancel) has no signal equivalent here. Replace with **durable admin-command rows** (a `command` table or columns on the target row) that the relevant worker/loop observes and acts on idempotently: knowledge approve/reject → a command consumed by the knowledge flow; embedder cancel → a `cancel_requested` flag the embedder job checks at its safe points; a review cancel → set `review_jobs.cancel_reason` + the run’s supersede/cancel, which the running shell honors at its claim-checkpoints. Each command is audited (RBAC on destructive ones).

### Effort

**~4–6 weeks** (v4 said 3–5; the shell + de-Temporal seam + finalizers + reconcile job + cutover detail add ~a week). Still the smallest No-Temporal option, no new dependency, no maturity bet; the bulk is the shell, cutover/parity, the small per-review operator UI, and the chaos soak.

## Cutover & rollback (finding #11)

- **Dispatch fork:** resolve `target_engine` (by installation/repo) **inside the existing `persistWebhook` transaction**, written onto the outbox row; **one dispatcher** routes to Temporal `startWorkflow` *or* a `review_jobs` insert based on it — no second dispatch path.
- **Drain old Temporal rows:** stop routing *new* webhooks to Temporal for a flipped install; let in-flight Temporal workflows finish on Temporal (≤30 min); a drain check confirms none remain before decommissioning the Temporal worker.
- **GitHub redelivery:** dedup on a **content key** (installation+repo+pr+head_sha+action), *not* `delivery_id` (GitHub re-mints it); route a redelivery to the engine that owns the current `run_id`, not the static flag.
- **Pause the runner:** a global/per-install `runner_paused` flag stops claiming new `review_jobs` while letting in-flight ones finish.
- **Rollback (before Temporal is removed):** flip `target_engine` back to Temporal for new work; for in-flight `review_jobs`, either let them finish on the runner, or abandon-and-re-allocate a Temporal run (idempotent post makes the re-review safe); the reaper/janitor must understand `review_jobs` before cutover.

## Required chaos test plan (finding #12)

Pre-merge, against a disposable Postgres + a real multi-worker harness:
- **kill worker during clone** → re-run produces a correct single review; workspace not leaked.
- **kill during the LLM call** → re-run re-pays at most the in-flight call (ledger), no double-post.
- **kill after GitHub post, before DB mark-done** → re-run does **not** double-post (post idempotency holds); job reconciles to done.
- **lease stolen while the old worker is still alive** → the old worker's late writes are fenced out (0 rows); no double effect.
- **supersede during a review** → the older run no-ops at its next claim-checkpoint; never posts.
- **SIGTERM graceful drain** → stop claiming, finish in-flight, finalizers run, exit within the deadline.
- **multi-pod same-PR contention** → the unique active-job index + mutex admit exactly one runner.

## Alternatives considered

- **Stage 0** (Temporal on Postgres-only) — recommended if the objection is operational weight.
- **Coarse-grained `review_jobs` runner** (recommended if No Temporal) — simplest; no new dependency; reuses `orchestrate()` + existing primitives.
- **DBOS** — Postgres-only durable-execution library (no server); fine-grained durable resume without owning runner code; young-framework-on-core-loop cost.
- **Fine-grained per-step runner** — rejected (Appendix B).
- **LangGraph** — a different layer (agent/LLM orchestration, not a durable distributed backbone); could compose *inside* a step if a review becomes agentic.
- **Restate / Hatchet** — new server component (→ ADR).
- **BullMQ + Redis** — rejected (Redis excluded; a queue, not durable execution).

## Open question (the decision)

**Operational weight → Stage 0. The dependency itself → the coarse-grained `review_jobs` runner** (or DBOS to avoid owning runner code). **Avoid the fine-grained per-step runner.**

---

## Appendix A — proof-of-concept spikes (honest scope)

`docs/adr/0077-spikes/spike.mjs` + `spike2.mjs`. They prove the toy engine mechanics in isolation (hand-off, fan-in for N≥1, lease-steal recovery, fencing, heartbeat, idempotency). They do **not** prove a concurrent in-flight paid call, multi-process, real durations, clock skew, or the N=0 case. For the **coarse-grained** design they are largely moot — there is no per-step fan-in to fence; the unit of work is the whole review. The required evidence for coarse-grained is the **chaos test plan** above, not the spikes.

## Appendix B — the fine-grained per-step runner (DO NOT BUILD)

Retained as a cautionary record. A per-step runner must close all of: a compiling schema (no partitioned-table unique index; `run_id` PK; per-sink non-partitioned idempotency ledgers); DB-`now()` lease clock + fencing + fenced watchdog; the fan-in N=0 base case; persisted shared `ReviewWorkflowState`; pinned retrieval generation + a `run_logical_now` clock; **workspace locality (new RWX infra or sticky claims)**; the 11-stage tail expanded with per-step idempotency; `post` decomposed into four idempotent GitHub sub-effects; unified reaper+supersede+fence authority; guaranteed finalizers incl. cost-release; a declared cross-tenant privileged claim path; a new high-churn per-attempt history store; and a shadow-cutover that does not contaminate `pr_id`-keyed findings nor double-spend Bedrock on prompt drift. Each is a sub-project; together, multi-quarter. **The coarse-grained runner exists so none of this is necessary.**
