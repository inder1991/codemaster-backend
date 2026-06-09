# ADR-0077: Temporal removal — decision and the Postgres-runner option

- Status: **Proposed**
- Date: 2026-06-09
- **Recommendation (v3): adopt _Stage 0_ — run Temporal Server on PostgreSQL-only persistence — and do NOT undertake the full Postgres job-runner rewrite, UNLESS the team decides the Temporal _dependency itself_ (not merely its operational weight) must go.** The full runner is a multi-quarter rewrite of the sacred core loop carrying the unresolved-risk register in Appendix B; the evidence below is why it is documented but not recommended.
- Revision: **v3** — re-frames the decision after three adversarial review passes. v1 (design review) raised 14 findings; a second human review raised 17; an Opus-4.8 6-lens adversarial pass raised ~28 more, several empirically verified against PostgreSQL 18.3 and the live codebase. The cumulative finding is structural (below), not a punch-list — so v3 leads with the decision and demotes the runner design to Appendix B.
- Relates to: ADR-0066, ADR-0068 (LLM invocation ledger — load-bearing here), ADR-0074, ADR-0075, ADR-0076; `docs/architecture/temporal-workflow-integration.md` (the map of what would be replaced); proof-of-concept spikes in `docs/adr/0077-spikes/` (scope in Appendix A).

## Context

The team is evaluating whether codemaster-backend should **stop depending on Temporal**, motivated by the operational weight of self-hosting Temporal Server (a multi-service stateful component) on on-prem OpenShift. This ADR records the analysis and a recommendation.

**The decision hinges on one question:** *is the objection Temporal's operational weight, or the Temporal dependency itself?*

- **Operational weight** → Stage 0 solves it at ~zero cost (below). Recommended.
- **The dependency itself** → the full Postgres runner (Appendix B), a multi-quarter core-loop rewrite. Only undertake with eyes open to the risk register.

### What Temporal actually provides

A replacement must consciously account for all of: durable step checkpointing (crash-resume); per-step retries+backoff; timers; **cancellation propagation**; **activity heartbeats**; activity timeout handling; workflow-ID conflict policy; schedule durability; **replay/versioning** (`workflow.patched`); per-attempt **history + a Web UI**; and signal handling. We use no signals today, but everything else is in active use.

### The load-bearing fact, restated honestly

~70% of the review pipeline's durable *data* already lives in Postgres (`core.outbox`, `core.review_runs` + supersede, `audit.workflow_events`, the ADR-0068 ledger, mutex leases). But the adversarial passes showed that the **execution model** — not just the data — is load-bearing: the review is **one in-process stateful durable execution**, and several correctness properties exist *only* because of that (next section). The "70% already in Postgres" figure understated the rewrite because it counted data, not the in-process execution semantics.

## Decision

1. **Recommended — Stage 0: run Temporal Server on PostgreSQL-only persistence** (no Cassandra, no Elasticsearch). Zero application-code change; removes the heavy-datastore/component objection; **preserves the in-process durable-execution model the pipeline silently depends on.** If the objection is operational weight, this is the answer, and stages below never happen.

2. **Not recommended — the full `core.workflow_jobs` runner (Appendix B).** Undertake only if the team decides the Temporal dependency itself must go. It is a multi-quarter rewrite of the sacred core loop (invariant 1) that must first close the unresolved-risk register in Appendix B. The proof-of-concept spikes (Appendix A) validate the *toy engine* in isolation; they do **not** validate the production workflow, and the gaps below show why that distinction is decisive.

3. **Documented fallback if (2) is chosen but a server is acceptable — DBOS** (durable execution as a Postgres-only library): it keeps the in-process model and so sidesteps most of the runner's structural gaps, at the cost of a young framework on the core loop.

## Why the full runner is not recommended — the evidence

Three independent review passes converged on **one root cause**: the ADR's runner models each step as an *independent, idempotent, retryable job*, but the live review is **one in-process stateful durable execution**. Five properties only hold because of that, and decomposing into job rows breaks all five:

1. a shared mutable `ReviewWorkflowState` object that ~8 stages read/write;
2. a **pod-local `emptyDir` workspace** — the cloned repo lives on one node's disk;
3. a fan-in denominator computed from a **mutable live-findings snapshot**;
4. an in-process query-vector cache + a **pinned retrieval generation**;
5. a frozen deterministic clock + an **~11-stage stateful tail** the model collapses into one `aggregate` step.

The risk register that follows is the argument. It is organized by theme; **bold = verified against PG 18.3 or the live source**; ⚠ = no cheap mitigation (these are exactly what Stage 0 avoids).

### A. The §1 schema does not even build (critical)
- ⚠ **A UNIQUE index on a partitioned table must include the partition key**, so the "fan-in backstop" indexes are *rejected by Postgres* (reproduced on 18.3). The schema fails at `CREATE`.
- **The obvious workaround — append `created_at` to the key — silently destroys the singleton guarantee** (verified: two `aggregate` jobs for one review both insert), so a fan-in race **double-posts to a customer PR** (violates invariant 9 + the `comment_ids` invariant).
- `idempotency_key` has no DB uniqueness and **cannot** be made unique under partitioning → §4's "single effect at the DB" is unenforced; real enforcement needs **per-sink, non-partitioned ledger tables**.
- Retention partition-DROP is **by `created_at`, blind to job state** → it **silently deletes `ready`/`leased`/version-`parked` jobs** of long-lived reviews (couples lethally with §6 deploy-parking) → silent stuck reviews invisible to every specified alert.

### B. Correctness & liveness the linear model breaks (critical/major)
- ⚠ **Fan-in N=0 wedges the review.** Path-filtered-out or fully carry-forwarded PRs enqueue *zero* chunk jobs, so `completed==total` never fires, the aggregate is never minted, and the run hangs until the reaper mis-cancels it as a timeout (found by 3 lenses independently). A normal, frequently-exercised branch.
- **Spine-retry re-reads live parent findings** → a *different* `total_chunks` denominator than the chunk jobs a prior partial attempt enqueued → permanent fan-in stall or unique-index abort. Carry-forward is a snapshot of mutable cross-run state; Temporal replays it byte-identically, a retryable job does not.
- **Lease-clock authority is unspecified**, and the cited exemplar (outbox) compares the *worker's* wall clock to `leased_until` while the mutex deliberately uses DB `now()` (the M1 fix) → adopting the outbox convention reopens the pod/DB clock-skew steal window.
- **`arbitrationNow` is `workflowInfo().startTime`** (a replay-frozen instant) stamped onto `suppressed_at`; the runner has no equivalent per-run frozen clock, so retried steps write drifting audit timestamps.

### C. Shared state & physical locality the model has no home for (critical) ⚠
- ⚠ **No schema slot for the shared `ReviewWorkflowState`** (policyBundles, queryVectorCache, retrievedKnowledgeChunkIds, inlinePostFilterMetadata, arbitration, persistedFindingIds, postedReview). v2 mis-buckets `state.ts` as "reuse light"; it is net-new persisted-state design that dwarfs the fencing work.
- ⚠ **The workspace is a pod-local `emptyDir`.** Clone runs on pod A; with `replicaCount=2`, ~50% of downstream steps land on pod B and read an *empty directory* → ENOENT or a silent empty review. Requires sticky/affinity claims **or a ReadWriteMany shared volume — a new infra dependency the ADR never named.**
- **The ~11-stage stateful tail** (dedup → aggregate → cap → config-notice → policy-post-filter → citation-validate → persist → arbitration → record-tool-runs → walkthrough → persist-walkthrough → post → update-PR-description → fix-prompt) is collapsed into one `aggregate` step → crash-resume granularity is the *whole tail*, re-running non-idempotent DB writes (persist, arbitration) and re-posting the fix-prompt comment.
- **`post` is not a leaf**: `update_pr_description` (read-modify-write) and a *second* `fix_prompt` GitHub comment fire inside post-success with asymmetric fail-open semantics → a coarse `post` retry double-posts.
- **Lifecycle bookkeeping** (`PostReviewCapture`: comment_ids / kept_finding_indices / dropped_classifications + the F9 length invariant) must cross the post→bookkeeping job boundary; no schema home → findings stay `delivery_outcome = NULL` (the stuck-row class the team already burned on).

### D. Cost, tenancy & audit regressions (major) ⚠
- ⚠ **Cost-cap is a two-phase reserve/reconcile straddling the paid edge.** A crash/steal between the SDK call and `recordCallCost` leaks the reservation; the ledger *replay* path **skips reconciliation**, so `cost_daily` is permanently inflated → the fail-closed cap eventually **denies legitimate reviews org-wide.** Supersede-mid-call leaks it too.
- **Concurrent in-flight double-spend.** Lease-steal during a 40s Bedrock call leaves two paid completions genuinely in flight; the ledger `lookup` is a plain `SELECT` (no `FOR UPDATE`/advisory lock) → it dedupes *sequential* retries, not *concurrent* invokers. The stubbed spike cannot reproduce this (Appendix A).
- **The claim query is a cross-tenant path** with no `installation_id` filter; the runtime tenancy plugin bypasses raw SQL and the PR-time gate is WARN-mode + token-presence — so it is green by *coincidence*, never declared a privileged path.
- **`audit.workflow_events` is not Temporal's per-attempt history** — it is coarse milestones. "Mostly have it" is false; the runner must build a new high-churn `workflow_job_attempts` store (input/output/error/retry/lease-steal per attempt), unbudgeted in the estimate.

### E. Shadow-parity & cutover are not as simple as v2 claimed (critical/major)
- ⚠ **Shadow contaminates live data.** `review_finding_id` is derived from `pr_id` (not `run_id`) with `ON CONFLICT DO NOTHING`, so a "read-only" shadow run **writes into the live PR's finding rows** — polluting or swallowing real findings. §11 only isolated GitHub, not `core.*`.
- **Shadow double-spends Bedrock.** The ledger key is `promptSha256`; the ANN `ORDER BY` has no tiebreaker → prompt bytes drift across engines → ledger *miss* → a second real completion per chunk.
- **The parity oracle "identical findings" is unsatisfiable** — Bedrock runs at temperature 1.0 with no seed, so output varies run-to-run. Needs a pin-the-LLM + fuzzy-structural-diff oracle, not exact equality.
- **"One engine claims a webhook" has nowhere to live** — run-allocation + outbox-append are inside the single ingest transaction, before any dispatcher sees the row.
- **GitHub redelivery mints a fresh `delivery_id`** → never deduped → always supersedes; during cutover it routes across engines → double-post race. Dedup must move to a content key (head_sha).
- **Rollback orphans in-flight runner job-graphs** — the kill switch only models forward in-flight (Temporal finishing its own).

### The shape of the argument

Count the ⚠ items: **workspace locality (new infra), shared-state persistence, per-attempt history, the two-phase cost split, fan-in N=0, shadow determinism.** None has a cheap fix; each is a multi-week sub-project on the sacred loop; and **Stage 0 avoids every one of them by keeping the in-process execution model.** That is the case for the recommendation: the rewrite costs far more than the operational weight it removes — unless the team's goal is specifically to eliminate the Temporal dependency, in which case Appendix B is the honest scope.

## Effort (revised)

The v2 figure (5–8 / 8–12 weeks) is now understood to be low. Adding shared-state persistence, workspace locality (incl. an infra decision), tail decomposition, a per-attempt history store, cost-accounting rework, and a parity harness that cannot use exact equality makes the full runner a **multi-quarter program on the core loop with low reversibility**. **Stage 0 is an afternoon.**

## Alternatives considered

- **Stage 0 — Temporal on Postgres-only (recommended).** Removes the operational objection; preserves the execution model.
- **DBOS — Postgres-only durable-execution library (documented fallback).** Keeps the in-process model, so it dodges the §C/§D structural gaps; cost is a young framework on the core loop.
- **`core.workflow_jobs` runner (Appendix B, not recommended).** Owns the mechanism on Postgres but must close the entire risk register first.
- **Restate / Hatchet** — new component (→ ADR); not preferred while Postgres-native options exist.
- **BullMQ + Redis** — rejected (Redis excluded; not durable execution).

## Open question (the decision)

**Is the objection Temporal's operational weight, or the dependency itself?** Operational weight → Stage 0 (recommended, ~zero cost). The dependency itself → Appendix B, accepting the multi-quarter program and its risk register.

---

## Appendix A — proof-of-concept spikes (honest scope)

Committed at `docs/adr/0077-spikes/spike.mjs` (the engine) and `spike2.mjs` (the production failure modes), runnable against a throwaway Postgres.

**What they prove** (the toy engine, in isolation, ~250 lines): the durable hand-off (mark-done + enqueue-next in one txn), race-safe fan-in for N≥1, lease-steal crash recovery, fencing via `attempt_token`, lease heartbeat keeping a long step alive, and external-effect idempotency via a key — all green under a forced lease-steal.

**What they do NOT prove** (and the ADR must not claim they do): a **concurrent in-flight paid provider call** (stub effects return instantly, so the two workers never overlap inside the effect — the real double-spend window), multi-process workers, real clone/static-analysis durations, worker↔DB clock skew, the N=0 fan-in base case, the shared `ReviewWorkflowState`, the pod-local workspace, the ~11-stage tail, supersede-mid-call, or the two-phase cost reservation. "Proven in spike2" therefore means *the engine mechanics in isolation*, never the production workflow.

## Appendix B — the runner design, if the team proceeds anyway

Retained for completeness; **not recommended.** A real design must first close every ⚠ above. The corrected skeleton (incorporating all three review passes):

- **Identity:** parent `core.workflow_runs(run_id uuid PRIMARY KEY, review_id, …)` keyed on the *execution* identity (not `review_id`); supersede truth stays `pull_request_reviews.current_run_id` (no duplicate `current` flag); child `core.workflow_jobs(job_id uuid PRIMARY KEY, run_id FK, …)`.
- **Do NOT partition the hot active jobs table** — that is what makes the fan-in/singleton unique indexes legal again; archive `done`/`dead` rows to a separate `workflow_jobs_archive`, deleting by *terminal-state + age*, never by `created_at` alone.
- **Fencing** on `(lease_owner, attempt_token)`; **DB `now()` is the sole lease clock** (the M1 mutex convention, not the outbox one); **heartbeat** extends the lease under the full fence; **watchdog** transitions are themselves fenced (terminal-state-wins).
- **Single-effect** is enforced by **per-sink non-partitioned ledger tables** (the ADR-0068 ledger is the template); LLM lookups need `FOR UPDATE`/advisory lock to block concurrent invokers; cost reserve+reconcile must be crash-atomic with the ledger, and replay/supersede paths must *release* orphaned reservations.
- **Shared run-state** (the §C `ReviewWorkflowState` fields) needs a persisted run-scoped artifact (claim-check) with a read-back contract; pin the **retrieval generation** + per-path query vectors into the spine payload; add a `run_logical_now` column for the frozen clock.
- **Workspace locality:** decide before any Stage-5 work — sticky/affinity claims on `workflow_jobs` *or* a RWX shared volume (its own infra ADR).
- **Branching & tail:** model the path-filters-excluded-all early exit as a skip-edge; expand the `aggregate` step into the real ordered tail with per-step idempotency; decompose `post` into `post_review` / `post_check_run` / `update_pr_description` / `fix_prompt`, each with its own idempotency key and failure policy; persist `PostReviewCapture` for the bookkeeping step (carry the F9 length invariant).
- **Cancellation:** unify reaper + supersede + fence into one terminal-state authority over **both** tables (the §5 check must gate on parent `lifecycle_state`, not only `current`); guaranteed finalizer jobs (mutex/workspace/placeholder/**cost-release**) on every terminal path incl. supersede-no-op.
- **Tenancy:** declare the claim/heartbeat/watchdog queries an explicit `@privileged_path` cross-tenant exemption; every per-tenant write validates `installation_id`/`repo_id`.
- **Per-attempt history:** a new append-only `workflow_job_attempts` table feeding the §10 operator UI (timeline / blocking job / retries / dead-letter / lease age / manual retry-cancel-supersede, with action audit + RBAC).
- **Cutover:** resolve `target_engine` inside `persistWebhook` so a single dispatcher routes by row (no second dispatch path); dedup redelivery on a content key (head_sha) and pin engine per-`current_run_id`; shadow isolated by a `run_kind` discriminator on every `core.*` write key; parity via pin-the-LLM + fuzzy structural diff; rollback as a drain, with the reaper/janitor taught about `workflow_jobs`.

**Unresolved-risk register to close before Accepted:** the workspace-locality infra decision; the shared-state persistence layer; the per-attempt history store + its write-amplification budget; the two-phase cost-accounting rework; the concurrent-in-flight double-spend mutual-exclusion; the shadow-determinism oracle. Each is a sub-project; together they are the multi-quarter scope.
