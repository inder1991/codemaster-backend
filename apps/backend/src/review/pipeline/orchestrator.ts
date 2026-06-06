// orchestrator — the deterministic review-pipeline driver (finding 1).
//
// 1:1 PORT of the frozen Python orchestrate_review_pipeline
// (vendor/codemaster-py/codemaster/workflows/review_pipeline_orchestrator.py:412) for the SPINE happy
// path, FUSED with the per-chunk ReviewContextV1 build the Python workflow body's `_review_chunk` closure
// performed (review_pull_request.py:1513). In the Python the orchestrator was unopinionated about the
// chunk callable and the workflow body injected `_review_chunk`; the TS port pulls the per-chunk context
// build INTO the orchestrator (as `buildChunkContext`) so the whole deterministic spine is one
// unit-testable module — the workflow body (Workflow phase) only wires the typed activity ports + state.
//
// ── SIGNATURE (finding 2) ──
// The ~35-kwarg Python signature collapses to ONE typed `ReviewPipelineContext` object
// ({ repo, pr, activities, limits, state }). No positional/callback explosion.
//
// ── GATE COLLAPSE (finding 3 / gates.ts COLLAPSED_GATES) ──
// This drives a NEW Temporal workflow type with ZERO Python histories, so every `workflow.patched(marker)`
// is unconditionally TRUE. The TRUE branch of every gate is ported as STRAIGHT-LINE code; the patched()/
// deprecate_patch() calls and ALL legacy/false branches are dead code and are NOT ported. The gates that
// land at THIS stage (Stage 1) as straight-line: repo-config-wiring, pr-topology-manifest,
// retrieval-knowledge-wiring, persist-review-walkthrough. The collapsed reads documented inline cite their
// gates.ts ledger entry.
//
// ── STAGE-4 WIRED (build-retrieved-evidence collapse-on) ──
//   * retrieved_evidence / build_retrieved_evidence — the per-chunk evidence manifest producer is now
//     dispatched as a Node ACTIVITY (ports.buildRetrievedEvidence) inside buildChunkContext, because the TS
//     ev_id mint uses node:crypto (banned in the workflow sandbox; ADR-0065/0066). The orchestrator only
//     holds the RetrievedEvidenceV1 TYPE (type-only import; erased at emit) so the bundle stays crypto-free.
//     When the port is omitted (unit tests) retrieved_evidence stays [] (the legacy default).
//
// ── CONFLUENCE / HYBRID RETRIEVAL (Stage 4 — confluence cluster; collapse-on) ──
//   buildChunkContext builds the Sub-spec B T17 confluence-context (pickPrContext over ctx.enrichment +
//   ctx.manifestSnapshots + PLATFORM_EXPOSED_LABELS) and threads include_confluence=true + pr_context +
//   yaml_config (state.repoConfig) + platform_exposed_labels onto the retrieveKnowledge dispatch. The
//   ORCHESTRATOR always passes the gated values (collapse-on); the ACTIVITY's `_shouldUseHybrid` gate
//   decides legacy-vs-hybrid per chunk (it needs a non-null query_vector_override too). The hybrid retriever
//   (BM25+ANN+Confluence+floors+rerank) is wired in build_activities → wiring/retrievers.ts.
//
// ── WIRED (port complete; some are unit-test-OPTIONAL ports that production always supplies) ──
//   * citation_validate (Stage 3 — its own activity boundary; Path.resolve syscalls). Dispatched at
//     Step 7.5 when ports.citationValidate is wired (build_activities wires it); omitted only in unit tests.
//   * apply_policy_post_filter — relocated INLINE (Step 7.2: applyPolicyPostFilter, pure + sync).
//   * apply_arbitration / record_tool_runs (Stage 5) — dispatched at Step 7.7 when the ports are wired
//     (build_activities wires both); skipped only in unit tests / when no static analysis ran.
//   * match_path_instructions — PORTED (apps/backend/src/config/path_match.ts); matchPathInstructions
//     populates ReviewContextV1.matched_path_instructions per chunk.
//
// ── PARTIAL (wiring in place; value lands when an upstream stage populates it) ──
//   * tier1_findings / tool_statuses threading (static-analysis-orchestrator-v2 + tier2-linter-aware-prompt
//     collapse-on). Stage 1's staticAnalysis returns an empty-valid StaticAnalysisResultV1, so the threaded
//     tuples are empty regardless; the orchestrator threads sa.tier1_findings / sa.tool_statuses straight-
//     line, turning real once a populating staticAnalysis lands. No conditional gate remains.
//
// ── SANDBOX SAFETY (ADR-0065 / ADR-0066 / check_clock_random + check_workflow_bundle) ──
// This module runs INSIDE the Temporal V8 workflow sandbox. It is DETERMINISTIC + crypto/clock/network/DB
// FREE: NO node:crypto, NO Date.now / new Date(), NO Math.random, NO fetch/http, NO DB. Every await is an
// activity-port dispatch (ports.*) or a pure helper (fanOutReview, stageOutcome, the helpers.ts leaves).
// All minting/hashing/uuid/clock/network work lives behind the typed ReviewActivityPorts. The parallel
// sections use Promise.all over plain Promises (the Python anyio.create_task_group analogue) — no timers.
//
// ── DEGRADATION-NOTES-BEFORE-POST (finding 7 / ADR-0069 hardening divergence) ──
// The orchestrator accumulates degradation markers into state.degradation as each fail-soft stage runs.
// They are read by the workflow body AFTER orchestrate() returns. The composed note flows into the
// walkthrough via the body (the orchestrator returns the raw notes on ReviewPipelineResult). The
// walkthrough activity is dispatched at Step 8 (AFTER every degradation-producing stage), so the rendered
// walkthrough reflects the true degraded state — closing the Python ordering bug where notes were folded in
// AFTER the post already happened.

import type { ReviewActivityPorts } from "./activity_ports.js";
import type { ReviewWorkflowState } from "./state.js";
import {
  type ReviewPipelineResult,
  makeReviewPipelineResult,
} from "./pipeline_result.js";
import { fanOutReview, type ChunkThreadingV1, type InvokeChunkFn } from "./parallelism.js";
import {
  inferPrTopologyKind,
  pathFiltersExcludedAllFinding,
  buildPolicyCitationContext,
  maybeAppendConfigNotice,
} from "./helpers.js";
import { stageOutcome, recordStage, type StageLogger } from "./degradation.js";
import { postReviewResults, type PostingLifecycleDeps } from "./posting.js";

// FIX #6+#9 — the ONE ported gitignore-style glob matcher (apps/backend/src/config/path_match.ts) backs BOTH
// path-config consumers, replacing the two Stage-1 placeholder implementations that used to live in this
// module (the inline `filterReviewPaths` "minimal glob" AND the deferred `matched_path_instructions: []`):
//   * filterReviewPaths(paths, pathFilters) — the `.codemaster.yaml::path_filters` review-set selector
//     (gitignore last-match-wins, root-anchored, '!'-negation). Byte-parity-proven against the frozen Python
//     `filter_review_paths` (test/parity/path_match.parity.test.ts).
//   * matchPathInstructions(rules, chunkPath) — the ADR-0001 per-glob `path_instructions` matcher that
//     populates ReviewContextV1.matched_path_instructions (port of the Python workflow body's
//     `match_path_instructions(path=..., rules=repo_config.path_instructions)` call in `_review_chunk`).
// Both are pure + sandbox-safe (no clock/RNG/network/DB); the same engine drives both so widening glob
// semantics never diverges between the two surfaces.
import { filterReviewPaths, matchPathInstructions } from "#backend/config/path_match.js";

import { postFilterFindingsWithMetadata } from "#backend/policy/trust_filter.js";
import { mergePerChunkBundles } from "#backend/policy/citation_context_builder.js";
import { recordInvariantViolationAttempted } from "#backend/observability/workflow_policy_metrics.js";

// Sub-spec B T17 confluence-context build (collapse-on of confluence-label-routing +
// confluence-pr-context-full-pr). BOTH are pure + sandbox-safe (no node:crypto / clock / RNG / network /
// DB): pr_context_builder is pure data construction over the enrichment result; PLATFORM_EXPOSED_LABELS
// is a frozen const computed at module load over static detector tables. The confluence retrieval itself
// runs in the retrieve_knowledge ACTIVITY (Node, DB OK) — the orchestrator only builds the gated INPUT.
import { pickPrContext } from "#backend/retrieval/pr_context_builder.js";
import { PLATFORM_EXPOSED_LABELS } from "#backend/retrieval/platform_labels.js";

import type { PrMetaV1, WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import type { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";
import type { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";
import type { ApplyArbitrationInputV1, Tier2Pair } from "#contracts/apply_arbitration_input.v1.js";
import type { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import type { ChangedLineRanges } from "./activity_ports.js";
import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import type { CarryForwardSelectionV1 } from "#contracts/carry_forward.v1.js";
import type { ReviewContextV1 } from "#contracts/review_context.v1.js";
import type { ReviewChunkResponseV1 } from "#contracts/review_chunk_response.v1.js";
import type { PRTopologyEntryV1 } from "#contracts/pr_topology.v1.js";
import type { KnowledgeChunkV1 } from "#contracts/knowledge_chunks.v1.js";
import type { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";
import type { LinkedIssueV1 } from "#contracts/walkthrough.v1.js";
// TYPE-ONLY — RetrievedEvidenceV1 lives in retrieved_evidence.v1.ts which imports node:crypto (the ev_id
// minting). The `import type` is ERASED at emit under verbatimModuleSyntax, so NO runtime edge to the
// crypto-importing contract is created — the workflow bundle stays crypto-free (check_workflow_bundle).
import type { RetrievedEvidenceV1 } from "#contracts/retrieved_evidence.v1.js";
// Sub-spec B T17 confluence-context inputs (the enrichment result + manifest snapshots the pr_context
// builder consumes). TYPE-ONLY — both contracts are pure zod (no crypto edge into the workflow bundle).
import type { PrFilesEnrichmentResultV1 } from "#contracts/pr_files_enrichment.v1.js";
import type { ManifestSnapshot } from "#contracts/pr_context.v1.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ReviewPipelineContext (finding 2) — the single typed orchestrate() argument.
//
//   repo:       the cloneable-repo identity (repo_url + changed_paths) — the inputs to clone + classify.
//   pr:         the PR-level identity/metadata the per-chunk context + persist + post stages read.
//   activities: the typed ReviewActivityPorts surface (the workflow body wires proxyActivities()).
//   limits:     bounded knobs (chunk fan-out concurrency).
//   state:      the mutable ReviewWorkflowState (policyBundles / queryVectorCache / degradation / …).
//
// SANDBOX-SAFE: every field is a plain data record / a typed port object / the state object — no
// non-deterministic value lives here. UUIDs (pr_id, run_id, review_id, parent_review_id) are STRINGS (the
// wire form; the sandbox has no uuid mint).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Cloneable-repo identity — the inputs to the clone + classify stages. */
export type ReviewPipelineRepoCtx = {
  /** repo_url — passed to clone (the git remote to clone at head_sha). */
  readonly repoUrl: string;
  /** changed_paths — the PR's changed file paths; clone fetches them, classify routes them. */
  readonly changedPaths: ReadonlyArray<string>;
  /** The allocated workspace handle. In the TS port the clone activity is WORKSPACE-AWARE — it clones INTO
   *  a pre-allocated, validated workspace (allocate_workspace, the Stage-2 lifecycle, runs BEFORE
   *  orchestrate and threads the handle through here). The Python orchestrator's clone took only
   *  (repo_url, head_sha, changed_paths); the TS clone contract (CloneRepoIntoWorkspaceInput) nests the
   *  handle so the cloner targets the lease-managed directory. The handle's workspace_id is also the
   *  release-lease key cleanup uses. */
  readonly workspaceHandle: WorkspaceHandle;
};

/** PR-level identity/metadata threaded through the per-chunk context + aggregate + persist + post stages.
 *  Mirrors the Python orchestrator kwargs that came off `typed_payload` / `pr_meta`. */
export type ReviewPipelinePrCtx = {
  /** The walkthrough/post PR metadata envelope (pr_id, installation_id, repo, pr_title, pr_description). */
  readonly prMeta: PrMetaV1;
  /** head_sha — the commit under review (post deep-links, persist, post stages). */
  readonly headSha: string;
  /** run_id — the ephemeral workflow execution id (persist + degradation pivot). UUID wire string. */
  readonly runId: string;
  /** review_id — the persistent review id (persist findings + persist walkthrough). UUID wire string. */
  readonly reviewId: string;
  /** repository_id — the internal UUID of the repo under review (the workflow payload's `repository_id`).
   *  FIX #2 (part 1): threaded onto the PR ctx so the Orchestrator phase can pass it to retrieveKnowledge
   *  (`repo_id` is sourced from `typed_payload.repository_id` in the frozen Python — review_pull_request.py
   *  :1756/:1768). Stage-1 stood `pr.prMeta.pr_id` in for `repo_id` until this field landed; the
   *  retrieveKnowledge call rewire is the Orchestrator phase (NOT this fix). UUID wire string. */
  readonly repositoryId: string;
  /** policy_revision — the routing-policy revision the aggregate stage stamps onto AggregatedFindingsV1. */
  readonly policyRevision: number;
  /** pr_number — the GitHub PR number (post_review + post_check_run target it; PostReviewInputV1.pr_number
   *  is gte(1)). Sourced from the workflow payload in Python. */
  readonly prNumber: number;
  /** changed_line_ranges — keyed by path, the post-image hunk windows (chunk + carry-forward + post). */
  readonly changedLineRanges: ChangedLineRanges;
  /** parent_findings — prior-review findings the carry-forward selector partitions (default []). */
  readonly parentFindings: ReadonlyArray<ReviewFindingV1>;
  /** parent_review_id — the prior review id the carry-forward selector keys off (null on a first review). */
  readonly parentReviewId: string | null;
};

/** Bounded knobs for the pipeline (the Python `chunk_concurrency` kwarg + room to grow). */
export type ReviewPipelineLimits = {
  /** Per-PR chunk-review fan-out concurrency (Python `chunk_concurrency`, default CHUNK_CONCURRENCY_DEFAULT). */
  readonly chunkConcurrency: number;
};

/** The single typed orchestrate() argument (finding 2). */
export type ReviewPipelineContext = {
  readonly repo: ReviewPipelineRepoCtx;
  readonly pr: ReviewPipelinePrCtx;
  readonly activities: ReviewActivityPorts;
  readonly limits: ReviewPipelineLimits;
  readonly state: ReviewWorkflowState;
  /** The PR's linked issues (Stage 4 — DM-WIRE T4). The Python fetched these INSIDE the `_walkthrough`
   *  closure (review_pull_request.py:2086-2154) right before `generate_walkthrough`; the TS port pulled
   *  `generateWalkthrough` into the orchestrator, so the workflow body resolves them up-front (their inputs
   *  are payload-only) — fetching `fetch_linked_issues_activity` fail-open — and threads the RESOLVED tuple
   *  here. Both walkthrough sites (the normal Step 8 + the advisory path-filters-excluded-all Step 2a.1)
   *  read it, exactly like the Python closure that fed both. Default [] (omitted in unit tests; the Python
   *  fail-open / skipped / `github_installation_id is None` branches all yield the empty tuple). */
  readonly linkedIssues?: ReadonlyArray<LinkedIssueV1>;
  /** The PR's CODEOWNERS-derived suggested reviewers (Stage 4 — S23.AR.3 / B5). Same threading rationale as
   *  `linkedIssues`: the Python fetched `fetch_suggested_reviewers_activity` inside `_walkthrough`
   *  (review_pull_request.py:2170-2218) fail-open; the TS port resolves it in the workflow body and threads
   *  the RESOLVED tuple here for both walkthrough sites. Default [] (flag-off / no-files / no-rules / unit
   *  tests). */
  readonly suggestedReviewers?: ReadonlyArray<string>;
  /** The WARN sink stageOutcome emits its degradation log line on. The workflow body injects the Temporal
   *  `workflow.log` (sandbox-safe + replay-safe); unit tests inject a recording logger to assert the WARN
   *  lines. Optional: when omitted, degradation WARN lines are dropped (record_stage in degradation.ts
   *  remains the metric source of truth) — but the workflow body ALWAYS injects it in production. */
  readonly logger?: StageLogger;
  /** The PR-mutex lease CLAIM-CHECK seam (Stage 2 — the workflow body's `_abort_if_claim_lost`). Called at
   *  the THREE Python stage boundaries (before clone, before classify/the Bedrock fan-out, before aggregate)
   *  so a review whose lease was reclaimed by a superseding review aborts non-retryably (the callback raises
   *  a non-retryable ApplicationFailure) rather than wasting Bedrock budget on a stolen review. The body
   *  injects the renewal-backed check; unit tests omit it (then it is a no-op). Replay-safe: the callback's
   *  only side effect is a `renew_pr_review_mutex_lease_activity` dispatch (Temporal-serialized). */
  readonly claimCheck?: () => Promise<void>;
  /** The placeholder TEARDOWN seam (Stage 2 — the workflow body's `delete_review_placeholder` call, which
   *  the Python places INSIDE `_post_review` AFTER the real review post lands). Called ONCE, right after the
   *  `postReview` activity succeeds (the normal post path AND the path-filters-excluded-all advisory post),
   *  so the "reviewing this PR..." placeholder comment is torn down only once the real review is on GitHub.
   *  Best-effort by construction (the injected callback wraps the dispatch in stageOutcome + swallows). The
   *  body injects it; unit tests omit it (then it is a no-op). */
  readonly onPlaceholderTeardown?: () => Promise<void>;
  /** The replay-safe instant the Step 7.7 arbitration apply writes onto SUPPRESSED_BY_LLM decisions'
   *  `suppressed_at` column (the Python `now=workflow.now()` kwarg to ApplyArbitrationInput). The orchestrator
   *  runs in the workflow sandbox where `Date.now()` / `new Date()` are clock-gate-banned, so the workflow
   *  body resolves this from `workflowInfo().startTime.toISOString()` (a replay-deterministic SDK-provided
   *  instant) and threads the RFC3339 string here. Default: an epoch-zero RFC3339 instant when omitted (unit
   *  tests; the arbitration step is then either skipped — no applyArbitration port — or runs with a fixed
   *  deterministic instant). */
  readonly arbitrationNow?: string;
  /** The `enrich_pr_files_activity_v2` result the workflow body captured at the top of the body (Stage-4
   *  enrichment; review_pull_request.py:830-917). The Sub-spec B T17 confluence-context build reads it to
   *  construct ONE full-PR PRContext (every changed file in the diff) per chunk fan-out via
   *  `build_pr_context_full`. `null`/undefined (github_installation_id null, or the v2 fetch errored +
   *  stageOutcome swallowed) makes the confluence gate fail-CLOSED for THIS PR — the per-chunk
   *  `pickPrContext` falls back to the MVP single-file context, and `_shouldUseHybrid` in the activity is
   *  still satisfiable, but the Python's `enrichment is None` fail-open path is preserved (the legacy MVP
   *  context still routes labels). Optional to honour exactOptionalPropertyTypes. */
  readonly enrichment?: PrFilesEnrichmentResultV1 | null;
  /** The manifest snapshots the workflow body fetched (`fetch_manifest_snapshots_activity` →
   *  `parse_manifest_dependencies_activity`; review_pull_request.py:919-1010) — threaded into the full-PR
   *  PRContext's `manifests` so the FrameworkDetector can route `framework:*` labels. DEFAULT []: the two
   *  fetch/parse activities are NOT yet ported (FOLLOW-UP-confluence-pr-context-manifests), so the workflow
   *  body threads [] — exactly the Python `_manifest_snapshots=()` fail-open fallback. Optional to honour
   *  exactOptionalPropertyTypes. */
  readonly manifestSnapshots?: ReadonlyArray<ManifestSnapshot>;
  /** The platform-exposed-labels ceiling (Sub-spec B T17; review_pull_request.py:1763). DEFAULT (when
   *  omitted): the canonical {@link PLATFORM_EXPOSED_LABELS} const. Injectable so tests can narrow the
   *  ceiling without re-importing the const. The confluence gate requires this be NON-EMPTY (it always is,
   *  for the const). */
  readonly platformExposedLabels?: ReadonlySet<string>;
};

/** A no-op StageLogger for when `ctx.logger` is omitted. SANDBOX-SAFE: pure inert sink (no console binding,
 *  which keeps the workflow bundle determinism-clean). record_stage (degradation.ts) is the metric source
 *  of truth regardless. */
const NULL_LOGGER: StageLogger = {
  warning(): void {
    // intentionally inert — see ReviewPipelineContext.logger
  },
};

// ─── tunables (1:1 with the Python module constants) ─────────────────────────────────────────────

/** _CLASSIFIER_FAILURE_THRESHOLD (review_pipeline_orchestrator.py:292). > this ratio → a degradation note. */
const CLASSIFIER_FAILURE_THRESHOLD = 0.1;

/** The query-text cap the per-chunk closure applies (`[:8000]`, review_pull_request.py:1636). The
 *  RetrieveKnowledgeInputV1 query field is bounded max(8000); the embed query field is bounded max(8000)
 *  too — slice keeps both within bound regardless of path/title length. */
const QUERY_TEXT_MAX = 8000;

/** The hard cap on the per-chunk retrieved-evidence manifest (the Python `_DEFAULT_ENTRY_CAP`). Matches
 *  `ReviewContextV1.retrieved_evidence` max_length (100) so the producer output never overflows the
 *  ReviewContextV1 field that carries it. The producer drops the LOWEST-priority entries first. */
const EVIDENCE_ENTRY_CAP = 100;

/** M-A5 chunk cap (Python `MAX_CHUNKS_PER_REVIEW`, review_pull_request.py:64). Bounds the Temporal
 *  event-history per PR fan-out: the chunk set fed to fanOutReview is truncated to at most this many chunks
 *  (the Python `_chunk_and_redact` closure applied it AFTER chunk_and_redact_activity returned). The TS port
 *  caps AFTER selectCarryForward narrows to `to_review` — the only chunks the fan-out actually reviews —
 *  which is the strictly tighter (mathematically subsumed) bound, so the event-history ceiling still holds
 *  while never truncating a chunk the carry-forward layer already dropped. */
const MAX_CHUNKS_PER_REVIEW = 100;

/** M-A3 inline-findings cap (Python `MAX_INLINE_FINDINGS`, review_pull_request.py:63). GitHub's PR Review
 *  API rejects > 300 inline comments; this is the belt-and-suspenders ceiling the workflow body's
 *  `_aggregate` closure applied to `aggregated.findings` AFTER the aggregate activity returned and BEFORE
 *  appending the config-change notice (so the notice is never capped away). It is SEPARATE from — and looser
 *  than — the aggregate activity's own per-review cap (`PER_REVIEW_CAP = 50`, rankAndCap), which always runs
 *  first; under normal flow this ceiling is a no-op, but it is ported faithfully as the Python's second
 *  guard. */
const MAX_INLINE_FINDINGS = 250;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// orchestrate — drive the full review pipeline through one PR push.
//
// Stage order (collapse-on gates as straight-line; Step numbers cite the Python orchestrator):
//   1.  clone
//   1a. load_repo_config        (repo-config-wiring collapse-on → straight-line)
//   1b. compute_policy_rules    (policy-engine-wiring collapse-on → straight-line; populates policyBundles)
//   2.  classify (+ classifier-failure-ratio degradation note)
//   2a. filter_review_paths     (path_filters; early-exit advisory if it excludes ALL review files)
//   3.  [chunkAndRedact || staticAnalysis] (parallel)
//   4.  selectCarryForward      (fail-open → "review every chunk")
//   5.  fanOutReview            (per-chunk context build; tier1 + manifest threaded; concurrency-bounded)
//   6.  dedup                   (dispatched as the dedupFindings activity — it embeds over the network)
//   7.  aggregateFindings
//   7.6 persistFindings         (fail-open; populates state.persistedFindingIds)
//   8.  generateWalkthrough
//   8a. persistReviewWalkthrough(persist-review-walkthrough collapse-on; fail-open)
//   9.  [postReview || postCheckRun] (parallel)
//   10. cleanup                 (finally — runs no matter how we exit)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function orchestrate(ctx: ReviewPipelineContext): Promise<ReviewPipelineResult> {
  const { activities: ports, pr, repo, state } = ctx;
  const headSha = pr.headSha;
  const runId = pr.runId;

  // Claim-check BEFORE clone (Python `_clone` boundary: `await _abort_if_claim_lost()` at the top of the
  // closure, review_pull_request.py:1069). No-op when ctx.claimCheck is omitted (unit tests). A lost lease
  // raises a non-retryable ApplicationFailure here, BEFORE the workspace is populated — so the finally-block
  // cleanup below is not yet armed (it arms once clone returns), exactly like the Python ordering.
  if (ctx.claimCheck !== undefined) {
    await ctx.claimCheck();
  }

  // Step 1 — clone (workspace-aware: clones INTO the pre-allocated, validated workspace handle). This is
  // OUTSIDE the try: a clone failure ends the workflow with no partial review possible (the Python "clone
  // failure → status=failed" policy), and the finally-block cleanup only needs to run once a workspace
  // exists — which is exactly "clone returned".
  const cloned = await ports.clone({
    schema_version: 1,
    handle: repo.workspaceHandle,
    repo_url: repo.repoUrl,
    head_sha: headSha,
    changed_paths: [...repo.changedPaths],
    pr_number: pr.prNumber,
  });
  // The workspace ROOT (lease key for cleanup) is cloned.workspace_path. The repo tree root — where every
  // FS-reading stage operates — is the explicit ClonedRepoV1.repo_path when present (repo-path-cutover
  // collapse-on), else the historical `<workspace>/repo` layout the cloner always wrote into
  // (mathematically equivalent; just explicit at the call site).
  const workspacePath = cloned.workspace_path;
  const workspaceRoot = cloned.repo_path ?? `${cloned.workspace_path}/repo`;

  try {
    // Step 1a — load .codemaster.yaml into state.repoConfig (repo-config-wiring collapse-on). Runs here
    // because the workspace is populated (clone done) and every downstream config consumer (policy
    // compute, review-set filter, per-chunk context) expects the config already resolved.
    state.repoConfig = await ports.loadRepoConfig({
      schema_version: 1,
      workspace_path: workspaceRoot,
    });

    // Step 1b — compute in-repo policy rules (policy-engine-wiring collapse-on). Populates
    // state.policyBundles (keyed by changed_path) so the per-chunk context build can attach
    // policyBundles.get(chunk.path) to each ReviewContextV1.applicable_policy. The Python published into a
    // closure-captured dict from inside the await; here the typed activity RETURNS the bundles and the
    // orchestrator writes them into state — same visibility-before-fan-out ordering, no shared mutable box.
    //
    // FIX #12 — policy fail-open. The Python `_compute_policy_rules` closure (review_pull_request.py:1288)
    // wraps the activity dispatch in `stage_outcome("policy_compute", ...)`: the policy step is fail-open by
    // design (A-3-parse-timeout; maximum_attempts=1) — a compute failure (pathological input, parse timeout,
    // FS error) must NOT fail the review. With no fail-open wrap the Stage-1 port let a policy-compute throw
    // propagate out of orchestrate and crash an otherwise-deliverable review. stageOutcome restores the
    // Python contract: on a caught error it logs `policy_compute` outcome=error, swallows, and leaves
    // state.policyBundles EMPTY, so every downstream policy consumer (per-chunk applicable_policy, the
    // Step-7.2 post-filter, the citation policy-context) cleanly no-ops on the empty bundle map and the review
    // proceeds. The `computed === undefined` branch below is the swallowed-failure path. The
    // degradationNotes adapter appends `policy_compute_failed` (the TS port surfaces the degraded-policy state
    // as a degradation note — the Python's `degradation_notes=None` dropped the note, but the task wires it so
    // the walkthrough renderer can reflect the partial-policy review; the bundles-empty fail-open behaviour
    // itself is 1:1).
    const computed = await stageOutcome(
      "policy_compute",
      {
        logger: ctx.logger ?? NULL_LOGGER,
        degradationNotes: degradationAdapter(state),
        headSha,
        runId,
      },
      async () =>
        ports.computePolicyRules({
          schema_version: 1,
          workspace_path: workspaceRoot,
          // Python: custom_patterns=repo_config.knowledge.file_patterns;
          // knowledge_enabled=repo_config.knowledge.enabled (review_pull_request.py:1308-1309).
          custom_patterns: [...state.repoConfig.knowledge.file_patterns],
          knowledge_enabled: state.repoConfig.knowledge.enabled,
          changed_paths: [...repo.changedPaths],
        }),
    );
    if (computed !== undefined) {
      for (const [path, bundle] of Object.entries(computed.bundles)) {
        state.policyBundles.set(path, bundle);
      }
    }

    // Claim-check BEFORE classify (Python `_classify` boundary: `await _abort_if_claim_lost()` at the top of
    // the closure, "stop before the Bedrock fan-out if lease lost", review_pull_request.py:1099). classify is
    // the gateway into the per-chunk fan-out, so a lost lease aborts here before any Bedrock spend. No-op
    // when ctx.claimCheck is omitted. INSIDE the try → the finally-block cleanup still releases the workspace
    // even when the abort raises (the workspace was populated by the clone above).
    if (ctx.claimCheck !== undefined) {
      await ctx.claimCheck();
    }

    // Step 2 — classify.
    const routing = await ports.classify({
      workspacePath: workspaceRoot,
      files: [...repo.changedPaths],
    });
    const failureRatio =
      routing.classifier_failures.length / Math.max(1, repo.changedPaths.length);
    if (failureRatio > CLASSIFIER_FAILURE_THRESHOLD) {
      state.degradation.add(
        `file classification failed for ${routing.classifier_failures.length}/` +
          `${repo.changedPaths.length} files; results may be incomplete`,
      );
    }

    // Step 2a — narrow the REVIEW set (NOT the clone/classify inputs) via path_filters. Files were still
    // cloned + classified; only the chunk/fan-out review set is narrowed here. Collapse-on of the
    // repo-config-wiring gate: the filter ALWAYS runs (no patched gate) and is the identity when the config
    // carries no path_filters — so a PR with zero review files and no path_filters falls through normally.
    const reviewFiles = filterReviewPaths(routing.review_files, state.repoConfig.path_filters);

    // Step 2a.1 — path_filters excluded EVERY review file: skip chunk + fan-out but STILL post an advisory
    // review so the misconfig is visible. INSIDE the try, so the finally-block cleanup still releases the
    // workspace. GUARD: fire ONLY when filtering emptied a NON-EMPTY set (a clean PR with zero review files
    // and no filters must fall through to the normal path).
    if (routing.review_files.length > 0 && reviewFiles.length === 0) {
      // Claim-check BEFORE the advisory aggregate (the Python `_aggregate` boundary guards EVERY aggregate
      // dispatch, including this advisory one). No-op when ctx.claimCheck is omitted.
      if (ctx.claimCheck !== undefined) {
        await ctx.claimCheck();
      }
      const emptyNotice = pathFiltersExcludedAllFinding();
      const aggregatedEmpty = await ports.aggregate({
        findings: [emptyNotice],
        policyRevision: pr.policyRevision,
      });
      const walkthroughEmpty = await ports.generateWalkthrough({
        schema_version: 1,
        pr_meta: pr.prMeta,
        aggregated: aggregatedEmpty,
        // Stage-4 walkthrough threading: the advisory path-filters-excluded-all walkthrough still renders the
        // "Linked issues" / "Suggested reviewers" sections, exactly like the Python `_walkthrough` closure
        // that fed BOTH the normal and advisory `generate_walkthrough(pr_meta, aggregated)` calls (the closure
        // fetched the two tuples internally, so the advisory post got them too). Threaded from the
        // workflow-body-resolved context (default [] when omitted).
        linked_issues: [...(ctx.linkedIssues ?? [])],
        suggested_reviewers: [...(ctx.suggestedReviewers ?? [])],
      });

      // The advisory post also runs through posting.ts::postReviewResults so it populates state.postedReview
      // (the Python advisory post goes through `_post_review` too). The advisory path has no persisted
      // findings (chunk/persist were skipped), so the dropped-state skip dispatch is inert. FIX #7: the
      // advisory post goes through the SAME runPostStage seam as the normal path, so the advisory placeholder
      // teardown is likewise decoupled from post_check_run (a check-run failure here degrades, never strands
      // the placeholder against a delivered advisory review).
      const advisoryPostingDeps: PostingLifecycleDeps =
        ports.recordDeliverySkipped !== undefined
          ? {
              recordDeliverySkipped: ports.recordDeliverySkipped,
              persistedFindingIds: state.persistedFindingIds,
              logger: ctx.logger ?? NULL_LOGGER,
            }
          : { persistedFindingIds: state.persistedFindingIds, logger: ctx.logger ?? NULL_LOGGER };
      await runPostStage(ctx, walkthroughEmpty, aggregatedEmpty, advisoryPostingDeps);

      state.degradation.add("path_filters_excluded_all");
      return makeReviewPipelineResult({
        status: "accepted",
        headSha,
        findingsCount: aggregatedEmpty.findings.length,
        walkthrough: walkthroughEmpty,
        aggregated: aggregatedEmpty,
        fileRouting: routing,
        staticAnalysis: null,
        carryForward: null,
        classifierFailureRatio: failureRatio,
        degradationNotes: state.degradation.notes,
      });
    }

    // Step 3 — parallel: chunk+redact the review files; static analysis on the sandbox files.
    const [chunks, sa] = await Promise.all([
      ports.chunkAndRedact({
        workspacePath: workspaceRoot,
        files: reviewFiles,
        ranges: pr.changedLineRanges,
      }),
      ports.staticAnalysis({
        workspacePath: workspaceRoot,
        files: [...routing.sandbox_files],
        ranges: pr.changedLineRanges,
        prMeta: pr.prMeta,
      }),
    ]);

    if (Object.keys(sa.per_tool_errors).length > 0) {
      state.degradation.add(
        "static-analysis tool failures: " + Object.keys(sa.per_tool_errors).sort().join(", "),
      );
    }
    if (Object.keys(sa.truncated_per_tool).length > 0) {
      const truncatedSummary = Object.entries(sa.truncated_per_tool)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([tool, count]) => `${tool}=${count}`)
        .join(", ");
      state.degradation.add(`static-analysis truncated: ${truncatedSummary}`);
    }

    // Step 4 — carry-forward selection. Fall back to "review every chunk" if the activity raises
    // (stage_outcome with raiseAfterLog=true + an outer catch that re-builds the "review everything"
    // selection — the Python sentinel-flag pattern). The helper appends `select_carry_forward_failed`; the
    // outer catch adds the human-readable variant the walkthrough renderer consumes.
    const selection = await selectCarryForwardWithFallback(ctx, chunks);

    // M-A5 chunk cap (Python `_chunk_and_redact` closure, review_pull_request.py:1138). Bound the chunk set
    // fed to the fan-out to MAX_CHUNKS_PER_REVIEW so the Temporal event-history per PR stays bounded. The
    // Python applied this inside `_chunk_and_redact` (on the raw chunk tuple, BEFORE carry-forward); the TS
    // port applies it to `selection.to_review` (AFTER carry-forward narrows) — the strictly tighter bound the
    // fan-out actually reviews, so the event-history ceiling still holds and a chunk the carry-forward layer
    // already dropped is never the one truncated. On truncation: WARN log + a degradation note so the
    // walkthrough renderer surfaces the partial-review state.
    let toReview: ReadonlyArray<DiffChunkV1> = selection.to_review;
    if (toReview.length > MAX_CHUNKS_PER_REVIEW) {
      (ctx.logger ?? NULL_LOGGER).warning(
        `review_pipeline.chunks_capped: original=${toReview.length} capped_to=${MAX_CHUNKS_PER_REVIEW}`,
      );
      state.degradation.add(
        `chunk set truncated to ${MAX_CHUNKS_PER_REVIEW} of ${toReview.length} chunks; ` +
          `review may be incomplete`,
      );
      toReview = toReview.slice(0, MAX_CHUNKS_PER_REVIEW);
    }

    // Step 5 — fan-out LLM review. Collapse-on of static-analysis-orchestrator-v2 + pr-topology-manifest:
    // thread tier1_findings / tool_statuses (straight from sa) AND build the PR-topology manifest from the
    // (capped) chunks selected for review. fanOutReview returns [findings, intents]; intents propagate to the
    // result for Stage 5's arbitration layer.
    const tier1ForFanout = sa.tier1_findings;
    const toolStatusesForFanout = sa.tool_statuses;
    const prTopologyManifest: ReadonlyArray<PRTopologyEntryV1> = toReview.map(
      (c): PRTopologyEntryV1 => ({
        chunk_id: c.chunk_id,
        path: c.path,
        start_line: c.start_line,
        end_line: c.end_line,
        kind: inferPrTopologyKind(c.path) as PRTopologyEntryV1["kind"],
      }),
    );
    const threading: ChunkThreadingV1 = {
      tier1Findings: tier1ForFanout,
      toolStatuses: toolStatusesForFanout,
      prTopologyManifest,
    };

    const invokeChunk: InvokeChunkFn = async (chunk, chunkThreading) => {
      const context = await buildChunkContext(ctx, chunk, chunkThreading);
      // Step 5b — the bedrock_review_chunk dispatch is wrapped in a stage_outcome with raiseAfterLog so a
      // dispatch failure logs `review_chunk` outcome=error then re-raises (the Python `_log_stage(...,
      // outcome="error"); raise` bridge). fanOutReview surfaces the first rejection.
      const result = await stageOutcome(
        "review_chunk",
        { logger: ctx.logger ?? NULL_LOGGER, headSha, runId, raiseAfterLog: true },
        async (): Promise<ReviewChunkResponseV1> => ports.reviewChunk(context),
      );
      // raiseAfterLog=true: on success `result` is the envelope; on failure stageOutcome re-raised, so this
      // line is only reached on success. The `?? ` is unreachable-defensive (stageOutcome's swallow path is
      // disabled by raiseAfterLog), kept to satisfy the `T | undefined` return type without a non-null `!`.
      if (result === undefined) {
        throw new Error("review_chunk: unexpected empty result after stageOutcome re-raise contract");
      }
      // output-safety-emit-chunk (collapse-on): when the chunk activity returned a sanitization_event,
      // dispatch the emit_output_safety_audit activity as a SEPARATE idempotent activity. Its retry budget
      // is independent of bedrock_review_chunk's — a failed emit does NOT re-run the LLM call (which would
      // double the LLM cost). audit_event_id is derived deterministically from the event, so a Temporal
      // retry of THIS dispatch is a no-op. SKIPPED when ctx.activities.emitOutputSafetyAudit is omitted.
      if (ports.emitOutputSafetyAudit !== undefined && result.sanitization_event !== null) {
        await ports.emitOutputSafetyAudit({ schema_version: 1, event: result.sanitization_event });
      }
      return result;
    };

    const [newFindings, arbitrationIntents] = await fanOutReview(toReview, invokeChunk, {
      concurrency: ctx.limits.chunkConcurrency,
      threading,
    });

    // Carried findings bypass the active-fan-out evidence validation by design (they were minted against a
    // prior PR snapshot; the selection layer owns their staleness gating). Concat carried FIRST so they keep
    // first-occurrence ordering through the dedup's exact stage.
    const llmFindings: ReadonlyArray<ReviewFindingV1> = [...selection.carried, ...newFindings];

    // Step 6 — dedup linter ↔ LLM. Dispatched as the dedupFindings ACTIVITY: the semantic stage embeds over
    // the network (the platform Qwen consumer), which the workflow sandbox forbids. The activity holds the
    // live EmbeddingsPort and fails open to exact-only dedup (semantic_skipped=true) on embedder outage.
    const linterFindings = sa.findings;
    const deduped = await ports.dedupFindings({
      schema_version: 1,
      linter_findings: [...linterFindings],
      llm_findings: [...llmFindings],
    });
    if (deduped.semantic_skipped) {
      state.degradation.add("dedup semantic stage skipped; exact-match dedupe still applied");
    }

    // Claim-check BEFORE aggregate (Python `_aggregate` boundary: `await _abort_if_claim_lost()` at the top
    // of the closure, "don't aggregate/post a superseded review", review_pull_request.py:1968). This is the
    // last gate before the review is aggregated + posted to GitHub. No-op when ctx.claimCheck is omitted.
    if (ctx.claimCheck !== undefined) {
      await ctx.claimCheck();
    }

    // Step 7 — aggregate. (`let`: the M-A3 cap + config-notice append below, Step 7.2's policy post-filter,
    // Step 7.5's citation_validate, and the Step 7.7 arbitration-result derivation reassign `aggregated` as
    // the pipeline narrows the findings.)
    let aggregated: AggregatedFindingsV1 = await ports.aggregate({
      findings: deduped.findings,
      policyRevision: pr.policyRevision,
    });

    // M-A3 inline-findings cap (Python `_aggregate` closure, review_pull_request.py:1986). GitHub's PR
    // Review API rejects > 300 inline comments; cap `aggregated.findings` to MAX_INLINE_FINDINGS. This is the
    // belt-and-suspenders ceiling the workflow body applied to the aggregate-activity result; the activity's
    // own rankAndCap (PER_REVIEW_CAP=50) always ran first, so under normal flow this is a no-op, but it is
    // ported faithfully as the Python's second guard. On truncation: WARN log (the Python
    // `findings_capped` line). Applied BEFORE the config-notice append so the notice is never capped away.
    if (aggregated.findings.length > MAX_INLINE_FINDINGS) {
      (ctx.logger ?? NULL_LOGGER).warning(
        `review_pipeline.findings_capped: original=${aggregated.findings.length} ` +
          `capped_to=${MAX_INLINE_FINDINGS}`,
      );
      aggregated = {
        schema_version: aggregated.schema_version,
        findings: aggregated.findings.slice(0, MAX_INLINE_FINDINGS),
        dedupe_stats: aggregated.dedupe_stats,
        policy_revision: aggregated.policy_revision,
      };
    }

    // spec §7 — append the .codemaster.yaml config-change notice (Python `_maybe_append_config_notice`,
    // review_pull_request.py:2002, called INSIDE the `_aggregate` closure right after the M-A3 cap). The
    // membership check uses `repo.changedPaths` = the Python `original_changed_paths` (the PRE-path_filters
    // snapshot), so a path_filters exclusion of .codemaster.yaml cannot hide the notice. Appended AFTER the
    // MAX_INLINE_FINDINGS cap so it can never be capped away — and BEFORE every downstream consumer
    // (post-filter / citation / persist / walkthrough / post), exactly like the Python ordering, so the
    // notice flows through the whole chain and lands in the persisted row + the GitHub comment. Idempotent —
    // maybeAppendConfigNotice never double-appends. cfg.no_spurious_notice smoke surface: the notice appears
    // IFF .codemaster.yaml is in the changed set, NOT otherwise.
    aggregated = maybeAppendConfigNotice(aggregated, repo.changedPaths);

    // Step 7.2 — inline policy post-filter (policy-post-filter-relocated collapse-on; the R-23 relocation).
    // Runs HERE, AFTER aggregate and BEFORE every downstream consumer (citation_validate / persist /
    // walkthrough / post), so the persisted row + the rendered walkthrough + the GitHub comment all see the
    // SAME filtered findings (closing the persist/render divergence flagged in the 2026-05-21 head-of-eng
    // review §1.1). The system-invariants severity floor (SI-001 / SI-005) is applied over the review-level
    // union of the per-chunk policy bundles. No-op when state.policyBundles is empty (no rules apply). The
    // per-finding metadata is stashed on state.inlinePostFilterMetadata so persist threads it as
    // precomputed_metadata (the persisted core.review_findings.policy_metadata reflects the inline filter,
    // NOT a re-filter — the TS persist activity does no post-filter of its own, so there is no double-filter
    // to bypass; this purely back-fills the metadata column with the same fired-invariant provenance).
    aggregated = applyPolicyPostFilter(ctx, aggregated);

    // Step 7.5 — citation validation (Stage 3). Drops findings whose `sources[]` cite a repo_path that
    // does NOT exist in the cloned workspace (GitHub silently 422s inline comments on phantom paths, so the
    // filter runs producer-side). The validator's Path.resolve/.exists/.is_file syscalls trip the workflow
    // sandbox, so the actual work is wrapped in the citationValidate ACTIVITY; the orchestrator dispatches
    // it here between aggregate (Step 7) and persist (Step 7.6). knowledge_chunk citations run in skip mode
    // (knowledge_chunk_ids=null) — production retrieval-tracking is a separate concern (S17.X-citation-
    // wiring). The policy_citation context is built from state.policyBundles (policy-engine-wiring collapse-
    // on; default enforcement="observe" — log mismatches, keep findings; operators flip to "enforce"). On
    // dropped findings, append a degradation note + reassign aggregated to the surviving partition so
    // walkthrough + post + persist all see the SAME filtered set. SKIPPED when ctx.activities.citation
    // Validate is omitted (unit tests; the Python `if citation_validate is not None` branch).
    if (ports.citationValidate !== undefined) {
      const citationResult = await ports.citationValidate({
        schema_version: 1,
        workspace_path: workspaceRoot,
        findings: [...aggregated.findings],
        // ENHANCEMENT beyond frozen Python (which hardcodes null/skip): pass the PR-level union of
        // retrieved knowledge chunk IDs the fan-out accumulated so knowledge_chunk citations are validated
        // against the actual retrieved set (a finding citing a non-retrieved id is dropped). Sorted →
        // replay-deterministic activity input regardless of fan-out completion order. Empty set → null
        // (skip mode), preserving the clean-PR / no-retrieval behavior 1:1 with Python.
        knowledge_chunk_ids:
          state.retrievedKnowledgeChunkIds.size > 0
            ? [...state.retrievedKnowledgeChunkIds].sort()
            : null,
        policy_citation: buildPolicyCitationContext(state.policyBundles, "observe"),
      });
      if (citationResult.dropped.length > 0) {
        (ctx.logger ?? NULL_LOGGER).warning(
          `review-pipeline: dropped ${citationResult.dropped.length} finding(s) with unresolvable sources`,
        );
        state.degradation.add(
          `citation-validator dropped ${citationResult.dropped.length} ` +
            `finding(s) with unresolvable sources`,
        );
        aggregated = {
          schema_version: aggregated.schema_version,
          findings: [...citationResult.surviving],
          dedupe_stats: aggregated.dedupe_stats,
          policy_revision: aggregated.policy_revision,
        };
      }
    }

    // Step 7.6 — persist findings to core.review_findings (fail-open). Populates state.persistedFindingIds
    // (the ordered rfids the persist activity wrote, for the lifecycle index → rfid dispatch). On persist
    // failure stageOutcome swallows + appends `persist_findings_failed`; the chain continues so the user
    // still gets GitHub comments.
    const persistedIds = await stageOutcome(
      "persist_findings",
      {
        logger: ctx.logger ?? NULL_LOGGER,
        degradationNotes: degradationAdapter(state),
        headSha,
        runId,
      },
      async (): Promise<ReadonlyArray<string>> =>
        ports.persistReviewFindings({
          schema_version: 1,
          pr_id: pr.prMeta.pr_id,
          installation_id: pr.prMeta.installation_id,
          aggregated,
          run_id: runId,
          review_id: pr.reviewId,
          policy_bundle: null,
          // R-23: thread the Step-7.2 inline post-filter metadata so the persisted policy_metadata column
          // carries the same fired-invariant provenance the inline filter computed (index-aligned with the
          // filtered findings). Undefined → null (no post-filter ran / no invariant fired).
          precomputed_metadata:
            state.inlinePostFilterMetadata === undefined
              ? null
              : state.inlinePostFilterMetadata.map((m) => ({
                  schema_version: 1,
                  invariant_violation_attempted: m.invariant_violation_attempted,
                  invariants_fired: [...m.invariants_fired],
                })),
        }),
    );
    state.persistedFindingIds = persistedIds ?? [];

    // Step 7.7 — Phase D Task D.8: arbitration apply + tool-run persistence (gated on sa != null). When the
    // applyArbitration port is wired (Stage 5 collapse-on), run the Tier-1/Tier-2 arbitration apply BETWEEN
    // persist (Step 7.6) and walkthrough (Step 8) so the post-review footer rendered in Step 9 can fold in
    // the suppressed-finding counts + tool-degradation summary. Both dispatches are fail-open (stageOutcome
    // swallows + appends a degradation note — NOT raise), so an arbitration failure never fails an
    // already-persisted review. The arbitration result + tool statuses are captured on state.arbitration for
    // the footer renderer (posting.ts::renderWalkthroughForPost). SKIPPED when ports.applyArbitration is
    // omitted (unit tests; the Python `apply_arbitration is None` branch) OR when sa is null (no static
    // analysis ran — the advisory path-filters-excluded-all early-exit already returned).
    await applyArbitrationStep(ctx, sa, aggregated, arbitrationIntents);

    // Step 8 — walkthrough. Stage-4 walkthrough threading: the resolved linked-issues + suggested-reviewers
    // tuples (fetched fail-open by the workflow body, threaded onto the context — 1:1 with the Python
    // `_walkthrough` closure that fetched them right before `generate_walkthrough`) are rendered into the
    // "Linked issues" / "Suggested reviewers" sections. Default [] when omitted (unit tests / fail-open).
    const walkthrough = await ports.generateWalkthrough({
      schema_version: 1,
      pr_meta: pr.prMeta,
      aggregated,
      linked_issues: [...(ctx.linkedIssues ?? [])],
      suggested_reviewers: [...(ctx.suggestedReviewers ?? [])],
    });
    // output-safety-emit-walkthrough (collapse-on): same idempotent-emit / independent-retry rationale as
    // the chunk-side dispatch. SKIPPED when ctx.activities.emitOutputSafetyAudit is omitted.
    if (ports.emitOutputSafetyAudit !== undefined && walkthrough.sanitization_event !== null) {
      await ports.emitOutputSafetyAudit({ schema_version: 1, event: walkthrough.sanitization_event });
    }

    // Step 8a — persist the walkthrough to core.review_walkthroughs (persist-review-walkthrough collapse-on;
    // fail-open). stageOutcome swallows on failure + appends `persist_walkthrough_failed`; the chain
    // continues to post the walkthrough to GitHub even if the DB write fails.
    await stageOutcome(
      "persist_walkthrough",
      {
        logger: ctx.logger ?? NULL_LOGGER,
        degradationNotes: degradationAdapter(state),
        headSha,
        runId,
      },
      async (): Promise<void> =>
        ports.persistReviewWalkthrough({
          schema_version: 1,
          review_id: pr.reviewId,
          installation_id: pr.prMeta.installation_id,
          walkthrough,
        }),
    );

    // FIX #10 (owner-requested HARDENING DIVERGENCE) — final claim-check IMMEDIATELY before the post stage.
    // The frozen Python guards only THREE boundaries (before clone, before classify, before aggregate); it
    // has NO claim-check between aggregate and post. That leaves a window: a superseding review can reclaim
    // the lease AFTER the before-aggregate check but BEFORE this review publishes, so two reviews race to
    // post to the same PR and the loser overwrites the winner. This 4th check closes that window — a review
    // whose lease was stolen aborts non-retryably (the injected callback raises PrMutexLostClaim) BEFORE any
    // GitHub round-trip (no postReview, no postCheckRun), so a superseded review NEVER posts. INSIDE the try
    // → the finally-block cleanup still releases the workspace; the abort propagates to the body's BF-5/BF-13
    // terminal-transition path exactly like the other three claim-check aborts. No-op when ctx.claimCheck is
    // omitted (unit tests). DIVERGENCE from the strict 1:1 port — documented per the owner-hardening contract.
    if (ctx.claimCheck !== undefined) {
      await ctx.claimCheck();
    }

    // Step 9 — post (review + check-run). postReviewResults (posting.ts) renders the walkthrough markdown,
    // dispatches the post activity, populates state.postedReview from the result (the capture the workflow
    // body's lifecycle bookkeeping reads after orchestrate returns), and on the H-2 dropped-state failure
    // dispatches record_delivery_skipped inline before re-raising. The placeholder teardown is sequenced
    // through Step 9a, decoupled from post_check_run (FIX #7).
    const postingDeps: PostingLifecycleDeps =
      ports.recordDeliverySkipped !== undefined
        ? {
            recordDeliverySkipped: ports.recordDeliverySkipped,
            persistedFindingIds: state.persistedFindingIds,
            logger: ctx.logger ?? NULL_LOGGER,
          }
        : { persistedFindingIds: state.persistedFindingIds, logger: ctx.logger ?? NULL_LOGGER };
    await runPostStage(ctx, walkthrough, aggregated, postingDeps);

    return makeReviewPipelineResult(
      {
        status: "accepted",
        headSha,
        findingsCount: aggregated.findings.length,
        walkthrough,
        aggregated,
        fileRouting: routing,
        staticAnalysis: sa,
        carryForward: selection,
        classifierFailureRatio: failureRatio,
        degradationNotes: state.degradation.notes,
      },
      {
        reviewFindingIds: state.persistedFindingIds,
        arbitrationIntents,
        // Step 7.7 (collapse-on): the arbitration result the Step-7.7 apply produced (null when the step was
        // skipped — no applyArbitration port / sa null / the dispatch failed fail-open). The workflow body
        // also reads state.arbitration.result for the footer; the result envelope carries it for downstream
        // consumers (analytics, replay) as the Python ReviewPipelineResult.arbitration_result.
        arbitrationResult: state.arbitration.result,
      },
    );
  } finally {
    // Step 10 — cleanup runs no matter how we exit. cleanup is a LIFECYCLE consumer — it releases the
    // workspace LEASE keyed by workspace_id. The Python passed the workspace ROOT path; the TS release
    // contract (ReleaseWorkspaceInput) is workspace_id-keyed, and that id is the allocated handle's
    // workspace_id (the lease key allocate_workspace minted; the same id the cleanup releases).
    // stageOutcome wraps it; skipOutcome() suppresses the success-path emit (cleanup runs on every workflow
    // — success is the hot path; the workflow body owns the success-path counter). The failure path still
    // emits record_stage(error) + appends `cleanup_failed`. `workspacePath` is referenced for the documented
    // workspace-root invariant (cleanup keys off the handle id, not the path, in the TS contract).
    void workspacePath;
    await stageOutcome(
      "cleanup",
      {
        logger: ctx.logger ?? NULL_LOGGER,
        degradationNotes: degradationAdapter(state),
        headSha,
        runId,
      },
      async (handle): Promise<void> => {
        handle.skipOutcome();
        await ports.cleanup({
          schema_version: 1,
          workspace_id: repo.workspaceHandle.workspace_id,
        });
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// buildChunkContext — the per-chunk ReviewContextV1 build (port of the workflow body's `_review_chunk`
// closure, review_pull_request.py:1513). For each chunk: embed the query (cached per path), retrieve
// knowledge (fail-open with degradation reason), attach the per-path policy bundle, and thread the
// PR-topology manifest + tier1/tool-status context. All collapse-on gates are straight-line.
//
// SANDBOX-SAFE: only awaits the embedQuery / retrieveKnowledge activity ports (both wrapped in inner
// stageOutcome fail-open) — no inline crypto/clock/network.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
async function buildChunkContext(
  ctx: ReviewPipelineContext,
  chunk: DiffChunkV1,
  threading: ChunkThreadingV1,
): Promise<ReviewContextV1> {
  const { activities: ports, pr, state } = ctx;
  const headSha = pr.headSha;
  const runId = pr.runId;

  // policy-engine-wiring collapse-on: per-chunk policy bundle lookup (null when no bundle for the path).
  const applicablePolicy = state.policyBundles.get(chunk.path) ?? null;

  // retrieval-knowledge-wiring collapse-on: per-chunk knowledge retrieval. Query = chunk path + PR title
  // (both deterministic projections of workflow input → replay-safe). Embed the query ONCE per unique path
  // (state.queryVectorCache); reuse across subsequent chunks of the same path.
  let retrievedKnowledge: ReadonlyArray<KnowledgeChunkV1> = [];
  let retrievalDegraded = false;
  let retrievalDegradationReason = "";

  const queryText = `${chunk.path} ${pr.prMeta.pr_title}`.slice(0, QUERY_TEXT_MAX);

  // Embed-query: finding 10 — cache by stable chunk-path key + validate embedding dimension before the
  // pgvector query + fail-open-with-degradation. On embed failure the override stays undefined and the
  // retrieve activity's AnnRetriever embeds per-chunk as the legacy fallback.
  let queryVectorOverride: ReadonlyArray<number> | null = state.queryVectorCache.get(chunk.path) ?? null;
  if (queryVectorOverride === null) {
    const embedResult = await stageOutcome(
      "embed_query",
      { logger: ctx.logger ?? NULL_LOGGER, headSha, runId },
      async () => ports.embedQuery({ schema_version: 1, query: queryText }),
    );
    if (embedResult !== undefined) {
      // finding 10 — validate embedding dimension before caching / handing to the pgvector query. A
      // zero-length vector cannot anchor an ANN search; fail-open-with-degradation (skip the override,
      // AnnRetriever embeds per-chunk) rather than poisoning the cache with an unusable vector.
      if (embedResult.vector.length > 0) {
        queryVectorOverride = embedResult.vector;
        state.queryVectorCache.set(chunk.path, embedResult.vector);
      } else {
        retrievalDegraded = true;
        retrievalDegradationReason = "embed_query returned an empty vector";
      }
    }
    // embedResult === undefined: the embed activity raised, stageOutcome swallowed it; override stays null.
  }

  // Retrieve-knowledge: fail-open via stageOutcome. On the activity raising — OR the in-block confluence-
  // context build raising — stageOutcome swallows and the local marker flips retrievalDegraded.
  //
  // CONFLUENCE collapse-on (Sub-spec B T17; review_pull_request.py:1710-1799): the confluence-supporting
  // fields are built INSIDE the stage_outcome block (exactly as the Python `pick_pr_context(...)` +
  // `RetrieveKnowledgeInputV1(...)` construction sits inside the `async with stage_outcome(...)`), so a
  // PRContext validation failure (e.g. a malformed head_sha) is fail-open — the review proceeds with empty
  // retrieved_knowledge + retrieval_degraded, never crashing the chunk. The ORCHESTRATOR ALWAYS passes the
  // gated values (collapse-on — the Python workflow body's `if patched(...)` branch is straight-line in the
  // historyless TS port); the ACTIVITY's `_shouldUseHybrid` gate decides legacy-vs-hybrid per chunk (it
  // falls through to BM25+ANN+RRF unless ALL five fields are present, including a non-null
  // query_vector_override). So a chunk whose query embed failed (queryVectorOverride === null) still routes
  // through the activity, which takes the legacy path for THAT chunk — exactly the Python behaviour.
  const retrieveResult = await stageOutcome(
    "retrieve_knowledge",
    { logger: ctx.logger ?? NULL_LOGGER, headSha, runId },
    async () => {
      // pr_context: pick_pr_context(use_full=true, ...) — the full-PR context (every changed file in the
      // diff) from the enrichment result; falls back to the MVP per-chunk single-file context when
      // enrichment is null/undefined (the Python fail-open). repo_default_branch="main" (1:1 with the
      // hardcoded Python kwarg; FOLLOW-UP-confluence-repo-default-branch to thread the real default branch).
      const confluencePrContext = pickPrContext({
        useFull: true,
        prId: pr.prMeta.pr_id,
        headSha,
        repoDefaultBranch: "main",
        enrichment: ctx.enrichment,
        chunkPath: chunk.path,
        manifestSnapshots: [...(ctx.manifestSnapshots ?? [])],
      });
      const confluencePlatformLabels: ReadonlyArray<string> = [
        ...(ctx.platformExposedLabels ?? PLATFORM_EXPOSED_LABELS),
      ];
      return ports.retrieveKnowledge({
        schema_version: 1,
        installation_id: pr.prMeta.installation_id,
        // FIX #2 (part 2) — repo_id is the internal repository UUID sourced from the workflow payload's
        // `repository_id` (1:1 with the frozen Python `repo_id=typed_payload.repository_id`,
        // review_pull_request.py:1756/1768). The WorkflowBody phase threaded it onto ReviewPipelinePrCtx as
        // `repositoryId`; this rewires the dispatch off the `pr_id` stand-in the Stage-1 port used (the
        // FOLLOW-UP-thread-repository-id marker is now closed). RetrieveKnowledgeInputV1.repo_id is a UUID
        // wire string, which `repositoryId` already is.
        repo_id: pr.repositoryId,
        query: queryText,
        top_k: 5,
        query_vector_override: queryVectorOverride === null ? null : [...queryVectorOverride],
        // CONFLUENCE collapse-on: include_confluence flips false → true; the supporting fields are threaded.
        include_confluence: true,
        pr_context: confluencePrContext,
        yaml_config: state.repoConfig,
        platform_exposed_labels: [...confluencePlatformLabels],
      });
    },
  );
  if (retrieveResult !== undefined) {
    retrievedKnowledge = retrieveResult.items;
    // Accumulate the retrieved knowledge chunk IDs into the PR-level union so the post-aggregate
    // citationValidate can enforce knowledge-citation membership (strict mode) instead of skip mode. Each
    // chunk contributes the IDs IT retrieved; the union is the full "retrieved set for this review".
    for (const item of retrievedKnowledge) {
      state.retrievedKnowledgeChunkIds.add(item.chunk_id);
    }
    retrievalDegraded = retrievalDegraded || retrieveResult.retrieval_degraded;
    if (retrieveResult.degradation_reason !== "") {
      retrievalDegradationReason = retrieveResult.degradation_reason;
    }
  } else {
    // retrieve_knowledge raised → stageOutcome swallowed → flip degraded (the Python
    // `if "retrieve_knowledge_failed" in _retrieve_failed: retrieval_degraded = True`).
    retrievalDegraded = true;
  }

  // Step 5a — v10 R-12 provenance-backed evidence manifest (Stage 4 — build-retrieved-evidence collapse-on).
  // Assemble the per-chunk evidence the LLM is permitted to cite via ReviewFindingV1.evidence_refs, from the
  // already-resolved per-chunk inputs (chunk body, retrieved knowledge, tier-1 findings, tool statuses, PR
  // topology). 1:1 with the Python inline `build_retrieved_evidence(...)` call (review_pull_request.py:1813),
  // EXCEPT the producer is dispatched as a Node ACTIVITY here: the TS `mintEvidenceId` mints ev_ ids via
  // node:crypto, which is RESTRICTED in the V8-isolate workflow sandbox (ADR-0065/0066) — so per the
  // GATE-COLLAPSE/SANDBOX rules the crypto-minting MUST move to the Node runtime. Replay-safe: the activity
  // is pure modulo the deterministic UUIDv5 (content-addressable; no clock / RNG / DB), so a replay mints
  // bit-identical ev_ids. SKIPPED when ctx.activities.buildRetrievedEvidence is omitted (unit tests; the
  // Python `is not None` analogue) — then retrieved_evidence stays [] (the Stage-1 default) and the parser's
  // evidence-refs validation is a no-op. The parser at the bedrock_review_chunk boundary asserts
  // finding.evidence_refs ⊆ {ev.evidence_id} so the LLM cannot invent grounding (CLAUDE.md invariant 15).
  let retrievedEvidence: ReadonlyArray<RetrievedEvidenceV1> = [];
  if (ports.buildRetrievedEvidence !== undefined) {
    retrievedEvidence = await ports.buildRetrievedEvidence({
      schema_version: 1,
      chunk,
      retrieved_knowledge: [...retrievedKnowledge],
      // The producer assembles entries from the SAME tier-1 / tool-status / topology context the chunk's
      // ReviewContextV1 carries (the fan-out threading), so the evidence ids the LLM may cite line up
      // exactly with what the prompt renders.
      tier1_findings: [...threading.tier1Findings],
      tool_statuses: [...threading.toolStatuses],
      pr_topology_manifest: [...threading.prTopologyManifest],
      // The hard cap on the output tuple length — matches the producer's _DEFAULT_ENTRY_CAP AND
      // ReviewContextV1.retrieved_evidence max_length (100), so the manifest never overflows the contract
      // that carries it. Explicit because the dispatch builds a parsed-output-shaped object.
      max_entries: EVIDENCE_ENTRY_CAP,
    });
  }

  return {
    schema_version: 1,
    pr_id: pr.prMeta.pr_id,
    installation_id: pr.prMeta.installation_id,
    repo: pr.prMeta.repo,
    pr_title: pr.prMeta.pr_title,
    pr_description: pr.prMeta.pr_description,
    chunk,
    policy_revision: pr.policyRevision,
    prior_findings: [],
    // FIX #6+#9 — ADR-0001 per-glob path_instructions: every rule whose `path` glob matches THIS chunk's
    // path, in declaration order. 1:1 with the Python `_review_chunk` closure's
    // `match_path_instructions(path=chunk.path, rules=repo_config.path_instructions)` call. Driven by the
    // SAME ported matcher (apps/backend/src/config/path_match.ts) that backs filterReviewPaths, so the two
    // path-config surfaces never diverge. Empty when the config carries no path_instructions (the common
    // case) — a clean no-op the activity reads declaratively.
    matched_path_instructions: matchPathInstructions(
      state.repoConfig.path_instructions,
      chunk.path,
    ),
    repo_config: state.repoConfig,
    retrieved_knowledge: [...retrievedKnowledge],
    retrieval_degraded: retrievalDegraded,
    retrieval_degradation_reason: retrievalDegradationReason,
    // prompt-budget-enforcement-v1 collapse-on: the assemble_prompt budget subsystem is now ported
    // (apps/backend/src/review/prompt_assembler.ts — byte-exact, Tier-1 parity-tested), so the prompt
    // builder honors this flag. The true branch (rank-then-wholesale-drop) is the live one — it caps
    // the per-chunk prompt at total_budget_tokens (4000) / policy_max_tokens (3000), force-including
    // forbid/security rules over the cap rather than dropping them silently.
    budget_enforcement: true,
    applicable_policy: applicablePolicy,
    removed_or_changed_symbols: [],
    consumer_hits: [],
    consumer_hits_truncated: false,
    // tier2-linter-aware-prompt collapse-on: thread the Tier-1 context straight from the fan-out threading.
    tier1_findings: [...threading.tier1Findings],
    tool_statuses: [...threading.toolStatuses],
    // build-retrieved-evidence collapse-on: the per-chunk manifest the producer activity assembled above.
    retrieved_evidence: [...retrievedEvidence],
    // pr-topology-manifest collapse-on: the manifest the fan-out threaded in.
    pr_topology_manifest: [...threading.prTopologyManifest],
    // #4 — the workflow body's fetch→parse manifest snapshots, threaded onto the ctx + rendered by the
    // prompt builder's `## PR dependency manifests` section. Empty when manifest fetch was skipped (no
    // enrichment / no changed paths / no github_installation_id) or failed (fail-open).
    manifests: [...(ctx.manifestSnapshots ?? [])],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// selectCarryForwardWithFallback — Step 4 with the fail-open "review every chunk" fallback (the Python
// sentinel-flag pattern). stageOutcome with raiseAfterLog=true appends `select_carry_forward_failed` + logs
// outcome=error; the outer catch re-builds the "review everything" selection and adds the human-readable
// note the walkthrough renderer consumes.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
async function selectCarryForwardWithFallback(
  ctx: ReviewPipelineContext,
  chunks: ReadonlyArray<DiffChunkV1>,
): Promise<CarryForwardSelectionV1> {
  const { activities: ports, pr, state } = ctx;
  try {
    const selection = await stageOutcome(
      "select_carry_forward",
      {
        logger: ctx.logger ?? NULL_LOGGER,
        degradationNotes: degradationAdapter(state),
        headSha: pr.headSha,
        runId: pr.runId,
        raiseAfterLog: true,
      },
      async () =>
        ports.selectCarryForward({
          parentFindings: [...pr.parentFindings],
          currentChunks: [...chunks],
          changedLineRanges: pr.changedLineRanges,
          parentReviewId: pr.parentReviewId,
        }),
    );
    // raiseAfterLog=true → on success `selection` is the result; on failure stageOutcome re-raised into the
    // catch below. The undefined branch is unreachable on success but typed-guarded.
    if (selection === undefined) {
      throw new Error("select_carry_forward: unexpected empty result after re-raise contract");
    }
    return selection;
  } catch {
    // Fallback: review EVERY chunk. The human-readable note is added in ADDITION to the helper's machine
    // marker (`select_carry_forward_failed`, appended by stageOutcome before it re-raised).
    state.degradation.add("carry-forward selector failed; every chunk re-reviewed");
    return {
      schema_version: 1,
      carried: [],
      to_review: [...chunks],
      parent_review_id: pr.parentReviewId,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// applyPolicyPostFilter — Step 7.2 inline system-invariants post-filter (1:1 with the Python
// _apply_policy_post_filter closure, review_pull_request.py:1347). Pure + synchronous (no activity boundary
// — the SYSTEM_INVARIANTS enforcement is pure stdlib): runs the severity floor over the aggregated findings,
// stashes the per-finding metadata on state for the persist step, and emits the per-(invariant, category)
// observability counter for each fired invariant.
//
// No-op (returns `aggregated` unchanged) when state.policyBundles is empty — the Python `if not
// policy_bundles: return aggregated` early-out (FF off / no rules apply). The merged review-level bundle is
// the union of the per-chunk bundles (dedup by rule_id, deterministic sort) so the invariants run against
// the same rule set every consumer sees. post_filter_findings_with_metadata is pure + handles per-invariant
// enforcement exceptions internally (fail-CLOSED at finding level per ADR 0042), so no stage_outcome wrap is
// needed (it does not raise on the happy path). SANDBOX-SAFE: no clock/random/network/DB.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
function applyPolicyPostFilter(
  ctx: ReviewPipelineContext,
  aggregated: AggregatedFindingsV1,
): AggregatedFindingsV1 {
  const { state } = ctx;
  if (state.policyBundles.size === 0) {
    // FF off / no rules apply — nothing to filter (the Python `if not policy_bundles` early-out).
    return aggregated;
  }
  const merged = mergePerChunkBundles(state.policyBundles);
  // post_filter_findings_with_metadata is pure (no I/O) AND handles per-invariant enforcement exceptions
  // internally per ADR 0042 (fail-CLOSED at finding level — the original finding is preserved if an
  // enforcement callable raises). The outer function does not raise on the happy path.
  const [filtered, perFindingMetadata] = postFilterFindingsWithMetadata(aggregated.findings, merged);
  recordStagePolicyPostFilter();
  // R-23: stash the metadata on state so the persist step threads it as precomputed_metadata. (Pre-fix the
  // persist re-filtered, which double-mutated and silently zeroed invariants_fired — in TS there is no
  // persist-side filter, so this simply back-fills the metadata column faithfully.)
  state.inlinePostFilterMetadata = perFindingMetadata;
  if (findingsArrayEqual(filtered, aggregated.findings)) {
    // No invariant fired; no-op result (object-identity preserved per finding through the no-op enforcement).
    return aggregated;
  }
  // R-9 + T-3: at least one finding changed. Emit ONE per-(invariant_id, category) counter per finding x
  // fired-invariant pair, using the REAL invariant_id from the metadata tuple.
  for (let i = 0; i < filtered.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded loop cursor into length-aligned local arrays
    const post = filtered[i]!;
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded loop cursor into a length-aligned local array
    const meta = perFindingMetadata[i]!;
    for (const firedInvariantId of meta.invariants_fired) {
      recordInvariantViolationAttempted({ invariantId: firedInvariantId, category: post.category });
    }
  }
  // model_copy(update={"findings": filtered}) — a fresh AggregatedFindingsV1 carrying the floored findings.
  return {
    schema_version: aggregated.schema_version,
    findings: [...filtered],
    dedupe_stats: aggregated.dedupe_stats,
    policy_revision: aggregated.policy_revision,
  };
}

/** Reference-identity array compare (the Python `filtered == aggregated.findings` no-op detect). The
 *  post-filter returns the SAME finding object on the no-op path (system_invariants.ts equality contract),
 *  so a per-element reference compare is exactly the Python value-equality short-circuit. */
function findingsArrayEqual(
  a: ReadonlyArray<ReviewFindingV1>,
  b: ReadonlyArray<ReviewFindingV1>,
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded loop cursor into length-equal local arrays
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Emit the policy_post_filter stage outcome=ok (the Python `_log_stage("policy_post_filter", outcome="ok")`
 *  inside the post-filter closure). Factored so the (sync) post-filter records the stage without a
 *  stageOutcome wrapper (which is for the swallow/re-raise async path). */
function recordStagePolicyPostFilter(): void {
  recordStage({ stage: "policy_post_filter", outcome: "ok" });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// applyArbitrationStep — Step 7.7 arbitration apply + tool-run record (1:1 with the orchestrator's Step 7.7
// block, review_pipeline_orchestrator.py:861 + the workflow body's _apply_arbitration / _record_tool_runs
// bridges, review_pull_request.py:3091/3185). Both dispatches are FAIL-OPEN (stageOutcome swallows + appends
// a degradation note — NOT raise), so an arbitration/tool-run failure never fails an already-persisted
// review. The result + tool statuses are captured on state.arbitration for the post-review footer renderer.
//
// The tier-2 mapping (arbitration finding_id → persisted review_finding_id) is built by zip-aligning the
// persisted rfids (state.persistedFindingIds, input order preserved by the persist activity's bulk INSERT)
// with aggregated.findings. The arbitration finding_id IS the persisted rfid — identity mapping for tier-2.
//
// SKIPPED when ports.applyArbitration is omitted (unit tests) OR sa is null (no static analysis ran).
// record_tool_runs runs only when sa.tool_statuses is non-empty.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
async function applyArbitrationStep(
  ctx: ReviewPipelineContext,
  sa: StaticAnalysisResultV1 | null,
  aggregated: AggregatedFindingsV1,
  arbitrationIntents: ReadonlyArray<ArbitrationIntentV1>,
): Promise<void> {
  const { activities: ports, pr, state } = ctx;
  if (ports.applyArbitration !== undefined && sa !== null) {
    // Build the tier-2 pairs + id map by zip-aligning persisted rfids with aggregated findings (both share
    // input order; the arbitration finding_id is the persisted rfid — identity mapping for tier-2).
    const rfids = state.persistedFindingIds;
    const tier2Pairs: Array<Tier2Pair> = [];
    const tier2IdMap: Record<string, string> = {};
    if (rfids.length > 0) {
      const n = Math.min(rfids.length, aggregated.findings.length); // zip(strict=False) — stop at shorter.
      for (let i = 0; i < n; i += 1) {
        // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded loop cursor into length-bounded local arrays
        const rfid = rfids[i]!;
        // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded loop cursor into a length-bounded local array
        const finding = aggregated.findings[i]!;
        tier2Pairs.push([rfid, finding]);
      }
      for (const rfid of rfids) {
        // eslint-disable-next-line security/detect-object-injection -- `rfid` is a workflow-local UUID string from the persisted-id tuple, not external input
        tier2IdMap[rfid] = rfid;
      }
    }
    const applyArbitration = ports.applyArbitration;
    const input: ApplyArbitrationInputV1 = {
      schema_version: 1,
      installation_id: pr.prMeta.installation_id,
      pr_id: pr.prMeta.pr_id,
      run_id: pr.runId,
      review_id: pr.reviewId,
      tier1_findings: [...sa.tier1_findings],
      tier2_findings: tier2Pairs,
      tier2_review_finding_id_by_arbitration_id: tier2IdMap,
      intents: [...arbitrationIntents],
      // The arbitration model + prompt_version threaded into the persistence layer's audit columns
      // (suppression_model, suppression_prompt_version). 1:1 with the Python placeholder values.
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      prompt_version: "phase-d-2026-05-16",
      // The replay-safe instant written onto SUPPRESSED_BY_LLM decisions' suppressed_at (the Python
      // now=workflow.now()). Resolved by the workflow body; epoch-zero default for unit tests.
      now: ctx.arbitrationNow ?? "1970-01-01T00:00:00.000Z",
    };
    const result = await stageOutcome(
      "apply_arbitration",
      {
        logger: ctx.logger ?? NULL_LOGGER,
        degradationNotes: degradationAdapter(state),
        headSha: pr.headSha,
        runId: pr.runId,
      },
      async (): Promise<ReturnType<NonNullable<ReviewActivityPorts["applyArbitration"]>>> =>
        applyArbitration(input),
    );
    if (result !== undefined) {
      // Capture the result so the post-review footer renderer (posting.ts) folds in the suppressed-finding
      // counts. The Python _apply_arbitration_with_capture bridge sets arbitration_capture.result IFF the
      // activity returned a result; the orchestrator's result envelope also carries it.
      state.arbitration.result = result;
    }
  }
  if (ports.recordToolRuns !== undefined && sa !== null && sa.tool_statuses.length > 0) {
    // Capture the tool statuses for the footer renderer (the Python _record_tool_runs_with_capture bridge),
    // then dispatch the record. Both fail-open.
    state.arbitration.toolStatuses = [...sa.tool_statuses];
    const recordToolRuns = ports.recordToolRuns;
    const toolStatuses = sa.tool_statuses;
    await stageOutcome(
      "record_tool_runs",
      {
        logger: ctx.logger ?? NULL_LOGGER,
        degradationNotes: degradationAdapter(state),
        headSha: pr.headSha,
        runId: pr.runId,
      },
      async (): Promise<void> =>
        recordToolRuns({
          schema_version: 1,
          installation_id: pr.prMeta.installation_id,
          run_id: pr.runId,
          review_id: pr.reviewId,
          tool_statuses: [...toolStatuses],
        }),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// post helpers — the parallel Step 9 sub-dispatches, factored so the empty-path early-exit and the normal
// path share one call shape. postReview maps the orchestrator state onto the PostReviewInputV1 contract;
// postCheckRun maps onto PostCheckRunInputV1. (The Python `_post_review` / `_post_check` closures.)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
async function postCheckRun(
  ports: ReviewActivityPorts,
  pr: ReviewPipelinePrCtx,
  headSha: string,
  summary: string,
): Promise<void> {
  await ports.postCheckRun({
    schema_version: 1,
    pr_meta: pr.prMeta,
    head_sha: headSha,
    summary,
    owner: ownerOf(pr.prMeta.repo),
    repo_name: repoNameOf(pr.prMeta.repo),
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// runPostStage — Step 9 post (review + check-run) with the placeholder teardown DECOUPLED from the
// check-run (FIX #7).
//
// THE BUG IT FIXES: the prior shape was `await Promise.all([postReviewResults(...), postCheckRun(...)])`
// FOLLOWED BY the placeholder teardown. Promise.all REJECTS the instant `postCheckRun` rejects — so when
// post_check_run failed (a transient GitHub Checks-API hiccup) the await threw BEFORE the teardown line ran,
// and the "reviewing this PR…" placeholder comment was STRANDED on a PR whose real review had ALREADY been
// delivered by `postReviewResults`. The teardown is logically part of the review-delivery path, NOT the
// check-run path.
//
// THE PYTHON PARITY: the frozen Python places `delete_review_placeholder` INSIDE the `_post_review` closure,
// sequenced AFTER `post_review_results` lands (review_pull_request.py:2809-2853) — i.e. coupled to the
// review post, INDEPENDENT of `_post_check`. The two run as separate anyio task-group tasks; the placeholder
// teardown belongs to the review task. This restructure restores that coupling in the TS port.
//
// THE STRUCTURE:
//   * Both posts are still issued concurrently (the Promise.all parallelism + the consecutive-pair dispatch
//     order the composition test asserts are preserved — neither member awaits the other before dispatch).
//   * We settle them via Promise.allSettled so a post_check_run rejection does NOT short-circuit the review
//     branch.
//   * If postReviewResults SUCCEEDED, tear down the placeholder NOW — independent of post_check_run's
//     outcome — so a delivered review never strands its placeholder.
//   * A post_check_run-only failure becomes a DEGRADED-AFTER-REVIEW-DELIVERY outcome: a `post_check_run`
//     stage-outcome=error + a degradation note, then the pipeline continues (the review is the value; the
//     check-run is advisory polish). It does NOT re-raise (that would fail an already-delivered review).
//   * If postReviewResults REJECTED, the review genuinely failed to deliver: the placeholder stays (the
//     "reviewing…" notice is still accurate), and we re-raise its error so the body's BF-5/BF-13 terminal
//     path marks the run FAILED. The H-2 dropped-state skip-dispatch already ran INSIDE postReviewResults
//     before it rejected.
//
// SANDBOX-SAFE: pure control flow over the activity-port dispatches + the injected teardown callback — no
// new clock/RNG/network/crypto.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
async function runPostStage(
  ctx: ReviewPipelineContext,
  walkthrough: WalkthroughV1,
  aggregated: AggregatedFindingsV1,
  postingDeps: PostingLifecycleDeps,
): Promise<void> {
  const { activities: ports, pr, state } = ctx;
  const headSha = pr.headSha;

  // Issue BOTH posts concurrently, then settle (so post_check_run failure cannot short-circuit the review
  // branch before its placeholder teardown). The two dispatches start back-to-back with no await between
  // them — the parallelism + the consecutive-pair dispatch order are unchanged.
  const [reviewSettled, checkSettled] = await Promise.allSettled([
    postReviewResults(ports, state, walkthrough, aggregated, pr, postingDeps),
    postCheckRun(ports, pr, headSha, walkthrough.tldr),
  ]);

  if (reviewSettled.status === "rejected") {
    // The REVIEW failed to deliver. The placeholder stays (the "reviewing…" notice is still accurate). The
    // H-2 dropped-state inline skip already ran inside postReviewResults before it rejected. Re-raise so the
    // body's BF-5/BF-13 terminal-transition path marks the run FAILED — exactly as the prior Promise.all did
    // for a postReview rejection. (A post_check_run rejection that ALSO occurred is subordinate; the review
    // failure is the dominant operator signal.)
    throw reviewSettled.reason;
  }

  // The REVIEW delivered. Tear down the placeholder NOW — INDEPENDENT of post_check_run's outcome — so a
  // delivered review never strands its placeholder. Best-effort: the injected callback wraps the dispatch in
  // stageOutcome + swallows; it never fails the pipeline. No-op when ctx.onPlaceholderTeardown is omitted
  // (unit tests). 1:1 with the Python `delete_review_placeholder` INSIDE `_post_review` after the post lands.
  if (ctx.onPlaceholderTeardown !== undefined) {
    await ctx.onPlaceholderTeardown();
  }

  // A post_check_run-only failure → DEGRADED-AFTER-REVIEW-DELIVERY: surface the stage-outcome=error + a
  // degradation note, then CONTINUE (the review is already on GitHub; the check-run is advisory). recordStage
  // emits `post_check_run` outcome=error (no-op outside a workflow). We do NOT re-raise — that would fail an
  // already-delivered review.
  if (checkSettled.status === "rejected") {
    recordStage({ stage: "post_check_run", outcome: "error" });
    (ctx.logger ?? NULL_LOGGER).warning(
      `stage_outcome: post_check_run failed; review already delivered ` +
        `head_sha=${headSha} run_id=${pr.runId}`,
    );
    state.degradation.add("post_check_run_failed");
  }
}

// ─── small pure helpers ──────────────────────────────────────────────────────────────────────────

/** Split a "owner/repo" slug into its owner half (the part before the first '/'). PrMetaV1.repo carries the
 *  full slug; the post activities target owner + repo_name separately. */
function ownerOf(repoSlug: string): string {
  const idx = repoSlug.indexOf("/");
  return idx === -1 ? repoSlug : repoSlug.slice(0, idx);
}

/** Split a "owner/repo" slug into its repo-name half (the part after the first '/'). */
function repoNameOf(repoSlug: string): string {
  const idx = repoSlug.indexOf("/");
  return idx === -1 ? repoSlug : repoSlug.slice(idx + 1);
}

/** Adapter exposing `state.degradation` as the `{ push }` shape stageOutcome appends `<stage>_failed` to.
 *  Routes through DegradationCollector.add so the dedup-on-insert discipline is preserved (a plain array
 *  push would skip dedup). */
function degradationAdapter(state: ReviewWorkflowState): { push(note: string): void } {
  return {
    push(note: string): void {
      state.degradation.add(note);
    },
  };
}

