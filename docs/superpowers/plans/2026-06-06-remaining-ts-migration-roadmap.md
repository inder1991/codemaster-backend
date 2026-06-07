# Remaining Python→TypeScript Migration — Program Roadmap (2026-06-06)

**Goal:** Migrate the rest of the codemaster platform (everything *around* the review engine) from the
frozen Python (`vendor/codemaster-py/`) to TypeScript (`apps/backend/`, `libs/contracts/`).

**Status of the review engine:** ✅ **DONE.** This roadmap covers ONLY what remains.

> Derived from a 12-auditor codebase sweep (Python source vs TS state, per journey) on 2026-06-06. The
> user's 10-journey analysis was verified accurate; the sweep added 2 genuinely-new journeys
> (knowledge-approval, feedback-ingestion). Per-journey implementation plans are authored just-in-time
> when each is picked up (per the sprint-readiness convention) — this is the program-level map.

---

## 1. Executive summary

The **review engine is fully migrated** — 73 subsystems, 101 contracts, 37 registered activities: the
entire `clone → classify → chunk → retrieve → review(LLM) → aggregate → walkthrough → post` pipeline plus
retrieval (BM25/ANN/Confluence/RRF/floors/rerank), the LLM stack (client cache, provider settings, cost
enforcer, idempotency ledger), security (tenancy, audit codec, trust-tier, redaction, output-safety),
GitHub client + token provider, policy, config, observability, and the domain repos.

**What remains is the *platform around* the engine** — how it RECEIVES work, how it's OPERATED, and the
BACKGROUND jobs that keep it healthy and fed with knowledge. That work collapses into:

- **3 shared foundations** that gate everything (an HTTP server, a scheduler/multi-workflow worker, the
  outbox spine). The audit's "multi-month" estimates are almost entirely these foundations folded in.
- **~12 journeys** that sit on top of the foundations and are each independently tractable once the
  foundations exist.

**Today the engine is a pure Temporal worker with one workflow type and no HTTP server** — it can review a
PR only if something hands it a fully-formed payload (the `prove_full_chain.ts` harness does this manually).
The remaining migration makes the platform *self-serve*: real webhooks come in, reviews run, operators
manage it, and background jobs keep knowledge + state healthy.

---

## 2. The DONE baseline (do NOT re-plan)

| Area | State |
|---|---|
| Review orchestrator workflow + `review/pipeline/*` (orchestrator, gates, state, posting, degradation, parallelism, helpers) | fully migrated |
| 37 registered activities (`build_activities.ts`) — clone, classify, chunk_and_redact, static_analysis, retrieve_knowledge, bedrock_review_chunk, dedup, aggregate, walkthrough, post, arbitration, fix-prompt, citation, lifecycle, mutex/workspace, manifests, carry-forward, etc. | fully migrated |
| Retrieval read path — BM25 + ANN + Confluence + RRF + floors + rerank (incl. the new flag-gated LLM reranker) | fully migrated |
| LLM stack — client cache, provider settings repo (Vault), cost enforcer, ADR-0068 idempotency ledger, Bedrock adapter | fully migrated |
| Security — tenancy plugin, audit codec (AES-256-GCM + the ADR-0070 `plain:v1:`), trust-tier, redaction (PII/secret/output), output-safety | fully migrated |
| GitHub — API client, token provider (JWT→install token via Vault), issue/review clients, subprocess cloner | fully migrated |
| 101 contracts (`libs/contracts/src`), 12 domain repos, policy system, config loader, observability metrics, Vault/blobstore/embeddings adapters | fully migrated |

---

## 3. The 3 foundations (critical path — build first)

Every remaining journey depends on at least one of these. **Nothing lands end-to-end without them.**

### F1 — HTTP server + the ingest/admin app pod  *(~1–2 weeks)*
The TS backend has **no HTTP server** today (only the `verifyGithubSignature` utility exists). Need:
- A Fastify server + app factory (port of `codemaster/api/app.py::build_app`): route registration,
  exception handlers, raw-body handling, health/ready/version.
- A **separate DB pool/session factory for the HTTP pod** (distinct from the worker's ADR-0062 pool).
- Vault wiring (deferred-init pattern, already exists as an adapter) for secret reads at the HTTP edge.
- The middleware framework seam (error → status mapping; the CSRF/session/authz middleware lands with F1
  but is filled in by the auth journey).
- **Unblocks:** webhook-ingress, auth-session, admin-api, feedback-ingestion, the confluence/embedder admin endpoints.

### F2 — Multi-workflow worker + Temporal Schedule registration  *(~1 week)*
The worker registers exactly **one** workflow type (`reviewPullRequest`) and has **no scheduler**. Need:
- A multi-workflow registration pattern (load N workflow types per task queue), and the **separate task
  queues** the architecture mandates (CLAUDE.md invariant #1): `review-default`, `refresh-default`,
  `ingest`, `partition-maintenance`, etc. — distinct worker pools.
- A long-lived **Temporal Client** at worker bootstrap (separate from the Worker connection) to call
  `client.createSchedule(...)`, plus idempotent `ensure_*_schedule()` lifespan hooks (mirroring Python).
- Session-factory DI for background activities.
- **Verify** `@temporalio/client` supports the Schedule API (`ScheduleSpec`, `overlap=SKIP`).
- **Unblocks:** every scheduled/background workflow — ops-maintenance, confluence-sync, semantic-docs, embedder-generation, outbox-dispatcher.

### F3 — Outbox table + dispatcher spine  *(~1–2 weeks)*
The webhook persistence emits **outbox rows**; a singleton **dispatcher** drains them to start workflows.
This is the spine that connects intake → review. Need:
- `core.outbox` schema available (likely already in `migrations/0001_baseline.sql` — **verify**, don't assume).
- `OutboxDispatcherWorkflow` — a **singleton, long-running** workflow (batched drain loop, `workflow.sleep`
  + `continueAsNew` for history bounding) + activities (claim_pending_rows, dispatch_row w/ lease
  heartbeat + stale-write guard, mark_dispatched/failed, extend_lease).
- A **sink registry** (`registerSink(name, handler)`) with the initial handlers: `temporal_workflow_start`
  (the review-dispatch path), `vault_credential_write`, `bedrock_payload_archive`.
- `ensure_outbox_dispatcher_singleton()` bootstrap + an OTel depth gauge.
- **Unblocks:** the webhook→review end-to-end path, plus reconcile / code-owners / semantic-docs dispatch.

> **Risk:** the singleton + `continueAsNew` determinism boundary is the trickiest single piece in the
> whole roadmap. Build + replay-test it carefully (it's the same V8-sandbox discipline the review workflow uses).

---

## 4. The journeys (sit on the foundations)

Effort bands below are *incremental over the foundations* (the audit's larger bands double-counted F1/F2/F3).

### Phase B — Live intake (make the product RECEIVE work) — highest value after foundations

**B1. GitHub webhook ingress**  *(deps: F1, F3 — ~2–3 weeks)*
The single largest non-admin port: `github_webhook_persistence.py` is **1888 lines**. Port: the
`POST /v1/github/webhook` route (sig verify → parse → persist), the **SERIAL+SUPERSEDE review-run
allocator** (`_review_run_allocator.py`), the idempotency dedup (`cache.cache_idempotency` ON CONFLICT),
the PR/review/gh_user upserts (fail-open SAVEPOINTs), workflow-event emission (atomic `sequence_no` via
advisory lock), issue-link parsing, action→trigger_type mapping, cross-fork reject, and **outbox emission**
(review dispatch + reconcile + code-owners + semantic-docs). Risk: idempotency-at-scale + the allocator's
concurrency correctness.

**B2. Installation/repository reconciliation**  *(deps: F2, F3 — ~1–2 weeks)*
3 workflows (`ReconcileInstallation`, `ReconcileRepositories`, `RepairInstallationRepositories`) + 3
activities + the `cache.repository_repair_state` cooldown/blocked-reason state machine (ADR-0054). The
webhook (B1) produces the repair-dispatch; this consumes it. Makes the platform self-heal when a PR arrives
for an unknown repo.

### Phase C — Knowledge subsystem (make reviews BETTER — currently fed from EMPTY stores)

**C1. Semantic-docs + symbol-graph refresh**  *(deps: F2 — ~2 weeks)*
`RefreshSemanticDocsWorkflow`, `MarkStaleChunksWorkflow`, **`RefreshSymbolGraphWorkflow`** (+ activities,
`discover_knowledge_docs`, `chunk_markdown`, `embed_doc_chunks`, symbol extractors for TS/JS/Python →
`core.repo_symbols` + `core.symbol_references`). **This is the producer the review orchestrator's
`removed_or_changed_symbols`/`consumer_hits` were left empty waiting for** — closing it lights up
cross-repo blast-radius context. Needs `EmbeddingsPort` (exists) + a `KnowledgeChunkRepoPort` + a
`RepoSymbolRepoPort` seam.

**C2. Confluence sync ingestion**  *(deps: F2, + the admin endpoints from D — ~2–3 weeks)*
`ConfluenceIngestWorkflow` (6h schedule), `TriggerPageResyncWorkflow`, 6 sync activities (fetch_space_pages,
fetch_page_body, sanitize, chunk_and_embed, upsert_chunks), the HTML chunker + sanitizer (bleach +
injection detection) + hard-limits, `core.confluence_chunks` + `core.confluence_page_approvals` repos, and
the Confluence REST client. The retrieval *read* path already exists; this fills the store it reads.

**C3. Knowledge-approval workflow**  *(deps: F2, admin — ~1 week)*
Long-lived approval orchestrator with **signal handlers**, + the admin approve/revoke endpoint that signals
it. (Page-approval gating for confluence chunks.)

### Phase D — Operator surface (production operability)

**D1. Auth / session / user management**  *(deps: F1 — ~1–2 weeks)*
Routes (`/api/auth/login|me|logout|csrf`), HMAC session cookies (`crypto.timingSafeEqual`), CSRF
(double-submit), per-IP rate-limit, credential lockout, RBAC (super_admin / platform_owner /
platform_operator / reader), the **three-tier login** dispatch (local_users → users → LDAP), super-admin
bootstrap. Risk: the three-tier precedence + lockout edge cases (the Python had a caught `>=`-vs-`==` bug —
port the *fixed* behavior + its tests).

**D2. Admin API / dashboard backend**  *(deps: F1, D1 — ~4–6 weeks, the biggest)*
**30 routers, 78 endpoints, 26 Kysely repo adapters, 3 Temporal dispatch adapters.** Cost caps, findings,
reviews, repositories, members, flags, integrations, knowledge, telemetry, page approvals, credentials,
status, taxonomy gaps, llm_models. Port systematically (one router group at a time, each with its
authz-matrix tests). Includes the two-person-approval state machine (optimistic concurrency, grace
windows). This is a large, mechanical-but-careful surface — best done as its own sub-program.

### Phase E — Embedder lifecycle + operational maintenance (production hygiene)

**E1. Embedder generation lifecycle**  *(deps: F1-admin, F2 — ~3–4 weeks)*
5 workflows (Reembed / Validate / GarbageCollect / HealthCheck / ConsistencyMonitor), 11 activities, 11
admin endpoints, the `EmbedderGenerationService` + `embedding_generations` state machine (the biconditional
CHECK + the gen-1 demote gotcha from prior memory). Lets you roll embedding models safely.

**E2. Operational maintenance workflows**  *(deps: F2 — ~2–3 weeks)*
8 scheduled workflows, each small but each a Temporal schedule: **mutex janitor + review-run reaper**
(near-critical — the review pipeline leaks mutex/run-state without them; tie to the prior mutex-liveness
work), workspace retention, run-id retention, partition maintenance, **prune-retrieval-traces +
refresh-retrieval-traces-MV** (couple these with the deferred **#3 RetrievalTraceV2 producer** — build the
trace + its lifecycle together), `llm_calls` daily rollup. Plus the outbox depth monitor.

### Phase F — Smaller journeys

**F-a. Code-owners sync**  *(deps: F2, F3 — ~1 week)* — `SyncCodeOwnersWorkflow` + activity (fetch
`.github/CODEOWNERS`) + the `core.flags` reader that flips the currently hard-disabled suggested-reviewers
(`build_activities.ts` `isEnabled: async () => false`). Watch GitHub rate-limit at fleet scale (why Python
ships it default-off).

**F-b. Feedback ingestion**  *(deps: F1 — ~days)* — `POST /v1/feedback` endpoint + persistence to the
feedback-event repo.

---

## 5. Recommended sequence

```
F1 (HTTP)  ─┬─────────────────────────────────────────────► D1 auth ─► D2 admin-api
            │                                                              │
F3 (outbox)─┼─► B1 webhook ─► (live intake works)                         └─► C2 confluence, E1 embedder admin
            │      └─► B2 reconcile
F2 (sched) ─┴─► C1 semantic-docs/symbol-graph
                 ├─► E2 ops-maintenance (+ #3 trace) ◄── mutex-janitor/reaper near-critical for prod
                 ├─► C3 knowledge-approval
                 └─► F-a code-owners
F1 ─► F-b feedback
```

**Priority order (value × unblock):**
1. **Foundations F1 + F2 + F3** (nothing works end-to-end without them).
2. **B1 webhook + B2 reconcile** — the product can finally receive real PRs without manual dispatch. Highest product value.
3. **E2 mutex-janitor + reaper** (subset of ops) — pull these forward; the live review pipeline needs them for production stability.
4. **C1 semantic-docs/symbol-graph** — cheap, lights up cross-repo review context that's currently empty.
5. **D1 auth → D2 admin-api** — the operator/dashboard surface (large; can run in parallel with C/E by a second stream).
6. **C2 confluence, C3 approval, E1 embedder, F-a code-owners, F-b feedback** — fill out the remaining surface.

---

## 6. Cross-cutting concerns

- **Deployment topology changes.** Today: one worker pod. Target: an **ingest pod** (HTTP, webhook), an
  **admin/api pod** (HTTP, admin+auth), the **review worker pool**, and **background/schedule workers**
  (`refresh-default`, `partition-maintenance`, ops). Each journey carries its Helm/OpenShift wiring +
  env vars (`CODEMASTER_PG_CORE_DSN`, `VAULT_ADDR`, etc.). Per CLAUDE.md invariant #1, background work runs
  on different queues/pools than the review spine — preserve that.
- **Schema: verify-don't-assume.** `migrations/0001_baseline.sql` is a dump of the full Python schema, so
  most tables (`core.outbox`, `confluence_chunks`, `repo_symbols`, `embedding_generations`, …) **likely
  already exist** — each journey should confirm its tables are present and add only genuinely-new DDL
  (following the expand-contract + biconditional-CHECK discipline).
- **HTTP framework:** Fastify (the audit's assumption; aligns with the existing TS stack). Decide once, in F1.
- **Pydantic → Zod:** every new router/contract is a Zod port with a parity test vs the frozen Python
  (the established pattern — `libs/contracts` already has 101 of these).
- **The singleton/`continueAsNew` boundary** (F3 outbox, embedder consistency-monitor) is the highest
  determinism risk — replay-test like the review workflow.
- **Testing:** keep the parity-vs-frozen-Python discipline (cassettes for external services; authz-matrix
  rows for every admin endpoint; per-migration forward/rollback tests; the smoke-runbook gate per sprint
  that touches the spine).

---

## 7. Effort summary

| Bucket | Pieces | Incremental effort |
|---|---|---|
| **Foundations** | F1 HTTP · F2 scheduler · F3 outbox | **~3–5 weeks** |
| Live intake | B1 webhook · B2 reconcile | ~3–5 weeks |
| Knowledge | C1 semantic/symbol · C2 confluence · C3 approval | ~5–6 weeks |
| Operator surface | D1 auth · D2 admin-api | ~5–8 weeks |
| Lifecycle + ops | E1 embedder · E2 ops (+ #3 trace) | ~5–7 weeks |
| Smaller | F-a code-owners · F-b feedback | ~1–2 weeks |

**Total: ~6–8 months single-stream; meaningfully less with two parallel streams** (e.g., one stream on
intake+knowledge+ops, a second on auth+admin-api, after the foundations land). The foundations are the
gate — land F1/F2/F3 first, then the journeys parallelize.
