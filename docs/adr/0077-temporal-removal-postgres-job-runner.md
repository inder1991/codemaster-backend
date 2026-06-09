# ADR-0077: Temporal removal — a Postgres-backed durable job runner

- Status: **Proposed** (decision deferred behind the Stage-0 gate below; this ADR records the analysis, the recommended option, and the staged plan so the decision can be made deliberately)
- Date: 2026-06-09
- Relates to: ADR-0066 (Temporal TS workflow bundle / crypto boundary), ADR-0074 (Temporal schedule-bootstrap seam), ADR-0075 (Confluence ingest port), ADR-0076 (Helm chart — bundles the Temporal workers), and `docs/architecture/temporal-workflow-integration.md` (the end-to-end map of what would be replaced)

## Context

The team has raised whether codemaster-backend should **stop depending on Temporal**. The motivation is operational: Temporal Server is a self-hosted, multi-service stateful component on on-prem OpenShift, and the team would prefer to lean on the PostgreSQL it already runs rather than operate another heavy component. This ADR exists so that if we act, we act on a measured picture rather than a reflex — and so we first rule out the cheap alternative.

### What Temporal actually does here

Per the architecture map (`docs/architecture/temporal-workflow-integration.md`), Temporal's footprint splits into three tiers of difficulty:

| Tier | Workload | Difficulty to de-Temporalize |
|---|---|---|
| Trivial | the **outbox dispatcher** (`OutboxDispatcherWorkflow`) | it is already a Postgres queue (`core.outbox`); the workflow is just a drain loop |
| Easy | the **crons** (mutex-janitor, reaper, retention, confluence sync, partition maintenance) + **reconcile/repair** | scheduled jobs + single-activity pass-throughs |
| **Hard** | the **review pipeline** (`reviewPullRequest` → `orchestrate()` 9-stage spine) | genuine durable orchestration: multi-step, per-step retries, fan-out (N parallel chunk reviews) + fan-in, timers, cancellation/supersede, crash-resume |

Only the review pipeline genuinely exercises a workflow engine.

### The load-bearing fact: most durable state is already in Postgres

Roughly **70% of what Temporal manages for the review pipeline is already persisted in our own schema**:

- `core.outbox` — a transactional queue with lease / attempts / dead-letter (`OUTBOX_MAX_ATTEMPTS=5`).
- `core.review_runs` — a lifecycle state machine (`PENDING → RUNNING → WAITING_RETRY → COMPLETED/FAILED/CANCELLED/PARTIAL`) plus `supersede` and a `current_run_id` pointer.
- `audit.workflow_events` — a per-run event log (effectively a history).
- the LLM invocation **ledger** (ADR-0068) — idempotency for the expensive Bedrock calls.
- `pr_review_mutex` leases + the mutex-janitor / reaper liveness backstops.
- every activity is already a single-input, typed, mostly-idempotent function.

The single capability Temporal provides that we do **not** already have is **automatic step-by-step checkpointing** — "write the pipeline as straight-line code and the engine resumes it exactly after a crash." Replacing Temporal means rebuilding that one thing.

### Measured footprint (what a removal touches)

| Disposition | What | ~LOC |
|---|---|---|
| **Delete** (pure Temporal scaffolding) | `adapters/temporal_port` + `real_temporal_client` (210), `data_converter` (83), `temporal_config` (80), `workflows/activity_proxy` (307), `review/pipeline/gates.ts` collapsed-gate ledger (275), `ensure_schedule` (164), `check_workflow_bundle` gate, the cron/dispatcher workflow shells, the two-worker bootstrap, the **temporal-helmchart** repo, `@temporalio/*` deps | ~1.5–2k deleted |
| **Rewrite** (logic kept, re-expressed) | `review/pipeline/orchestrator.ts` (1,491), the review workflow body (~1,100), `parallelism.ts` fan-out (212), `activity_ports.ts` retry config (487), the worker bootstraps → a Graphile bootstrap | ~3.5k reworked |
| **Reuse** (light touch) | **`activities/` — 12,956 LOC / 52 files** (drop the Temporal wrapper; bodies unchanged), `build_activities` DI (1,020), `degradation`/`state` (470), the outbox table+repo+sinks, the run-state machine, supersede, mutex leases, contracts, the clock/randomness seams | ~14k survives |
| **New** | the durable step-runner, the race-safe fan-in, Graphile Worker + cron setup, migrations (`current_step`/jobs table), and the crash/parity test suites | ~1.2–1.8k new |

Scope signals: **32 files import `@temporalio`**, **122 `proxyActivities` call sites**, **14 workflows**, **52 activities**. Net LOC likely *shrinks*, but the churn concentrates on the most critical path.

## Decision

The recommendation has two parts; the second is conditional on the first.

### Stage 0 — gate the whole effort on the actual objection (do this first)

If the real complaint is **operational component count** ("Temporal Server is too many moving parts to run"), then note that **Temporal Server runs on PostgreSQL-only persistence** — no Cassandra, no Elasticsearch — for moderate scale. That removes the heavy-datastore objection with **zero application code change**, and stages 1–6 below never happen. This must be evaluated before any rewrite is funded, because it may fully satisfy the goal at near-zero cost, immediately after we just finished the Temporal port.

### If Temporal must go entirely — adopt a Postgres-backed durable job runner

Build the orchestration on the PostgreSQL we already operate, using the patterns we already run, with **Graphile Worker** (Postgres `LISTEN/NOTIFY` + a jobs table; no Redis) as the queue/cron substrate. The model:

- **`workflow_runs`** (parent): state + context only — `review_id`, `state`, `total_chunks`, `completed_chunks`, the current-run pointer. **No lease lives on the parent.**
- **`jobs`** (children): one row per executable step. **Lease, attempts, retry, dead-letter live here.**
- **workers**: backend processes that claim **job rows** (never the whole review), one step at a time.

```
PR webhook → create workflow_run + first job (clone)
worker claims clone job → runs → in ONE txn: mark clone done + enqueue classify
… classify → chunk_and_redact → (fans out N review_chunk jobs)
review_chunk jobs → claimed by different workers in parallel
  each finish → completed_chunks += 1 (atomic)
  whoever takes completed_chunks → total_chunks creates the single aggregate job
aggregate → REVIEW COMPLETE
```

Claiming **jobs, not the parent**, is what makes retries, crash recovery, and parallel chunk review work without blocking the whole review.

Four correctness properties the runner must hold:

1. **Atomic hand-off** — "mark step N done" and "enqueue step N+1" commit in one transaction (no lost step, no double-enqueue on retry).
2. **Race-safe fan-in** — the chunk counter increments under the parent's row lock, so exactly one transaction observes `completed == total` and creates the single aggregate job (with a unique index as a belt-and-suspenders backstop).
3. **Crash recovery via lease expiry** — a worker that dies mid-step leaves the job leased; the lease expires and another worker reclaims and resumes from the last completed step.
4. **Parallelism by job-level claiming** — `FOR UPDATE SKIP LOCKED` guarantees two workers never grab the same job.

A ~250-line proof-of-concept (`/Users/ascoe/Projects/dtemporal-spike/spike.mjs`, run against the disposable PG) demonstrates all four against the real pipeline shape (clone → classify → chunk → parallel review_chunk → aggregate), including an injected hard crash recovered automatically and a 6-chunk fan-in producing exactly one aggregate job. **The spike proves the engine, not the production workflow** (see "What the spike does NOT prove" below).

### Rejected for the core loop: a different execution engine

DBOS (durable execution as a Postgres library, in-process), Restate, and Hatchet were considered. They are rejected for the review pipeline because invariant 1 ("protect the core loop") and "no new spine dependency without ADR" make putting a young framework — or a new server component — in charge of the sacred loop a poor trade when we already own every primitive needed. DBOS is the closest call (Postgres-only, no server) and remains the fallback if the team would rather *rent* durable execution than *own* it; this ADR records it as the documented runner-up.

## What the spike does NOT prove — the production checklist

The runner is the easy-to-prove core. The production workflow is the real work and the real risk. Of the twelve concerns below, **about half already have strong foundations from the Temporal build** — they are not green-field:

| Concern | Foundation already in codemaster | Genuinely new work |
|---|---|---|
| cancellation / supersede | **Strong** — `supersedeRun()`, `lifecycle_state=CANCELLED`, `current_run_id`, the claim-check | check "parent is still current" before each job runs |
| retry → dead-letter | **Strong** — the outbox *is* this | generalize onto the jobs table |
| idempotency for paid LLM calls | **Strong** — ADR-0068 ledger | reuse as-is |
| idempotency for GitHub comments / check-runs | **Medium** — 2-phase atomic-claim post + `comment_ids` invariant + stale-write guard | make the post *step* idempotent on job re-run |
| per-step timeout policies | **Strong (data)** — the `RETRY_POLICIES` table | a watchdog that fails a job exceeding its timeout |
| stuck-job janitor | **Strong** — mutex-janitor + reaper; lease-expiry reclaim | tune + alert |
| manual retry from admin/API | **Medium** — admin API surface exists | one endpoint: `dead` job → `ready` |
| migration from Temporal state | **Easy by nature** — reviews are ephemeral (≤30 min) | **drain, don't migrate** (below) |
| worker shutdown (graceful drain) | Weak | stop-claiming flag + release leases on SIGTERM |
| backpressure / concurrency limits | Medium — cost-caps exist; the claim self-limits | explicit per-step concurrency caps |
| **observability / debugging UI** | **Weak — the biggest single loss** | Temporal's Web UI was free; "why is review X stuck / why did it fail" is real new work (could live in the admin frontend) |
| **parity tests vs Temporal** | Medium — smoke harness + cassettes exist | a side-by-side diff harness |

The residual risk therefore concentrates in **observability/debugging UI**, **parity testing**, **backpressure**, and **graceful shutdown** — not in the "scary" durability concerns, most of which we already solved for Temporal.

## Staged migration plan (risk moved last)

0. **Decision gate** — evaluate Temporal-on-Postgres-only. If it satisfies the goal, stop here.
1. **Build the `workflow_runs` + `jobs` runner** (productionise the spike: atomic hand-off, race-safe fan-in, lease/retry/dead-letter, timeout watchdog, graceful drain) behind tests.
2. **Move the simple scheduled jobs** (janitor, reaper, retention, partition maintenance) to Graphile cron.
3. **Move the outbox dispatcher** to a plain Postgres poller (it is already a Postgres queue).
4. **Move the simple event workflows** (reconcile / repair / sync / refresh) — single-step, low risk.
5. **Move the PR review pipeline last** — the 9-stage spine, fan-out/fan-in, supersede, observability.
6. **Run Temporal and the Postgres runner side-by-side** until behavior matches: for the same PR, the runner must post the same findings/comments/outcome. The parity harness asserts this.

**Migration is cheaper than the usual nightmare because reviews are ephemeral.** We do **not** migrate live workflow histories; at cutover we let in-flight reviews finish on Temporal and cut *new* PRs to the runner (`workflow.patched`-style fork on the dispatch path, or a flag). "Drain, don't migrate."

## Consequences

**Effort:** ~5–8 focused engineering-weeks for one strong engineer (≈3–4 for two), with the review-pipeline runner + the new production surface above being ~70% of it. Calendar time is longer because this is the core loop: it needs the side-by-side soak and the smoke-runbook gate.

**What we gain.** A large amount of Temporal-specific machinery is deleted: the V8 workflow sandbox, the wire-clean payload converter, the `no-Date.now`/randomness gates *as a replay constraint on workflows*, `workflow.patched()` versioning, the bundle-purity gate, the two-worker split, and the temporal-helmchart. Activities become plain async functions; the review spine becomes a normal function with explicit, queryable checkpoints. Fewer components to operate; simpler mental model; everything inspectable with `SELECT`.

**What we lose.** Automatic durable replay and per-step retries/timers "for free"; the battle-tested-at-scale guarantee; and — most underrated — **the free Temporal Web UI** for operators. We take on hand-rolled crash-resume/idempotency (partly already built) and must rebuild operator observability.

**Reversibility.** Low once the PR pipeline is cut over (you would not casually re-introduce Temporal). This is why Stage 0 and the side-by-side soak are mandatory, and why the cheap alternative must be ruled out first.

## Alternatives considered

- **Temporal-on-Postgres-only (Option 0)** — keep Temporal, drop Cassandra/ES. Near-zero cost; the right answer if the objection is operational weight. *Must be evaluated first.*
- **Postgres-backed job runner + Graphile Worker (chosen, if Temporal must go)** — owns the mechanism on the Postgres we run; reuses our outbox/run-state primitives; aligns with invariants 1–2 and "Postgres covers everything."
- **DBOS** — durable execution as a Postgres library, no server; lowest migration churn (workflows stay near straight-line). Rejected as primary only on core-loop maturity/own-vs-rent grounds; documented fallback.
- **Restate / Hatchet** — lighter than Temporal but still a new component (→ ADR + whitelist). Not preferred while Postgres-native options exist.
- **BullMQ + Redis** — rejected: Redis is on the excluded list (needs its own ADR), and BullMQ is a queue, not durable execution.

## Open questions (what would move this to Accepted)

1. Is the real objection operational weight (→ Option 0 ends it) or the Temporal dependency itself (→ proceed)?
2. Sign-off on losing the Temporal Web UI and funding an operator/debugging view (likely in the admin frontend).
3. Acceptance of the staged plan + the side-by-side parity gate as the cutover criterion for the PR pipeline.
4. ADR for Graphile Worker as a new spine dependency (per "no new spine dependency without ADR").
