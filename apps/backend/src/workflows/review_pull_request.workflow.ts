/**
 * `reviewPullRequest` workflow — the Temporal-TS workflow body that drives the review-pipeline SPINE.
 *
 * 1:1 PORT of the frozen Python `ReviewPullRequestWorkflow.run`
 * (vendor/codemaster-py/codemaster/workflows/review_pull_request.py:477) for the SPINE + the Stage-2
 * mutex/workspace LIFECYCLE. The body now carries the load-bearing ordering the Stage-1 thin body
 * deliberately bypassed:
 *
 *   1. GATE — dispatch `start_review_for_webhook_activity` with the RAW payload. The gate does the
 *      tenancy re-check + per-PR mutex acquire. A non-`accepted` status (skipped_busy / skipped_disabled /
 *      closed / skipped_legacy_payload) SHORT-CIRCUITS the whole workflow — we return the gate result
 *      verbatim. On `accepted` we extract the held `mutex_id` (raise if null — the PR #111 B-A1 fix means
 *      the gate holds the mutex for the chain duration).
 *   2. PLACEHOLDER — dispatch `post_review_placeholder_activity` (best-effort, stageOutcome-wrapped) so
 *      engineers see a "reviewing this PR..." comment within ~5s of webhook receipt.
 *   3. WORKSPACE — dispatch `allocate_workspace_activity` to mint a REAL `WorkspaceHandle` (replacing the
 *      Stage-1 deterministic stub); thread it through `ctx.repo.workspaceHandle` so the clone activity
 *      targets the lease-managed directory.
 *   4. ORCHESTRATE — call `orchestrate(ctx)` with two Stage-2 lifecycle callbacks threaded onto the
 *      context: `claimCheck` (the `_abort_if_claim_lost` renewal-backed lease check fired before clone,
 *      classify, aggregate) and `onPlaceholderTeardown` (the `delete_review_placeholder` call fired after
 *      the real post lands).
 *   5. CLEANUP (finally, NON-CANCELLABLE) — release the PR mutex AND release the workspace on EVERY exit
 *      path (success, error, Temporal cancellation). The cleanup runs inside a `CancellationScope.
 *      nonCancellable` so a cancellation still executes the release activities before the CancelledFailure
 *      re-propagates (the Python try/finally analogue; the finally always runs even under cancellation).
 *
 * ── GATE COLLAPSE (gates.ts COLLAPSED_GATES) ──
 * This is a NEW Temporal workflow type with ZERO Python histories, so every `workflow.patched(marker)` is
 * unconditionally TRUE — the TRUE branch of every gate is straight-line code; we NEVER call
 * `workflow.patched()` / `deprecate_patch()`. In particular the `pr-mutex-lease-renewal` gate is collapse-
 * on: lease renewal is UNCONDITIONAL. The Python `_claim_still_held` time-throttle (the `force=False`
 * branch via `workflow.now()`) is DEAD in the frozen body — every call site is `_abort_if_claim_lost` →
 * `_claim_still_held(force=True)`, which short-circuits the throttle. So the renewal runs unconditionally
 * at each of the three boundaries; the wall-clock throttle is not ported (it would be unreachable code AND
 * would trip the clock/random gate, which bans `Date.now()` in the workflow sandbox).
 *
 * ── STAGE-3 RUN-LIFECYCLE + DELIVERY BOOKKEEPING (wired here) ──
 *   * ANALYSIS_STARTED is emitted after the gate/placeholder/allocate (before the BF-5 try opens).
 *   * The BF-5/BF-13 outer try/catch flips the run RUNNING → FAILED (any uncaught exception) or RUNNING →
 *     CANCELLED (a Temporal cancellation), AFTER the inner non-cancellable cleanup released the mutex +
 *     workspace. Both run-transition records are best-effort (logged + swallowed so the original exception
 *     re-propagates).
 *   * After orchestrate returns, `runLifecycleBookkeeping` flips the persisted findings to their delivery
 *     outcome (finalized / skipped / degraded) from `state.postedReview` (the capture the orchestrator's
 *     posting.ts populates) + the pipeline result's ordered rfids. Bookkeeping-only: a setter failure NEVER
 *     fails the workflow.
 *   * ANALYZED is then emitted (with the buildAnalyzedPayload publication/degradation provenance) and the
 *     run advances RUNNING → COMPLETED via finalize_review_run.
 *   * The orchestrator's post stage (posting.ts) populates `state.postedReview` from the PostedReviewV1, so
 *     review_id / publication_outcome flow into the result envelope (no longer the deferred null/null).
 *
 * ── SANDBOX SAFETY (ADR-0065 / ADR-0066 / check_workflow_bundle + check_clock_random) ──
 * This module is bundled into the Temporal V8-isolate workflow sandbox, which BANS `node:crypto` and raw
 * clock/RNG. It imports ONLY `@temporalio/workflow` + `@temporalio/common` (the sandbox-safe API surface),
 * the deterministic orchestrator/state/proxy helpers (all sandbox-clean), and TYPE-ONLY contract shapes
 * (erased at emit under `verbatimModuleSyntax`, so NO runtime edge to the crypto-importing contracts is
 * created). It does NO clock / random / uuid / network / DB work: it parses the payload (Zod, pure), proxies
 * activities, and proxies the cleanup inside a cancellation scope. All non-deterministic work lives behind
 * the typed activity ports. The build-time proof is `scripts/check_workflow_bundle.ts`.
 */

import {
  CancellationScope,
  proxyActivities,
  isCancellation,
  log as workflowLog,
  workflowInfo,
} from "@temporalio/workflow";
import { ApplicationFailure } from "@temporalio/common";

import { orchestrate, type ReviewPipelineContext } from "#backend/review/pipeline/orchestrator.js";
import { ReviewWorkflowState } from "#backend/review/pipeline/state.js";
import { CHUNK_CONCURRENCY_DEFAULT } from "#backend/review/pipeline/parallelism.js";
import { stageOutcome, type StageLogger } from "#backend/review/pipeline/degradation.js";
import { resolveDegradedPayload, buildAnalyzedPayload } from "#backend/review/pipeline/helpers.js";
import { buildManifestCandidatePaths } from "#backend/review/manifest_candidates.js";
import { RETRY_POLICIES } from "#backend/review/pipeline/activity_ports.js";
import {
  recordLifecycleSetterSucceeded,
  recordLifecycleSetterFailed,
} from "#backend/observability/finding_lifecycle_metrics.js";
import { makeActivityPorts, toActivityOptions } from "./activity_proxy.js";

import { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";
import type {
  FetchManifestSnapshotsInputV1,
  FetchManifestSnapshotsOutputV1,
} from "#contracts/fetch_manifest_snapshots.v1.js";
import type {
  ParseManifestDependenciesInputV1,
  ParseManifestDependenciesOutputV1,
} from "#contracts/parse_manifest_dependencies.v1.js";
import type {
  LoadParentReviewFindingsInputV1,
  LoadParentReviewFindingsResultV1,
} from "#contracts/load_parent_review_findings.v1.js";
import type { ManifestSnapshot } from "#contracts/pr_context.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

import type { ReviewPipelineResult } from "#backend/review/pipeline/pipeline_result.js";
import type { ChangedLineRanges } from "#backend/review/pipeline/activity_ports.js";
import type { ReviewPullRequestResultV1 } from "#contracts/review_pull_request.v1.js";
import type { PrMetaV1, LinkedIssueV1 } from "#contracts/walkthrough.v1.js";
import type { PrFilesEnrichmentResultV1 } from "#contracts/pr_files_enrichment.v1.js";
import type { EnrichPrFilesInputV1 } from "#contracts/enrich_pr_files_input.v1.js";
import type { FetchLinkedIssuesInputV1 } from "#contracts/fetch_linked_issues_input.v1.js";
import type { FetchSuggestedReviewersInputV1 } from "#contracts/fetch_suggested_reviewers_input.v1.js";
import type { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";
import type { AllocateWorkspaceInput } from "#contracts/allocate_workspace_input.v1.js";
import type { ReleaseWorkspaceInput } from "#contracts/release_workspace_input.v1.js";
import type { PostReviewPlaceholderInput } from "#contracts/post_review_placeholder_input.v1.js";
import type { DeleteReviewPlaceholderInput } from "#contracts/delete_review_placeholder_input.v1.js";
import type {
  RecordReviewLifecycleEventInput,
  FinalizeReviewRunInput,
  RecordRunFailedInput,
  RecordRunCancelledInput,
} from "#contracts/record_review_lifecycle_inputs.v1.js";
import type {
  FinalizedInputV1,
  SkippedInputV1,
  DegradedInputV1,
} from "#contracts/finding_lifecycle_inputs.v1.js";

// ─── lifecycle activity proxies (the Stage-2 mutex/workspace/placeholder surface) ────────────────────
//
// These are dispatched DIRECTLY by the workflow body (NOT through activity_proxy.ts, which proxies the 18
// orchestrator pipeline activities). Each carries the SAME ActivityOptions the frozen Python used at its
// execute_activity site, transcribed 1:1. Registered names are the camelCase worker-registry names (the TS
// composition root registers `startReviewForWebhook`, `allocateWorkspace`, `releaseWorkspace`,
// `renewPrReviewMutexLeaseActivity`, `releasePrReviewMutexActivity`, `postReviewPlaceholder`,
// `deleteReviewPlaceholder`).

/** GATE — start_review_for_webhook_activity (review_pull_request.py:500): 5-min timeout, 3 attempts,
 *  ValueError non-retryable. Returns the typed gate result envelope. */
const { startReviewForWebhook } = proxyActivities<{
  startReviewForWebhook(payloadDict: unknown): Promise<ReviewPullRequestResultV1>;
}>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "2 seconds",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["ValueError"],
  },
});

/** WORKSPACE allocate — allocate_workspace_activity (review_pull_request.py:1033): 30s timeout, 3 attempts. */
const { allocateWorkspace } = proxyActivities<{
  allocateWorkspace(input: AllocateWorkspaceInput): Promise<WorkspaceHandle>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "2 seconds", maximumAttempts: 3 },
});

/** WORKSPACE release — release_workspace_activity (review_pull_request.py:3251): 30s timeout, 2 attempts.
 *  Dispatched inside the non-cancellable cleanup scope. */
const { releaseWorkspace } = proxyActivities<{
  releaseWorkspace(input: ReleaseWorkspaceInput): Promise<void>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "2 seconds", maximumAttempts: 2 },
});

/** MUTEX renew — renew_pr_review_mutex_lease_activity (review_pull_request.py:547): 15s timeout, 3 attempts.
 *  Returns the DB's HONEST still-held boolean (false = definitive lost claim). The result type is given
 *  explicitly by this proxy's interface (string-name dispatch does NOT auto-infer the result type from the
 *  payload converter — see feedback_temporal_string_name_result_type). */
const { renewPrReviewMutexLeaseActivity } = proxyActivities<{
  renewPrReviewMutexLeaseActivity(mutexId: string): Promise<boolean>;
}>({
  startToCloseTimeout: "15 seconds",
  retry: { maximumAttempts: 3 },
});

/** MUTEX release — release_pr_review_mutex_activity (review_pull_request.py:3452): 30s timeout, 5 attempts
 *  (release is critical — leaking the mutex blocks every future review of this PR). Idempotent + commit-safe.
 *  Dispatched inside the non-cancellable cleanup scope. */
const { releasePrReviewMutexActivity } = proxyActivities<{
  releasePrReviewMutexActivity(mutexId: string): Promise<void>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "2 seconds", maximumAttempts: 5 },
});

/** PLACEHOLDER post — post_review_placeholder_activity (review_pull_request.py:631): 15s timeout, 2 attempts,
 *  RuntimeError non-retryable. Best-effort (the activity swallows; the body wraps it in stageOutcome). */
const { postReviewPlaceholder } = proxyActivities<{
  postReviewPlaceholder(input: PostReviewPlaceholderInput): Promise<void>;
}>({
  startToCloseTimeout: "15 seconds",
  retry: {
    initialInterval: "1 second",
    maximumAttempts: 2,
    nonRetryableErrorTypes: ["RuntimeError"],
  },
});

/** PLACEHOLDER delete — delete_review_placeholder_activity (review_pull_request.py:2835): 15s timeout,
 *  2 attempts, RuntimeError non-retryable. Best-effort (fired by the orchestrator's onPlaceholderTeardown
 *  hook after the real post lands). */
const { deleteReviewPlaceholder } = proxyActivities<{
  deleteReviewPlaceholder(input: DeleteReviewPlaceholderInput): Promise<void>;
}>({
  startToCloseTimeout: "15 seconds",
  retry: {
    initialInterval: "1 second",
    maximumAttempts: 2,
    nonRetryableErrorTypes: ["RuntimeError"],
  },
});

// ─── Stage-4 enrichment activity proxies (dispatched DIRECTLY by the workflow body) ─────────────────
//
// These populate the REAL changed_paths / changed_line_ranges (enrich) + the walkthrough's linked-issues /
// suggested-reviewers sections. Each is dispatched by the body (NOT the orchestrator's activity_proxy
// bridge) because its INPUTS are payload-only (no orchestrate() state) and its OUTPUTS thread into the
// ReviewPipelineContext the body builds. Each carries the RETRY_POLICIES the Python execute_activity sites
// used, transcribed 1:1. Registered names are the worker-registry names (enrichPrFilesV2, fetchLinkedIssues,
// fetchSuggestedReviewers). GATE COLLAPSE: enrich-pr-files-v2 is collapse-on — the v2 PrFilesEnrichmentResultV1
// path is live; the v1 legacy branch is NOT ported, no workflow.patched() is called.

/** ENRICH — enrich_pr_files_activity_v2 (review_pull_request.py:830-835): 30s timeout, 3 attempts,
 *  GitHubAppUnauthorized non-retryable. Returns the PrFilesEnrichmentResultV1 (file list + per-file ranges
 *  + truncation marker). The result type is given explicitly by this proxy's interface (string-name
 *  dispatch does NOT auto-infer the result type — see feedback_temporal_string_name_result_type). */
const { enrichPrFilesV2 } = proxyActivities<{
  enrichPrFilesV2(input: EnrichPrFilesInputV1): Promise<PrFilesEnrichmentResultV1>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "2 seconds",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["GitHubAppUnauthorized"],
  },
});

/** #4 MANIFEST FETCH — fetch_manifest_snapshots_activity (review_pull_request.py:944-962): 30s, 3 attempts,
 *  GitHubAppUnauthorized non-retryable. SHA-scoped manifest snapshot retrieval. */
const { fetchManifestSnapshots } = proxyActivities<{
  fetchManifestSnapshots(input: FetchManifestSnapshotsInputV1): Promise<FetchManifestSnapshotsOutputV1>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "2 seconds",
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["GitHubAppUnauthorized"],
  },
});

/** #4 MANIFEST PARSE — parse_manifest_dependencies_activity (review_pull_request.py:989-1000): 30s, 3 attempts.
 *  Per-ecosystem dependency parsing of the fetched snapshots. */
const { parseManifestDependencies } = proxyActivities<{
  parseManifestDependencies(input: ParseManifestDependenciesInputV1): Promise<ParseManifestDependenciesOutputV1>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "2 seconds", maximumAttempts: 3 },
});

/** #6 CARRY-FORWARD LOADER — load_parent_review_findings (ENHANCEMENT beyond Python; flag-gated default-off):
 *  the PR's currently-live findings as the carry-forward parent set. 30s, 3 attempts. */
const { loadParentReviewFindings } = proxyActivities<{
  loadParentReviewFindings(input: LoadParentReviewFindingsInputV1): Promise<LoadParentReviewFindingsResultV1>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "2 seconds", maximumAttempts: 3 },
});

/**
 * #D root-manifest seeding flag (default OFF). EXCEEDS the frozen Python (which passes changed_paths only),
 * so it ships dormant to keep the parity dual-run clean AND to give the extra GitHub root-manifest fetches
 * the same measure-then-enable treatment as carry-forward. Flip to true (+ redeploy) to make root-level
 * dependency context independent of the GitHub Tree-API nearest-walk (which returns [] on large-repo tree
 * truncation / fetch failure). Remove this scaffolding once flipped + observed stable.
 */
const SEED_COMMON_ROOT_MANIFESTS = false;

/** LINKED ISSUES — fetch_linked_issues_activity (review_pull_request.py:2143-2148): 30s timeout, 2 attempts,
 *  GitHubAppUnauthorized non-retryable. Returns the resolved tuple[LinkedIssueV1, ...] for the walkthrough. */
const { fetchLinkedIssues } = proxyActivities<{
  fetchLinkedIssues(input: FetchLinkedIssuesInputV1): Promise<ReadonlyArray<LinkedIssueV1>>;
}>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "2 seconds",
    maximumAttempts: 2,
    nonRetryableErrorTypes: ["GitHubAppUnauthorized"],
  },
});

/** SUGGESTED REVIEWERS — fetch_suggested_reviewers_activity (review_pull_request.py:2211-2215): 15s timeout,
 *  2 attempts (NO non-retryable types — pure DB+ranking, no GitHub call). Returns tuple[str, ...] of the
 *  top-N CODEOWNERS-derived reviewer logins (flag-gated INSIDE the activity on code_owners_v1). */
const { fetchSuggestedReviewers } = proxyActivities<{
  fetchSuggestedReviewers(input: FetchSuggestedReviewersInputV1): Promise<ReadonlyArray<string>>;
}>({
  startToCloseTimeout: "15 seconds",
  retry: { initialInterval: "2 seconds", maximumAttempts: 2 },
});

// ─── Stage-3 run-lifecycle activity proxies (dispatched DIRECTLY by the workflow body) ──────────────
//
// These write the `core.review_runs` lifecycle row + the `audit.workflow_events` milestone stream. They are
// dispatched by the body (NOT the orchestrator's activity_proxy bridge — that proxies the 18 pipeline
// activities). Each carries the RETRY_POLICIES the Python execute_activity sites used, transcribed 1:1.
// Registered names are the camelCase worker-registry names the composition root registers.

/** ANALYSIS_STARTED + ANALYZED granular milestone emit — record_review_lifecycle_event_activity. 30s, 3
 *  attempts, ValueError non-retryable (the event_type allow-list reject is a permanent caller bug). */
const { recordReviewLifecycleEvent } = proxyActivities<{
  recordReviewLifecycleEvent(input: RecordReviewLifecycleEventInput): Promise<void>;
}>(toActivityOptions(RETRY_POLICIES.recordReviewLifecycleEvent));

/** RUNNING → COMPLETED — finalize_review_run_activity. 30s, 3 attempts, StateDrift+ValueError
 *  non-retryable (a drifted run is a permanent terminal state). */
const { finalizeReviewRun } = proxyActivities<{
  finalizeReviewRun(input: FinalizeReviewRunInput): Promise<void>;
}>(toActivityOptions(RETRY_POLICIES.finalizeReviewRun));

/** BF-5 RUNNING → FAILED — record_run_failed_activity. 30s, 3 attempts, StateDrift+ValueError
 *  non-retryable. */
const { recordRunFailed } = proxyActivities<{
  recordRunFailed(input: RecordRunFailedInput): Promise<void>;
}>(toActivityOptions(RETRY_POLICIES.recordRunTerminal));

/** BF-13 RUNNING → CANCELLED — record_run_cancelled_activity. Same curve as record_run_failed. */
const { recordRunCancelled } = proxyActivities<{
  recordRunCancelled(input: RecordRunCancelledInput): Promise<void>;
}>(toActivityOptions(RETRY_POLICIES.recordRunTerminal));

// ─── Stage-3 finding-delivery lifecycle setter proxies (the bookkeeping block's 3 conditional dispatches) ──
//
// Each flips rows in core.review_findings to their delivery outcome. Bookkeeping-ONLY: a failure here NEVER
// fails the workflow (the review is already posted) — the body's try/catch around each dispatch logs +
// counts + continues. The retry curves match the Python lifecycle-bookkeeping execute_activity sites.

/** record_delivery_finalized_activity — inline-delivered finalization. 30s, initial 1s, backoff 2.0, 3 attempts. */
const { recordDeliveryFinalized } = proxyActivities<{
  recordDeliveryFinalized(input: FinalizedInputV1): Promise<number>;
}>(toActivityOptions(RETRY_POLICIES.recordDeliveryFinalized));

/** record_delivery_skipped_activity — per-row skipped flips. Same curve as finalized. */
const { recordDeliverySkipped } = proxyActivities<{
  recordDeliverySkipped(input: SkippedInputV1): Promise<number>;
}>(toActivityOptions(RETRY_POLICIES.recordDeliverySkipped));

/** record_delivery_degraded_activity — body-only / failed degraded flips. Same curve as finalized. */
const { recordDeliveryDegraded } = proxyActivities<{
  recordDeliveryDegraded(input: DegradedInputV1): Promise<number>;
}>(toActivityOptions(RETRY_POLICIES.recordDeliveryDegraded));

/**
 * The SPINE workflow. GATE → placeholder → allocate-workspace → orchestrate (with the lease claim-check +
 * placeholder-teardown lifecycle callbacks) → release mutex + workspace in a non-cancellable finally.
 *
 * @param rawPayload the wire review-request envelope (validated + defaulted by the Zod parse below; the
 *   gate re-validates it independently as its own boundary check).
 * @returns the typed `ReviewPullRequestResultV1` (status=accepted on the spine happy path; the gate's
 *   skip status verbatim when the gate did not accept).
 */
export async function reviewPullRequest(
  rawPayload: unknown,
): Promise<ReviewPullRequestResultV1> {
  // ─── Step 1: validate the input contract at the workflow boundary (Python model_validate fail-fast) ───
  const payload = ReviewPullRequestPayloadV1.parse(rawPayload);

  const logger: StageLogger = { warning: (msg: string): void => proxyLog(msg) };

  // ─── Step 2: GATE (start_review_for_webhook_activity) ─────────────────────────────────────────────
  // Dispatch with the RAW payload (the gate model_validates it independently). A non-accepted status
  // short-circuits the whole workflow — return the gate result verbatim (skipped_busy / skipped_disabled /
  // closed / skipped_legacy_payload). 1:1 with review_pull_request.py:500-512.
  const pre = await startReviewForWebhook(rawPayload);
  if (pre.status !== "accepted") {
    return pre;
  }

  // B-A1: the mutex is HELD by the gate (no longer auto-released). The finally below releases it on every
  // exit path. An accepted gate result MUST carry the mutex_id (the PR #111 B-A1 fix). 1:1 with py:516-520.
  if (pre.mutex_id === null) {
    throw ApplicationFailure.nonRetryable(
      "accepted gate result missing mutex_id; PR #111 B-A1 fix not in effect",
      "PrMutexMissingOnAccept",
    );
  }
  const mutexId: string = pre.mutex_id;

  // ─── Per-PR mutex lease renewal (Fix E / A1+A3) ───────────────────────────────────────────────────
  // `claimStillHeld()` returns false ONLY on a definitive lost claim (lease reclaimed by a newer review or
  // swept by the janitor); the renewal *error* is fail-open (a transient blip must not kill a live review).
  // pr-mutex-lease-renewal collapse-on: lease renewal is UNCONDITIONAL. The Python `force=False` wall-clock
  // throttle is dead in the frozen body (every call site forces), so the renewal runs unconditionally at
  // each of the three claim-check boundaries — no `Date.now()` (sandbox/clock-gate clean).
  const claimStillHeld = async (): Promise<boolean> => {
    try {
      return await renewPrReviewMutexLeaseActivity(mutexId);
    } catch {
      // fail-open: a transient renewal error must not kill a live review (review_pull_request.py:554).
      return true;
    }
  };

  // `_abort_if_claim_lost` — force-renew; if the lease is definitively lost, abort the workflow
  // non-retryably (the superseding review owns the result). 1:1 with review_pull_request.py:559-567.
  const abortIfClaimLost = async (): Promise<void> => {
    if (!(await claimStillHeld())) {
      throw ApplicationFailure.nonRetryable(
        "pr_review_mutex lease lost; superseded by a newer review",
        "PrMutexLostClaim",
      );
    }
  };

  // ─── FIX #1 — MUTEX/WORKSPACE LEAK-WINDOW CLOSURE (owner hardening DIVERGENCE) ─────────────────────
  // In the frozen Python the per-PR mutex is released ONLY inside the orchestrate-finally (the `_post_review`
  // cleanup): everything BETWEEN the gate accepting the mutex and that finally — placeholder, enrich,
  // allocate_workspace, ANALYSIS_STARTED, the up-front issue/reviewer fetches — runs UNGUARDED. If
  // `allocate_workspace` or `record_review_lifecycle_event(ANALYSIS_STARTED)` raises before orchestrate is
  // reached, the Python leaks the held mutex (and, post-allocate, the workspace lease) until lease-expiry +
  // the janitor sweep self-heal it. That self-heal still applies here (the lease+janitor backstop is ported),
  // but IMMEDIATE release is strictly better — so this is a deliberate HARDENING DIVERGENCE from Python: the
  // OUTER try/finally below opens the instant the gate's `mutexId` is in hand and brackets EVERYTHING after it
  // (placeholder, enrich, allocate, ANALYSIS_STARTED, issue/reviewer fetch, ctx build, orchestrate,
  // bookkeeping, ANALYZED, finalize). The `CancellationScope.nonCancellable` cleanup-finally ALWAYS releases
  // the mutex, and releases the workspace IFF a handle was actually allocated (`workspaceHandle !== null`) —
  // so an allocate failure releases the mutex but does NOT dispatch a workspace release against a handle that
  // was never minted. `workspaceHandle` is declared nullable BEFORE the try so the finally can read it on
  // every exit path (including a failure that fired before allocate assigned it).
  let workspaceHandle: WorkspaceHandle | null = null;
  let result: ReviewPipelineResult;
  // `state` is hoisted to the function-body scope (NOT block-scoped in the inner try) because the Step 6
  // return below reads `state.postedReview` AFTER the try/catch — the orchestrator's posting.ts populates it
  // during orchestrate(). Constructed (not just declared) here so it is always a usable instance on the
  // success path the return reaches. FIX #3 adds the enrich-error degradation note onto it before orchestrate.
  const state = new ReviewWorkflowState();
  // OUTER try = BF-5/BF-13 run-transition. INNER try/finally = the NON-CANCELLABLE mutex + workspace cleanup.
  // The inner-finally runs BEFORE the outer-catch (the Python "mutex release is the more critical action; the
  // run-transition is best-effort" ordering — the cleanup has already released both resources by the time the
  // BF-5/BF-13 record fires). releaseMutex runs even if releaseWorkspace fails (and vice-versa).
  try {
    try {
    // ─── Step 2.25: placeholder PR comment (best-effort) ────────────────────────────────────────────
    // Post a "reviewing this PR..." comment so engineers see life on the PR before the pipeline completes.
    // stageOutcome with skipOutcome() (the Python `_log_stage` is the canonical success emitter; the helper
    // handles WARN + record_stage(error) on failure) — a placeholder failure does NOT fail the workflow.
    await stageOutcome(
      "post_review_placeholder",
      { logger, headSha: payload.head_sha, runId: payload.run_id },
      async (handle): Promise<void> => {
        handle.skipOutcome();
        await postReviewPlaceholder({
          schema_version: 1,
          pr_id: payload.pr_id,
          run_id: payload.run_id,
          review_id: payload.review_id,
          installation_id: payload.installation_id,
          owner: payload.gh_owner,
          repo_name: payload.gh_repo_name,
          pr_number: payload.pr_number,
        });
      },
    );

    // ─── Step 3.5: enrich PR files → REAL changed_paths / changed_line_ranges (review_pull_request.py:776-917) ──
    // ENRICH BEFORE ALLOCATE: fetch the PR's changed files from GitHub (paginated) BEFORE allocate_workspace,
    // so the orchestrator reviews the REAL changed files (replacing the Stage-1 changed_paths=[] /
    // changed_line_ranges={} stubs). GATE COLLAPSE: enrich-pr-files-v2 is collapse-on — only the v2
    // PrFilesEnrichmentResultV1 path is dispatched (no workflow.patched(), no v1 legacy branch).
    //
    // Gated on `github_installation_id != null` (the numeric GitHub-API id the files-fetch needs; pre-T1
    // outbox rows where it's null skip with a "skipped" stage outcome — fail-open). The stageOutcome wrap
    // (raiseAfterLog defaults false) swallows a fetch failure → `enrichment` stays undefined → the derivation
    // below falls back to the empty tuple/dict. skipOutcome() defers to the canonical `_log_stage(
    // "enrich_pr_files")` success emit (the activity owns it).
    //
    // ── FIX #3 — ENRICH FAIL-CLOSED/DEGRADED ON ERROR (owner hardening DIVERGENCE) ──
    // The frozen Python is fully FAIL-OPEN here: a swallowed enrich failure leaves `enrichment = None` and the
    // derivation falls back to empty changed_paths — INDISTINGUISHABLE from a genuinely-empty PR, so a
    // transient GitHub files-API blip produces a silent CLEAN "no findings" review. This is a hardening
    // DIVERGENCE from Python: we DISTINGUISH enrich-ERROR (github_installation_id non-null AND the activity
    // threw + stageOutcome swallowed → `enrichment === undefined` on the non-null branch) from a
    // genuinely-empty SUCCESSFUL enrichment (`enrichment !== undefined` with `files: []` — NOT flagged). On
    // enrich-ERROR we still fail-OPEN on the data (empty changed_paths, the pipeline proceeds) but mark the run
    // DEGRADED: the `pr_file_enrichment_failed` note is added to `state.degradation` below (after state is
    // constructed), so the orchestrator folds it into `ReviewPipelineResult.degradation_notes` (orchestrator.ts
    // :763) → the walkthrough's degradation-state + the posted check-run reflect a DEGRADED outcome instead of
    // a clean pass. `stageOutcome` returns `undefined` ONLY on the swallowed-error path; on the success path it
    // returns the value — so `enrichErrored` captures the error-vs-empty distinction precisely.
    let enrichment: PrFilesEnrichmentResultV1 | undefined;
    let enrichErrored = false;
    if (payload.github_installation_id !== null) {
      const githubInstallationId = payload.github_installation_id;
      enrichment = await stageOutcome(
        "enrich_pr_files",
        { logger, headSha: payload.head_sha, runId: payload.run_id },
        async (handle): Promise<PrFilesEnrichmentResultV1> => {
          handle.skipOutcome();
          return enrichPrFilesV2({
            schema_version: 1,
            installation_id: payload.installation_id,
            github_installation_id: githubInstallationId,
            repository_id: payload.repository_id,
            pr_id: payload.pr_id,
            gh_owner: payload.gh_owner,
            gh_repo_name: payload.gh_repo_name,
            pr_number: payload.pr_number,
          });
        },
      );
      // FIX #3: on the non-null branch, `enrichment === undefined` means the activity threw and stageOutcome
      // swallowed it (a SUCCESSFUL enrichment — even an empty one — is always a defined PrFilesEnrichmentResultV1).
      // That is the enrich-ERROR case the degradation note below flags.
      enrichErrored = enrichment === undefined;
    }
    // Derive the orchestrator inputs from the enrichment result (review_pull_request.py:897-917). Fail-open
    // (enrichment undefined — github_installation_id null, or the v2 fetch errored + stageOutcome swallowed)
    // preserves the Stage-1 behaviour: empty changed_paths + empty changed_line_ranges. A truncation marker
    // surfaces a WARN (the PR has more files than MAX_FILES_PER_ENRICHMENT).
    let changedPathsForOrchestrator: ReadonlyArray<string> = [];
    let changedLineRangesForOrchestrator: ChangedLineRanges = {};
    if (enrichment !== undefined) {
      changedPathsForOrchestrator = enrichment.files.map((pf) => pf.file_path);
      changedLineRangesForOrchestrator = enrichment.changed_line_ranges;
      if (enrichment.truncated_at !== null) {
        workflowLog.warn(
          `review_pipeline.enrichment_truncated: files capped at ${enrichment.truncated_at} ` +
            `(PR has more files than MAX_FILES_PER_ENRICHMENT)`,
        );
      }
    }

    // ─── Step 4a: allocate the REAL workspace (replaces the Stage-1 deterministic stub) ──────────────
    // The returned WorkspaceHandle carries the workspace identity + lease key; the clone activity targets it
    // and the cleanup-finally releases it by its workspace_id. FIX #1: the allocate result is assigned to the
    // outer-scope nullable `workspaceHandle` so the cleanup-finally below releases it on EVERY subsequent exit
    // path. A failure HERE (allocate itself throws) leaves `workspaceHandle` null → the cleanup-finally
    // releases the mutex but does NOT dispatch a workspace release against a handle that was never minted.
    // 1:1 with review_pull_request.py:1033-1061 for the activity dispatch shape. The local `const handle`
    // gives the ctx build a NON-NULL reference (the assignment narrows here, not in the closures below).
    const handle: WorkspaceHandle = await allocateWorkspace({
      schema_version: 1,
      run_id: payload.run_id,
      review_id: payload.review_id,
      installation_id: payload.installation_id,
      // ReviewPullRequestPayloadV1 carries the internal UUID repository_id; the numeric GitHub-side repo_id
      // (diagnostic _meta only, AD-13) is not on the payload — pass null (1:1 with the Python `repo_id=None`).
      repo_id: null,
      workflow_id: payload.run_id,
    });
    workspaceHandle = handle;

    // ─── Step 2.5: emit ANALYSIS_STARTED (review_pull_request.py:651-684) ────────────────────────────
    // The granular analysis-stage milestone, emitted AFTER the gate accepted + the placeholder/allocate ran
    // and BEFORE the orchestrator invokes any analysis-stage activity. Idempotent under Temporal at-least-once
    // retry (the activity checks for an existing event of this type before INSERT). FIX #1: a FAILURE here is
    // now INSIDE the outer try, so the cleanup-finally releases BOTH the mutex AND the workspace (the handle
    // was already allocated + assigned above) — closing the leak window the Python left between
    // ANALYSIS_STARTED and the orchestrate-finally. The BF-5 catch flips the run RUNNING → FAILED on this path.
    await recordReviewLifecycleEvent({
      schema_version: 2,
      installation_id: payload.installation_id,
      run_id: payload.run_id,
      review_id: payload.review_id,
      provider: "github",
      event_type: "ANALYSIS_STARTED",
      payload: {
        pr_id: payload.pr_id,
        head_sha: payload.head_sha,
        policy_revision: payload.policy_revision,
      },
    });

    // ─── Step 8.5 + S23.AR.3: fetch linked issues + suggested reviewers (review_pull_request.py:2086-2220) ──
    // The Python fetched these INSIDE the `_walkthrough` closure right before `generate_walkthrough`. The TS
    // port pulled `generateWalkthrough` into the orchestrator, so the body resolves them up-front (their
    // inputs are payload-only) and threads the RESOLVED tuples onto the context — both walkthrough sites (the
    // normal Step 8 + the advisory path-filters-excluded-all Step 2a.1) read them, exactly like the Python
    // closure that fed both. Both gated on `github_installation_id != null` + FAIL-OPEN (the stageOutcome wrap
    // swallows → the empty tuple stays → the renderer drops the section). skipOutcome() defers to the
    // canonical `_log_stage(...)` success emit. suggested_reviewers is additionally flag-gated INSIDE its
    // activity on `code_owners_v1` (returns [] when off; default-off in the composition root).
    let linkedIssues: ReadonlyArray<LinkedIssueV1> = [];
    let suggestedReviewers: ReadonlyArray<string> = [];
    if (payload.github_installation_id !== null) {
      const githubInstallationId = payload.github_installation_id;
      const resolvedLinked = await stageOutcome(
        "fetch_linked_issues",
        { logger, headSha: payload.head_sha, runId: payload.run_id },
        async (handle2): Promise<ReadonlyArray<LinkedIssueV1>> => {
          handle2.skipOutcome();
          return fetchLinkedIssues({
            schema_version: 1,
            installation_id_uuid: payload.installation_id,
            installation_id_int: githubInstallationId,
            repository_id: payload.repository_id,
            pr_id: payload.pr_id,
            owner: payload.gh_owner,
            repo: payload.gh_repo_name,
          });
        },
      );
      if (resolvedLinked !== undefined) {
        linkedIssues = resolvedLinked;
      }

      const resolvedSuggested = await stageOutcome(
        "fetch_suggested_reviewers",
        { logger, headSha: payload.head_sha, runId: payload.run_id },
        async (handle2): Promise<ReadonlyArray<string>> => {
          handle2.skipOutcome();
          return fetchSuggestedReviewers({
            schema_version: 1,
            installation_id: payload.installation_id,
            repository_id: payload.repository_id,
            pr_id: payload.pr_id,
          });
        },
      );
      if (resolvedSuggested !== undefined) {
        suggestedReviewers = resolvedSuggested;
      }
    }

    // ─── build the ReviewPipelineContext with the Stage-2 lifecycle callbacks ───────────────────────
    // `state` is the function-body-scoped instance hoisted above (read by the Step 6 return after the catch).
    // FIX #3 — on enrich-ERROR, mark the run DEGRADED. Adding the note to `state.degradation` BEFORE
    // orchestrate folds it into `ReviewPipelineResult.degradation_notes` (orchestrator.ts:763) → the
    // walkthrough degradation-state + posted check-run reflect a DEGRADED outcome (NOT a clean pass). A
    // genuinely-empty successful enrichment never sets `enrichErrored`, so it is NOT flagged.
    if (enrichErrored) {
      state.degradation.add("pr_file_enrichment_failed");
    }

    // ── #4 manifest fetch → parse (port of review_pull_request.py:919-1007). The Python gates this behind
    // workflow.patched markers; in the historyless TS workflow type those gates COLLAPSE to true, so it runs
    // straight-line when enrichment + changed paths + a github_installation_id are present. FAIL-OPEN via
    // stageOutcome (returns undefined on error): a fetch/parse failure NEVER aborts the review — manifests
    // are review-context enrichment, not gating. SHA-scoped (head_sha) so replay matches under force-push.
    let manifestSnapshots: ReadonlyArray<ManifestSnapshot> = [];
    if (
      enrichment !== undefined &&
      changedPathsForOrchestrator.length > 0 &&
      payload.github_installation_id !== null
    ) {
      const githubInstallationId = payload.github_installation_id;
      const fetchResult = await stageOutcome(
        "fetch_manifest_snapshots",
        { logger, headSha: payload.head_sha, runId: payload.run_id },
        async () =>
          fetchManifestSnapshots({
            schema_version: 1,
            installation_id: payload.installation_id,
            github_installation_id: githubInstallationId,
            repository_id: payload.repository_id,
            gh_owner: payload.gh_owner,
            gh_repo_name: payload.gh_repo_name,
            head_sha: payload.head_sha,
            // #D: default OFF → changed paths only (1:1 with Python). When SEED_COMMON_ROOT_MANIFESTS is
            // flipped on, union the common root manifests so root-level dependency context survives a
            // Tree-API nearest-walk failure/truncation on large repos.
            candidate_paths: SEED_COMMON_ROOT_MANIFESTS
              ? buildManifestCandidatePaths(changedPathsForOrchestrator)
              : [...changedPathsForOrchestrator],
          }),
      );
      if (fetchResult !== undefined) {
        manifestSnapshots = fetchResult.manifests;
        if (manifestSnapshots.length > 0) {
          const snapshotsToParse = manifestSnapshots;
          const parseResult = await stageOutcome(
            "parse_manifest_dependencies",
            { logger, headSha: payload.head_sha, runId: payload.run_id },
            async () =>
              parseManifestDependencies({ schema_version: 1, manifests: [...snapshotsToParse] }),
          );
          if (parseResult !== undefined) {
            manifestSnapshots = parseResult.parsed_manifests;
          }
        }
      }
    }

    // ── #6 carry-forward loader. ALWAYS dispatched; the activity reads the CODEMASTER_CARRY_FORWARD_ENABLED
    // env flag (default OFF — operator-flippable, replay-safe) and short-circuits to the empty parent set
    // when disabled. So with the flag off, parentFindings stays [] / parentReviewId null — 1:1 with the
    // frozen Python's parent_findings=() / parent_review_id=None at the orchestrate() call. Fail-open via
    // stageOutcome.
    let parentFindings: ReadonlyArray<ReviewFindingV1> = [];
    let parentReviewId: string | null = null;
    const loaded = await stageOutcome(
      "load_parent_review_findings",
      { logger, headSha: payload.head_sha, runId: payload.run_id },
      async () =>
        loadParentReviewFindings({
          schema_version: 1,
          installation_id: payload.installation_id,
          pr_id: payload.pr_id,
          review_id: payload.review_id,
        }),
    );
    if (loaded !== undefined) {
      parentFindings = loaded.parent_findings;
      parentReviewId = loaded.parent_review_id;
    }

    const ctx: ReviewPipelineContext = {
      repo: {
        repoUrl: `https://github.com/${payload.gh_owner}/${payload.gh_repo_name}.git`,
        // Stage-4 enrichment: the REAL changed paths the PR-files fetch resolved (replaces the Stage-1 []).
        changedPaths: [...changedPathsForOrchestrator],
        workspaceHandle: handle,
      },
      pr: {
        prMeta: buildPrMeta(payload),
        headSha: payload.head_sha,
        runId: payload.run_id,
        reviewId: payload.review_id,
        // FIX #2 (part 1): thread the internal UUID repository_id onto the PR ctx so the Orchestrator phase
        // can pass it to retrieveKnowledge (`repo_id` is sourced from typed_payload.repository_id in Python).
        repositoryId: payload.repository_id,
        policyRevision: payload.policy_revision,
        prNumber: payload.pr_number,
        // Stage-4 enrichment: the REAL per-file post-image hunk ranges (replaces the Stage-1 {}).
        changedLineRanges: changedLineRangesForOrchestrator,
        // #6 carry-forward: the PR's live findings (flag-gated) — [] / null when the flag is off (default).
        parentFindings: [...parentFindings],
        parentReviewId,
      },
      activities: makeActivityPorts(),
      limits: { chunkConcurrency: CHUNK_CONCURRENCY_DEFAULT },
      state,
      logger,
      // Stage-4 walkthrough threading: the resolved linked-issues + suggested-reviewers tuples (fetched
      // fail-open above) flow into BOTH the orchestrator's generateWalkthrough sites.
      linkedIssues,
      suggestedReviewers,
      // Sub-spec B T17 confluence-context: thread the enrich_pr_files_activity_v2 result so the
      // orchestrator's per-chunk buildChunkContext can construct the full-PR PRContext (build_pr_context_full)
      // for the hybrid/confluence retrieval path. `null` when github_installation_id is null OR the v2 fetch
      // errored + stageOutcome swallowed (the Python `enrichment is None` fail-open) — the orchestrator then
      // builds the MVP per-chunk PRContext. The retrieve_knowledge ACTIVITY composes BM25+ANN+Confluence
      // (gated on `_shouldUseHybrid`). manifestSnapshots stays [] — the fetch_manifest_snapshots /
      // parse_manifest_dependencies activities are NOT yet ported (FOLLOW-UP-confluence-pr-context-manifests),
      // exactly the Python `_manifest_snapshots=()` fail-open fallback when those markers are unsatisfied.
      enrichment: enrichment ?? null,
      // #4 — the fetch→parse manifest snapshots from the workflow-body flow above (empty when skipped/failed).
      manifestSnapshots: [...manifestSnapshots],
      // Stage-5 arbitration `now` (the Python `now=workflow.now()` kwarg). The orchestrator runs in the
      // workflow sandbox where Date.now()/new Date() are clock-gate-banned, so the body resolves the instant
      // HERE from the SDK-provided, replay-deterministic workflow start time and threads the RFC3339 string.
      // Written onto SUPPRESSED_BY_LLM decisions' suppressed_at by the apply_arbitration activity.
      arbitrationNow: workflowInfo().startTime.toISOString(),
      // CLAIM-CHECK seam: the renewal-backed lease check, fired by the orchestrator before clone, classify,
      // aggregate (the three Python `_abort_if_claim_lost` boundaries). A lost lease raises a non-retryable
      // ApplicationFailure that propagates out of orchestrate (the cleanup-finally still releases mutex/workspace).
      claimCheck: abortIfClaimLost,
      // PLACEHOLDER-TEARDOWN seam: the delete_review_placeholder dispatch, fired by the orchestrator after the
      // real post lands. Best-effort (stageOutcome-wrapped + skipOutcome); a teardown failure never fails the
      // pipeline. 1:1 with the Python `delete_review_placeholder` inside `_post_review`.
      onPlaceholderTeardown: async (): Promise<void> => {
        await stageOutcome(
          "delete_review_placeholder",
          { logger, headSha: payload.head_sha, runId: payload.run_id },
          async (handle2): Promise<void> => {
            handle2.skipOutcome();
            await deleteReviewPlaceholder({
              schema_version: 1,
              pr_id: payload.pr_id,
              run_id: payload.run_id,
              review_id: payload.review_id,
              installation_id: payload.installation_id,
              owner: payload.gh_owner,
              repo_name: payload.gh_repo_name,
              pr_number: payload.pr_number,
            });
          },
        );
      },
    };

    // ─── Step 5: orchestrate, then bookkeeping + ANALYZED + finalize (review_pull_request.py:685-4153) ──
    // FIX #1 restructure: this is now the BODY of the SINGLE outer try opened above (right after the gate
    // handed over `mutexId`). The cleanup-finally below releases the mutex + (conditionally) the workspace on
    // EVERY exit path; the BF-5/BF-13 catch flips the run terminal state. The lifecycle bookkeeping + ANALYZED
    // + finalize all run inside this same scope, so a failure in any of them also reaches the FAILED transition.
    result = await orchestrate(ctx);

    // ─── Step 5.4: finding-delivery lifecycle bookkeeping (review_pull_request.py:3554-4027) ─────────
    // After orchestrate returns cleanly, flip the persisted findings to their delivery outcome based on
    // the post-review capture (state.postedReview) + the pipeline result. Bookkeeping-ONLY: every setter
    // dispatch is individually try/caught so a failure NEVER fails the workflow (the review is already
    // posted). Runs BEFORE the ANALYZED emit (the Python ordering).
    await runLifecycleBookkeeping(payload, state, result);

    // ─── Step 5.5: ANALYZED + finalize COMPLETED (review_pull_request.py:3960-4027) ──────────────────
    // Reaching here means the orchestrator + bookkeeping completed. Emit the ANALYZED milestone carrying
    // the final findings_count + publication/degradation provenance (buildAnalyzedPayload), then advance
    // the run RUNNING → COMPLETED. Both idempotent under Temporal at-least-once retry.
    await recordReviewLifecycleEvent({
      schema_version: 2,
      installation_id: payload.installation_id,
      run_id: payload.run_id,
      review_id: payload.review_id,
      provider: "github",
      event_type: "ANALYZED",
      payload: buildAnalyzedPayload({
        findingsCount: result.findingsCount,
        headSha: payload.head_sha,
        postedReviewCapture: state.postedReview,
        pipelineResult: result,
      }),
    });
    await finalizeReviewRun({
      run_id: payload.run_id,
      review_id: payload.review_id,
      attempt: 1,
      duration_ms: null,
      worker_id: null,
    });
    } finally {
      // ─── FIX #1 — NON-CANCELLABLE mutex + workspace cleanup (runs on EVERY exit path) ───────────────
      // Brackets EVERYTHING in the inner try (placeholder → finalize) — closing the Python leak window where
      // an allocate / ANALYSIS_STARTED failure between the gate and the orchestrate-finally leaked the held
      // mutex (and post-allocate workspace) until lease-expiry. Dispatched inside CancellationScope.
      // nonCancellable so a Temporal cancellation still executes the release activities BEFORE the
      // CancelledFailure re-propagates.
      await CancellationScope.nonCancellable(async () => {
        // Release the mutex (B-A1 — critical: 5 attempts). ALWAYS runs — the gate held it the instant it
        // accepted, so it must be released regardless of how far the body got. Independent of the workspace
        // release: a workspace-release failure must NOT skip the mutex release. stageOutcome swallows so a
        // release failure is logged but never masks the original exit error (success/orig-error/cancellation).
        await stageOutcome(
          "cleanup",
          { logger, headSha: payload.head_sha, runId: payload.run_id },
          async (handle2): Promise<void> => {
            handle2.skipOutcome();
            await releasePrReviewMutexActivity(mutexId);
          },
        );
        // Release the workspace by its lease key (workspace_id) — FIX #1: ONLY when a handle was actually
        // allocated (`workspaceHandle !== null`). An allocate failure (or any failure before allocate)
        // releases the mutex above but does NOT dispatch a workspace release against a handle that was never
        // minted. On the success/post-allocate paths the orchestrator's own cleanup() already released the
        // LEASE via the releaseWorkspace port; this body-level release is the lifecycle backstop the Python
        // workflow body owns (release by workspace_id regardless of how orchestrate exited). Idempotent: a
        // second release of an already-released lease is a no-op. stageOutcome swallows so a failure never
        // masks the exit path.
        if (workspaceHandle !== null) {
          const allocated = workspaceHandle;
          await stageOutcome(
            "cleanup",
            { logger, headSha: payload.head_sha, runId: payload.run_id },
            async (handle2): Promise<void> => {
              handle2.skipOutcome();
              await releaseWorkspace({ schema_version: 1, workspace_id: allocated.workspace_id });
            },
          );
        }
      });
    }
  } catch (exc) {
    // BF-13: a Temporal cancellation flips RUNNING → CANCELLED (so AD-7 `cancelled_at NOT NULL ⇒
    // state='CANCELLED'` holds + AD-5 telemetry routes the row into _runs_cancelled, not _runs_failed).
    // BF-5: every OTHER uncaught exception flips RUNNING → FAILED. Both run inside a non-cancellable scope so
    // the transition is recorded even while a CancelledFailure is in flight. Best-effort: a failure to record
    // the transition is logged + swallowed so the ORIGINAL exception re-propagates (the bare `throw exc`).
    await CancellationScope.nonCancellable(async () => {
      if (isCancellation(exc)) {
        try {
          await recordRunCancelled({
            run_id: payload.run_id,
            review_id: payload.review_id,
            reason: "temporal_cancellation",
            attempt: 1,
          });
        } catch (cancelExc) {
          // Defensive: record_run_cancelled itself failed (e.g. DB wedged). Log; the original cancellation
          // propagates so Temporal still observes the cancellation + the janitor sweeps the orphan run.
          workflowLog.warn(
            `record_run_cancelled_activity itself failed; original cancellation propagates: ${String(cancelExc)}`,
          );
        }
      } else {
        // Sanitise the message: one line, capped at 200 chars (the lifecycle_transition event carries it).
        const firstLine = String(exc instanceof Error ? exc.message : exc).split("\n")[0] ?? "";
        const failureReason = `${exc instanceof Error ? exc.constructor.name : typeof exc}: ${firstLine.slice(0, 200)}`;
        try {
          await recordRunFailed({
            run_id: payload.run_id,
            review_id: payload.review_id,
            reason: failureReason === "" ? "unknown failure" : failureReason,
            attempt: 1,
          });
        } catch (failedExc) {
          // Defensive: record_run_failed itself failed. Log; the original exception propagates (Temporal
          // marks the workflow failed; the retention janitor's followup scan catches the orphan run).
          workflowLog.warn(
            `record_run_failed_activity itself failed; original exception propagates: ${String(failedExc)}`,
          );
        }
      }
    });
    throw exc;
  }

  // ─── Step 6: map ReviewPipelineResult → ReviewPullRequestResultV1 (review_pull_request.py:4157-4171) ──
  // review_id / publication_outcome are read from state.postedReview, which the orchestrator's posting.ts
  // populates from the PostedReviewV1 on the post-success path (the Stage-3 capture wiring). When no
  // publication happened (orchestrator raised before post, but the workflow still reached this success
  // return — not possible on the happy path), the capture stays at its makePostReviewCapture() defaults
  // (reviewId=null / publicationOutcome=null), matching the Python "no publication captured" branch.
  const postedReviewId = state.postedReview.reviewId;
  return {
    schema_version: 1,
    status: "accepted",
    pr_number: pre.pr_number,
    review_id: postedReviewId === null ? null : String(postedReviewId),
    findings_count: result.findingsCount,
    // mutex_id=null — already released; don't expose to caller (py:4162).
    mutex_id: null,
    installation_id: payload.installation_id,
    pr_id: payload.pr_id,
    publication_outcome: state.postedReview.publicationOutcome,
  };
}

/**
 * Run the finding-delivery lifecycle bookkeeping (review_pull_request.py:3554-4027). After orchestrate
 * returns, flip the persisted findings to their delivery outcome based on the post-review capture
 * (`state.postedReview`) + the pipeline result's ordered rfids. Three conditional dispatches:
 *
 *   * record_delivery_finalized — kept (inline-delivered) rfids, ONLY when the publication outcome was
 *     INLINE_POSTED. Skipped (with a WARN) on a kept-rfid / comment-id length mismatch (a data-quality
 *     invariant, not a transient failure).
 *   * record_delivery_skipped   — the classifier-dropped rfids (per-row eligibility reasons).
 *   * record_delivery_degraded  — kept rfids flipped to body_only_fallback / failed on the degraded
 *     publication outcomes (resolveDegradedPayload).
 *
 * BOOKKEEPING-ONLY: every dispatch is individually try/caught — a setter failure NEVER fails the workflow
 * (the review is already posted to GitHub). Each failure is logged on the replay-safe workflow logger; the
 * chain continues. SANDBOX-SAFE: pure index mapping + activity-port dispatches (no clock / random / uuid /
 * I/O); the `posted_review_pr_id` gate is the structural guard the three dispatches share.
 *
 * The `_lifecycle_posted_review_pr_id is not None` gate (the Python C-2 binding) is the structural guard:
 * when the capture's postedReviewPrId is null, the post step never ran (no published review to back-fill
 * against), so all three dispatches are inert.
 */
async function runLifecycleBookkeeping(
  payload: ReviewPullRequestPayloadV1,
  state: ReviewWorkflowState,
  pipelineResult: ReviewPipelineResult,
): Promise<void> {
  const capture = state.postedReview;
  const postedReviewPrId = capture.postedReviewPrId;
  const reviewFindingIds = pipelineResult.reviewFindingIds;
  const rfidsCount = reviewFindingIds.length;

  // Build the kept (inline-delivered) rfid mapping. Guard: every kept index must be in-bounds of the
  // persisted-rfid tuple (the Python `max(kept_indices) < len(review_finding_ids)` guard).
  let keptRfids: ReadonlyArray<string> = [];
  if (
    rfidsCount > 0 &&
    capture.keptFindingIndices.length > 0 &&
    Math.max(...capture.keptFindingIndices) < rfidsCount
  ) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is bounds-checked (max < rfidsCount) against a workflow-local string array
    keptRfids = capture.keptFindingIndices.map((i) => reviewFindingIds[i]!);
  }

  // Build the skipped (dropped) rfid + reason mapping. Same in-bounds guard over the dropped indices.
  let skippedRfids: ReadonlyArray<string> = [];
  let skippedReasons: ReadonlyArray<string> = [];
  if (
    rfidsCount > 0 &&
    capture.droppedClassifications.length > 0 &&
    Math.max(...capture.droppedClassifications.map((dc) => dc.index)) < rfidsCount
  ) {
    skippedRfids = capture.droppedClassifications.map((dc) => reviewFindingIds[dc.index]!);
    skippedReasons = capture.droppedClassifications.map((dc) => dc.eligibility_reason);
  }

  // ── Phase: inline-delivered finalization (only on INLINE_POSTED; degraded branches own the others) ──
  if (
    keptRfids.length > 0 &&
    postedReviewPrId !== null &&
    capture.publicationOutcome === "inline_posted"
  ) {
    if (keptRfids.length !== capture.commentIds.length) {
      // F9 — len-mismatch is a permanent data-quality invariant violation, NOT a transient condition. Emit
      // observability (WARN + the finalized_len_mismatch failure counter, retryable=false) instead of
      // silently skipping; do NOT dispatch (a mismatched finalize would pair rfids with the wrong
      // comment_ids). 1:1 with the Python record_lifecycle_setter_failed(setter="finalized_len_mismatch",
      // retryable=False) + the _setter_failures append.
      workflowLog.warn(
        `lifecycle finalize skipped (rfid/comment_id length mismatch): ` +
          `kept=${keptRfids.length} comments=${capture.commentIds.length} ` +
          `pr_id=${payload.pr_id} run_id=${payload.run_id}`,
      );
      recordLifecycleSetterFailed({ setter: "finalized_len_mismatch", retryable: false });
    } else {
      try {
        await recordDeliveryFinalized({
          schema_version: 1,
          installation_id: payload.installation_id,
          run_id: payload.run_id,
          review_id: payload.review_id,
          rfids: [...keptRfids],
          comment_ids: [...capture.commentIds],
          posted_review_pr_id: postedReviewPrId,
        });
        recordLifecycleSetterSucceeded({ setter: "finalized" });
      } catch (e) {
        workflowLog.warn(
          `lifecycle setter failed (bookkeeping-only; review already posted): ` +
            `setter=record_delivery_finalized error=${String(e)} ` +
            `pr_id=${payload.pr_id} run_id=${payload.run_id}`,
        );
        recordLifecycleSetterFailed({ setter: "finalized" });
      }
    }
  }

  // ── Phase: skipped findings (per-row eligibility reasons) ──
  if (skippedRfids.length > 0 && postedReviewPrId !== null) {
    try {
      await recordDeliverySkipped({
        schema_version: 1,
        installation_id: payload.installation_id,
        run_id: payload.run_id,
        review_id: payload.review_id,
        rfids: [...skippedRfids],
        reasons: [...skippedReasons],
        posted_review_pr_id: postedReviewPrId,
      });
      recordLifecycleSetterSucceeded({ setter: "skipped" });
    } catch (e) {
      workflowLog.warn(
        `lifecycle setter failed (bookkeeping-only; review already posted): ` +
          `setter=record_delivery_skipped error=${String(e)} ` +
          `pr_id=${payload.pr_id} run_id=${payload.run_id}`,
      );
      recordLifecycleSetterFailed({ setter: "skipped" });
    }
  }

  // ── Phase: degraded outcomes (body-only fallback / failed) ──
  const degraded = resolveDegradedPayload(capture.publicationOutcome, keptRfids);
  if (degraded.rfidsToFlip.length > 0 && degraded.outcomeValue !== null && postedReviewPrId !== null) {
    try {
      await recordDeliveryDegraded({
        schema_version: 1,
        installation_id: payload.installation_id,
        run_id: payload.run_id,
        review_id: payload.review_id,
        rfids: [...degraded.rfidsToFlip],
        outcome: degraded.outcomeValue,
        posted_review_pr_id: postedReviewPrId,
      });
      recordLifecycleSetterSucceeded({ setter: "degraded" });
    } catch (e) {
      workflowLog.warn(
        `lifecycle setter failed (bookkeeping-only; review already posted): ` +
          `setter=record_delivery_degraded error=${String(e)} ` +
          `pr_id=${payload.pr_id} run_id=${payload.run_id}`,
      );
      recordLifecycleSetterFailed({ setter: "degraded" });
    }
  }
}

/**
 * Build the per-PR `PrMetaV1` the walkthrough / post / per-chunk-context stages read, from the typed
 * payload. 1:1 with the Python `pr_meta` construction off `typed_payload`.
 */
function buildPrMeta(payload: ReviewPullRequestPayloadV1): PrMetaV1 {
  return {
    pr_id: payload.pr_id,
    installation_id: payload.installation_id,
    repo: `${payload.gh_owner}/${payload.gh_repo_name}`,
    pr_title: payload.pr_title,
    pr_description: payload.pr_description,
    author_login: payload.author_login,
    draft: payload.draft,
    base_ref: payload.base_ref,
    head_ref: payload.head_ref,
    opened_at: payload.opened_at,
  };
}

/**
 * Emit a degradation WARN line on the Temporal workflow logger (the sandbox-safe + replay-safe sink). The
 * SDK's `log` (from `@temporalio/workflow`) folds every line into workflow history deterministically, so it
 * is replay-safe. This tiny indirection maps the orchestrator's StageLogger shape (`{ warning(msg) }`) onto
 * the SDK's `log.warn(msg)`.
 */
function proxyLog(msg: string): void {
  workflowLog.warn(msg);
}
