# ADR-0077: Temporal removal — a Postgres-backed durable job runner

- Status: **Proposed** (NOT yet Accepted — gated behind Stage 0 below and the open questions at the end)
- Date: 2026-06-09
- Revision: **v2** — incorporates the design review of 2026-06-09 (fencing, heartbeats, external-side-effect idempotency, supersede protocol, versioning, backpressure, Postgres-queue ops, shadow-mode parity, rollback, observability acceptance criteria, and the queue-substrate decision). Review findings are addressed inline and cross-referenced as `[R-n]`.
- Relates to: ADR-0066, ADR-0068 (LLM invocation ledger — load-bearing here), ADR-0074, ADR-0075, ADR-0076, and `docs/architecture/temporal-workflow-integration.md`

## Context

The team is evaluating whether codemaster-backend should **stop depending on Temporal**. The motivation is operational: Temporal Server is a self-hosted, multi-service stateful component on on-prem OpenShift, and the team would prefer to lean on the PostgreSQL it already runs. This ADR records the analysis, a recommended option, and an execution-grade design so the decision is made deliberately — and so we first rule out the cheap alternative.

### What Temporal actually provides `[R-2]`

The v1 of this ADR claimed the "single missing capability" is automatic checkpointing. That was too narrow. Temporal gives us — and a replacement must consciously account for — **all** of:

| Capability | Do we rebuild it? |
|---|---|
| durable step checkpointing (crash-resume) | **Yes** — the core of the runner |
| automatic per-step retries + backoff | Yes — but the outbox already does exactly this |
| timers / `sleep` | Yes — a `run_after` column (we use no long workflow timers today) |
| **cancellation propagation** | **Yes** — the supersede protocol §5 |
| **activity heartbeats** (long steps) | **Yes** — the heartbeat/lease protocol §3 |
| activity timeout handling | Yes — `timeout_at` + a watchdog |
| **workflow-ID conflict policy** | Yes — the dispatch/dedup rules (one webhook ⇒ one run) |
| schedule durability | Yes — `pg_cron` / a small scheduler |
| **replay / versioning** (`workflow.patched`) | **Yes** — explicit `workflow_version` / `step_version` §6 |
| history / audit | Mostly have it — `audit.workflow_events` + the jobs table |
| **query / debug tooling (Web UI)** | **Yes, and this is the biggest single loss** §10 |
| signal handling | **No** — we define no signals today |

So this is not "rebuild one thing." It is "rebuild a focused slice of a workflow engine, deliberately, and re-earn its operational guarantees."

### The load-bearing fact: most durable state is already in Postgres

Roughly **70% of what Temporal manages for the review pipeline already lives in our schema**: `core.outbox` (lease/attempts/dead-letter), `core.review_runs` (lifecycle state machine + supersede + `current_run_id`), `audit.workflow_events` (a history), the ADR-0068 LLM ledger (idempotency for paid calls), the `pr_review_mutex` leases + janitor/reaper. Every activity is already a single-input, typed, mostly-idempotent function. The one capability we wholly lack is durable step checkpointing.

### Measured footprint `[R-13]` (corrected)

- **16** files under `workflows/` (**14** workflows) · **53** files under `activities/` (**52** activities)
- **~50** files import `@temporalio` (**32** in `apps/backend/src` non-test, **14** in tests, ~4 elsewhere)
- **146** `proxyActivities` references across **25** files

| Disposition | What | ~LOC |
|---|---|---|
| Delete | temporal_port + real_temporal_client, data_converter, temporal_config, activity_proxy, gates.ts ledger, ensure_schedule, check_workflow_bundle, the workflow shells, the two-worker bootstrap, the temporal-helmchart, `@temporalio/*` | ~1.5–2k |
| Rewrite | `orchestrator.ts` (1,491), the review workflow body (~1,100), `parallelism.ts` (212), `activity_ports.ts` retry config (487), the bootstraps | ~3.5k |
| Reuse (light) | **`activities/` 12,956 LOC** (drop the wrapper), `build_activities` DI (1,020), degradation/state (470), outbox table+repo+sinks, run-state machine, supersede, mutex, contracts, clock/random seams | ~14k |
| New | the `core.workflow_jobs` runner, fencing/heartbeat/idempotency, supersede + versioning, backpressure, the shadow harness, the operator UI, migrations | ~2–3k |

## Decision

### Stage 0 — gate the whole effort on the actual objection (do first)

If the real complaint is **operational component count**, note that **Temporal Server runs on PostgreSQL-only persistence** (no Cassandra, no Elasticsearch) for moderate scale. That removes the heavy-datastore objection with **zero application-code change**, and stages 1–6 never happen. Evaluate this before funding a rewrite.

### Queue substrate: build `core.workflow_jobs`, do NOT layer on Graphile Worker `[R-1]`

v1 said "use Graphile Worker" while also defining custom `workflow_runs`/`jobs` — an ambiguity that would create two queue semantics, two retry systems, and unclear ownership. **Resolved: build our own `core.workflow_jobs` runner on `FOR UPDATE SKIP LOCKED`, and do not adopt Graphile Worker for the queue.** The runner needs *workflow-aware* semantics that do not map onto Graphile's generic job model — lease **fencing**, fan-in on the parent row, the four-point **supersede** check, **workflow/step/payload versioning**, **idempotency keys**, and **per-dimension backpressure**. Wrapping those around Graphile means fighting its retry/locking/scheduling. This is also the pattern we already operate (`core.outbox` is precisely a fenced Postgres queue). Time-based triggers use **`pg_cron`** (or a tiny in-app scheduler), not Graphile. One queue, one retry system, one owner.

### If Temporal must go — the model

- **`core.workflow_runs`** (parent): state + context only. No lease.
- **`core.workflow_jobs`** (children): one row per executable step. Lease, attempts, retry, dead-letter, **fencing**, **idempotency**, **versioning** live here.
- **workers** claim **job rows**, never the whole run.

A ~250-line spike (`dtemporal-spike/spike.mjs`) proves the engine; a second spike (`spike2.mjs`) proves the production failure modes below — fencing, heartbeat, and external-effect idempotency under a real lease-steal.

DBOS / Restate / Hatchet were considered and **rejected for the core loop** (a young framework, or a new server component, on the sacred loop, when we own every primitive). DBOS (Postgres-only library) is the documented fallback if the team prefers to *rent* durable execution rather than *own* it.

---

## Design (the sections the review required)

### 1. Job & run schema

```sql
CREATE TABLE core.workflow_runs (
  review_id        uuid PRIMARY KEY,
  workflow_version int  NOT NULL,                 -- §6 the runner version that owns this run
  state            text NOT NULL,                 -- pipeline stage (observability + supersede oracle)
  current          boolean NOT NULL DEFAULT true, -- false once superseded
  total_chunks     int,
  completed_chunks int  NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.workflow_jobs (
  id               bigint GENERATED ALWAYS AS IDENTITY,
  review_id        uuid NOT NULL,                 -- parent FK
  installation_id  uuid NOT NULL,                 -- tenancy + backpressure dimension
  step_type        text NOT NULL,                 -- clone|classify|chunk_and_redact|review_chunk|aggregate|post|…
  chunk_index      int,                            -- only for review_chunk
  state            text NOT NULL DEFAULT 'ready',  -- ready|leased|done|dead
  attempts         int  NOT NULL DEFAULT 0,
  max_attempts     int  NOT NULL DEFAULT 5,
  -- fencing §2
  lease_owner      text,
  attempt_token    uuid,                           -- minted fresh on EVERY claim; invalidates a stolen prior lease
  leased_until     timestamptz,
  heartbeat_at     timestamptz,                    -- §3
  timeout_at       timestamptz,                    -- per-step hard deadline §3
  run_after        timestamptz NOT NULL DEFAULT now(),  -- retry backoff / timers
  -- versioning §6
  step_version     int  NOT NULL,
  payload          jsonb NOT NULL,
  payload_schema_version int NOT NULL,
  -- idempotency §4
  idempotency_key  text,                           -- deterministic external-effect key for this step
  trace_context    jsonb,
  last_error       text,
  dead_reason      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)                     -- partitioned by created_at (range) for retention §9
) PARTITION BY RANGE (created_at);
```

Indexes: a partial **claim index** `WHERE state IN ('ready','leased')`; a singleton-step unique index (`review_id, step_type` where the step is singleton) and a per-chunk unique index (`review_id, chunk_index`) — the fan-in backstop; `(installation_id)` for backpressure; `(review_id)` for the operator timeline.

### 2. Job completion protocol — with fencing `[R-3]`

The claim mints a fresh `attempt_token`; a reclaimed (lease-expired) job gets a **new** token, which is exactly what invalidates the previous owner. Completion is gated on the full fence and committed atomically with the next-step writes:

```sql
-- inside ONE transaction:
UPDATE core.workflow_jobs SET state='done'
  WHERE id = $job AND state='leased' AND lease_owner = $me AND attempt_token = $token;
-- if rowcount <> 1  → ROLLBACK and abort (our lease was stolen; another worker owns it)
-- else → fan-in / enqueue-next writes, then COMMIT
```

Fan-in increments the parent counter under its row lock, so exactly one transaction observes `completed == total` and creates the single `aggregate` job (unique index as backstop). **Proven in `spike2.mjs`:** under a forced lease-steal, the late worker's completion affected 0 rows and was discarded — `completed_chunks` stayed exact (4/4) and exactly one aggregate job was created.

### 3. Lease, heartbeat & timeout protocol `[R-4]`

Lease expiry alone duplicates work for legitimately-long steps (clone, static analysis, LLM, GitHub post). Therefore:

- **Heartbeat loop:** a worker running a long step extends its lease every `heartbeat_interval` via `UPDATE … SET leased_until = now()+lease WHERE id AND lease_owner AND attempt_token AND state='leased'`. If that returns 0 rows the worker **lost the lease** and must cooperatively abort (don't commit, don't post).
- **Per-step timeout:** `timeout_at` is a hard ceiling; a watchdog fails a job past it. Heartbeat keeps a *healthy* long step alive; `timeout_at` kills a *stuck* one.
- **Cooperative abort:** the step body checks an abort signal (heartbeat-loss or shutdown) at each safe point.

**Proven in `spike2.mjs`:** the heartbeated long step was never stolen (ran once); the non-heartbeated long step was stolen and recovered safely.

### 4. External side-effect idempotency protocol `[R-5]`

A DB transaction cannot contain Bedrock / GitHub / Vault / git. Rules:

- **LLM (Bedrock):** keyed through the **ADR-0068 invocation ledger** by a deterministic request id minted *before* the provider call; a retried step finds the ledger row and reuses the result (no double spend).
- **GitHub comments / check-runs:** deterministic external idempotency keys (we already do 2-phase atomic-claim posting with the `comment_ids` invariant + stale-write guard); a re-run reuses/updates rather than re-creates.
- **Post-review step is idempotent across retry** by construction.
- **Crash after external call, before DB commit:** the step does the effect *through* the ledger keyed by `idempotency_key`, then commits. On resume, the same key suppresses the duplicate effect; the fence discards the stale completion.

**Proven in `spike2.mjs`:** a chunk body that executed on two workers produced exactly one external effect (the second was suppressed on the idempotency key).

### 5. Supersede / cancellation protocol `[R-6]`

"Check the parent before each job" is insufficient. A long job re-checks `workflow_runs.current = true` (and that `current_run_id` still points at this run) at **four** points: (a) before starting, (b) before any external side effect, (c) before committing output, (d) before enqueueing the next step. A newer commit's webhook flips `current=false` (the existing `supersedeRun`), so a superseded run's jobs no-op before they can post. Fencing is the second line of defense; the `current` check is the first.

### 6. Workflow & payload versioning `[R-7]`

`workflow.patched()` goes away, so pending jobs must survive deploys. Every job carries `workflow_version`, `step_version`, and `payload_schema_version`. A worker only claims jobs whose versions it understands; jobs from a newer version are **parked** (not failed) until the matching worker rolls out; payload migrations are explicit, versioned transforms. A new breaking step shape is a new `step_version`, retired over the three-deploy lifecycle (the discipline ADR-0047 / the patched-lifecycle used).

### 7. Worker shutdown behavior

On `SIGTERM`: stop claiming new jobs; signal in-flight steps to reach a safe checkpoint; either finish quickly or release the lease (so another worker resumes immediately rather than waiting for expiry); exit within a drain deadline. Heartbeat-loss and shutdown share the one cooperative-abort path.

### 8. Backpressure & concurrency model `[R-9]`

Cost-caps alone are insufficient. Explicit caps enforced at claim time (via partial-index claim filters + per-dimension running-counts / advisory locks):

- per **step_type** (cap concurrent `clone` and `review_chunk` separately)
- per **installation** and per **repository** (fairness; no single org starves others)
- per **LLM provider/model** (provider concurrency / TPM limits)
- **GitHub API rate-limit** budget per installation
- **DB pool** pressure (claimers back off when the pool is saturated)
- **workspace disk** pressure (gate `clone`/`allocate_workspace` when disk is low)

### 9. Postgres-as-queue operations `[R-10]`

A high-churn jobs table is itself a production risk. Required: **partition `workflow_jobs` by `created_at`** with scheduled detach/drop of old partitions (retention) — `done`/`dead` rows never accumulate unbounded; aggressive **autovacuum** on the hot partition; the **partial claim index** to keep claims cheap; mitigate **lock contention on the fan-in counter** (the parent row is a hot lock for wide fan-outs — shard the counter or cap fan-out width); if `LISTEN/NOTIFY` is used for wakeups, treat it as an optimization with **fallback polling** (NOTIFY can be lost); **alerts** on queue depth by step, lease age (stuck jobs), and dead-letter rate.

### 10. Observability / debugging UI — acceptance criteria `[R-8]`

Losing the free Temporal Web UI is the biggest operational cost; the replacement is a **hard deliverable**, not "an admin frontend idea." Minimum, per review: **job timeline per review**, **current blocking job**, **retry history**, **dead-letter reason**, **queue depth by step**, **lease age / stuck jobs**, and **manual retry / cancel / supersede controls**. Natural home: the admin frontend. This gates the PR-pipeline cutover (Stage 5).

### 11. Shadow-mode parity plan `[R-11]`

Side-by-side must be **shadow mode**, never dual-posting: **exactly one engine may post to GitHub** (check-runs/comments); the shadow runner compares **pre-post artifacts** (findings set, walkthrough, fix-prompt) against Temporal's; **LLM calls in shadow use cassettes or the shared ledger** (no double spend); all other external effects are **disabled or redirected** for shadow runs. Parity oracle: for the same PR, identical findings/comments/outcome.

### 12. Rollback & cutover plan `[R-12]`

"Drain, don't migrate" is correct (reviews are ephemeral, ≤30 min — we never migrate live histories) but needs: a **dispatch flag by installation/repo** routing each webhook to exactly one engine (so **both engines never claim the same webhook**); a **kill switch back to Temporal**; **GitHub redelivery handling** during cutover (idempotency keys make redelivery safe); **detect in-flight Temporal workflows before disabling that worker** (drain check). At cutover, in-flight reviews finish on Temporal; new PRs route to the runner.

---

## Production checklist — foundation vs new

| Concern | Foundation | New |
|---|---|---|
| supersede / cancel | **Strong** (`supersedeRun`, `current_run_id`, claim-check) | the 4-point protocol §5 |
| retry → dead-letter | **Strong** (outbox) | generalize onto jobs |
| LLM idempotency | **Strong** (ADR-0068 ledger) | reuse |
| GitHub idempotency | **Medium** (2-phase post + invariant) | idempotent post step §4 |
| per-step timeout | **Strong (data)** (RETRY_POLICIES) | watchdog §3 |
| stuck-job janitor | **Strong** (janitor/reaper) | tune/alert |
| manual retry | **Medium** (admin API exists) | one endpoint + UI §10 |
| migration | **Easy** (ephemeral) | drain + rollback §12 |
| fencing | none | §2 — **proven** in spike2 |
| heartbeat / long-step | **Medium** (clone heartbeats in Temporal today) | §3 — **proven** in spike2 |
| backpressure | Medium (cost-caps) | §8 |
| **observability UI** | **Weak — biggest loss** | §10 (hard deliverable) |
| **parity testing** | Medium (smoke/cassettes) | §11 shadow harness |
| versioning | none (was `patched()`) | §6 |

## Staged migration (risk last)

0. **Decision gate** — Temporal-on-Postgres-only. If it satisfies the goal, stop.
1. Build `core.workflow_runs` + `core.workflow_jobs` runner (fencing, heartbeat, timeout, idempotency, versioning, shutdown) behind tests.
2. Move simple scheduled jobs (janitor/reaper/retention/partition) to `pg_cron` + the runner.
3. Move the outbox dispatcher to a plain poller.
4. Move simple event workflows (reconcile/repair/sync/refresh).
5. Move the PR review pipeline last — spine, fan-out/fan-in, supersede, **observability UI**.
6. **Shadow-mode** the runner against Temporal until parity; then **cutover by installation/repo with a kill switch**.

## Consequences

**Effort `[R-14]`:** **5–8 weeks to a first production candidate**; **8–12 weeks for confidence equivalent to Temporal** (observability UI, shadow parity, versioning, backpressure, ops hardening); **longer calendar** if one engineer owns implementation *and* validation. The hard, genuinely-new work is fencing/heartbeat/idempotency (now proven), the operator UI, shadow parity, versioning, and backpressure — not the durability basics, most of which we already own.

**Gain:** delete the workflow sandbox, payload converter, replay-determinism gates *as workflow constraints*, `workflow.patched()`, the bundle gate, the two-worker split, and the temporal-helmchart. Activities become plain functions; the spine becomes a queryable state machine; one less component to operate.

**Lose:** free durable replay, free per-step retry/timer ergonomics, the battle-tested-at-scale guarantee, and the **free Web UI**. We take on fencing, idempotency, versioning, backpressure, and operator tooling ourselves.

**Reversibility:** low once the PR pipeline cuts over — hence Stage 0, shadow mode, and the kill switch are mandatory.

## Alternatives considered

- **Temporal-on-Postgres-only (Option 0)** — near-zero cost; correct if the objection is operational weight. *Evaluate first.*
- **`core.workflow_jobs` runner (chosen if Temporal must go)** — owns workflow-aware semantics on the Postgres we run; one queue, one retry, one owner.
- **DBOS** — Postgres-only durable-execution library; lowest churn; documented fallback (own-vs-rent / core-loop-maturity call).
- **Graphile Worker as the queue** — **rejected** `[R-1]`: its generic model can't carry fencing/fan-in/supersede/versioning without two-systems drift. (Considered for cron only; `pg_cron` preferred.)
- **Restate / Hatchet** — new component (→ ADR); not preferred while Postgres-native works.
- **BullMQ + Redis** — rejected: Redis is excluded; BullMQ is a queue, not durable execution.

## Open questions (to reach Accepted)

1. Is the objection operational weight (→ Option 0 ends it) or the Temporal dependency itself (→ proceed)?
2. Sign-off to fund the operator/debugging UI (§10) as a gating deliverable.
3. Acceptance of shadow-mode parity (§11) + the install/repo kill-switch cutover (§12) as the criteria.
4. Confirm the queue-substrate decision (build `core.workflow_jobs`; `pg_cron` for schedules; no Graphile) `[R-1]`.
5. Accept the revised estimate (5–8 weeks to candidate; 8–12 to Temporal-equivalent confidence).
