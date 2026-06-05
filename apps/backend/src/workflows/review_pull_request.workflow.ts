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
} from "@temporalio/workflow";
import { ApplicationFailure } from "@temporalio/common";

import { orchestrate, type ReviewPipelineContext } from "#backend/review/pipeline/orchestrator.js";
import { ReviewWorkflowState } from "#backend/review/pipeline/state.js";
import { CHUNK_CONCURRENCY_DEFAULT } from "#backend/review/pipeline/parallelism.js";
import { stageOutcome, type StageLogger } from "#backend/review/pipeline/degradation.js";
import { resolveDegradedPayload, buildAnalyzedPayload } from "#backend/review/pipeline/helpers.js";
import { RETRY_POLICIES } from "#backend/review/pipeline/activity_ports.js";
import { makeActivityPorts, toActivityOptions } from "./activity_proxy.js";

import { ReviewPullRequestPayloadV1 } from "#contracts/review_pull_request.v1.js";

import type { ReviewPipelineResult } from "#backend/review/pipeline/pipeline_result.js";
import type { ReviewPullRequestResultV1 } from "#contracts/review_pull_request.v1.js";
import type { PrMetaV1 } from "#contracts/walkthrough.v1.js";
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

  // ─── Step 2.25: placeholder PR comment (best-effort) ──────────────────────────────────────────────
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

  // ─── Step 4a: allocate the REAL workspace (replaces the Stage-1 deterministic stub) ────────────────
  // The returned WorkspaceHandle carries the workspace identity + lease key; the clone activity targets it
  // and the finally releases by its workspace_id. A failure here propagates past orchestrate entirely, but
  // the mutex-release finally still runs (it brackets this allocate too). 1:1 with review_pull_request.py
  // :1033-1061. Allocate runs OUTSIDE the orchestrate try so a failed allocation never enters the workspace-
  // release path with a handle that was never minted (mutex release still happens via the finally below).
  const workspaceHandle: WorkspaceHandle = await allocateWorkspace({
    schema_version: 1,
    run_id: payload.run_id,
    review_id: payload.review_id,
    installation_id: payload.installation_id,
    // ReviewPullRequestPayloadV1 carries the internal UUID repository_id; the numeric GitHub-side repo_id
    // (diagnostic _meta only, AD-13) is not on the payload — pass null (1:1 with the Python `repo_id=None`).
    repo_id: null,
    workflow_id: payload.run_id,
  });

  // ─── Step 2.5: emit ANALYSIS_STARTED (review_pull_request.py:651-684) ──────────────────────────────
  // The granular analysis-stage milestone, emitted AFTER the gate accepted + the placeholder/allocate ran
  // and BEFORE the orchestrator invokes any analysis-stage activity. Idempotent under Temporal at-least-once
  // retry (the activity checks for an existing event of this type before INSERT). A FAILURE here propagates
  // — but it is dispatched OUTSIDE the BF-5 try (the run is not yet "in flight" until ANALYSIS_STARTED has
  // landed), so the mutex/workspace finally below still releases on that failure path (it brackets this
  // dispatch too). This is the boundary marker that proves the run is in flight for BF-5's FAILED transition.
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

  // ─── build the ReviewPipelineContext with the Stage-2 lifecycle callbacks ─────────────────────────
  const state = new ReviewWorkflowState();
  const ctx: ReviewPipelineContext = {
    repo: {
      repoUrl: `https://github.com/${payload.gh_owner}/${payload.gh_repo_name}.git`,
      changedPaths: [],
      workspaceHandle,
    },
    pr: {
      prMeta: buildPrMeta(payload),
      headSha: payload.head_sha,
      runId: payload.run_id,
      reviewId: payload.review_id,
      policyRevision: payload.policy_revision,
      prNumber: payload.pr_number,
      changedLineRanges: {},
      parentFindings: [],
      parentReviewId: null,
    },
    activities: makeActivityPorts(),
    limits: { chunkConcurrency: CHUNK_CONCURRENCY_DEFAULT },
    state,
    logger,
    // CLAIM-CHECK seam: the renewal-backed lease check, fired by the orchestrator before clone, classify,
    // aggregate (the three Python `_abort_if_claim_lost` boundaries). A lost lease raises a non-retryable
    // ApplicationFailure that propagates out of orchestrate (the finally still releases the mutex/workspace).
    claimCheck: abortIfClaimLost,
    // PLACEHOLDER-TEARDOWN seam: the delete_review_placeholder dispatch, fired by the orchestrator after the
    // real post lands. Best-effort (stageOutcome-wrapped + skipOutcome); a teardown failure never fails the
    // pipeline. 1:1 with the Python `delete_review_placeholder` inside `_post_review`.
    onPlaceholderTeardown: async (): Promise<void> => {
      await stageOutcome(
        "delete_review_placeholder",
        { logger, headSha: payload.head_sha, runId: payload.run_id },
        async (handle): Promise<void> => {
          handle.skipOutcome();
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

  // ─── Step 5: orchestrate, wrapped in (outer) BF-5/BF-13 run-transition + (inner) NON-CANCELLABLE cleanup ──
  //
  // Nesting matches the frozen Python ordering (review_pull_request.py:685-4153):
  //   * The INNER try/finally owns the mutex + workspace release: they run on EVERY exit path (success,
  //     error, cancellation), dispatched inside CancellationScope.nonCancellable so a Temporal cancellation
  //     still executes them BEFORE the cancellation re-propagates. releaseMutex runs even if releaseWorkspace
  //     fails (and vice-versa) — leaking the mutex blocks every future review of this PR.
  //   * The OUTER try/catch is BF-5/BF-13: on ANY uncaught exception the run row flips RUNNING → FAILED
  //     (BF-5) — UNLESS the exception is a Temporal cancellation, which flips RUNNING → CANCELLED (BF-13).
  //     The cleanup inner-finally has ALREADY run by the time the catch fires (the Python "mutex release is
  //     the more critical action; the run-transition is best-effort" ordering). recordRunFailed /
  //     recordRunCancelled are best-effort: a failure to record the transition is logged + swallowed so the
  //     ORIGINAL exception still propagates (Temporal still marks the workflow failed; the retention janitor
  //     sweeps any orphan run). The lifecycle bookkeeping + ANALYZED + finalize all run INSIDE this scope so
  //     a failure in any of them also reaches the FAILED transition.
  let result: ReviewPipelineResult;
  try {
    try {
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
      await CancellationScope.nonCancellable(async () => {
        // Release the mutex (B-A1 — critical: 5 attempts). Independent of the workspace release: a workspace-
        // release failure must NOT skip the mutex release. stageOutcome swallows so a release failure is
        // logged but never masks the original exit error (success/orig-error/cancellation propagates).
        await stageOutcome(
          "cleanup",
          { logger, headSha: payload.head_sha, runId: payload.run_id },
          async (handle): Promise<void> => {
            handle.skipOutcome();
            await releasePrReviewMutexActivity(mutexId);
          },
        );
        // Release the workspace by its lease key (workspace_id). The orchestrator's own cleanup() already
        // released the LEASE via the releaseWorkspace activity port on the success path; this body-level
        // release is the lifecycle backstop the Python workflow body owns (it releases by workspace_id
        // regardless of how orchestrate exited). Idempotent: a second release of an already-released lease is
        // a no-op. stageOutcome swallows so a failure never masks the exit path.
        await stageOutcome(
          "cleanup",
          { logger, headSha: payload.head_sha, runId: payload.run_id },
          async (handle): Promise<void> => {
            handle.skipOutcome();
            await releaseWorkspace({ schema_version: 1, workspace_id: workspaceHandle.workspace_id });
          },
        );
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
      // observability (WARN) instead of silently skipping; do NOT dispatch (a mismatched finalize would
      // pair rfids with the wrong comment_ids).
      workflowLog.warn(
        `lifecycle finalize skipped (rfid/comment_id length mismatch): ` +
          `kept=${keptRfids.length} comments=${capture.commentIds.length} ` +
          `pr_id=${payload.pr_id} run_id=${payload.run_id}`,
      );
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
      } catch (e) {
        workflowLog.warn(
          `lifecycle setter failed (bookkeeping-only; review already posted): ` +
            `setter=record_delivery_finalized error=${String(e)} ` +
            `pr_id=${payload.pr_id} run_id=${payload.run_id}`,
        );
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
    } catch (e) {
      workflowLog.warn(
        `lifecycle setter failed (bookkeeping-only; review already posted): ` +
          `setter=record_delivery_skipped error=${String(e)} ` +
          `pr_id=${payload.pr_id} run_id=${payload.run_id}`,
      );
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
    } catch (e) {
      workflowLog.warn(
        `lifecycle setter failed (bookkeeping-only; review already posted): ` +
          `setter=record_delivery_degraded error=${String(e)} ` +
          `pr_id=${payload.pr_id} run_id=${payload.run_id}`,
      );
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
