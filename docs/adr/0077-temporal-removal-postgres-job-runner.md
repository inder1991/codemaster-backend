# ADR-0077: Temporal removal — decision, and the right way to do it

- Status: **Accepted for implementation *planning*; not yet Accepted for *build*** — the architecture direction is approved in review; the v6 "Implementation design" section below closes the production details required before build starts.
- Date: 2026-06-09
- **Recommendation:**
  - **Objection = operational weight** → **Stage 0**: Temporal on PostgreSQL-only persistence. ~zero code, ~zero risk.
  - **Objection = the Temporal dependency itself** → a **coarse-grained `review_jobs` runner** (one job = one whole review, executed in one process). Recommended at our scale. **DBOS** (a Postgres-only durable-execution *library*) is the alternative if fine-grained durable resume is wanted without owning runner code.
  - **Do NOT build a fine-grained, per-step job runner** (Appendix B).
- Revision: **v5** — closes the execution gaps from the v4 review. Specifically: (1) `orchestrate()` is reused *mostly* unchanged but needs a new non-Temporal **review-job shell**; (2) a small **cancellation/failure/metrics seam** to de-Temporalize `degradation.ts`/`posting.ts`; (3) **admin commands** (knowledge approve/reject, embedder cancel) replace `signalWorkflow`; (4) the **LLM-ledger guarantee is weakened** + a cost/ledger reconcile job; (5) the **post-tail side-effects** are enumerated with per-effect retry behavior; (6) **per-activity internal retries stay** so a whole-review re-run is only for hard crashes; (7) the **schema is expanded**; (8) a **finalizer protocol**; (9) the **scheduler default is fixed** (in-app + advisory lock); (10) **duplicate posting is a bug to prevent**, not an acceptable outcome; (11) the **cutover is detailed**; (12) a **chaos test plan**. **v6** — adds the full **Implementation design** section closing the pre-build details: non-review workloads, the exact review-job shell contract, the activity retry wrapper, the in-flight LLM ledger protocol, cost-reservation reconciliation, fix-prompt/PR-description idempotency, workspace-cleanup ownership, the job state machine, explicit supersede checkpoints, scheduler table/overlap semantics, the outbox-sink migration, the operator API/UI minimum, and a 13th chaos case.
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

## Implementation design (v6 — closes the pre-build production details)

### 1. Non-review workloads (Temporal runs more than reviews)

`review_jobs` is the hot path; the other Temporal workflows get coarse homes too — **two coarse tables + the scheduler + the existing outbox**:

| Temporal workload | New home |
|---|---|
| outbox dispatcher | a plain Postgres **poller** (it is already a queue; drop the singleton-loop workflow) |
| reconcile / repair, sync_code_owners, refresh_semantic_docs, confluence sync, mark_stale_chunks, trigger_page_resync | **`core.background_jobs`** — one generic coarse table, same lease/attempts/fence/finalizer shape as `review_jobs`; each job = one whole workflow run, in-process |
| mutex-janitor, review-run reaper, retention (run_id / partition / workspace) | **scheduled** → the in-app scheduler emits a `background_jobs` row each tick |
| admin-triggered (embedder reembed/validate/gc; knowledge approval) | **admin-command rows** → `background_jobs` (§ Admin commands) |

So nothing is orphaned: `review_jobs` (hot review path) + `background_jobs` (everything else) share one runner skeleton; the outbox stays.

### 2. The review-job shell contract (exact stages)

The shell is the de-Temporalized `review_pull_request.workflow.ts` body; `orchestrate()` is called unchanged inside it.

```text
shell(run):
  gate = startReviewForWebhook(run)          # re-check tenancy + acquire PR mutex
  if not gate.accepted: finalize(skipped); return
  try:
    startMutexHeartbeat(gate.mutex_id)        # renew the mutex lease in the background
    placeholder = postPlaceholder(run)
    ws          = allocateWorkspace(run)      # per-attempt workspace
    emit ANALYSIS_STARTED
    result      = orchestrate(ctx)            # the 9-stage pipeline, REUSED
    runLifecycleBookkeeping(result)           # delivery_outcome flips (idempotent on rfid)
    emit ANALYZED
    finalizeRun(COMPLETED)
  except (Cancelled | Superseded): finalizeRun(CANCELLED)
  except err:                     finalizeRun(mapFailure(err))   # FAILED → re-enqueue or dead
  finally:                        runFinalizers(run)             # idempotent; see §8 v5
```

`mapFailure(err)` uses the de-Temporal `classifyFailure` seam; `runFinalizers` is the §"Finalizer protocol" set.

### 3. Activity retry wrapper

Temporal supplied per-activity retry; replace it with a shared `runWithRetry(policy, fn)`:
- reads the activity's `RETRY_POLICIES` entry (start-to-close timeout, `initialInterval`/`maximumInterval`/`backoffCoefficient`/`maximumAttempts`);
- retries on transient errors with exponential backoff; **does not** retry errors in `nonRetryableErrorTypes` (`BedrockBudgetExceededError`, `PrClosedError`, `StaleWriteError`, …);
- on exhaustion, throws the last error to the shell.

Activity-port calls become `runWithRetry(RETRY_POLICIES.x, () => activityX(input))`. This keeps transient failures cheap (local retry) so the whole-review re-run is reserved for hard crashes.

### 4. In-flight LLM ledger protocol

The ADR-0068 ledger is today a *completed-result* ledger. Extend it into a 2-phase in-flight coordinator — add `status (in_flight|completed|failed)`, `owner`, `lease_until`:
- **before** the provider call: `INSERT (status=in_flight, owner, lease) ON CONFLICT(idempotency_key) DO NOTHING RETURNING`; then, in one `SELECT … FOR UPDATE`: a `completed` row → **replay**; an `in_flight` row with a **live** lease → **block/await** (a concurrent invoker waits, not races); an `in_flight` row with an **expired** lease → **stale-owner recovery** (take over);
- **after** the call: `UPDATE → completed`, store result;
- **on failure**: `UPDATE → failed` (retryable per policy).

This closes the concurrent-double-spend window the v5 review flagged.

### 5. Cost-reservation reconciliation

Correlate the reservation to the ledger by a shared key. The reserve step writes `cost_reservations(reservation_id, idempotency_key, estimated_cents, state='reserved', created_at)` **in the same transaction** as the ledger `in_flight` insert; `recordCallCost` settles it by `reservation_id` (`reserved → settled` with the actual cost). The **reconcile job**: (a) `reserved` rows older than T with no `completed` ledger row → **release** (orphan from a crash); (b) `completed` ledger rows whose reservation is still `reserved` → **settle**. Reservations become correlatable and self-healing; `cost_daily` cannot drift unboundedly.

### 6. Fix-prompt & PR-description idempotency (deterministic keys)

GitHub has no native comment idempotency, so use a hidden marker keyed by `run_id`:
- **fix-prompt:** post with `<!-- codemaster:fix-prompt run_id=<run_id> -->`. On (re)post, list the PR's issue comments, find the marker; present → **PATCH (update)**, absent → **create**.
- **PR-description:** replace a fenced block `<!-- codemaster:summary -->…<!-- /codemaster:summary -->` in place (no re-append).

Same marker discipline the placeholder already uses; deterministic on `run_id`, so a re-run updates rather than duplicates.

### 7. Workspace cleanup ownership (pod-local)

Add `owner_pod` + `lease_until` to the workspace-lease row. Each pod runs a **local** workspace janitor that sweeps **only its own** `CODEMASTER_WORKSPACE_ROOT` for directories whose lease is released/expired **and** `owner_pod = self` — a pod never tries to delete another pod's `emptyDir`. A crashed pod's `emptyDir` dies with the pod (K8s reclaims it), so cross-pod orphans need no disk action; the reaper marks the dead pod's lease rows released so the run re-allocates a fresh per-attempt workspace on its next pod (it re-clones — acceptable for a coarse re-run).

### 8. Job state machine (precise)

```text
ready ──claim──▶ leased ──┬─ done       (terminal)
                          ├─ cancelled  (terminal)
                          └─ failed ──┬─ attempts < max ─▶ ready  (run_after = backoff)
                                      └─ attempts ≥ max ─▶ dead   (terminal)
```

- `failed` is a **transient** internal step: finalizers run, then the job returns to `ready` with a backoff `run_after` if attempts remain, else `dead`.
- Terminal = `done | cancelled | dead`.
- Mapping to `core.review_runs.lifecycle_state`: `leased`→`RUNNING` (or `WAITING_RETRY` between attempts), `done`→`COMPLETED`, `dead`→`FAILED`, `cancelled`→`CANCELLED`. (`PARTIAL` remains a `publication_outcome`, orthogonal.)

### 9. Supersede checkpoints (explicit, part of the contract)

An `assertStillCurrent(run)` helper (returns false if `current_run_id ≠ run.run_id` or the run is `CANCELLED`) is checked — abort-and-no-op on loss — at **five** points: **(a)** before start (the gate); **(b)** before the expensive LLM fan-out; **(c)** before persisting findings; **(d)** before posting the GitHub review; **(e)** before finalizing `done`. (a–d) reuse the existing in-`orchestrate()` claim-checks; (e) is new. These are a named part of the shell/orchestrator contract, not incidental.

### 10. Scheduler table & overlap semantics

- Config: a `schedules(schedule_id, cron, input, overlap_policy, enabled)` table (or static config to start).
- **Leader** = holder of a `pg_advisory_lock`; only the leader ticks.
- Each due tick `INSERT`s a `background_jobs` row with a **deterministic key** `schedule_id:<tick-window>` under a `UNIQUE` constraint ⇒ **overlap = skip** (a still-running prior tick's key collides → no-op); `replace`/`queue` by varying the key.
- **Missed ticks** (leader was down): on election, emit at most **one** catch-up tick per schedule — never backfill a storm.
- **Leader failover**: the advisory lock releases when the leader's session dies; another pod acquires it and resumes. The deterministic key prevents any double-tick during the handover.

### 11. Outbox sink migration (payload-level)

Today: `sink='temporal_workflow_start'` + `TemporalWorkflowStartPayloadV1`. Add `sink='review_job_enqueue'` + `ReviewJobEnqueuePayloadV1 (run_id, review_id, installation_id, repo_id, provider)` and bump `OUTBOX_PAYLOAD_SCHEMA_VERSION`. The **one** dispatcher branches on `sink`: `temporal_workflow_start` → Temporal `startWorkflow` (during rollout); `review_job_enqueue` → `INSERT INTO review_jobs`. The webhook writes one or the other by `target_engine`. Old and new rows coexist during rollout; once an install is fully on the runner and Temporal drained, only the new sink is written.

### 12. Operator API/UI minimum contract

Per-job read + controls, RBAC-gated, every action `audit.audit_events`-logged:
- **read:** state, attempts, `lease_owner`, heartbeat age, `run_id`, `last_error`, `dead_reason`/`cancel_reason`, finalizer status, timeline.
- **list/filter:** by state (running / stuck / dead), install, repo.
- **controls:** retry (`dead`→`ready`), cancel (→ supersede + finalizers), force-release (mutex/workspace) for a wedged job.

Lives in the admin frontend (the migration sub-project), reading the `review_jobs`/`background_jobs` tables.

### 13. Additional chaos case

Add to §"Required chaos test plan": **crash after `post_review` succeeds but before the delivery-lifecycle setters complete** → the re-run must **not** re-post (post idempotency) **and** must finish the lifecycle bookkeeping so no finding is left `delivery_outcome = NULL` (the exact stale-outcome class the current system guards).

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
