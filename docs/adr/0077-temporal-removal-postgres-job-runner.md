# ADR-0077: Temporal removal — decision, and the right way to do it

- Status: **Accepted for implementation *planning*; not yet Accepted for *build*** — the architecture direction is approved and unchanged. A final adversarial pass (v7) found 3 critical + 11 major flaws in v6's *implementation specifics* (not the architecture); these are corrected/registered in §"Implementation hazards & corrections (v7)". That register — not further ADR rounds — is the input to the implementation plan.
- Date: 2026-06-09
- **Recommendation:**
  - **Objection = operational weight** → **Stage 0**: Temporal on PostgreSQL-only persistence. ~zero code, ~zero risk.
  - **Objection = the Temporal dependency itself** → a **coarse-grained `review_jobs` runner** (one job = one whole review, executed in one process). Recommended at our scale. **DBOS** (a Postgres-only durable-execution *library*) is the alternative if fine-grained durable resume is wanted without owning runner code.
  - **Do NOT build a fine-grained, per-step job runner** (Appendix B).
- Revision: **v5** — closes the execution gaps from the v4 review. Specifically: (1) `orchestrate()` is reused *mostly* unchanged but needs a new non-Temporal **review-job shell**; (2) a small **cancellation/failure/metrics seam** to de-Temporalize `degradation.ts`/`posting.ts`; (3) **admin commands** (knowledge approve/reject, embedder cancel) replace `signalWorkflow`; (4) the **LLM-ledger guarantee is weakened** + a cost/ledger reconcile job; (5) the **post-tail side-effects** are enumerated with per-effect retry behavior; (6) **per-activity internal retries stay** so a whole-review re-run is only for hard crashes; (7) the **schema is expanded**; (8) a **finalizer protocol**; (9) the **scheduler default is fixed** (in-app + advisory lock); (10) **duplicate posting is a bug to prevent**, not an acceptable outcome; (11) the **cutover is detailed**; (12) a **chaos test plan**. **v6** — adds the full **Implementation design** section closing the pre-build details: non-review workloads, the exact review-job shell contract, the activity retry wrapper, the in-flight LLM ledger protocol, cost-reservation reconciliation, fix-prompt/PR-description idempotency, workspace-cleanup ownership, the job state machine, explicit supersede checkpoints, scheduler table/overlap semantics, the outbox-sink migration, the operator API/UI minimum, and a 13th chaos case. **v7** — a final Opus adversarial pass found that several v6 *implementation specifics* were unbuildable-as-written (the §4 `FOR UPDATE` ledger block, the §5 per-call cost reservation, the §2 background mutex-renew, the §13 lost-claim `comment_ids` collision, the §6 fix-prompt key); v7 corrects them and consolidates all 14 findings into an **Implementation hazards & corrections** register. The architecture is unchanged and converged; the register is the input to the implementation plan. **v8 (consolidation)** — resolves the v7-review's #1 (the corrections-vs-stale-body self-contradiction) with a top-of-doc **authority banner** + inline supersedes (cost-model, fix-prompt-key, delivery-setters row, the per-run uniqueness overclaim); folds the rest of the v7 review (#2–#11, all plan-content) into the **Implementation-plan required deliverables** checklist; and revises the effort to **~8–12 weeks**. No architecture change. The ADR is decision-complete; the next artifact is the plan, not a v9.
- Relates to: ADR-0066, ADR-0068 (LLM ledger — load-bearing), ADR-0074/0075/0076; `docs/architecture/temporal-workflow-integration.md`; spikes in `docs/adr/0077-spikes/`.

> ⚠ **AUTHORITATIVE-ORDER NOTE (read first).** Where any earlier section conflicts with §"Implementation hazards & corrections (v7)", **the v7 register is authoritative and supersedes the earlier text** — do not implement from the superseded passages. Specifically **superseded**: the §4 in-flight-ledger `FOR UPDATE`/"block-the-waiter" text (use poll-with-backoff, no held transaction), the §5 `cost_reservations(reservation_id …)` per-call model (use a compensating signed journal), the §6 fix-prompt `run_id` marker key (use `review_id` + a DB-fenced claim), and the side-effects table's "delivery setters safe (idempotent on rfid)" row (false on the lost-claim path). The implementation plan implements the v7 register, not the v4–v6 prose.

## Context

The decision hinges on one question: **is the objection Temporal's operational weight, or the dependency itself?** If the dependency must go, the **granularity** of the replacement matters more than "Postgres runner vs library": the three review passes (14 + 17 + 28 findings) showed a *fine-grained, per-step* runner is unbuildable-without-multi-quarter-pain, while a *coarse-grained* runner (the whole review as one in-process job) sidesteps the entire register.

**The decisive property: the bot is advisory** (comment-only; never blocks a merge — invariant 9). That lowers the **availability** bar (a missing or late review is tolerable) — but **not** the bar on *what gets posted*: a duplicate or superseded-review comment damages trust and is a **bug to prevent**, not a normal outcome (see §Correctness below).

What we already operate in Postgres: `core.outbox` (lease/attempts/dead-letter), `core.review_runs` (lifecycle + supersede + `current_run_id`), `audit.workflow_events`, the ADR-0068 ledger, `pr_review_mutex` + janitor/reaper. `orchestrate()` is a pure in-process async driver, unit-tested without Temporal.

## Decision

| Objection | Recommended path | Cost | Risk |
|---|---|---|---|
| operational weight | **Stage 0** (Temporal on Postgres-only) | an afternoon | ~none |
| the dependency itself | **Coarse-grained `review_jobs` runner** | **~8–12 weeks** (revised v8 — see Effort) | low–moderate |
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
-- at most one active job per RUN (this is per-run only; review-level ownership is via
-- pull_request_reviews.current_run_id + the PR mutex, NOT this index — do not overclaim):
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
| delivery-lifecycle setters | ⚠ **NOT safe on the lost-claim path** (superseded — see v7 §5/§13) | the lost-claim `PUT` returns `comment_ids=[]` → F9 guard blocks finalize → `delivery_outcome=NULL`; needs persisted `comment_ids` or a reconcile job |

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

**~8–12 weeks** (revised at v8). v4–v6's 3–6 week figure under-counted the work the v7 register exposed: the **cost-accounting redesign** (a compensating journal / per-reservation rows against the parity-critical spine enforcer — a sub-project with its own migration + parity tests, and a build-gating decision), the **in-flight LLM ledger mini-protocol** (polling/backoff/lease/takeover/heartbeat/retention), the review-job **shell**, the **retry wrapper** (timeouts + AbortSignal + subprocess kill), the **`background_jobs`** subsystem, the **scheduler** + dedicated runner process, the **cutover** (outbox sink + engine-pinning + redelivery), the **operator UI**, and the **chaos/parity harness**. Still the smallest No-Temporal option and no new dependency — but it is a multi-month core-loop program, not a few weeks. (Stage 0 remains an afternoon.)

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

## Implementation hazards & corrections (v7 — final adversarial pass)

A final Opus adversarial pass (4 lenses, code-verified) found **3 critical + 11 major** flaws — **all in v6's implementation *specifics*, none in the architecture.** The lesson: v6 specced several mechanisms in the abstract that don't match the *exact* existing code; some are **unbuildable as written.** Below: the corrections (superseding the wrong v6 statements), the hazards to resolve in the implementation plan, and the sections verified sound.

### Critical corrections — these v6 statements are wrong as written (superseded)

1. **§4 in-flight ledger "block/await (`FOR UPDATE`)" → SUPERSEDED.** A held `FOR UPDATE` releases the waiter only when the owner's transaction commits, i.e. the owner must hold a pinned pooled connection across the 40–90s Bedrock call. With pool max = 8 and `CHUNK_CONCURRENCY_DEFAULT = 4` per review, this re-creates the `TooManyConnectionsError` ADR-0062 exists to prevent. **Correct:** the `in_flight` INSERT is its own short *committed* transaction (connection released immediately); a losing invoker **polls** the row with bounded backoff (re-`SELECT`, no open transaction) until `status='completed'` (replay) or the lease has expired (takeover). The lease lives in `lease_until` vs DB `now()`, never in a held transaction. *No transaction is held across the provider call.*
2. **§4 stale-owner takeover must be fenced.** The ledger row needs an `attempt_token`; takeover is a conditional `UPDATE … SET owner=:me, lease_until=now()+ttl, attempt_token=:new WHERE idempotency_key=:k AND status='in_flight' AND lease_until<now() RETURNING` — only the row whose UPDATE returns becomes owner; the completion UPDATE carries the matching token so a stale owner's late write fences to 0 rows. Set the lease TTL **above** the worst-case provider wall-time (≈6 min for `reviewChunk` = 90s×4 + backoff) and heartbeat-renew it across the retry loop, so a slow-but-alive owner is never wrongly declared stale (which otherwise yields 2–3 paid calls for one chunk).
3. **§5 cost reserve/settle-by-`reservation_id` → SUPERSEDED.** The real model (`checkOrRaise`/`recordCallCost`) increments/diffs a **shared `telemetry.cost_daily` aggregate**; there is no per-call `reservation_id`, and "release" against an aggregate double-subtracts (can breach the `daily_total_cents >= 0` CHECK). **Correct:** a **compensating journal** — every reserve and every settle/release writes a *signed* per-call row `(call_id, ±cents, kind)`; the daily total is derived/checked from the journal; an orphan is healed by **appending a release row, never a blind subtract**. (Alternative: explicitly re-architect `checkOrRaise`/`recordCallCost` to per-reservation rows — a **Pattern-D** change against the parity-critical spine enforcer, with migration-safety + parity called out.) The reconcile window `T` must be **derived from `RETRY_POLICIES`** (`reviewChunk` ≈ 6 min) or gated on **lease-expiry** — never a fixed guess, which false-positive-releases live, still-retrying calls.
4. **§2 mutex renewal as a background timer → SUPERSEDED.** A background renewer can only log; it cannot interrupt the in-flight `await orchestrate()`. The real supersede-abort is a **synchronous inline claim-check that throws** (`abortIfClaimLost` → `PrMutexLostClaim` at `orchestrator.ts:360/442/656/849`, the last being the pre-post FIX-10 guard). **Correct:** thread the renewal as the synchronous `ctx.claimCheck` callback the Temporal body uses; any background renewer is **additive only**. Supersede defense is synchronous-abort at the checkpoints, not passive renewal.
5. **§13 13th case "must finish bookkeeping" + the side-effects table's "delivery setters safe (idempotent on rfid)" → SUPERSEDED.** A coarse re-run's `post_review` **loses** the `posted_reviews` claim and takes the lost-claim `PUT /reviews` (body-only) path, which returns `comment_ids=[]`; `runLifecycleBookkeeping`'s **F9 length guard** (`keptRfids.length !== commentIds.length` → N≠0) then refuses to finalize, and nothing heals it → the kept findings stay `delivery_outcome=NULL` **permanently** (Temporal's history-replay was masking this). **Correct:** persist `comment_ids` on `core.posted_reviews` at first post and return them on the lost-claim path (or `GET` the review comments to re-learn the ordered ids), **or** add a `delivery_outcome=NULL` reconcile job for findings under a fully-posted review. Drop the "safe (idempotent on rfid)" claim until one is specified.
6. **§6 fix-prompt idempotency → CORRECTED on three counts.** (a) The mechanism **does not exist** today (`generate_fix_prompt` calls `createIssueComment` *unconditionally*; no marker; no update path) — it is unscoped build work (marker render + `listIssueComments` + `updateIssueComment`). (b) Key the marker on **`review_id`** (the upsert key + the supersede-stable identity), **not `run_id`** — the contract carries `review_id`, and a supersede keeps `review_id` while minting a new `run_id`, so a `run_id` marker double-posts on every force-push. (c) The list-then-create is **TOCTOU** and the GitHub POST is **unfenced** (no supersede checkpoint brackets the tail POST; GitHub `GET` is eventually consistent) → fence the POST behind a DB claim `INSERT INTO fix_prompt_comments … ON CONFLICT(review_id) DO NOTHING` so only the winner POSTs (the list becomes a best-effort fast-path, not the correctness gate). *(Minor: §6 cites markers `<!-- codemaster:summary -->`; the PR-description code actually uses `codemaster-summary-start/end` — fix the doc text.)*

### Hazards to resolve in the implementation plan (not architecture changes)

- **§9 two-signal conflation:** keep the **mutex-lease check** (fail-open, liveness; the inline `ctx.claimCheck` at 360/442/656/849) and the **`current_run_id` stale-write guard** (fail-closed; at the `persistAggregated`/post durable-write boundaries) as **separate** signals — do not collapse them into one `assertStillCurrent` oracle; (e) is a `current_run_id` read under `FOR SHARE` + a CAS-guarded finalize.
- **§8 `mapFailure`:** must special-case `StateDrift(actual=CANCELLED)` and `StaleWriteError` as **terminal-cancelled** (run finalizers, never re-enqueue) — else the `transitionRun` CAS's benign throw on a superseded run becomes FAILED→re-enqueue→re-pay, and writing `failed_at` on a CANCELLED run violates `ck_review_runs_cancelled_at_state`.
- **Two-reaper race:** the new `review_jobs` lease-expiry healer and the existing `review_run_reaper` (keyed on `review_runs.started_at`, 3600s) have **opposite terminal intents on different tables** → thrash + repeated re-pay. Unify: one liveness clock (the job lease); disable the run-reaper for runs with a live `review_jobs` row; heal (re-enqueue + repoint the run row) in one transaction.
- **Runner process topology:** the dispatcher poller + the scheduler-leader loop run as a **dedicated always-on process** (the analogue of today's `outbox_dispatcher_main.ts`), **not** as `background_jobs` rows (circular — the loop that drains them can't be one of them). Idle waits use **`clock.sleep`** (the sanctioned seam), never `setInterval`/`setTimeout` (the `check_clock_random` ERROR gate). The poller may run on N pods (`SKIP LOCKED`); the scheduler-leader is single (`pg_advisory_lock`).
- **Interval-schedule dedup key:** 3 of the 7 cadences are **interval** (workspace-retention 5 min, confluence 6 h, mark-stale 24 h) with no wall-clock anchor, so `schedule_id:<tick-window>` is not pod-invariant → leader failover + clock skew can double-emit or **skip** a tick (a 24 h skip = a day with no sweep, no alert). Fix: convert the interval cadences to cron-equivalents, **or** anchor the window to **DB `now()`** read inside the leader's emit transaction; state the interval missed-tick rule.
- **Confluence coarse grain:** one whole-corpus `background_jobs` row **re-pays the entire Qwen embed cost** on a late crash (no per-activity durability across many spaces × pages) and risks the **F-40** soft-delete-safety invariant. Fix: scope the job to **one space per row** (fan the schedule into N rows — matching `review_jobs`' one-unit grain), **or** gate the embed on a `(page_id, version, content_hash)` pre-check so a re-run skips already-embedded pages; make "reconcile-deletions only on a *complete* page loop" an explicit checkpoint. *(Retention and admin-command mappings are sound under whole-job re-run — verified.)*
- **Chaos plan +2 cases:** (i) **supersede during fix-prompt** → no second fix-prompt comment; (ii) **crash after `post_review`, before delivery setters, on the lost-claim path** → `comment_ids` recovered and `delivery_outcome` set, never left NULL. (Total: 9 cases.)

### Verified sound (no change)

§3 retry wrapper (`RETRY_POLICIES` + `nonRetryableErrorTypes` exist as assumed); §6 PR-description strip-and-recompose (already idempotent); §8 job state machine; §11 outbox-sink migration (a clean extension of the existing `getSink` dispatch); the `post_review` / `post_check_run` / placeholder side-effect rows; the §4 idempotency-key derivation; and the retention + admin-command non-review mappings.

### Convergence

The **architecture is settled and unchanged across all eight revisions** — every finding since v3 has been an implementation specific, not architectural. **This ADR is decision-complete and now internally consistent** (the v8 authority banner + inline supersedes resolve the v7-corrections-vs-stale-body conflict). The right next artifact is the **implementation plan** — not a v9.

**Implementation-plan required deliverables** (the v7-review items, which are plan content, not more ADR design). The plan MUST specify, each with TDD + the 9-case chaos suite:

1. **Cost accounting — build-gating, decide first:** a signed per-call **compensating journal** (derive/check totals; heal an orphan by appending a release row) *or* explicit per-reservation rows — with migration + parity tests against `checkOrRaise`/`recordCallCost`. **Do not start the runner until this is designed.**
2. **In-flight LLM ledger mini-protocol:** polling backoff, max-wait, stale-owner takeover (fenced via `attempt_token`), heartbeat-renew across provider retries, failed-row retry, ledger-row retention/cleanup.
3. **Finalizer vs slow-but-alive worker:** stale worker fenced before any finalizer mutates DB; workspace deletion owner-pod/local-only with grace; every GitHub POST preceded by a synchronous claim/`current` check; finalizers idempotent + attempt-token-aware.
4. **`background_jobs` schema + execution contract:** job/idempotency key, installation/repo scope, state machine, payload schema version, retry policy, finalizer behavior, concurrency caps.
5. **Scheduler anchoring — pick one:** convert interval cadences to cron *or* anchor windows to DB `now()` in the emit transaction (not both).
6. **Admin-command contract:** command id, target type/id, actor/user id, requested state, idempotency key, audit record, `consumed_at`/`failed_at`, RBAC mapping.
7. **Retry wrapper beyond loops:** per-attempt timeout, `AbortSignal`, subprocess-kill, client/fetch timeout propagation, retryable-vs-terminal classification without Temporal error classes.
8. **Cutover/outbox detail:** `target_engine` on the row vs payload; old `TemporalWorkflowStartPayloadV1` rows keep dispatching; redelivery seeing a different target engine; pinning one run to one engine until terminal.
9. **Operator UI/API additions:** cost reservation/ledger state, finalizer attempts/errors, claim/checkpoint status, engine target, last-heartbeat, and a manual **"reconcile delivery outcome"** action for the lost-claim class.
10. **Two-reaper unification** (§v7 hazards) and the **§9 two-signal separation** (mutex-lease fail-open vs `current_run_id` fail-closed).

And it is all gated on the one open decision: **operational weight → Stage 0 (this plan is never written); the dependency itself → write this plan.**

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
