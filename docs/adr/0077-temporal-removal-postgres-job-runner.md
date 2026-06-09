# ADR-0077: Temporal removal — decision, and the right way to do it

- Status: **Proposed**
- Date: 2026-06-09
- **Recommendation (v4):**
  - **If the objection is operational weight** → **Stage 0**: run Temporal Server on PostgreSQL-only persistence. ~zero code, ~zero risk.
  - **If the objection is the Temporal dependency itself** → build a **coarse-grained `review_jobs` runner** (one job = one whole review, run in-process). This is the recommended No-Temporal path at our scale. **DBOS** (a Postgres-only durable-execution *library*) is the alternative if fine-grained durable resume is wanted without owning any runner code.
  - **Do NOT build a fine-grained, per-step job runner** (one job per clone/classify/chunk/aggregate). That design — the one the three review passes shredded — is preserved only as a cautionary appendix (Appendix B).
- Revision: **v4** — adds the coarse-vs-fine-grained distinction. v1–v3 evaluated only the *fine-grained* runner and (rightly) recommended against it; the catalog of failures was an indictment of **over-decomposition**, not of a Postgres runner per se. Because codemaster is an **internal, advisory** tool (the bot is comment-only and never blocks a merge — invariant 9), the reliability bar permits a far simpler **coarse-grained** runner that sidesteps the entire risk register.
- Relates to: ADR-0066, ADR-0068 (the LLM ledger — load-bearing here), ADR-0074/0075/0076; `docs/architecture/temporal-workflow-integration.md`; proof-of-concept spikes in `docs/adr/0077-spikes/`.

## Context

The team is evaluating whether codemaster-backend should stop depending on Temporal, motivated by the operational weight of self-hosting Temporal Server on on-prem OpenShift. **The decision hinges on one question: is the objection Temporal's operational weight, or the dependency itself?** And — the v4 insight — *if* the dependency must go, the granularity of the replacement matters more than the choice of "Postgres runner vs library."

What Temporal provides (a replacement must account for all): durable checkpointing; retries+backoff; timers; cancellation propagation; activity heartbeats; timeout handling; workflow-ID conflict policy; schedule durability; replay/versioning; per-attempt history + a Web UI; signals (unused here).

What we already operate in Postgres: `core.outbox` (lease/attempts/dead-letter), `core.review_runs` (lifecycle + supersede + `current_run_id`), `audit.workflow_events`, the ADR-0068 LLM ledger, the `pr_review_mutex` + janitor/reaper. The review pipeline’s `orchestrate()` is a **pure, in-process async driver** already callable without any Temporal context (its unit tests call it directly).

**The decisive property: the bot is advisory.** A failed, delayed, or duplicated review is a *missing or duplicate advisory comment*, never a blocked merge or data loss. That lowers the reliability bar enough that "simple + self-healing" beats "bulletproof + complex."

## Decision

| If the objection is… | Recommended path | Cost | Risk |
|---|---|---|---|
| **operational weight** | **Stage 0** — Temporal on Postgres-only persistence (drop Cassandra/ES) | an afternoon | ~none (no code change) |
| **the dependency itself** | **Coarse-grained `review_jobs` runner** (below) | ~3–5 weeks | low–moderate (small bespoke poller; reuses existing primitives) |
| the dependency itself, prefer not to own runner code | **DBOS** (Postgres-only durable-execution library) | ~6–9 weeks | moderate (maturity bet on a young library on the core loop) |
| — | **Fine-grained per-step runner** | multi-quarter | high — **do not build** (Appendix B) |

## The coarse-grained `review_jobs` runner (recommended, if No Temporal)

**One job = one whole review, executed in a single process.** Not one job per step.

### Model

```sql
CREATE TABLE core.review_jobs (
  job_id          uuid PRIMARY KEY,
  run_id          uuid NOT NULL,        -- the execution identity (FK core.review_runs.run_id)
  review_id       uuid NOT NULL,        -- the PR-review grouping (metadata)
  installation_id uuid NOT NULL,        -- tenancy + fairness dimension
  state           text NOT NULL DEFAULT 'ready',  -- ready | leased | done | failed | dead
  attempts        int  NOT NULL DEFAULT 0,
  max_attempts    int  NOT NULL DEFAULT 3,
  lease_owner     text,
  attempt_token   uuid,                 -- fencing: minted fresh on every claim
  leased_until    timestamptz,
  heartbeat_at    timestamptz,
  run_after       timestamptz NOT NULL DEFAULT now(),  -- retry backoff
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

A worker loop:

1. **Claim** the next review with `FOR UPDATE SKIP LOCKED`, set `lease_owner` + a fresh `attempt_token` + `leased_until` (DB `now()` is the sole lease clock).
2. **Run the existing `orchestrate()` unchanged, in this process** — clone → classify → chunk → fan-out chunk reviews (in-process `Promise.all`, exactly as today) → aggregate → post.
3. **Heartbeat** the lease while the review runs (extend under the full fence); a single per-review timeout bounds a stuck review.
4. **Finalize**: mark `done`/`failed`; on terminal failure past `max_attempts`, `dead`.
5. **Crash** → the lease expires → another worker re-claims (fresh `attempt_token`) and **re-runs the whole review from scratch.**

### Why the entire v1–v3 risk register vanishes

Every structural finding came from decomposing the review into independently-claimed per-step jobs. Keeping the whole review as one in-process job removes the root cause:

| Fine-grained failure (v1–v3) | Coarse-grained outcome |
|---|---|
| pod-local workspace: clone on pod A, classify on pod B finds an empty dir | one process holds the clone for the whole review ✅ |
| no home for shared `ReviewWorkflowState` | stays in memory, exactly like today ✅ |
| fan-in N=0 wedge; the ~11-stage tail collapsed into one step | it's all just code inside `orchestrate()`, not a job graph ✅ |
| §1 schema won't compile (unique index on a partitioned table) | no per-chunk rows, no partitioning gymnastics ✅ |
| per-chunk retrieval loses the query-vector cache / pinned generation | in-process cache preserved ✅ |
| `arbitrationNow` frozen-clock loss | a single in-process run; same as today ✅ |

### Reused primitives (this is "more of the same," not new infrastructure)

- **PR mutex** (`pr_review_mutex`) → already prevents two workers running the same PR's review; the claim-gate re-checks it.
- **Supersede + `current_run_id`** → a newer push allocates a new `review_jobs` row; the older review’s in-`orchestrate()` claim-checks abort before it posts (unchanged behavior).
- **LLM ledger (ADR-0068)** → a whole-review re-run **replays the expensive Bedrock calls instead of re-paying** — so a crash costs a re-clone + re-analysis (seconds), not real LLM spend.
- **Post idempotency** → the existing 2-phase atomic-claim + `comment_ids` invariant + stale-write guard already make re-posting safe.
- **Reaper / janitor** → already the model for "a wedged review gets re-run"; point it at `review_jobs`.
- **Outbox pattern** → the template for lease/attempts/dead-letter; `review_jobs` is the same shape.

### Crash & failure semantics (honest)

- **Whole-review re-run on crash** — coarse, not fine-grained resume. Acceptable because (a) crashes are rare, (b) the ledger memoizes the costly LLM calls, and (c) re-clone + re-analysis is cheap.
- **At-most-one running** per PR via the mutex; **fencing** (`attempt_token`) makes a stolen lease’s late write a no-op.
- **Double-post** is bounded by the post-step idempotency; worst case is a duplicate advisory comment, not corruption.
- **Cost-cap drift**: a crashed run can leave a small unreconciled cost reservation; bounded and healable by a periodic reconcile sweep (the daily cap is coarse).

### What you still build

A small, bounded surface: the leased `review_jobs` poller + heartbeat + reaper wiring; the schedules (an in-app scheduler with an advisory-lock leader, or `pg_cron` if the platform approves — **not** a new heavy component); minimal **per-review** operator views (far less than per-attempt history — list/inspect/retry/cancel a review, with action audit + RBAC); and the cutover/parity work shared by any option. The dispatch fork (Temporal vs `review_jobs`) is resolved once, inside the existing webhook transaction, by a `target_engine` on the outbox row — one dispatcher, no second path.

### Effort

**~3–5 weeks** — the smallest of the No-Temporal options. The runner core is small (a leased poller over a table you already have the pattern for), `orchestrate()` is reused verbatim in-process, and the heavy reliability primitives already exist. The bulk of the time is cutover/parity + the small operator UI + a soak.

## Why an advisory internal tool justifies "simple"

The reviewers’ failure modes are tolerable here precisely because the bot is comment-only:
- occasional **double-post** → cosmetic;
- occasional **wedge → reaper retry** → a slightly late comment;
- **whole-review re-run** → cheap (ledger replays the LLM spend).

None is data loss or an outage. This is the canonical case where right-sizing the reliability bar (and the design) beats importing a general-purpose engine.

## Why NOT the fine-grained per-step runner (the cautionary path)

Preserved in **Appendix B**. Three independent review passes (14 + 17 + a 28-finding Opus pass, several verified vs PostgreSQL 18.3 and live source) showed that decomposing the review into independently-claimed per-step jobs breaks five load-bearing properties and produces a schema that does not even compile, silent double-posts, deleted in-flight jobs, cost leaks, shadow contamination, and a multi-quarter scope. **Coarse-grained avoids all of it by not decomposing.** If anyone proposes per-step jobs "for fine-grained resume," the answer is: use DBOS (it provides that, hardened) rather than hand-rolling it.

## Alternatives considered

- **Stage 0 (Temporal on Postgres-only)** — recommended if the objection is operational weight; preserves the in-process model at ~zero cost.
- **Coarse-grained `review_jobs` runner (recommended if No Temporal)** — simplest, no new dependency, reuses `orchestrate()` + existing primitives.
- **DBOS** — Postgres-only durable-execution *library* (no server, no new pod); gives fine-grained durable resume + recovery + versioning without owning runner code; cost is a young framework on the core loop.
- **Fine-grained per-step runner** — **rejected** (Appendix B): the over-decomposed design the review passes shredded.
- **LangGraph** — a different *layer*: an agent/LLM-orchestration framework (great for making a step *agentic*), not a durable distributed-execution backbone. The library leaves you owning the reliability layer; its distributed story is a separate self-hosted server. Not a Temporal replacement; could compose *inside* a step if a review ever becomes agentic.
- **Restate / Hatchet** — a new server component (→ ADR); not preferred while Postgres-native options work.
- **BullMQ + Redis** — rejected (Redis excluded; a queue, not durable execution).

## Open question (the decision)

**Is the objection Temporal's operational weight, or the dependency itself?** Operational weight → **Stage 0**. The dependency itself → **the coarse-grained `review_jobs` runner** (recommended at our scale), or **DBOS** if fine-grained durable resume is wanted without owning runner code. In all cases, **avoid the fine-grained per-step runner.**

---

## Appendix A — proof-of-concept spikes (honest scope)

`docs/adr/0077-spikes/spike.mjs` (the engine) and `spike2.mjs` (fencing/heartbeat/idempotency under a forced lease-steal), runnable against a throwaway Postgres. **They prove** the toy engine mechanics in isolation (hand-off, fan-in for N≥1, lease-steal recovery, fencing, heartbeat, idempotency). **They do NOT prove** a concurrent in-flight paid provider call, multi-process workers, real clone/analysis durations, clock skew, the production pipeline’s shared state/workspace, or the N=0 base case. Note: for the **coarse-grained** design the spikes are largely moot — there is no per-step fan-in to fence; the unit of work is the whole review.

## Appendix B — the fine-grained per-step runner (DO NOT BUILD)

Retained as a cautionary record of the rejected design and the verified reasons. A fine-grained runner (one job per step) must close all of: a schema that compiles (no partitioned-table unique-index for fan-in; `run_id` PK; per-sink non-partitioned idempotency ledgers); DB-`now()` lease clock + fencing + fenced watchdog; the fan-in N=0 base case; persisted shared `ReviewWorkflowState`; pinned retrieval generation + a `run_logical_now` clock; **workspace locality (a new RWX infra dependency or sticky claims)**; the ~11-stage tail expanded with per-step idempotency; `post` decomposed into four idempotent GitHub sub-effects; unified reaper+supersede+fence terminal authority; guaranteed finalizers incl. cost-release; declared cross-tenant privileged claim path; a new high-churn per-attempt history store; and a cutover plan whose shadow mode does not contaminate `pr_id`-keyed `core.review_findings` nor double-spend Bedrock on prompt drift. Each is a sub-project; together they are the multi-quarter scope this ADR recommends against. **The coarse-grained runner exists specifically so none of this is necessary.**
