// activity_proxy — the workflow-side bridge that turns the typed `ReviewActivityPorts` surface into a
// proxy of `proxyActivities()` stubs, applying the EXACT per-activity Temporal ActivityOptions
// (RETRY_POLICIES) the frozen Python bridge closures used.
//
// ── Why this module exists (the naming bridge) ──
// The orchestrator (orchestrator.ts) calls `ports.clone(...)`, `ports.reviewChunk(...)`,
// `ports.aggregate(...)`, `ports.cleanup(...)` etc. — the COMPACT port method names of
// `ReviewActivityPorts`. The worker composition root (worker/build_activities.ts) registers the activities
// under their LONG Python-aligned names (`cloneRepoIntoWorkspace`, `bedrockReviewChunk`,
// `aggregateFindings`, `releaseWorkspace`, …). A bare `proxyActivities<ReviewActivityPorts>()` would
// dispatch activities named `clone` / `reviewChunk` / `aggregate` / `cleanup`, which are NOT registered —
// `ActivityNotRegistered` at dispatch. This module is the ONE place the two name-spaces are reconciled: it
// builds each port method as a single-activity `proxyActivities()` stub keyed by the REGISTERED name with
// that activity's RETRY_POLICIES, then assembles them into the `ReviewActivityPorts` object the
// orchestrator consumes.
//
// ── Per-activity options (RETRY_POLICIES) ──
// `proxyActivities(options)` applies ONE options object across the proxy it returns. The Python bridge
// closures used DIFFERENT timeout + retry curves per activity (clone 60s/heartbeat-30s, reviewChunk
// 90s/4-attempts/non-retryable-Bedrock-errors, staticAnalysis 120s, …). To preserve each curve exactly we
// make a SEPARATE `proxyActivities()` call per activity, each typed to its single registered-name method,
// spreading `RETRY_POLICIES.<port>` into the options. The 18 calls are cheap (each returns a Proxy) and
// keep every activity's options byte-identical to the transcribed Python source.
//
// ── SANDBOX SAFETY (ADR-0065 / ADR-0066) ──
// This module runs INSIDE the Temporal V8 workflow sandbox (the workflow body imports it). It imports
// ONLY `@temporalio/workflow` (the sandbox-safe API) + TYPE-ONLY contract shapes (erased at emit under
// verbatimModuleSyntax, so NO runtime edge to the crypto-importing contracts is created) + the
// type-only `ReviewActivityPorts` / value-only `RETRY_POLICIES` (pure data) from activity_ports.ts. NO
// node:crypto, NO clock, NO RNG, NO fetch/DB. `proxyActivities` stubs are turned into deterministic
// ScheduleActivityTask commands by the SDK; all non-deterministic work happens inside the activity runtime.

import { type ActivityOptions, proxyActivities } from "@temporalio/workflow";

import {
  type ReviewActivityPorts,
  type RetryActivityOptions,
  RETRY_POLICIES,
} from "#backend/review/pipeline/activity_ports.js";

import type { ClonedRepoV1 } from "#contracts/cloned_repo.v1.js";
import type { CloneRepoIntoWorkspaceInput } from "#contracts/clone_repo_into_workspace_input.v1.js";
import type { FileRoutingV1 } from "#contracts/file_routing.v1.js";
import type { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import type { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";
import type { CarryForwardSelectionV1 } from "#contracts/carry_forward.v1.js";
import type { EmbedQueryInputV1, EmbedQueryResultV1 } from "#contracts/embed_query.v1.js";
import type {
  RetrieveKnowledgeInputV1,
  RetrieveKnowledgeResultV1,
} from "#contracts/retrieve_knowledge.v1.js";
import type { ReviewContextV1 } from "#contracts/review_context.v1.js";
import type { ReviewChunkResponseV1 } from "#contracts/review_chunk_response.v1.js";
import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import type { WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import type { PostReviewInputV1 } from "#contracts/post_review_input.v1.js";
import type { PostedReviewV1 } from "#contracts/posted_review.v1.js";
import type { ReleaseWorkspaceInput } from "#contracts/release_workspace_input.v1.js";
import type { GenerateWalkthroughInputV1 } from "#contracts/generate_walkthrough_input.v1.js";
import type { PostCheckRunInputV1, PostedCheckRunV1 } from "#contracts/posted_check_run.v1.js";
import type { DedupFindingsInputV1, DedupedFindingsV1 } from "#contracts/dedup_findings.v1.js";
import type { LoadRepoConfigInputV1 } from "#contracts/load_repo_config.v1.js";
import type { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import type {
  ComputePolicyRulesInputV1,
  ComputedPolicyRulesV1,
} from "#contracts/policy_compute.v1.js";
import type { PersistReviewFindingsInputV1 } from "#contracts/persist_review_findings.v1.js";
import type { PersistReviewWalkthroughInputV1 } from "#contracts/persist_review_walkthrough.v1.js";
import type { CitationValidateInputV1 } from "#contracts/citation_validate_input.v1.js";
import type { CitationValidationResultV1 } from "#contracts/citation_validation.v1.js";
import type { EmitOutputSafetyAuditEventInput } from "#contracts/emit_output_safety_audit.v1.js";
import type { SkippedInputV1 } from "#contracts/finding_lifecycle_inputs.v1.js";
import type { BuildRetrievedEvidenceInputV1 } from "#contracts/build_retrieved_evidence_input.v1.js";
import type { RetrievedEvidenceV1 } from "#contracts/retrieved_evidence.v1.js";
import type { UpdatePrDescriptionInputV1 } from "#contracts/update_pr_description.v1.js";
import type { ApplyArbitrationInputV1 } from "#contracts/apply_arbitration_input.v1.js";
import type { ArbitrationResultV1 } from "#contracts/arbitration_result.v1.js";
import type { RecordToolRunsInputV1 } from "#contracts/record_tool_runs_input.v1.js";
import type { GenerateFixPromptInputV1 } from "#contracts/generate_fix_prompt.v1.js";
import type { FixPromptActivityResultV1 } from "#contracts/fix_prompt_activity_result.v1.js";
import type {
  ClassifyInput,
  ChunkAndRedactInput,
  StaticAnalysisInput,
  SelectCarryForwardInput,
  AggregateInput,
} from "#backend/review/pipeline/activity_ports.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// toActivityOptions — adapt a `RetryActivityOptions` (the load-bearing RETRY_POLICIES transcription, which
// types `nonRetryableErrorTypes` as a `ReadonlyArray<string>` and is frozen `as const`) onto the SDK's
// `ActivityOptions` (which wants a MUTABLE `string[]` for `retry.nonRetryableErrorTypes`). We copy the
// fields into a fresh object and spread the readonly tuple into a mutable array — a pure, allocation-only
// transform (sandbox-safe; no clock/random/network). Every value is byte-identical to the transcribed
// Python source; this adapter only re-shapes the readonly-ness the two type systems disagree on.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function toActivityOptions(policy: RetryActivityOptions): ActivityOptions {
  const retry = policy.retry;
  const options: ActivityOptions = {};
  if (policy.startToCloseTimeout !== undefined) {
    options.startToCloseTimeout = policy.startToCloseTimeout;
  }
  if (policy.heartbeatTimeout !== undefined) {
    options.heartbeatTimeout = policy.heartbeatTimeout;
  }
  if (policy.scheduleToCloseTimeout !== undefined) {
    options.scheduleToCloseTimeout = policy.scheduleToCloseTimeout;
  }
  if (retry !== undefined) {
    options.retry = {
      ...(retry.initialInterval !== undefined ? { initialInterval: retry.initialInterval } : {}),
      ...(retry.maximumInterval !== undefined ? { maximumInterval: retry.maximumInterval } : {}),
      ...(retry.backoffCoefficient !== undefined
        ? { backoffCoefficient: retry.backoffCoefficient }
        : {}),
      ...(retry.maximumAttempts !== undefined ? { maximumAttempts: retry.maximumAttempts } : {}),
      ...(retry.nonRetryableErrorTypes !== undefined
        ? { nonRetryableErrorTypes: [...retry.nonRetryableErrorTypes] }
        : {}),
    };
  }
  return options;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// makeActivityPorts — assemble the typed `ReviewActivityPorts` from per-activity `proxyActivities()`
// stubs keyed by the worker's REGISTERED activity names. Each `proxyActivities<{...}>()` call is typed to
// exactly the one registered-name method it provides, spreading that activity's RETRY_POLICIES options.
//
// The registered-name → port-method mapping (the 7 that differ are flagged ←):
//   cloneRepoIntoWorkspace   → clone               ←
//   loadRepoConfigActivity   → loadRepoConfig       ←
//   computePolicyRules       → computePolicyRules
//   classifyFiles            → classify             ←
//   chunkAndRedact           → chunkAndRedact
//   staticAnalysis           → staticAnalysis
//   selectCarryForward       → selectCarryForward
//   embedQuery               → embedQuery
//   retrieveKnowledge        → retrieveKnowledge
//   bedrockReviewChunk       → reviewChunk          ←
//   dedupFindings            → dedupFindings
//   aggregateFindings        → aggregate            ←
//   persistReviewFindings    → persistReviewFindings
//   generateWalkthrough      → generateWalkthrough
//   persistReviewWalkthrough → persistReviewWalkthrough
//   postReviewResults        → postReview           ←
//   postCheckRun             → postCheckRun
//   releaseWorkspace         → cleanup              ←
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function makeActivityPorts(): ReviewActivityPorts {
  const { cloneRepoIntoWorkspace } = proxyActivities<{
    cloneRepoIntoWorkspace(input: CloneRepoIntoWorkspaceInput): Promise<ClonedRepoV1>;
  }>(toActivityOptions(RETRY_POLICIES.clone));

  const { loadRepoConfigActivity } = proxyActivities<{
    loadRepoConfigActivity(input: LoadRepoConfigInputV1): Promise<CodemasterConfigV1>;
  }>(toActivityOptions(RETRY_POLICIES.loadRepoConfig));

  const { computePolicyRules } = proxyActivities<{
    computePolicyRules(input: ComputePolicyRulesInputV1): Promise<ComputedPolicyRulesV1>;
  }>(toActivityOptions(RETRY_POLICIES.computePolicyRules));

  const { classifyFiles } = proxyActivities<{
    classifyFiles(input: ClassifyInput): Promise<FileRoutingV1>;
  }>(toActivityOptions(RETRY_POLICIES.classify));

  const { chunkAndRedact } = proxyActivities<{
    chunkAndRedact(input: ChunkAndRedactInput): Promise<ReadonlyArray<DiffChunkV1>>;
  }>(toActivityOptions(RETRY_POLICIES.chunkAndRedact));

  const { staticAnalysis } = proxyActivities<{
    staticAnalysis(input: StaticAnalysisInput): Promise<StaticAnalysisResultV1>;
  }>(toActivityOptions(RETRY_POLICIES.staticAnalysis));

  const { selectCarryForward } = proxyActivities<{
    selectCarryForward(input: SelectCarryForwardInput): Promise<CarryForwardSelectionV1>;
  }>(toActivityOptions(RETRY_POLICIES.selectCarryForward));

  const { embedQuery } = proxyActivities<{
    embedQuery(input: EmbedQueryInputV1): Promise<EmbedQueryResultV1>;
  }>(toActivityOptions(RETRY_POLICIES.embedQuery));

  const { retrieveKnowledge } = proxyActivities<{
    retrieveKnowledge(input: RetrieveKnowledgeInputV1): Promise<RetrieveKnowledgeResultV1>;
  }>(toActivityOptions(RETRY_POLICIES.retrieveKnowledge));

  const { bedrockReviewChunk } = proxyActivities<{
    bedrockReviewChunk(input: ReviewContextV1): Promise<ReviewChunkResponseV1>;
  }>(toActivityOptions(RETRY_POLICIES.reviewChunk));

  const { dedupFindings } = proxyActivities<{
    dedupFindings(input: DedupFindingsInputV1): Promise<DedupedFindingsV1>;
  }>(toActivityOptions(RETRY_POLICIES.dedupFindings));

  const { aggregateFindings } = proxyActivities<{
    aggregateFindings(input: AggregateInput): Promise<AggregatedFindingsV1>;
  }>(toActivityOptions(RETRY_POLICIES.aggregate));

  const { persistReviewFindings } = proxyActivities<{
    persistReviewFindings(input: PersistReviewFindingsInputV1): Promise<ReadonlyArray<string>>;
  }>(toActivityOptions(RETRY_POLICIES.persistReviewFindings));

  const { generateWalkthrough } = proxyActivities<{
    generateWalkthrough(input: GenerateWalkthroughInputV1): Promise<WalkthroughV1>;
  }>(toActivityOptions(RETRY_POLICIES.generateWalkthrough));

  const { persistReviewWalkthrough } = proxyActivities<{
    persistReviewWalkthrough(input: PersistReviewWalkthroughInputV1): Promise<void>;
  }>(toActivityOptions(RETRY_POLICIES.persistReviewWalkthrough));

  const { postReviewResults } = proxyActivities<{
    postReviewResults(input: PostReviewInputV1): Promise<PostedReviewV1>;
  }>(toActivityOptions(RETRY_POLICIES.postReview));

  const { postCheckRun } = proxyActivities<{
    postCheckRun(input: PostCheckRunInputV1): Promise<PostedCheckRunV1>;
  }>(toActivityOptions(RETRY_POLICIES.postCheckRun));

  const { releaseWorkspace } = proxyActivities<{
    releaseWorkspace(input: ReleaseWorkspaceInput): Promise<void>;
  }>(toActivityOptions(RETRY_POLICIES.cleanup));

  // ── Stage-3 ports ──
  // citation_validate_activity — Step 7.5 (drops findings citing missing repo_paths). Registered name
  // `citationValidate`.
  const { citationValidate } = proxyActivities<{
    citationValidate(input: CitationValidateInputV1): Promise<CitationValidationResultV1>;
  }>(toActivityOptions(RETRY_POLICIES.citationValidate));
  // emit_output_safety_audit_event_activity — dispatched on a chunk/walkthrough sanitization_event.
  // Registered name `emitOutputSafetyAuditEvent`.
  const { emitOutputSafetyAuditEvent } = proxyActivities<{
    emitOutputSafetyAuditEvent(input: EmitOutputSafetyAuditEventInput): Promise<void>;
  }>(toActivityOptions(RETRY_POLICIES.emitOutputSafetyAudit));
  // record_delivery_skipped_activity — the H-2 inline skip dispatch on the post-review dropped-state
  // failure path. Registered name `recordDeliverySkipped`.
  const { recordDeliverySkipped } = proxyActivities<{
    recordDeliverySkipped(input: SkippedInputV1): Promise<number>;
  }>(toActivityOptions(RETRY_POLICIES.recordDeliverySkipped));

  // ── Stage-4 ports ──
  // build_retrieved_evidence — the per-chunk provenance-backed evidence-manifest producer (mints ev_ ids via
  // node:crypto, so it runs in the Node activity runtime; the workflow body only dispatches the typed input
  // + receives the RetrievedEvidenceV1 tuple back across the wire). Registered name `buildRetrievedEvidence`.
  const { buildRetrievedEvidence } = proxyActivities<{
    buildRetrievedEvidence(
      input: BuildRetrievedEvidenceInputV1,
    ): Promise<ReadonlyArray<RetrievedEvidenceV1>>;
  }>(toActivityOptions(RETRY_POLICIES.buildRetrievedEvidence));
  // update_pr_description_summary — the S19.NOW8.B PR-description appendage, dispatched by posting.ts after
  // the review lands (fail-open). Registered name `updatePrDescriptionSummary`.
  const { updatePrDescriptionSummary } = proxyActivities<{
    updatePrDescriptionSummary(input: UpdatePrDescriptionInputV1): Promise<void>;
  }>(toActivityOptions(RETRY_POLICIES.updatePrDescriptionSummary));

  // ── Stage-5 ports (arbitration layer + fix-prompt) ──
  // apply_arbitration_activity — Step 7.7 Tier-1/Tier-2 arbitration apply (pure arbitrate() core +
  // persistence). Returns the ArbitrationResultV1 the post-review footer renderer folds into the walkthrough
  // body. Registered name `applyArbitrationActivity`.
  const { applyArbitrationActivity } = proxyActivities<{
    applyArbitrationActivity(input: ApplyArbitrationInputV1): Promise<ArbitrationResultV1>;
  }>(toActivityOptions(RETRY_POLICIES.applyArbitration));
  // record_tool_runs_activity — Step 7.7 per-tool review_tool_runs persistence. Registered name
  // `recordToolRuns`.
  const { recordToolRuns } = proxyActivities<{
    recordToolRuns(input: RecordToolRunsInputV1): Promise<void>;
  }>(toActivityOptions(RETRY_POLICIES.recordToolRuns));
  // generate_fix_prompt_activity — the post-path fix-prompt dispatch (dispatched by posting.ts after the
  // post lands, when aggregated.findings non-empty). Registered name `generateFixPrompt`. The result is read
  // as the typed FixPromptActivityResultV1 (the contract carries `generated` / `generation_mode` for the
  // fix-prompt stage-outcome mapping).
  const { generateFixPrompt } = proxyActivities<{
    generateFixPrompt(input: GenerateFixPromptInputV1): Promise<FixPromptActivityResultV1>;
  }>(toActivityOptions(RETRY_POLICIES.generateFixPrompt));

  return {
    clone: cloneRepoIntoWorkspace,
    loadRepoConfig: loadRepoConfigActivity,
    computePolicyRules,
    classify: classifyFiles,
    chunkAndRedact,
    staticAnalysis,
    selectCarryForward,
    embedQuery,
    retrieveKnowledge,
    reviewChunk: bedrockReviewChunk,
    dedupFindings,
    aggregate: aggregateFindings,
    persistReviewFindings,
    generateWalkthrough,
    persistReviewWalkthrough,
    postReview: postReviewResults,
    postCheckRun,
    cleanup: releaseWorkspace,
    // Stage-3 ports — the orchestrator dispatches these (Step 7.5 / sanitization-event emit / H-2 skip).
    citationValidate,
    emitOutputSafetyAudit: emitOutputSafetyAuditEvent,
    recordDeliverySkipped,
    // Stage-4 ports — per-chunk evidence manifest (buildChunkContext) + PR-description summary (posting.ts).
    buildRetrievedEvidence,
    updatePrDescriptionSummary,
    // Stage-5 ports — arbitration apply + tool-run record (orchestrator Step 7.7) + fix-prompt (posting.ts).
    applyArbitration: applyArbitrationActivity,
    recordToolRuns,
    generateFixPrompt,
  };
}
