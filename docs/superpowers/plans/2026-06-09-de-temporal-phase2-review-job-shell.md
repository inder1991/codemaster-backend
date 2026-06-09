# De-Temporal Phase 2 — Review-Job Shell Implementation Plan (FINAL)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **GATE (project-owner directive, verbatim):** *"Do not start Phase 2 until its own plan explicitly proves the abort-aware side-effect contract, LLM ledger protocol, post-review idempotency, and reaper unification."* This plan discharges that gate: §Gate Proofs maps each of the four to a concrete chaos test (Wave 7) that must be GREEN before Phase 2 is "done". A wave that lands code without its gate proof is NOT complete.

**Goal:** Build the real `JobHandler` — `runReviewJob(job, signal)` — that runs the existing `orchestrate()` **in-process, no Temporal**, safely re-runnable from scratch on crash, on branch `feat/de-temporal-runner-phase1`.

**Architecture:** Phase 1 gave the durable lease/fence/timeout runner (`core.review_jobs` + `ReviewJobsRepo` + `runOneJob`/`RunnerLoop`). Phase 2 makes the *work inside* idempotent: the job row becomes the durable workflow-argument store (D1), all five paid LLM call sites replay through the ADR-0068 ledger (D2), the job lease becomes the single liveness clock with the PR mutex subordinated to it (D3), and GitHub posting recovers `comment_ids` across re-runs (D4). The Temporal path stays untouched and green — the shell is additive; **no production enqueue caller lands in Phase 2** (cutover is Phase 4), so the shell ships exercised by its gate-proof suite only.

**Tech Stack:** as Phase 1 (TS/ESM/Node 22, Kysely raw `sql`, Zod 3, PG16, vitest). DB tests ONLY against `CODEMASTER_PG_CORE_DSN=postgresql://postgres:postgres@localhost:5434/codemaster` — never the cluster. Clock/Random seams mandatory (`check_clock_random` bans raw timers + `Math.random()` in `src/`). Integration tests carry the Phase-1 isolation hook (`beforeEach DELETE` guarded on `INTEGRATION_DSN`) and rely on `--no-file-parallelism`.

**Grounding:** every claim below was verified against the code by the 2026-06-09 8-subsystem deep-read (file:symbol cited inline). The Phase-1 plan v4 lives at `docs/superpowers/plans/2026-06-09-de-temporal-review-jobs-runner.md`; its Phase-2 "must detail before coding" checklist is superseded by THIS document.

---

## v2 — review patches (project-owner review, 2026-06-09; all 9 findings dispositioned)

| F | Sev | Finding | Patch (verified) |
|---|---|---|---|
| F1 | **BLOCKER** | `payload_schema_version` collides with the review payload's own `schema_version` (=2, `review_pull_request.v1.ts:41` `z.literal(2)`) | Column renamed `job_payload_schema_version` — it versions the **storage envelope**, not the review contract (W0.1, W0.2). enqueue validates the inner `schema_version=2`. |
| F2 | **BLOCKER** | pre-Phase-2 rows get `payload='{}'` → fail `verifyPayload` after claim | Migration **dead-letters** existing `ready`/`leased` rows in the same migration; claim's `state IN ('ready','leased')` filter then excludes them. Step-2 asserts the count is 0 (W0.1). |
| F3 | **BLOCKER** | fix-prompt `comment_posted_at`-as-claim → crash between claim and post permanently suppresses the comment | **Recoverable lease**: `comment_posted_at`+`github_comment_id` set ONLY on success (biconditional CHECK); in-flight claim is `comment_claim_owner`/`comment_claim_expires_at`, reclaimed on expiry. New crash-recovery test proves the comment is never lost (W0.1, W3.3). |
| F4 | MED | "all 5 ledgered" weakened by optional `review_id` (no-ledger fallback) | Shell constructs the LLM client in **strict-ledger mode**: a paid `invokeModel` in the shell path with NO idempotency context is a HARD ERROR. Optional/no-ledger stays Temporal-legacy-only (W2.1, W5.2; acceptance §AC). |
| F5 | MED | cancel finalization "best-effort" → cancelled job + still-RUNNING run = leak | The `review_runs → CANCELLED` transition is a **required, retried** terminal step (not best-effort); only mutex/workspace release stays best-effort-idempotent. G3 asserts BOTH `review_jobs.state='cancelled'` AND `review_runs.lifecycle_state='CANCELLED'`. Unified reaper is the hard-crash backstop (W5.2, E6, G3). |
| F6 | MED | mutex reuse needs ownership validation, not just "live" | FK `review_jobs.mutex_id → pr_review_mutex(mutex_id)` added (safe — nothing DELETEs mutex rows); W5.1 reuse path re-validates `installation_id`/`repository_id`/`pr_number` against the job payload + reclaimable-by-us, else re-acquires fresh (W0.1, W5.1). |
| F7 | MED | "zero paid calls after abort" overstated | Reworded to the enforceable guarantee: **no NEW paid call starts after abort**; in-flight calls receive the `signal`; a call already on the wire may complete and is made safe by the ledger + cost-cap fence (never double-charged) — gate ① / G1. |
| F8 | LOW | weak DB constraints | Added: `posted_reviews.comment_ids` is-array CHECK; `fix_prompts.github_comment_id > 0`; biconditional `comment_posted_at ⇔ github_comment_id` (W0.1). |
| F9 | LOW | ledger purpose + metric purpose must agree | Each newly-ledgered site sets the SAME `purpose` token for both the idempotency `chunkId` surrogate (E8) AND the `purpose` metric label; W2.2 asserts they match (W2.1, W2.2). |

**Blockers F1/F2/F3 are fixed in the plan above; mediums F4–F7 are acceptance criteria (see §Phase 2 exit criteria), not later cleanup.**

---

## Locked decisions (project-owner, 2026-06-09 — verbatim requirements)

**D1 — Payload: `core.review_jobs` becomes the durable workflow-argument store.**
"The review job must be self-contained. Temporal had the full workflow argument in history; after removing Temporal, core.review_jobs needs to become that durable argument store."
```sql
ALTER TABLE core.review_jobs
  ADD COLUMN job_payload_schema_version int NOT NULL DEFAULT 1,   -- F1: storage-envelope version (NOT the payload's own schema_version=2)
  ADD COLUMN payload jsonb NOT NULL,
  ADD COLUMN payload_sha256 text NOT NULL;
```
Enqueue: (1) validate `ReviewPullRequestPayloadV1` (inner `schema_version` must be `2`); (2) canonicalize/hash; (3) insert payload + `job_payload_schema_version` + sha256 with the job; (4) shell reads row → parses payload → verifies hash → runs. **Do not rehydrate from outbox** (delivery plumbing, not durable history). **Do not rebuild from `core.pull_requests`** (reconstructed state ≠ the exact event/run input).

**D2 — LLM ledger: ledger all 5 paid call sites; no in-flight reservation.**
Keep migration 0003's schema. Extend coverage to `bedrock_review_chunk` (already done) + **walkthrough + Tier-1 curator + rerank + fix-prompt**. Stable idempotency keys for PR-level calls: review_id, purpose tag (`walkthrough|curator|rerank|fix_prompt`), model, prompt hash, tool/schema version — `run_id` only if the output must change per run. Replay stored provider response on re-run. Metrics: **ledger hit, ledger miss, ledger store failure, provider call after ledger miss**. Add retention pruning. Concurrent duplicates: accept the rare double-pay, make it visible with telemetry; if soak shows meaningful duplicate spend, upgrade to the full in-flight reservation protocol then. **"Key by purpose + stable input, not just review_id"** — otherwise walkthrough and fix-prompt could collide or replay the wrong LLM response.

**D3 — Liveness: job lease primary, mutex subordinated.**
Requirements (verbatim): add `mutex_id` to `core.review_jobs`; persist it when the shell first acquires the PR mutex; **on re-run, reuse the same mutex_id instead of a fresh competing acquire**; the job heartbeat loop also renews the mutex lease; if mutex renewal fails → treat as lost claim / superseded / cancelled depending on the exact failure reason — **do not keep reviewing after losing the mutex**; unified reaper transaction = mark job dead-or-cancelled + transition review_runs to CANCELLED/FAILED as appropriate + release mutex + record audit/lifecycle event; the existing `review_run_reaper` must ignore runs with a live job row via `NOT EXISTS (SELECT 1 FROM core.review_jobs WHERE run_id = review_runs.run_id AND state IN ('ready','leased'))`; after cutover, retire the old age-sweep schedule and document the operator deletion command in the runbook.

**D4 — Post recovery: persist `comment_ids` on `core.posted_reviews`.**
```sql
ALTER TABLE core.posted_reviews
  ADD COLUMN comment_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
```
Won-claim path writes `github_review_id` AND `comment_ids`; lost-claim path reads + returns stored `comment_ids`; **if comment_ids is empty for a posted review with findings, emit a repair-needed metric/event**; integration test = first call wins claim and stores ids → simulated crash before lifecycle finalization → re-run loses claim → lost-claim returns stored ids → lifecycle finalizes findings normally. NOT flipping `CODEMASTER_LIFECYCLE_WRITES_ENABLED` (separate behavior change needing its own verification). GitHub re-fetch is acceptable fallback only, never primary truth.

## Engineering calls (documented, not re-litigated per task)

| # | Call | Rationale |
|---|---|---|
| E1 | **Separate non-Temporal port bundle** (`makeInProcessPorts`) — do NOT add `signal` to the shared `ReviewActivityPorts` type (25+ methods; the Temporal proxy path can't carry a JS AbortSignal across the activity boundary anyway) | dual-runtime asymmetry; lightest seam |
| E2 | **`arbitrationNow` = `job.started_at` ISO** (stable per attempt-chain; replaces `workflowInfo().startTime`) | re-runs must write identical `suppressed_at` |
| E3 | **New `markCancelled` + `RunOutcome` gains `'cancelled'`** + a `TerminalCancelError` class the shell throws for `PrMutexLostClaim`/`StaleWriteError`/`StateDrift`/`CurrentRunMismatch`; `runOneJob` settles those via `markCancelled` (terminal — NEVER re-enqueue) | superseded loser must exit clean, not bounce back |
| E4 | **`claimCheck` hybrid, fail-closed on supersede**: (a) `signal.aborted` → throw; (b) renew mutex (fail-open on transient error per current semantics); (c) read `current_run_id === runId` → fail-closed throw on mismatch | mutex renew alone is fail-open and can hide supersede |
| E5 | **Keep `@temporalio/common ApplicationFailure` as the error-carrier** for the H-2 dropped-state path (`extractDroppedStateFromPostFailure` posting.ts:162 depends on it) + a plain-Node smoke-import test proving `orchestrate`/`degradation`/`posting` load and behave outside a workflow (`inWorkflowContext()` → false → metric no-op) | replacing it silently breaks dropped-state routing |
| E6 | **Cleanup writes are EXEMPT from the abort rule**: mutex release + workspace release + terminal run-transition run in the handler's `finally` and deliberately ignore `signal` (the non-Temporal analogue of `CancellationScope.nonCancellable`). "No external write after abort" applies to REVIEW side effects (LLM, GitHub, findings), not releases | a skipped release leaks the mutex/workspace |
| E7 | **Same-run takeover on the posted_reviews NULL-row path**: `doPost` gains `opts.sameRunTakeover` (shell passes `true`; Temporal path unchanged at `false`). On lost-claim + `github_review_id IS NULL` + `assertCurrentRun` passed for OUR run_id: bypass the 300s `IN_FLIGHT_WINDOW` and re-attempt the create (compare-and-set `UPDATE … WHERE pr_id = … AND github_review_id IS NULL` fences a racer) — because in the runner world the re-run IS the retry; the crashed self must not strand the review as DEGRADED_UNPOSTED nor retry-loop against its own corpse | the window heuristic assumes the prior owner is a different execution |
| E8 | **PR-level ledger chunk-key surrogate** = `uuid5(LEDGER_PURPOSE_NS, purpose)` (purpose ∈ `walkthrough|curator|rerank|fix_prompt`) passed as `chunkId`; `reviewId` = `review_id` for PR-level calls; key uniqueness across sites holds via purpose-uuid + promptSha256 + per-site toolSchemaVersion | keeps `computeKey` unchanged; satisfies D2's "key by purpose + stable input" |

## Findings → task traceability (all 18 review findings land somewhere)

| Finding | Task |
|---|---|
| #1 payload gap (blocking) | W0.1/W0.2 (D1) |
| #2 Temporal lib coupling (blocking) | W1.1 (E5 smoke-import) |
| #3 ledger checklist≠schema (blocking) | resolved by D2 (no reservation; plan text corrected) |
| #4 four unledgered LLM sites | W2.2 (D2) |
| #5 run_id stability | W5.2 (shell passes `job.run_id` into ctx; pinned in G3) |
| #6 comment_ids unrecoverable + dormant lifecycle flag | W3.1 (D4) |
| #7 mutex self-deadlock on re-run | W0.1 + W5.1 (D3 mutex_id reuse) |
| #8 three liveness clocks / age-sweep kills live reviews / cron survives code removal | W6.1–W6.3 (D3) |
| #9 reapCrashLooped orphans the run at RUNNING | W6.1 (unified txn) |
| #10 no markCancelled / supersede bounce-back | W0.3 (E3) |
| #11 no AbortSignal anywhere external | W4.1–W4.3 (gate ①) |
| #12 cleanup must be abort-exempt | W5.2 finally (E6) |
| IN_FLIGHT_WINDOW self-race | W3.2 (E7) |
| claimCheck fail-open hides supersede | W5.2 (E4) |
| arbitrationNow nondeterminism | W5.2 (E2) |
| update_pr_description double-append | W3.4 (audit + marker-dedupe if needed) |
| fix-prompt blind POST + unledgered call | W3.3 + W2.2 |
| ledger silent store-failure / no retention | W2.1/W2.3 + W6.4 |

**Confirmed-solid (no task needed):** `doPost` 2-phase pr_id claim survives re-runs (given #5/#6); `computeChunkId` is content-addressed UUIDv5 (`libs/contracts/src/diff_chunking.v1.ts`) — the ledger chunk key IS stable across re-runs; `core.fix_prompts` DB upsert idempotent; Phase-1 fence/lease/reap slots in as designed.

---

## Verify before coding (preflight — run before Wave 0; abort the wave on any mismatch)

1. `SELECT to_regclass('core.review_jobs')` on `:5434` is non-NULL and migration `0036` is in `pgmigrations`; next free number is `0037`.
2. `core.review_jobs` has **zero production rows** (no enqueue caller exists — `grep -rn "\.enqueue(" apps/backend/src --include="*.ts" | grep -v runner/` returns nothing); dev/test rows may exist → the migration uses add-with-default-then-drop-default (Task W0.1) instead of assuming emptiness.
3. The five paid call sites are where the deep-read pinned them: `apps/backend/src/review/review_activity.ts:~149` (ledgered), `apps/backend/src/review/walkthrough_activity.ts:~294`, `apps/backend/src/analysis/curator.ts:~254`, `apps/backend/src/retrieval/llm_rerank.ts`, `apps/backend/src/review/fix_prompt/fix_prompt_theme_activity.ts:~167` (all unledgered — confirm each `invokeModel` call has NO `idempotency` arg).
4. `LlmClient.invokeModel`'s `idempotency` arg shape + `LlmInvocationLedger.computeKey(inputs)` (`apps/backend/src/integrations/llm/invocation_ledger.ts`) and that the ledger is wired in `apps/backend/src/worker/build_activities.ts:~475-491`.
5. `doPost` anatomy (`apps/backend/src/activities/post_review_results.activity.ts`): Phase-1 claim `ON CONFLICT (pr_id) DO NOTHING` + `assertCurrentRun` (:~951) + lost-claim branch (:~1139-1218) + `IN_FLIGHT_WINDOW_SECONDS_DEFAULT=300`.
6. `acquirePrReviewMutex/renewPrReviewMutexLease/releasePrReviewMutex` signatures (`apps/backend/src/concurrency/pr_mutex.ts`) + `startReviewForWebhook` (`apps/backend/src/activities/start_review_for_webhook.activity.ts`) — what the gate transaction does, so W5.1's reuse path replicates tenancy-recheck semantics.
7. `reviewRunReaperActivity` CTE shape (`apps/backend/src/activities/review_run_reaper.activity.ts:~127-155`) for the W6.2 `NOT EXISTS` insertion point; `WAVE1_LIVENESS_SCHEDULES` (`apps/backend/src/worker/outbox_dispatcher_main.ts:~52-65`).
8. **Does the installed Anthropic SDK accept an abort signal in request options?** Check the installed SDK types for `signal`/`AbortSignal` on request options. If YES → W4.2 passes it through; if NO → the pre-call `signal.aborted` gate is the only LLM enforcement (no in-flight cancel of a call already on the wire) — record the answer in the W4.2 commit body.
9. `AbortSignal.any` is available (Node ≥20.3; we run 22) — no polyfill.
10. `posting.ts` fix-prompt + update_pr_description blocks (`apps/backend/src/review/pipeline/posting.ts:~328-383`) and `generate_fix_prompt.activity.ts` persist+post sequence.

---

## Wave 0 — Foundations: migration 0037 + contracts + enqueue + markCancelled

### Task W0.1: Migration `0037_review_job_shell.sql`

**Files:** Create `migrations/0037_review_job_shell.sql`

- [ ] **Step 1: Write** (none of these tables is in the hot-table list — `core.outbox`/`audit.workflow_events`/`core.review_runs`/`core.pull_request_reviews`; `ADD COLUMN` with constant default is metadata-only in PG16; the CHECK adds scan small warm tables briefly but are sub-second. Defaults on `payload`/`payload_sha256` exist ONLY so pre-existing rows survive the ADD, then are dropped so new enqueues must supply them explicitly):

```sql
-- 0037_review_job_shell.sql — Phase 2: durable workflow-argument store (D1), mutex subordination (D3),
-- comment_ids recovery (D4), RECOVERABLE fix-prompt post claim. ADR-0077.

-- D1 / F1: job-ENVELOPE version. DISTINCT from the review payload's OWN schema_version (=2, a Phase-4
--   hard-cut: review_pull_request.v1.ts:41 `z.literal(2)`). This column versions how the ROW stores the
--   payload (the storage envelope), NOT the review contract — so it is named job_payload_schema_version.
ALTER TABLE core.review_jobs
  ADD COLUMN job_payload_schema_version int NOT NULL DEFAULT 1,
  ADD COLUMN payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN payload_sha256 text  NOT NULL DEFAULT '',
  ADD COLUMN mutex_id       uuid REFERENCES core.pr_review_mutex(mutex_id) ON DELETE SET NULL;  -- D3/F6: FK safe — janitor only sets released_at, nothing DELETEs pr_review_mutex
ALTER TABLE core.review_jobs ALTER COLUMN payload DROP DEFAULT;
ALTER TABLE core.review_jobs ALTER COLUMN payload_sha256 DROP DEFAULT;

-- F2: pre-Phase-2 rows carry no payload and would fail verifyPayload AFTER being claimed (real work not
--   started). Dead-letter them in the SAME migration (recoverable — row retained; production has zero rows;
--   dev/test/smoke rows are disposable). This + the claim's `state IN ('ready','leased')` filter means an
--   un-payloaded row can never be claimed by the shell.
UPDATE core.review_jobs
   SET state = 'dead', dead_reason = 'pre-phase2: no payload (migration 0037)', finished_at = now(),
       leased_until = NULL, lease_owner = NULL, attempt_token = NULL, timeout_at = NULL, heartbeat_at = NULL
 WHERE state IN ('ready','leased');

-- D4 / F8: durable per-comment ids (array-typed) so a crash re-run can finalize findings inline
ALTER TABLE core.posted_reviews
  ADD COLUMN comment_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE core.posted_reviews
  ADD CONSTRAINT ck_posted_reviews_comment_ids_array CHECK (jsonb_typeof(comment_ids) = 'array');

-- D4 / F3: RECOVERABLE fix-prompt GitHub-comment claim — claim ≠ success, so a crash between claim and
--   post can NEVER permanently suppress the comment. `comment_posted_at`+`github_comment_id` are set ONLY
--   after GitHub success (biconditional); the in-flight claim is a reclaimable LEASE
--   (comment_claim_owner/comment_claim_expires_at) that a re-run takes over once it expires.
ALTER TABLE core.fix_prompts
  ADD COLUMN github_comment_id        bigint,
  ADD COLUMN comment_posted_at        timestamptz,
  ADD COLUMN comment_claim_owner      text,
  ADD COLUMN comment_claim_expires_at timestamptz;
ALTER TABLE core.fix_prompts
  ADD CONSTRAINT ck_fix_prompts_comment_id_positive
    CHECK (github_comment_id IS NULL OR github_comment_id > 0),
  ADD CONSTRAINT ck_fix_prompts_posted_iff_comment_id      -- F8: posted ⇔ comment id (biconditional)
    CHECK ((comment_posted_at IS NULL     AND github_comment_id IS NULL)
        OR (comment_posted_at IS NOT NULL AND github_comment_id IS NOT NULL));
```

- [ ] **Step 2: Apply** — `CODEMASTER_PG_CORE_DSN=postgresql://postgres:postgres@localhost:5434/codemaster npm run migrate:up`; verify `\d core.review_jobs` (job_payload_schema_version/payload/payload_sha256/mutex_id; payload+sha256 NO default; FK to pr_review_mutex), `\d core.posted_reviews` (comment_ids + array CHECK), `\d core.fix_prompts` (4 new cols + 2 CHECKs); confirm `SELECT count(*) FROM core.review_jobs WHERE state IN ('ready','leased')` = 0 (pre-Phase-2 rows dead-lettered).
- [ ] **Step 3: Commit** — `git add migrations/0037_review_job_shell.sql && git commit -m "feat(runner): 0037 — job_payload argument store + mutex_id FK + posted_reviews.comment_ids + recoverable fix_prompt post-claim + pre-phase2 dead-letter (D1/D3/D4; F1/F2/F3/F6/F8)"`

### Task W0.2: Contracts + `enqueue` payload (validate → canonicalize → hash)

**Files:** Modify `libs/contracts/src/review_jobs.v1.ts`, `apps/backend/src/runner/review_jobs_repo.ts`; Test `test/unit/contracts/review_jobs.v1.test.ts`, `test/integration/runner/review_jobs_repo.integration.test.ts`

- [ ] **Step 1: Failing tests** — contract: `ReviewJobV1` parses `job_payload_schema_version/payload_sha256/mutex_id` (add explicit fields; **`job_payload_schema_version` is the storage-envelope version — NOT the payload's own `schema_version: 2`, F1**). Repo: `enqueue` now REQUIRES `payload` (a valid `ReviewPullRequestPayloadV1` object, whose inner `schema_version` must be `2`); inserts it + `job_payload_schema_version=1` + sha256; `getById` round-trips; enqueue with an INVALID payload (e.g. inner `schema_version != 2`) throws (Zod) and inserts nothing; the stored `payload_sha256` equals `sha256hex(canonicalJson(payload))`.
- [ ] **Step 2: Implement** — add a tiny canonicalizer (stable key-ordered JSON.stringify) + `sha256hex` (reuse the `node:crypto` import pattern of `invocation_ledger.ts::hashMessagesForLedger` — `createHash` is gate-sanctioned for hashing). `EnqueueArgs` gains `payload: unknown` (validated inside `enqueue` via `ReviewPullRequestPayloadV1.parse`); INSERT gains the three columns (`CAST(${json} AS jsonb)` bind per the JSONB idiom). Add `verifyPayload(job): ReviewPullRequestPayloadV1` helper: parse + recompute hash + throw `PayloadIntegrityError` on mismatch.
- [ ] **Step 3:** Run green (update the existing Phase-1 integration tests' `enqueue(s)` calls to pass a minimal valid payload fixture — extend `_fixtures.ts` with `minimalReviewPayload(s)`); typecheck; commit `feat(runner): self-contained job payload (validate→canonicalize→hash at enqueue; verified parse in shell) [D1]`.

### Task W0.3: `markCancelled` + `RunOutcome 'cancelled'` + `TerminalCancelError`

**Files:** Modify `apps/backend/src/runner/review_jobs_repo.ts`, `apps/backend/src/runner/review_job_runner.ts`; Test `test/integration/runner/review_jobs_repo.integration.test.ts`, `test/integration/runner/review_job_runner.integration.test.ts`

- [ ] **Step 1: Failing tests** — repo: `markCancelled({jobId, owner, token, reason})` is fenced like `markDone`, sets `state='cancelled'`, `cancel_reason`, `finished_at`, clears ALL lease metadata, returns `FencedResult`; stale token → `applied:false`. Runner: a handler that throws `new TerminalCancelError("superseded", cause)` settles the job `cancelled` (NOT `ready`, NOT `dead`) and `runOneJob` returns `outcome:'cancelled'`; attempts are NOT re-driven.
- [ ] **Step 2: Implement** — `export class TerminalCancelError extends Error { constructor(public reason: string, cause?: unknown) … }` in `review_job_runner.ts`; the catch block: `e instanceof TerminalCancelError → markCancelled` else `markFailed` (existing). `RunOutcome = "idle" | "done" | "failed" | "lease_lost" | "cancelled"`. Wire `jobs_total{outcome}` for the new outcome.
- [ ] **Step 3:** Green → commit `feat(runner): markCancelled + terminal-cancelled outcome (supersede losers never re-enqueue) [E3]`.

## Wave 1 — Plain-Node compatibility proof (blocking gap #2)

### Task W1.1: smoke-import + behavior test for the Temporal-coupled modules

**Files:** Create `test/unit/runner/plain_node_compat.test.ts`

- [ ] **Step 1: The test** (this is a PROOF, not a formality — if it fails, STOP and surface; the "orchestrate unchanged" premise is broken): import `orchestrate` (`#backend/review/pipeline/orchestrator.js`), `stageOutcome`/`recordStage` (`degradation.js`), `postReviewResults`/`extractDroppedStateFromPostFailure` (`posting.js`) in plain vitest Node. Assert: (a) imports do not throw; (b) `inWorkflowContext()` from `@temporalio/workflow` returns false here and `stageOutcome('classify', {}, async () => "ok")` resolves (metric emit no-ops, no sandbox throw); (c) `ApplicationFailure.create({type: 'POST_REVIEW_FAILED_WITH_DROPPED_STATE', details:[…]})` thrown by a stub and fed to `extractDroppedStateFromPostFailure` round-trips the details (E5 — the error-carrier works without the activity boundary); (d) `CancelledFailure` is constructible + `instanceof`-detectable.
- [ ] **Step 2:** Green → commit `test(runner): plain-Node compatibility proof for orchestrate/degradation/posting (E5)`. If RED: file the exact failing symbol and STOP the wave (the fix is a targeted seam in degradation/posting, designed then, not improvised).

## Wave 2 — Ledger expansion (D2; gate ② mechanics)

### Task W2.1: purpose-key helper + metrics

**Files:** Modify `apps/backend/src/integrations/llm/invocation_ledger.ts` (helper + counters), `apps/backend/src/integrations/llm/client.ts` (emit points); Test `test/unit/llm/ledger_purpose_key.test.ts`

- [ ] **Step 1:** `export const LEDGER_PURPOSE_NS = "<uuid4 literal, minted once at authoring time>"` + `export function purposeChunkId(purpose: "walkthrough"|"curator"|"rerank"|"fix_prompt"): string { return uuid5(LEDGER_PURPOSE_NS, purpose); }` (E8, via `#platform/randomness.js::uuid5`). Test: deterministic across calls, distinct per purpose.
- [ ] **Step 2:** Four bounded-cardinality counters (label `purpose` only): `codemaster_llm_ledger_hit_total`, `..._miss_total`, `..._store_failed_total`, `..._paid_call_total` — emitted inside `invokeModel`'s existing branches (hit→replay; miss→before SDK; store catch→store_failed; after paid SDK→paid_call). Mirror the OTel idiom of `runner_metrics.ts`. **`store_failed` makes the silent-swallow visible; `paid_call` vs `miss` over time exposes duplicate spend (D2's upgrade trigger).** **F9: the `purpose` token used for the metric label MUST be the SAME token that drives the idempotency `chunkId` surrogate (E8) — a unit test asserts the two agree per call site so cost observability and replay keying never diverge.**
- [ ] **Step 2b (F4 — strict-ledger mode):** add a constructor flag `strictLedger?: boolean` (default false = current Temporal-legacy behavior). When `true`, a paid `invokeModel` (a ledger MISS that is about to call the SDK) with NO `idempotency` context **throws** `LedgerRequiredError` instead of paying un-ledgered. The shell (W5.2) constructs its review `LlmClient` with `strictLedger: true`, so every paid Bedrock call in the shell path is provably ledgered (gate ②). Unit test: strict client + paid call without idempotency → throws; with idempotency → replays/pays normally.
- [ ] **Step 3:** Green → commit `feat(llm): ledger purpose keys + telemetry + strict-ledger mode (paid calls must be ledgered in the shell) [D2, F4, F9]`.

### Task W2.2: thread idempotency into the four unledgered call sites

**Files:** Modify `apps/backend/src/review/walkthrough_activity.ts`, `apps/backend/src/analysis/curator.ts`, `apps/backend/src/retrieval/llm_rerank.ts`, `apps/backend/src/review/fix_prompt/fix_prompt_theme_activity.ts`; Test `test/integration/llm/llm_invocation_ledger.integration.test.ts` (extend)

- [ ] **Step 1: Failing test** — for EACH purpose: drive the call site twice with identical inputs against a counting SDK stub + real ledger on `:5434`; assert the paid SDK call count is 1 across both runs (HIT replays), the ledger row's `chunk_id` equals `purposeChunkId(purpose)`, and a CHANGED prompt produces a MISS + second row (invalidation direction pinned).
- [ ] **Step 2: Implement** — each site passes `idempotency: { reviewId: <review_id in scope>, chunkId: purposeChunkId("<purpose>"), toolSchemaVersion: <per-site sha256-of-shape literal mirroring REVIEW_TOOL_SCHEMA_VERSION (review_activity.ts:55)> }`. `run_id` is deliberately NOT in the key (D2: output need not change per run). Where `review_id` isn't in scope, thread it through the activity input contract (additive optional field, default absent = no ledgering — back-compat with the Temporal path until it too passes it).
- [ ] **Step 3:** Green per site (4 small commits, `feat(llm): ledger <purpose> paid call (purpose-keyed replay) [D2]`).

### Task W2.3: ledger retention pruner (mechanism only; wired in W6.4)

**Files:** Modify `apps/backend/src/integrations/llm/invocation_ledger.ts`; Test extend the ledger integration test

- [ ] `pruneOlderThan(days: number): Promise<number>` — `DELETE FROM core.llm_invocation_ledger WHERE created_at < now() - make_interval(days => ${days})` (cross-tenant maintenance → `// tenant:exempt reason=retention-sweep follow_up=FOLLOW-UP-gf3-error-mode` on the line above the template). Default 7 days via `CODEMASTER_LLM_LEDGER_RETENTION_DAYS`. Test: old row pruned, fresh row survives. Commit `feat(llm): ledger retention pruner [D2]`.

## Wave 3 — Posting recovery (D4 + E7; gate ③ mechanics)

### Task W3.1: persist + return `comment_ids` on `core.posted_reviews`

**Files:** Modify `apps/backend/src/activities/post_review_results.activity.ts`; Test `test/integration/activities/post_review_results_rerun.integration.test.ts` (new)

- [ ] **Step 1: Failing test (D4's verbatim scenario):** seed findings + pr_meta; run `doPost` with stub ghClient A (createReview → `{reviewId: 999, commentIds: [N ids]}`) → assert won-claim, row has `github_review_id=999` AND `comment_ids` JSONB = the N ids. Run `doPost` again (stub B) → assert lost-claim, ZERO `createReview` on B, ONE `updateReview`, and the returned `PostedReviewV1.comment_ids` equals the stored N ids (**no longer `[]`**) — lifecycle finalization works on the re-run. Plus: a posted review whose stored `comment_ids` is empty BUT input has kept findings → `codemaster_posted_reviews_comment_ids_repair_needed_total` increments (D4's repair signal).
- [ ] **Step 2: Implement** — won-claim Phase-2 UPDATE gains `comment_ids = CAST(${json} AS jsonb)`; lost-claim SELECT gains `comment_ids::text` (JSONB-read idiom) and threads them into the returned `PostedReviewV1`; the repair-needed counter (bounded, no labels) emits on the empty-with-findings condition. `PostedReviewV1` already carries `comment_ids` — no contract change.
- [ ] **Step 3:** Green → commit `feat(post): durable comment_ids on posted_reviews — re-run recovers inline finalization [D4]`.

### Task W3.2: same-run takeover on the NULL-row path (E7)

**Files:** Modify `apps/backend/src/activities/post_review_results.activity.ts`; Test extend W3.1's file

- [ ] **Step 1: Failing test:** simulate the crashed-self: win the claim but make stub createReview THROW after the claim row exists (`github_review_id` stays NULL); re-run `doPost` with `sameRunTakeover: true` and a working stub → assert it does NOT raise `PostReviewTransientError` (no self-retry-loop), does NOT return DEGRADED_UNPOSTED, but re-attempts `createReview` and lands `github_review_id` via the compare-and-set `UPDATE … WHERE pr_id = … AND github_review_id IS NULL`. Racer variant: pre-set `github_review_id` between read and CAS → falls back to the lost-claim update path (0-row CAS detected).
- [ ] **Step 2: Implement** — `DoPostDeps`/opts gains `sameRunTakeover?: boolean` (default false → Temporal behavior byte-identical). Branch only on: lost-claim + NULL `github_review_id` + flag + (`assertCurrentRun` already passed for OUR run_id).
- [ ] **Step 3:** Green → commit `feat(post): same-run takeover on NULL-row lost-claim (the re-run IS the retry) [E7]`.

### Task W3.3: fix-prompt GitHub-comment RECOVERABLE claim + abort gate (F3 blocker)

**Files:** Modify `apps/backend/src/domain/repos/fix_prompt_repo.ts`, `apps/backend/src/activities/generate_fix_prompt.activity.ts`; Test `test/integration/activities/generate_fix_prompt.activity.integration.test.ts` (new)

> **F3 fix — claim ≠ success.** The naive "set `comment_posted_at`, then post" conflates in-flight with done: a crash AFTER the claim but BEFORE the GitHub post makes every re-run skip → the comment is **permanently lost**. So `comment_posted_at`+`github_comment_id` are set ONLY on success (the biconditional CHECK); the in-flight claim is a reclaimable LEASE (`comment_claim_owner`/`comment_claim_expires_at`) a re-run takes over once it expires.

- [ ] **Step 1: Failing tests:** (a) DEDUPE — run `generateFixPrompt` twice (same `review_id`, recording client) → `createIssueComment` called EXACTLY ONCE; `comment_posted_at`+`github_comment_id` set; one row. (b) **CRASH-RECOVERY (the F3 proof)** — run once but make the post THROW *after* the claim is taken (so `comment_posted_at` stays NULL, claim set); let the claim expire (tiny TTL); re-run → it RE-CLAIMS the expired lease and posts → `createIssueComment` exactly once total, the comment IS posted (never lost). (c) ABORT — a run with an already-aborted `AbortSignal` posts nothing and takes no claim. (d) CONCURRENT — a second run while the first holds a LIVE (unexpired) claim → the second skips (no double post).
- [ ] **Step 2: Implement** — repo:
  - `claimCommentPost(reviewId, owner, ttlS): Promise<boolean>` = `UPDATE core.fix_prompts SET comment_claim_owner = ${owner}, comment_claim_expires_at = now() + make_interval(secs => ${ttlS}) WHERE review_id = ${id} AND comment_posted_at IS NULL AND (comment_claim_expires_at IS NULL OR comment_claim_expires_at < now())` (`numAffectedRows===1` → won; loses if already posted OR a live claim exists).
  - `recordCommentPosted(reviewId, owner, commentId)` = `UPDATE … SET comment_posted_at = now(), github_comment_id = ${commentId}, comment_claim_owner = NULL, comment_claim_expires_at = NULL WHERE review_id = ${id} AND comment_claim_owner = ${owner}` (fenced on our claim; satisfies `ck_fix_prompts_posted_iff_comment_id`).
  - `isCommentPosted(reviewId): boolean` (`comment_posted_at IS NOT NULL`).
  - Activity: persist row → `if (signal?.aborted) return` → `if (await isCommentPosted) return` → `if (!await claimCommentPost(owner, TTL=120s)) return` → `if (signal?.aborted) return` (re-check) → `createIssueComment` → on SUCCESS `recordCommentPosted`; on FAILURE leave the claim to expire (next re-run reclaims). Activity input gains optional `signal` (Temporal path passes none → still dedupes + recovers). Embed `<!-- codemaster:fix-prompt-marker:${review_id} -->` (forensics belt; the DB lease is the fence).
  - The 120s TTL > GitHub-post worst case so claim-expiry-mid-post (→ a rare bounded DOUBLE-post, never a LOSS) is unlikely; the marker GET is the secondary belt. The recoverable lease eliminates permanent loss, which was the F3 hazard.
- [ ] **Step 3:** Green → commit `feat(fix-prompt): recoverable comment claim (lease, not success-marker) — crash cannot suppress the comment [F3, gate ③]`.

### Task W3.4: `update_pr_description` re-run audit

**Files:** Read the update-PR-description activity (locate exact file via grep); Test added only if needed

- [ ] **Step 1:** Read the activity: is the summary append idempotent (marker-replace) or a blind append? If marker-replace → add a 2-run integration assertion pinning it, no code change. If blind append → add the marker-replace (GET → strip existing marker block → append fresh) + test. Commit accordingly.

## Wave 4 — Abort-aware side effects (gate ① mechanics)

### Task W4.1: signal threading into the GitHub client + cloner

**Files:** Modify `apps/backend/src/integrations/github/api_client.ts`, `apps/backend/src/integrations/git/cloner.ts`; Tests `test/unit/github/api_client_abort.test.ts`, extend cloner tests

- [ ] **Step 1: Failing tests** — api_client: `request`/`_request` accept optional `signal`; an already-aborted signal rejects BEFORE any fetch (recording fetch stub sees zero calls); a live signal combines with the transport timeout via `AbortSignal.any([external, transportAbortSignal(timeoutMs)])`. cloner: `clone({…, signal})` — pre-spawn abort → no subprocess spawned; mid-clone abort → existing SIGTERM→SIGKILL teardown fires and the askpass script is removed (the finally must run on the abort path).
- [ ] **Step 2: Implement** (optional param, default absent → byte-identical current behavior for every existing caller). **Step 3:** green → two commits.

### Task W4.2: signal + pre-write gate on the LLM client

**Files:** Modify `apps/backend/src/integrations/llm/client.ts`; Test extend the client unit tests

- [ ] **Step 1: Failing test:** `invokeModel({…, signal: aborted})` on a ledger MISS rejects BEFORE the SDK call and BEFORE cost-cap reservation (counting stubs see zero); a ledger HIT with an aborted signal MAY still replay (replay is a read — allowed; assert it does NOT hit the SDK).
- [ ] **Step 2: Implement** — optional `signal` on `invokeModel`; the pre-write gate sits exactly between ledger-lookup-miss and cost-cap `checkOrRaise`. Pass `signal` into the SDK request options **iff preflight #8 confirmed support** (record either way in the commit body).
- [ ] **Step 3:** Green → commit `feat(llm): abort gate before paid call (no payment after abort) [gate ①]`.

### Task W4.3: pre-write gates at the GitHub write boundaries

**Files:** Modify `apps/backend/src/activities/post_review_results.activity.ts`

- [ ] `doPost` gains optional `signal`; checks `signal?.aborted` immediately BEFORE the create call and before `updateReview` — throws `TerminalCancelError("aborted")` (the claim row stays NULL → the next run's same-run takeover (W3.2) recovers it; interplay asserted in G1). Test + commit `feat(post): no GitHub write after abort [gate ①]`.

## Wave 5 — The shell

### Task W5.1: mutex acquire-or-reuse (D3)

**Files:** Create `apps/backend/src/runner/shell_mutex.ts`; Modify `apps/backend/src/runner/review_jobs_repo.ts` (`persistMutexId(jobId, mutexId)` — fenced); Test `test/integration/runner/shell_mutex.integration.test.ts`

- [ ] **Step 1: Failing tests:** (a) first run: `acquireOrReuseMutex({payload, jobId, repo, db})` with `job.mutex_id IS NULL` → acquires via the same transaction shape as the gate (tenancy recheck + `acquirePrReviewMutex(installation_id, repository_id, pr_number)`), persists `mutex_id` on the job row, returns `{mutexId, status:'acquired'}`; a busy FOREIGN lease → `{status:'busy'}` (caller maps to terminal-cancel per W5.2). (b) re-run reuse: `job.mutex_id` set + the mutex row passes **ownership validation** → `{mutexId, status:'reused'}` WITHOUT a competing acquire (no `skipped_busy` self-deadlock — the headline D3 fix). (c) **F6 ownership validation** — `job.mutex_id` points at a mutex row whose `installation_id`/`repository_id`/`pr_number` do NOT match the job payload, OR `released_at IS NOT NULL`, OR the lease is held by a DIFFERENT live holder → do NOT reuse; re-acquire fresh + persist the new id (and if that finds a foreign live lease → `busy`).
- [ ] **Step 2: Implement** — the reuse branch reads the mutex row by `job.mutex_id` and asserts, as a written invariant (not just "live"): `installation_id = payload.github_installation_id`-resolved-repo-tenant AND `repository_id = payload.repository_id` AND `pr_number = payload.pr_number` AND `released_at IS NULL` AND the lease is ours-or-expired (reclaim-by-holder via `renewPrReviewMutexLease`). Any mismatch falls through to a fresh `acquirePrReviewMutex`. The FK `review_jobs.mutex_id → pr_review_mutex(mutex_id)` (W0.1) guarantees the referenced row exists; this code guarantees it is the RIGHT row.
- [ ] **Step 3:** green → commit `feat(shell): mutex acquire-or-reuse with ownership validation (no self-skipped_busy; reuse only the matching live mutex) [D3, F6]`.

### Task W5.2: `runReviewJob` — the handler

**Files:** Create `apps/backend/src/runner/review_job_shell.ts`, `apps/backend/src/runner/in_process_ports.ts`; Test `test/integration/runner/review_job_shell.integration.test.ts`

- [ ] **Step 1 (ports):** `makeInProcessPorts(deps, signal): ReviewActivityPorts` — maps every port name to the REAL activity function exactly as `worker/build_activities.ts` registers them (use its wiring table as the source of truth; same DSN/client factories), each wrapped in `withAbortGate(name, fn)` that throws `TerminalCancelError("aborted")` when `signal.aborted` BEFORE dispatch (E1). External-write activities additionally receive the `signal` where W3/W4 added the param (post, fix-prompt, clone, LLM via the client). **F4: the review `LlmClient` (and its role cache) is constructed here with `LlmInvocationLedger.fromDsn(dsn)` AND `strictLedger: true` (W2.1) — so any paid Bedrock call in the shell path that lacks an idempotency context throws `LedgerRequiredError` rather than paying un-ledgered.** Unit-test the wrapper: aborted signal → no underlying call; strict client + un-ledgered paid call → throws.
- [ ] **Step 2 (shell):** `runReviewJob(deps): JobHandler` returning `async (job, signal) => { … }`:
  1. `const payload = verifyPayload(job)` (W0.2; hash mismatch → `TerminalCancelError("payload-integrity")`).
  2. `acquireOrReuseMutex` (W5.1); `busy` → `TerminalCancelError("mutex-busy")` (a FOREIGN review owns the PR — never spin).
  3. `claimCheck` hybrid (E4): `signal.aborted → throw TerminalCancelError("aborted")`; `renewPrReviewMutexLease(mutexId)` returns false → `TerminalCancelError("mutex-lost")` (transient renew ERROR stays fail-open per current semantics); `SELECT current_run_id …` ≠ `job.run_id` → `TerminalCancelError("superseded")` (fail-closed — D3: "do not keep reviewing after losing the mutex").
  4. Heartbeat-coupled mutex renewal (D3): the shell wraps the handler body in its OWN light renew loop (`cancellableSleep(clock, renewS, signal)` + renew; Phase-1 heartbeat pattern) so the mutex lease renews in lockstep with the job lease — the runner's `runOneJob` heartbeat stays untouched.
  5. Replicate the body sequence verbatim from `review_pull_request.workflow.ts::reviewPullRequest` with direct calls: placeholder → enrichPrFiles → allocateWorkspace → ANALYSIS_STARTED → linked issues/reviewers/manifests/parent findings (same `stageOutcome` fail-open wrappers) → build `ReviewPipelineContext` with: `pr.runId = job.run_id` (**finding #5 — NEVER mint a new run_id**), `claimCheck` = (3), `onPlaceholderTeardown`, **`arbitrationNow = job.started_at ISO` (E2)**, `activities = makeInProcessPorts(deps, signal)` → `await orchestrate(ctx)` → `runLifecycleBookkeeping` equivalent (direct calls; `doPost` receives `sameRunTakeover: true` + `signal`) → ANALYZED → `finalizeReviewRun`.
  6. catch: `TerminalCancelError` rethrow (runOneJob settles `cancelled`); `StaleWriteError|StateDrift|CurrentRunMismatch|PrMutexLostClaim` → wrap in `TerminalCancelError` (E3); else rethrow (settles `failed`/retry).
  7. **terminal + finally (E6, abort-EXEMPT):** the run-state transition is part of the **deterministic terminal path, not best-effort (F5)** — on a `TerminalCancelError`/supersede, `recordRunCancelled` (`review_runs → CANCELLED`) is a REQUIRED step with a bounded in-handler retry (a cancelled job must never leave a RUNNING run — that is an operational leak); on a thrown failure, `recordRunFailed`. Only the **cleanup releases** (idempotent mutex release + workspace release) are best-effort in the `finally`. None of these check `signal` (E6). Backstop for a HARD crash that skips the handler entirely: the unified reaper (W6.1) + the age-sweep's `NOT EXISTS` scope (W6.2) — a `cancelled`/`dead` job no longer shields its run, so the run gets reaped.
- [ ] **Step 3: Integration test (happy path):** enqueue a job with a real payload fixture; run `runOneJob` with `runReviewJob` wired and ALL ports stubbed at the in-process bundle level (counting stubs) against `:5434` → outcome `done`; run/review lifecycle rows transitioned; mutex released. Commit `feat(shell): runReviewJob — the non-Temporal review-job shell [W5]`.

## Wave 6 — Reaper unification (D3; gate ④ mechanics)

### Task W6.1: unified reaper transaction

**Files:** Modify `apps/backend/src/runner/review_jobs_repo.ts` (replace `reapCrashLooped` with `reapStuckRuns`), `apps/backend/src/runner/review_job_runner.ts` (RunnerLoop idle call); Test extend runner integration tests

- [ ] **Step 1: Failing test:** seed run(RUNNING) + job(leased, `leased_until` past, attempts exhausted) + a held mutex whose id is on the job row → ONE `reapStuckRuns()` call, ONE transaction → job `dead`, run `CANCELLED` (`cancel_reason='timeout'`, `cancelled_at` set — biconditional CHECK honored), mutex `released_at` set, ONE audit/lifecycle event recorded (D3's fourth requirement). Negative: live lease → all three untouched. Expired lease with attempts REMAINING → left for `claim()` reclaim, nothing reaped.
- [ ] **Step 2: Implement** — single transaction (`withPgTransaction` idiom); cross-tenant sweep marker as in Phase 1. Subsumes the Phase-1 crash-loop dead-letter (delete `reapCrashLooped`; update its tests).
- [ ] **Step 3:** Green → commit `feat(runner): unified reaper — job+run+mutex+audit in one txn [D3, gate ④]`.

### Task W6.2: scope the age-sweep with `NOT EXISTS`

**Files:** Modify `apps/backend/src/activities/review_run_reaper.activity.ts`; Test extend `test/integration/activities/review_run_reaper.activity.integration.test.ts`

- [ ] **Step 1: Failing test (deep-read GATE TEST 1):** run RUNNING with `started_at = now()-7200s` + a LIVE job row (`state='leased'`, future lease) → reaper leaves it RUNNING (the live job shields it). Dead/delete the job row → re-run → CANCELLED. (Predicate must use exactly `state IN ('ready','leased')` so it rides `uq_review_jobs_active_run`'s partial index.)
- [ ] **Step 2:** add D3's verbatim predicate to the CTE WHERE: `AND NOT EXISTS (SELECT 1 FROM core.review_jobs j WHERE j.run_id = review_runs.run_id AND j.state IN ('ready','leased'))`.
- [ ] **Step 3:** Green → commit `feat(reaper): age-sweep ignores runs with a live review_jobs row [D3, gate ④]`.

### Task W6.3: runbook — post-cutover schedule retirement

**Files:** Create `docs/runbooks/de-temporal-cutover-reaper-retirement.md`

- [ ] Document (D3 verbatim requirement): after Phase-4 cutover + soak, the `codemaster-review-run-reaper` Temporal Schedule must be deleted by an operator (`temporal schedule delete --schedule-id codemaster-review-run-reaper`) because `ensureCronSchedule` never deletes existing schedules (code removal alone leaves it firing); until then the W6.2 predicate makes its firing safe. Same note for `codemaster-mutex-janitor` (it stays — the mutex backstop; the unified reaper releases shell-held mutexes first). Commit `docs(runbook): reaper schedule retirement at cutover [D3]`.

### Task W6.4: wire the ledger pruner

**Files:** Modify `apps/backend/src/runner/review_job_runner.ts`

- [ ] `RunnerLoop` idle cycle calls `pruneOlderThan(retentionDays)` at most once per `CODEMASTER_LLM_LEDGER_PRUNE_INTERVAL_S` (default 6h, tracked via `clock.monotonic()` — no wall clock); test asserts old ledger rows vanish after an idle cycle. Commit `feat(runner): ledger retention wired to the runner idle cycle [D2]`.

## Wave 7 — GATE PROOFS (the chaos suite; Phase 2 is NOT done until these are green)

**Files:** Create `test/integration/runner/review_job_shell_gates.integration.test.ts` (+ helpers in `_fixtures.ts`). All against `:5434`, isolation hook, `--no-file-parallelism`, counting stubs at the in-process port bundle + SDK/GH client level.

### G1 — abort-aware side-effect contract ① (guarantee precisely, per F7)
The enforceable guarantee is: **no NEW paid/external call STARTS after `signal.aborted`** (not "zero in-flight"); every external call RECEIVES the `signal`; and a call already on the wire that the provider cannot cancel may complete — but is made safe by the ledger (its result is stored + replays, never re-charged via the cost-cap fence) and the post-side claim (no duplicate GitHub write).
- [ ] Fire an `AbortController` at the pre-aggregate `claimCheck` boundary → assert: handler settles `cancelled`; the recording GH client saw ZERO `createReview`/`updateReview`/`createIssueComment` STARTED after the abort timestamp; the counting LLM SDK STARTED zero new paid calls after it; the cloner spawned nothing after it; every external stub that WAS mid-call received `signal` (assert the arg carried the aborted signal); **the mutex + workspace were still released (E6 cleanup ran)**. Second scenario: abort DURING the post stage (between claim and the GitHub call) → `doPost`'s pre-write gate throws, the claim row stays NULL, and a follow-up re-run with `sameRunTakeover` completes the post exactly once (W3.2 interplay). Third (ledger-safety): a paid LLM call already on the wire that *completes* after abort is stored in the ledger and the cost-cap charges it exactly once (no double-charge) — proving the "may complete but is safe" clause.

### G2 — LLM ledger protocol ②
- [ ] Run the shell to a forced crash AFTER chunk-fanout + walkthrough completed but BEFORE `markDone` (throw injected in a late port). Re-run the same job (claim reclaims; same `run_id`, same payload). Assert across BOTH runs: paid SDK calls == exactly one per chunk + one per exercised purpose (`walkthrough|curator|rerank|fix_prompt`); every second-run lookup was a HIT (`hit_total` delta == replayed count); cost-cap stub charged once per key; findings byte-identical across runs.

### G3 — post-review idempotency ③ (D4's verbatim scenario + supersede)
- [ ] (a) First run completes through post (stub returns reviewId 999 + N comment ids) then crashes before finalization → re-run → lost-claim path returns the STORED N comment_ids → lifecycle finalization proceeds; GH saw ONE `createReview` total, ONE `updateReview` on the re-run; exactly one `posted_reviews` row; fix-prompt comment posted exactly once. Plus the **F3 fix-prompt crash-recovery** sub-case (W3.3 test b) re-asserted at the shell level. (b) Supersede (deep-read Scenario A): while run R1's shell is paused at a checkpoint, `allocateRun` R2 (supersede + `flipCurrentRun`) → resume R1 → R1 settles `cancelled` (never `ready`), posts NOTHING (claimCheck fail-closed OR `assertCurrentRun` blocks), releases its mutex. **F5: assert BOTH terminal states — `core.review_jobs.state='cancelled'` AND `core.review_runs.lifecycle_state='CANCELLED'` (no cancelled-job-with-RUNNING-run leak)** — and the mutex row is `released_at NOT NULL`.

### G4 — reaper unification ④
- [ ] (a) Live-lease shield: RUNNING run aged 2× the stale threshold + live leased job → age-sweep no-ops; (b) crash: expired lease + attempts exhausted + held mutex → one `reapStuckRuns` txn flips job→dead, run→CANCELLED, mutex→released, audit row present; an immediate fresh mutex acquire for that PR succeeds (`accepted`, not `skipped_busy`) — no 30/60-min blocking window remains; (c) re-run path: expired lease with attempts remaining → `claim()` reclaims (new token, same `run_id`), nothing reaped, mutex REUSED via `job.mutex_id` (W5.1).

- [ ] **Final step:** full verification — `npm run typecheck` + `npm run lint` (0 errors) + `npm run gates` + unit subtree + `CODEMASTER_PG_CORE_DSN=… npm run test:integration` (the pre-existing `clone_asserts_lease` failure on main is known/unrelated) + **the four gate tests green twice consecutively**. Commit `test(shell): gate proofs ①–④ green [Phase-2 exit]`.

---

## Phase 2 exit criteria
1. All four gate proofs (G1–G4) green against `:5434`, twice consecutively, under `--no-file-parallelism`.
2. `typecheck`/`lint` 0 errors; `gates` exit 0 with no new findings; no `Math.random`/raw timers in new `src/`; tenancy markers on every cross-tenant raw-SQL site.
3. The Temporal path untouched and green (existing workflow/activity tests pass unchanged; `doPost` default behavior byte-identical when `sameRunTakeover` absent; the shared ports type unmodified).
4. The traceability table's 18 findings each closed by their named task (re-audit at review time).
5. No production enqueue caller introduced (cutover remains Phase 4); the shell + runner are exercised by tests only.
6. The W6.3 runbook exists; the W1.1 plain-Node proof is in the suite as a permanent regression pin.
7. **§AC — v2-review acceptance (blockers fixed in-plan; mediums asserted by a test, not deferred):**
   - **F1** `job_payload_schema_version` is the column name; a test asserts an enqueued payload's inner `schema_version` must be `2`.
   - **F2** post-migration `count(review_jobs WHERE state IN ('ready','leased'))` = 0; the shell never claims an un-payloaded row.
   - **F3** the fix-prompt crash-recovery test (W3.3 b) is green — a crash between claim and post does NOT suppress the comment.
   - **F4** a strict-ledger test: a paid shell-path `invokeModel` without idempotency context throws; all 5 paid sites are ledgered in G2.
   - **F5** G3(b) asserts BOTH `review_jobs.state='cancelled'` AND `review_runs.lifecycle_state='CANCELLED'`.
   - **F6** a W5.1 test asserts a mismatched/foreign `mutex_id` is NOT reused (re-acquire fresh); the FK is present.
   - **F7** G1 asserts "no NEW paid/external call after abort" + the in-flight-completes-but-ledger-safe sub-case.
   - **F8** `\d` shows the three new CHECKs; **F9** a unit test asserts the metric `purpose` == the ledger-key `purpose` per site.

## Self-review (writing-plans)
- **Gate coverage:** ① W4.1–4.3 + E6 + G1; ② D2/W2.1–2.3 + G2; ③ D4/W3.1–3.4 + E7 + G3; ④ D3/W5.1/W6.1–6.3 + G4. The owner's four-gate directive is the exit criterion, not a checklist item.
- **Decisions:** D1–D4 captured verbatim (schema DDL, key rules, reaper txn contents, repair metric); E1–E8 documented with rationale; no decision is left to the implementer.
- **Placeholders:** W3.4 and preflight #8 are deliberate verify-then-act tasks (unknowns named, both bounded); everything else carries concrete files, signatures, SQL, scenarios, and commit messages.
- **Type consistency:** `TerminalCancelError`/`RunOutcome 'cancelled'` (W0.3) used by W5.2(6), W4.3, G1/G3; `verifyPayload` (W0.2) by W5.2(1); `purposeChunkId` (W2.1) by W2.2/G2; `sameRunTakeover` (W3.2) by W5.2(5), G1, G3; `acquireOrReuseMutex` (W5.1) by W5.2(2), G4(c); `reapStuckRuns` (W6.1) by W6.4's host loop, G4(b).
- **Migration safety:** 0037 is additive on non-hot tables (`review_jobs`/`posted_reviews`/`fix_prompts` are not in the hot-table list); add-default-then-drop-default protects existing rows; the F2 pre-Phase-2 sweep is an UPDATE (dead-letter), NOT a DELETE (row retained → recoverable → no archive needed); the three new CHECKs validate clean on existing data (`comment_ids` default `'[]'` is an array; `fix_prompts` new cols default NULL → both biconditional sides hold); the `mutex_id` FK is `ON DELETE SET NULL` and nothing DELETEs `pr_review_mutex`.
