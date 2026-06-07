# Review-Orchestrator Live Dual-Run Runbook (2026-06-06)

The orchestrator migration (`feat/review-orchestrator-port`, Stages 0–6) is **code-complete** and proven
to compose end-to-end **in-process** (`TestWorkflowEnvironment`, replay-safe). This runbook is the final
**live** validation: run the real worker against a real Temporal server + the disposable Postgres + Ollama
and execute an actual review workflow. This is operator-gated (you start Temporal).

## Pre-flight

1. **Disposable Postgres** (NEVER the cluster) — already up at `localhost:5434` db `codemaster`, migrated to head.
   ```bash
   docker ps --filter name=cm-phase1-pg   # expect Up
   ```
2. **Ollama** at `localhost:11434` with a chat model for the review + walkthrough roles and an embed model.
   ```bash
   curl -s localhost:11434/api/tags | jq '.models[].name'   # expect a chat model + mxbai-embed-large
   ```
3. **Temporal dev server** — YOU start one of:
   ```bash
   temporal server start-dev                 # gRPC on :7233 (simplest), OR
   kubectl port-forward -n codemaster svc/temporal-frontend 7233:7233   # the cluster's Temporal
   ```
   Use an **isolated namespace + task queue** so it never collides with real workflows:
   `TEMPORAL_NAMESPACE=dualrun`, `TEMPORAL_TASK_QUEUE=review-pr-dualrun`.
4. **LLM provider settings** — seed `core.llm_provider_settings` so `LlmClientCache.forRole` resolves the
   `primary` role (review + walkthrough + fix-prompt purposes) to the local Ollama (Bedrock-shaped) endpoint.
   The provider is DB-selected per-role (see memory `project_llm_mode_vestigial`); point it at Ollama's
   OpenAI-compatible `/v1` with a local model. (Seed script: TODO at dual-run time — mirror the smoke seed.)
5. **GitHub** — for a real PR clone + post, the token provider needs Vault/env creds + a test repo/PR
   (e.g. an `inder1991` fixture). For a FIRST dry run, a fixture repo + a fixed `ReviewPullRequestPayloadV1`
   (schema_version=2) is enough to drive clone→…→post.

## Run

```bash
# 0. Shared env — the worker + the dispatch must agree on DSN + namespace + task queue.
export CODEMASTER_PG_CORE_DSN=postgresql://postgres:postgres@localhost:5434/codemaster
export TEMPORAL_ADDRESS=localhost:7233
export TEMPORAL_NAMESPACE=dualrun
# Task queue defaults to `review-pull-request-dualrun` on BOTH sides (worker temporal_config.ts ↔
# prove_full_chain.ts), so leaving TEMPORAL_TASK_QUEUE unset is fine on localhost.

# 1. The worker — registers buildActivities() + the REAL reviewPullRequest workflow.
CODEMASTER_GITHUB_INSTALLATION_ID=<numeric-install-id> \
  npx tsx apps/backend/src/worker/main.ts

# 2. Dispatch a real review against YOUR test PR. scripts/dualrun/prove_full_chain.ts seeds the FK chain
#    with these real GitHub identifiers, dispatches `reviewPullRequest`, awaits ReviewPullRequestResultV1,
#    and verifies core.review_findings + core.review_walkthroughs + review_runs.status=COMPLETED + the
#    audit.workflow_events milestone trail.
DUALRUN_GH_OWNER=<owner> DUALRUN_GH_REPO=<repo> \
DUALRUN_GH_INSTALLATION_ID=<numeric-install-id> \
DUALRUN_HEAD_SHA=<40-char-head-sha> DUALRUN_PR_NUMBER=<n> \
  npx tsx scripts/dualrun/prove_full_chain.ts
```

> `prove_full_chain.ts` is the first runnable artifact for the FULL chain (vs `prove_pipe.ts`, which only
> dispatches the spine). It is typecheck + lint clean but has **not** been executed live — it needs the
> worker + Temporal + Ollama + a real PR. The **first run is the debugging surface**: the FK-seeding
> contract and any activity-level gaps surface here, which is the whole point of the dual-run. (Example of
> exactly this: the STAGE_NAMES crash that the Temporal-gated tests caught — commit `04594cc`.)

## Verify (the acceptance criteria)

- Temporal Web shows the workflow executing `gate → placeholder → enrich → allocate → clone → classify →
  [chunk‖static-analysis] → carry-forward → fan-out(review) → dedup → aggregate → post-filter → citation →
  persist → arbitration → walkthrough → [post‖check] → fix-prompt → lifecycle bookkeeping → ANALYZED → finalize → cleanup → release-mutex`.
- `ReviewPullRequestResultV1.status == "accepted"`, `findings_count > 0`.
- `core.review_findings` + `core.review_walkthroughs` rows persisted (stale-write-guarded).
- A GitHub review/check-run posted (or the degraded-publication outcome recorded).
- `review_runs.status == COMPLETED` (no zombie RUNNING).

## Notes

- **Tracked deferrals** (won't fire in the dual-run; expected): real static-analysis runners
  (`FOLLOW-UP-static-analysis-stage4-runners` — `staticAnalysis` returns empty-valid, so no Tier-1 linter
  findings) + the Confluence cluster (`FOLLOW-UP-confluence-cluster` — legacy BM25+ANN retrieval only).
- The LLM idempotency ledger (ADR-0068) is wired: a retried chunk replays the stored completion instead of
  re-paying Bedrock/Ollama.
- Keep all DB writes on `localhost:5434` (the disposable PG) — never the cluster — until the mutex/lifecycle
  has been observed clean on a live run.
