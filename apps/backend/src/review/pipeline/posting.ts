// posting — the Step-9 post-review sub-functions (finding 8), extracted from the orchestrator so the
// post stage's render → dispatch → capture → on-failure-skip-dispatch concerns live in one unit-testable
// module. 1:1 port of the frozen Python workflow body's `_post_review` closure
// (vendor/codemaster-py/codemaster/workflows/review_pull_request.py:2342-2840) — the parts that run AROUND
// the `post_review_results` activity dispatch: the walkthrough markdown render (+ arbitration footer fold),
// the PostedReviewV1 → `_PostReviewCapture` population, the publication-outcome stage-outcome mapping, and
// the H-2 dropped-state failure path (extract dropped-state details from the ApplicationFailure, map
// dropped indices → rfids, dispatch record_delivery_skipped INLINE, then re-raise).
//
// ── SANDBOX SAFETY (ADR-0065 / ADR-0066 / check_workflow_bundle + check_clock_random) ──
// This module runs INSIDE the Temporal V8 workflow sandbox (the orchestrator imports it). It is
// DETERMINISTIC + crypto/clock/network/DB FREE: NO node:crypto, NO Date.now / new Date(), NO Math.random,
// NO fetch/http/DB. Every await is an activity-port dispatch (ports.*); the rest is pure string/array work.
// The `@temporalio/common` failure types it reads (ActivityFailure / ApplicationFailure) are sandbox-safe.
//
// ── ARBITRATION FOOTER (Stage 5 — collapse-on) ──
// The Python `_post_review` folds `render_arbitration_footer_md(...)` onto the walkthrough markdown WHEN
// `arbitration_capture.result is not None`. The orchestrator's Step 7.7 arbitration apply populates
// `state.arbitration.result` (+ `.toolStatuses`) BEFORE the post stage runs, so `renderWalkthroughForPost`
// folds the suppressed-finding + tool-degradation footer here. When the arbitration step was skipped
// (no applyArbitration port / sa null / fail-open swallow) `state.arbitration.result` stays null and the
// fold is a no-op — the base markdown is returned unchanged.

import {
  ActivityFailure,
  ApplicationFailure,
} from "@temporalio/common";

import { stageOutcomeForPublication, fixPromptStageOutcome } from "./helpers.js";
import { stageOutcome, recordStage, type StageLogger } from "./degradation.js";
import { renderArbitrationFooterMd } from "#backend/review/arbitration/arbitration_footer.js";
import { renderWalkthrough } from "#backend/review/walkthrough_renderer.js";

import type { ReviewActivityPorts, ChangedLineRanges } from "./activity_ports.js";
import type { ReviewPipelinePrCtx } from "./orchestrator.js";
import type { ReviewWorkflowState } from "./state.js";
import type { ChangedLineRange } from "#contracts/chunk_and_redact.v1.js";
import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import type { WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import type { PostedReviewV1 } from "#contracts/posted_review.v1.js";
import type { SkippedInputV1 } from "#contracts/finding_lifecycle_inputs.v1.js";

/**
 * The Temporal `type` string the `post_review_results` activity stamps on the {@link ApplicationFailure} it
 * raises when a GitHub publish fails AFTER the classifier already partitioned findings into kept/dropped
 * (so the workflow body can still flip the dropped rows to DELIVERY_FINALIZED-skipped). 1:1 with the frozen
 * Python `_POST_REVIEW_FAILED_WITH_DROPPED_STATE` constant. The on-failure handler below acts ONLY on a
 * failure carrying this exact type (any other failure propagates unchanged).
 */
export const POST_REVIEW_FAILED_WITH_DROPPED_STATE = "PostReviewFailedWithDroppedState";

/**
 * The lifecycle-dispatch seam the post stage needs on the on-failure (dropped-state) path. The orchestrator
 * threads these from the workflow body so `posting.ts` stays sandbox-pure (it never constructs a DB-backed
 * setter — it only DISPATCHES the `record_delivery_skipped` activity through the typed port).
 *
 * `recordDeliverySkipped` is OPTIONAL: when omitted (unit tests, or the lifecycle wiring not yet injected),
 * the dropped-state skip dispatch is a no-op (the failure still re-raises). `persistedFindingIds` is the
 * ordered rfid tuple `_persist_findings` wrote — the H-2 capture the dropped-index → rfid mapping reads
 * (the orchestrator's `pipeline_result.review_finding_ids` is unreachable on the post-failure path because
 * the orchestrator never returns). Sourced from `state.persistedFindingIds`.
 */
export type PostingLifecycleDeps = {
  /** The record_delivery_skipped activity port (1-arg typed dispatch). Omitted → inline skip is a no-op. */
  readonly recordDeliverySkipped?: (input: SkippedInputV1) => Promise<number>;
  /** The ordered rfids _persist_findings wrote (state.persistedFindingIds), for the dropped-index mapping. */
  readonly persistedFindingIds: ReadonlyArray<string>;
  /** The WARN sink the fail-open `update_pr_description` stageOutcome wrap logs on (the Temporal workflow
   *  logger in production; a recording logger in tests). Omitted → the stageOutcome wrap drops its WARN line
   *  (record_stage stays the metric source of truth). */
  readonly logger?: StageLogger;
};

/**
 * Render the walkthrough markdown the GitHub review body wraps (1:1 with the `_post_review` render step).
 *
 * The frozen Python calls `render_walkthrough(walkthrough)` (the structured-markdown renderer) then, when
 * the arbitration capture carries a result, appends `render_arbitration_footer_md(...)`. Both halves are
 * now ported: {@link renderWalkthrough} produces the full structured body (header + TL;DR + truncated/
 * degradation notices + file table + config section + linked issues + suggested reviewers, safety-cap
 * truncated). The arbitration footer fold (Stage 5 collapse-on): when `state.arbitration.result` is
 * populated (the Step 7.7 apply ran), the footer renderer appends the suppressed-finding + tool-degradation
 * block (rstrip the base + footer + trailing newline, 1:1 with the Python
 * `walkthrough_md.rstrip() + footer_md + "\n"`). When the result is null (arbitration skipped) the base
 * markdown is returned unchanged. Pure: no activity dispatch, no I/O.
 */
export function renderWalkthroughForPost(
  walkthrough: WalkthroughV1,
  state: ReviewWorkflowState,
): string {
  const walkthroughMd = renderWalkthrough(walkthrough);
  // Arbitration footer fold — when Step 7.7's apply_arbitration populated state.arbitration.result, append
  // the footer HERE (the Python `if arbitration_capture.result is not None:` branch). The renderer returns
  // "" when there are no non-NONE decisions AND all tools completed, so even a populated (but empty) result
  // leaves the base markdown unchanged.
  if (state.arbitration.result !== null) {
    const footerMd = renderArbitrationFooterMd({
      result: state.arbitration.result,
      toolStatuses: state.arbitration.toolStatuses,
    });
    if (footerMd !== "") {
      // rstrip the base + append the footer + a trailing newline (1:1 with the Python
      // `walkthrough_md.rstrip() + footer_md + "\n"`).
      return walkthroughMd.replace(/\s+$/, "") + footerMd + "\n";
    }
  }
  return walkthroughMd;
}

/**
 * Map the {@link PublicationOutcome} the post activity returned to the workflow stage-outcome vocabulary
 * (`ok` for INLINE_POSTED; `fallback` for BODY_ONLY_POSTED / DEGRADED_UNPOSTED). 1:1 with the Python
 * `_log_stage("post_review", outcome=_stage_outcome_for_publication(...))` call. Thin re-export of the
 * helper so the post stage's outcome derivation reads from one place.
 */
export function derivePublicationOutcome(posted: PostedReviewV1): string {
  return stageOutcomeForPublication(posted.publication_outcome);
}

/**
 * Populate the workflow-body `_PostReviewCapture` from a successful {@link PostedReviewV1} (1:1 with the
 * `if posted is not None:` capture block in `_post_review`). The capture is the slot the workflow body's
 * lifecycle-bookkeeping block reads AFTER orchestrate() returns — `posted_review_pr_id` is bound to
 * `pr.prMeta.pr_id` (the `core.posted_reviews` PK keyed by PR), the rest from the PostedReviewV1 envelope.
 */
export function captureFromPostedReview(
  state: ReviewWorkflowState,
  posted: PostedReviewV1,
  pr: ReviewPipelinePrCtx,
): void {
  state.postedReview = {
    reviewId: posted.review_id,
    commentIds: [...posted.comment_ids],
    // posted_review_pr_id matches pr_meta.pr_id — the PK of the core.posted_reviews row keyed by PR.
    postedReviewPrId: pr.prMeta.pr_id,
    keptFindingIndices: [...posted.kept_finding_indices],
    publicationOutcome: posted.publication_outcome,
    degradationNotes: [...posted.degradation_notes],
    droppedClassifications: [...posted.dropped_classifications],
  };
}

/**
 * The JSON-safe dropped-state details the post activity packs into {@link ApplicationFailure}.details[0] on
 * the H-2 failure path. 1:1 with the Python `_build_dropped_state_details` shape: `posted_review_pr_id` as
 * a string, `kept_finding_indices` as int[], `dropped_classifications` as a list of `{index, eligibility_
 * reason}` dicts. Modelled loosely (the runtime narrowing below validates each field).
 */
type DroppedStateDetails = {
  dropped_classifications?: ReadonlyArray<unknown>;
  kept_finding_indices?: ReadonlyArray<unknown>;
  posted_review_pr_id?: unknown;
};

/**
 * Extract the dropped-state details dict from a post-review failure, OR null when the failure is not the
 * H-2 dropped-state shape. 1:1 with the workflow body's `_app_err` extraction: Temporal wraps an activity
 * exception in `ActivityFailure(cause=ApplicationFailure)`, but the `ApplicationFailure` can also surface
 * DIRECTLY; narrow either shape, require `type === PostReviewFailedWithDroppedState` and a non-empty
 * `details` array, and return `details[0]` as the JSON-safe payload.
 */
export function extractDroppedStateFromPostFailure(err: unknown): DroppedStateDetails | null {
  let appErr: ApplicationFailure | null = null;
  if (err instanceof ApplicationFailure) {
    appErr = err;
  } else if (err instanceof ActivityFailure && err.cause instanceof ApplicationFailure) {
    appErr = err.cause;
  }
  if (appErr === null || appErr.type !== POST_REVIEW_FAILED_WITH_DROPPED_STATE) {
    return null;
  }
  const details = appErr.details;
  if (details === undefined || details === null || details.length === 0) {
    return null;
  }
  const raw = details[0];
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  return raw as DroppedStateDetails;
}

/**
 * On a post-review dropped-state failure: map dropped indices → rfids (via `deps.persistedFindingIds`),
 * dispatch `record_delivery_skipped` INLINE, then return (the caller re-raises). 1:1 with the workflow
 * body's H-2 except clause. Best-effort: a skip-dispatch failure is swallowed here (the original
 * post-review failure is the dominant operator signal that re-propagates). A no-op when:
 *   * the failure is not the dropped-state shape (details === null),
 *   * no dropped classifications survived the index→rfid mapping,
 *   * `deps.recordDeliverySkipped` is not injected (the skip dispatch seam is absent).
 */
async function dispatchInlineSkippedLifecycle(
  details: DroppedStateDetails,
  pr: ReviewPipelinePrCtx,
  deps: PostingLifecycleDeps,
): Promise<void> {
  const droppedRaw = details.dropped_classifications;
  const postedPrIdRaw = details.posted_review_pr_id;
  if (
    !Array.isArray(droppedRaw) ||
    droppedRaw.length === 0 ||
    typeof postedPrIdRaw !== "string" ||
    deps.persistedFindingIds.length === 0
  ) {
    return;
  }
  const rfidsCount = deps.persistedFindingIds.length;
  const skippedPairs: Array<{ rfid: string; reason: string }> = [];
  for (const entry of droppedRaw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const e = entry as { index?: unknown; eligibility_reason?: unknown };
    const idx = e.index;
    const reason = e.eligibility_reason;
    if (
      typeof idx === "number" &&
      Number.isInteger(idx) &&
      idx >= 0 &&
      idx < rfidsCount &&
      typeof reason === "string"
    ) {
      // eslint-disable-next-line security/detect-object-injection -- `idx` is bounds-checked (0 <= idx < rfidsCount) against a workflow-local string array, not external input
      skippedPairs.push({ rfid: deps.persistedFindingIds[idx]!, reason });
    }
  }
  if (skippedPairs.length === 0 || deps.recordDeliverySkipped === undefined) {
    return;
  }
  try {
    await deps.recordDeliverySkipped({
      schema_version: 1,
      installation_id: pr.prMeta.installation_id,
      run_id: pr.runId,
      review_id: pr.reviewId,
      rfids: skippedPairs.map((p) => p.rfid),
      reasons: skippedPairs.map((p) => p.reason),
      posted_review_pr_id: postedPrIdRaw,
    });
  } catch {
    // B.12 — the inline skip dispatch is best-effort. The post-review failure is the dominant operator
    // signal; a skip-dispatch failure must NOT shadow it (the original failure re-raises in the caller).
  }
}

/** Convert the readonly ChangedLineRanges into the mutable shape PostReviewInputV1 expects (pure copy). */
function toMutableRanges(ranges: ChangedLineRanges): Record<string, Array<[number, number]>> {
  const out: Record<string, Array<[number, number]>> = {};
  for (const [path, pairs] of Object.entries(ranges)) {
    // eslint-disable-next-line security/detect-object-injection -- `path` is a key from Object.entries over the input record, not external input
    out[path] = pairs.map((p: ChangedLineRange): [number, number] => [p[0], p[1]]);
  }
  return out;
}

/** Split a "owner/repo" slug into owner (before the first '/'). */
function ownerOf(repoSlug: string): string {
  const idx = repoSlug.indexOf("/");
  return idx === -1 ? repoSlug : repoSlug.slice(0, idx);
}

/** Split a "owner/repo" slug into repo-name (after the first '/'). */
function repoNameOf(repoSlug: string): string {
  const idx = repoSlug.indexOf("/");
  return idx === -1 ? repoSlug : repoSlug.slice(idx + 1);
}

/**
 * Run the full post-review sub-pipeline: render the walkthrough markdown, dispatch the `post_review_results`
 * activity, and EITHER populate the `_PostReviewCapture` from the success result OR (on the H-2 dropped-
 * state failure) map dropped indices → rfids + dispatch `record_delivery_skipped` inline, then re-raise.
 *
 * 1:1 with the `_post_review` closure's structure. On success, returns the {@link PostedReviewV1} (the
 * caller may map its publication outcome to the stage outcome via {@link derivePublicationOutcome}). On
 * failure, the dropped-state skip is dispatched best-effort and the original failure re-propagates so the
 * orchestrator's stage-outcome wrap records `outcome=error` and the workflow body's BF-5 path marks the run
 * FAILED.
 */
export async function postReviewResults(
  ports: ReviewActivityPorts,
  state: ReviewWorkflowState,
  walkthrough: WalkthroughV1,
  aggregated: AggregatedFindingsV1,
  pr: ReviewPipelinePrCtx,
  deps: PostingLifecycleDeps,
): Promise<PostedReviewV1> {
  const walkthroughMd = renderWalkthroughForPost(walkthrough, state);
  let posted: PostedReviewV1;
  try {
    posted = await ports.postReview({
      schema_version: 1,
      pr_meta: pr.prMeta,
      aggregated,
      walkthrough,
      head_sha: pr.headSha,
      walkthrough_md: walkthroughMd,
      owner: ownerOf(pr.prMeta.repo),
      repo_name: repoNameOf(pr.prMeta.repo),
      pr_number: pr.prNumber,
      run_id: pr.runId,
      review_id: pr.reviewId,
      changed_line_ranges: toMutableRanges(pr.changedLineRanges),
    });
  } catch (postReviewExc) {
    // H-2 dropped-state failure path: when the activity wrapped its underlying GitHub failure in an
    // ApplicationFailure carrying the classifier output, flip the dropped rows to skipped BEFORE re-raising
    // so they don't stay stuck at PERSISTED with delivery_outcome IS NULL forever. Any other failure (or a
    // failure without the dropped-state details) just re-raises unchanged.
    const details = extractDroppedStateFromPostFailure(postReviewExc);
    if (details !== null) {
      await dispatchInlineSkippedLifecycle(details, pr, deps);
    }
    throw postReviewExc;
  }
  captureFromPostedReview(state, posted, pr);

  // S19.NOW8.B — append the codemaster summary to the PR DESCRIPTION (GET-modify-PATCH the PR body). The
  // Python runs this INSIDE `_post_review` AFTER the review lands + the publication-outcome stage emit
  // (review_pull_request.py:2729-2746). FAIL-OPEN (AC3): a failure here NEVER fails the workflow — the
  // already-posted review is the value; the description appendage is polish. The stageOutcome wrap
  // (raiseAfterLog defaults false) swallows + records outcome=error; skipOutcome() defers to the activity's
  // own success (the Python `_log_stage("update_pr_description", outcome="ok")` is the canonical emit — the
  // wrap's auto-ok would double-count). SKIPPED when ctx.activities.updatePrDescriptionSummary is omitted
  // (unit tests; the Python wiring-not-injected analogue). The advisory path-filters-excluded-all post goes
  // through postReviewResults too, so it fires there as well (1:1 with the Python `_post_review` closure
  // serving both paths). The activity is INDEPENDENT of the parallel post_check_run dispatch.
  if (ports.updatePrDescriptionSummary !== undefined) {
    const updatePort = ports.updatePrDescriptionSummary;
    await stageOutcome(
      "update_pr_description",
      { logger: deps.logger ?? NULL_POSTING_LOGGER, headSha: pr.headSha, runId: pr.runId },
      async (handle): Promise<void> => {
        handle.skipOutcome();
        await updatePort({
          schema_version: 1,
          owner: ownerOf(pr.prMeta.repo),
          repo: repoNameOf(pr.prMeta.repo),
          pr_number: pr.prNumber,
          aggregated,
        });
      },
    );
  }

  // fix-prompt (fix-prompt-v1 collapse-on) — after the review is posted (+ the PR-description appendage),
  // generate the aggregated copy-pasteable Claude Code fix prompt (persisted to core.fix_prompts + posted as
  // a collapsed advisory PR comment). UNCONDITIONAL when aggregated.findings is non-empty (the Python
  // `if aggregated.findings and workflow.patched("fix-prompt-v1")` — the patched gate collapses on).
  // Advisory: a failure here NEVER fails the already-posted review (the stageOutcome wrap, raiseAfterLog
  // defaults false, swallows + records outcome=error). skipOutcome() defers to the explicit recordStage so
  // the ok/fallback/skipped outcome (NOT the wrap's auto-ok) is the canonical emit — 1:1 with the Python
  // `_fix_prompt_handle.skip_outcome()` + `_log_stage("fix_prompt", outcome=_fix_prompt_stage_outcome(...))`.
  // SKIPPED when ports.generateFixPrompt is omitted (unit tests; the wiring-not-injected analogue). The
  // advisory path-filters-excluded-all post has zero findings, so this never fires there.
  if (aggregated.findings.length > 0 && ports.generateFixPrompt !== undefined) {
    const generateFixPrompt = ports.generateFixPrompt;
    await stageOutcome(
      "fix_prompt",
      { logger: deps.logger ?? NULL_POSTING_LOGGER, headSha: pr.headSha, runId: pr.runId },
      async (handle): Promise<void> => {
        handle.skipOutcome();
        const fpResult = await generateFixPrompt({
          schema_version: 1,
          review_id: pr.reviewId,
          installation_id: pr.prMeta.installation_id,
          pr_number: pr.prNumber,
          owner: ownerOf(pr.prMeta.repo),
          repo: repoNameOf(pr.prMeta.repo),
          aggregated,
        });
        recordStage({
          stage: "fix_prompt",
          outcome: fixPromptStageOutcome({
            generated: fpResult.generated,
            generationMode: fpResult.generation_mode,
          }),
        });
      },
    );
  }

  return posted;
}

/** A no-op StageLogger for when `deps.logger` is omitted (the update_pr_description fail-open wrap). Inert
 *  by construction (sandbox-safe — no console binding); record_stage stays the metric source of truth. */
const NULL_POSTING_LOGGER: StageLogger = {
  warning(): void {
    // intentionally inert — see PostingLifecycleDeps.logger
  },
};
