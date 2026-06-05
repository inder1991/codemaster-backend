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
// ── DEFERRED (tracked; pass empty/None per the task) ──
//   * retrieved_evidence / build_retrieved_evidence (Stage 4 — mints ev_ ids via crypto, must run in an
//     activity; the workflow sandbox bans node:crypto). Passed as [] here.
//   * confluence pr_context + label routing (Stage 4 — confluence cluster). retrieveKnowledge dispatched
//     WITHOUT pr_context / yaml_config / platform_exposed_labels (the legacy BM25+ANN+RRF fast path).
//   * citation_validate (Stage 3 — its own activity boundary; Path.resolve syscalls). Step 7.5 skipped.
//   * apply_policy_post_filter (Stage 5 — policy post-filter relocation). Step 7.2 skipped.
//   * apply_arbitration / record_tool_runs (Stage 5 — arbitration layer). Step 7.7 skipped.
//   * match_path_instructions (NOT YET PORTED — codemaster/config/path_match.py). matched_path_instructions
//     passed as [] until the path-match helper lands; the activity reads it declaratively, so [] is a clean
//     no-op (the legacy "no per-glob instructions" shape).
//   * tier1_findings / tool_statuses threading (static-analysis-orchestrator-v2 + tier2-linter-aware-prompt
//     collapse-on, Stage 5). Stage 1's staticAnalysis returns an empty-valid StaticAnalysisResultV1, so the
//     threaded tuples are empty regardless; the WIRING is in place (the orchestrator threads
//     sa.tier1_findings / sa.tool_statuses straight-line — collapse-on), and turns real once Stage 4 wires
//     a populating staticAnalysis. No conditional gate remains.
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
} from "./helpers.js";
import { stageOutcome, type StageLogger } from "./degradation.js";
import { postReviewResults, type PostingLifecycleDeps } from "./posting.js";

import type { PrMetaV1 } from "#contracts/walkthrough.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import type { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import type { ChangedLineRanges } from "./activity_ports.js";
import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import type { CarryForwardSelectionV1 } from "#contracts/carry_forward.v1.js";
import type { ReviewContextV1 } from "#contracts/review_context.v1.js";
import type { ReviewChunkResponseV1 } from "#contracts/review_chunk_response.v1.js";
import type { PRTopologyEntryV1 } from "#contracts/pr_topology.v1.js";
import type { KnowledgeChunkV1 } from "#contracts/knowledge_chunks.v1.js";
import type { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";

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
    const computed = await ports.computePolicyRules({
      schema_version: 1,
      workspace_path: workspaceRoot,
      // Python: custom_patterns=repo_config.knowledge.file_patterns;
      // knowledge_enabled=repo_config.knowledge.enabled (review_pull_request.py:1308-1309).
      custom_patterns: [...state.repoConfig.knowledge.file_patterns],
      knowledge_enabled: state.repoConfig.knowledge.enabled,
      changed_paths: [...repo.changedPaths],
    });
    for (const [path, bundle] of Object.entries(computed.bundles)) {
      state.policyBundles.set(path, bundle);
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
        linked_issues: [],
        suggested_reviewers: [],
      });

      // The advisory post also runs through posting.ts::postReviewResults so it populates state.postedReview
      // (the Python advisory post goes through `_post_review` too). The advisory path has no persisted
      // findings (chunk/persist were skipped), so the dropped-state skip dispatch is inert.
      const advisoryPostingDeps: PostingLifecycleDeps =
        ports.recordDeliverySkipped !== undefined
          ? {
              recordDeliverySkipped: ports.recordDeliverySkipped,
              persistedFindingIds: state.persistedFindingIds,
            }
          : { persistedFindingIds: state.persistedFindingIds };
      await Promise.all([
        postReviewResults(ports, state, walkthroughEmpty, aggregatedEmpty, pr, advisoryPostingDeps),
        postCheckRun(ports, pr, headSha, walkthroughEmpty.tldr),
      ]);

      // Placeholder teardown AFTER the advisory review post (Python places `delete_review_placeholder`
      // inside `_post_review`, so it fires for this advisory post too). No-op when omitted.
      if (ctx.onPlaceholderTeardown !== undefined) {
        await ctx.onPlaceholderTeardown();
      }

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

    // Step 5 — fan-out LLM review. Collapse-on of static-analysis-orchestrator-v2 + pr-topology-manifest:
    // thread tier1_findings / tool_statuses (straight from sa) AND build the PR-topology manifest from the
    // chunks selected for review. fanOutReview returns [findings, intents]; intents propagate to the result
    // for Stage 5's arbitration layer.
    const tier1ForFanout = sa.tier1_findings;
    const toolStatusesForFanout = sa.tool_statuses;
    const prTopologyManifest: ReadonlyArray<PRTopologyEntryV1> = selection.to_review.map(
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

    const [newFindings, arbitrationIntents] = await fanOutReview(selection.to_review, invokeChunk, {
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

    // Step 7 — aggregate. (`let`: Step 7.5's citation_validate reassigns `aggregated` to the surviving
    // partition; the DEFERRED apply_policy_post_filter / apply_arbitration reassignments land in Stage 5.)
    let aggregated: AggregatedFindingsV1 = await ports.aggregate({
      findings: deduped.findings,
      policyRevision: pr.policyRevision,
    });

    // DEFERRED Step 7.2 — apply_policy_post_filter (Stage 5). DEFERRED Step 7.7 — apply_arbitration /
    // record_tool_runs (Stage 5). Skipped at this stage; aggregated flows downstream unchanged.

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
        knowledge_chunk_ids: null, // skip mode — see citation_validator docstring
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
          precomputed_metadata: null,
        }),
    );
    state.persistedFindingIds = persistedIds ?? [];

    // Step 8 — walkthrough.
    const walkthrough = await ports.generateWalkthrough({
      schema_version: 1,
      pr_meta: pr.prMeta,
      aggregated,
      linked_issues: [],
      suggested_reviewers: [],
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

    // Step 9 — post (review + check-run, in parallel). postReviewResults (posting.ts) renders the
    // walkthrough markdown, dispatches the post activity, populates state.postedReview from the result (the
    // capture the workflow body's lifecycle bookkeeping reads after orchestrate returns), and on the H-2
    // dropped-state failure dispatches record_delivery_skipped inline before re-raising.
    const postingDeps: PostingLifecycleDeps =
      ports.recordDeliverySkipped !== undefined
        ? { recordDeliverySkipped: ports.recordDeliverySkipped, persistedFindingIds: state.persistedFindingIds }
        : { persistedFindingIds: state.persistedFindingIds };
    await Promise.all([
      postReviewResults(ports, state, walkthrough, aggregated, pr, postingDeps),
      postCheckRun(ports, pr, headSha, walkthrough.tldr),
    ]);

    // Step 9a — placeholder teardown (Stage 2). The Python invokes `delete_review_placeholder` INSIDE
    // `_post_review`, AFTER the real `post_review_results` activity lands the review (review_pull_request.py
    // :2809-2853). The TS port surfaces it as a context callback invoked ONCE here, right after the post
    // pair resolves, so the "reviewing this PR..." placeholder comment is torn down only once the real
    // review is on GitHub. Best-effort: the injected callback swallows (stageOutcome) — it never fails the
    // pipeline. No-op when ctx.onPlaceholderTeardown is omitted (unit tests).
    if (ctx.onPlaceholderTeardown !== undefined) {
      await ctx.onPlaceholderTeardown();
    }

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
        // DEFERRED: arbitration_result stays null until Stage 5 wires apply_arbitration.
        arbitrationResult: null,
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

  // Retrieve-knowledge: fail-open via stageOutcome. On the activity raising, stageOutcome swallows and the
  // local marker tuple flips retrievalDegraded. DEFERRED: confluence pr_context / yaml_config /
  // platform_exposed_labels (Stage 4) — dispatched WITHOUT them (the legacy BM25+ANN+RRF fast path).
  const retrieveResult = await stageOutcome(
    "retrieve_knowledge",
    { logger: ctx.logger ?? NULL_LOGGER, headSha, runId },
    async () =>
      ports.retrieveKnowledge({
        schema_version: 1,
        installation_id: pr.prMeta.installation_id,
        repo_id: pr.prMeta.pr_id, // repo_id is sourced from the workflow payload in Python; pr_id stands in
        // until the repository_id is threaded onto ReviewPipelinePrCtx (FOLLOW-UP-thread-repository-id).
        query: queryText,
        top_k: 5,
        query_vector_override: queryVectorOverride === null ? null : [...queryVectorOverride],
        include_confluence: false,
        pr_context: null,
        yaml_config: null,
        platform_exposed_labels: [],
      }),
  );
  if (retrieveResult !== undefined) {
    retrievedKnowledge = retrieveResult.items;
    retrievalDegraded = retrievalDegraded || retrieveResult.retrieval_degraded;
    if (retrieveResult.degradation_reason !== "") {
      retrievalDegradationReason = retrieveResult.degradation_reason;
    }
  } else {
    // retrieve_knowledge raised → stageOutcome swallowed → flip degraded (the Python
    // `if "retrieve_knowledge_failed" in _retrieve_failed: retrieval_degraded = True`).
    retrievalDegraded = true;
  }

  // DEFERRED: build_retrieved_evidence (Stage 4 — mints ev_ ids via crypto; must run in an activity).
  // retrieved_evidence passed as [] here; the parser's evidence-refs validation runs in the Stage-4 wiring.
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
    // DEFERRED: match_path_instructions (codemaster/config/path_match.py not yet ported) → [].
    matched_path_instructions: [],
    repo_config: state.repoConfig,
    retrieved_knowledge: [...retrievedKnowledge],
    retrieval_degraded: retrievalDegraded,
    retrieval_degradation_reason: retrievalDegradationReason,
    budget_enforcement: false,
    applicable_policy: applicablePolicy,
    removed_or_changed_symbols: [],
    consumer_hits: [],
    consumer_hits_truncated: false,
    // tier2-linter-aware-prompt collapse-on: thread the Tier-1 context straight from the fan-out threading.
    tier1_findings: [...threading.tier1Findings],
    tool_statuses: [...threading.toolStatuses],
    // DEFERRED: retrieved_evidence (Stage 4).
    retrieved_evidence: [],
    // pr-topology-manifest collapse-on: the manifest the fan-out threaded in.
    pr_topology_manifest: [...threading.prTopologyManifest],
    manifests: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// filterReviewPaths — port of the workflow body's path_filters review-set narrowing (the
// filter_review_paths_cb closure). LAST-MATCH-WINS over the config's path_filters: a leading '!' is an
// exclude marker; a bare pattern is an include. With no path_filters the function is the identity over its
// input (the collapse-on identity-when-no-filters path). Pure + synchronous (no activity boundary).
//
// The matcher is a minimal glob: '*' matches any run of non-'/' chars, '**' matches across '/' boundaries,
// '?' matches one non-'/' char. This mirrors the Python config-side fnmatch-ish semantics for the spine
// happy path; the full glob engine (codemaster/config/path_match.py) lands with the path-match port.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function filterReviewPaths(
  reviewFiles: ReadonlyArray<string>,
  pathFilters: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (pathFilters.length === 0) {
    return [...reviewFiles];
  }
  const kept: Array<string> = [];
  for (const file of reviewFiles) {
    // Default-include when the first matching rule is an include OR no rule matches AND the filter set is
    // all-excludes (so an exclude-only filter prunes named paths and keeps the rest). Last-match-wins: the
    // last rule whose pattern matches `file` decides; if none matches, keep iff there is no include rule
    // at all (exclude-only filters are subtractive).
    let decision: boolean | null = null;
    let sawInclude = false;
    for (const raw of pathFilters) {
      const isExclude = raw.startsWith("!");
      if (!isExclude) {
        sawInclude = true;
      }
      const pattern = isExclude ? raw.slice(1) : raw;
      if (globMatch(pattern, file)) {
        decision = !isExclude;
      }
    }
    const keep = decision ?? !sawInclude;
    if (keep) {
      kept.push(file);
    }
  }
  return kept;
}

/** Minimal glob matcher (sandbox-safe; pure). '**' → any (incl. '/'); '*' → any run of non-'/'; '?' → one
 *  non-'/'. Anchored full-string match. */
function globMatch(pattern: string, path: string): boolean {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded loop cursor into a local string, not user input
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        // swallow a trailing '/' after '**' so '**/x' matches 'x' too
        // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded loop cursor into a local string
        if (pattern[i] === "/") {
          i += 1;
        }
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    // escape regex metacharacters in the literal run
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  re += "$";
  // eslint-disable-next-line security/detect-non-literal-regexp -- `re` is built solely from `pattern` (config-sourced glob) with all metachars escaped; no injection surface
  return new RegExp(re).test(path);
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

