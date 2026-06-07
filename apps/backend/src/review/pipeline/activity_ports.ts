// activity_ports — the typed ReviewActivityPorts surface (finding 9: ONE typed input envelope per
// activity) + the per-activity RETRY_POLICIES constants transcribed 1:1 from the Python dispatch sites.
//
// SCOPE (Stage 0): this module DEFINES the ports TYPE + the retry/timeout constants ONLY. It does NOT call
// proxyActivities() — that requires the @temporalio/workflow runtime context (a workflow execution must be
// active) and lands in Stage 1's workflow body (review_pull_request.workflow.ts), which will:
//   const ports = makeReviewActivityPorts();   // proxyActivities<...>(...) per-activity with RETRY_POLICIES.X
// The orchestrator (Stage 1) calls ports.reviewChunk({...}) etc. — never positional args=[...].
//
// The RETRY_POLICIES values are LOAD-BEARING — they are the exact start_to_close_timeout + RetryPolicy
// (initial_interval, maximum_interval, backoff_coefficient, maximum_attempts, non_retryable_error_types,
// heartbeat_timeout) from the frozen Python bridge closures in
// vendor/codemaster-py/codemaster/workflows/review_pull_request.py. Each constant cites its source line.
//
// Duration shape: the TS SDK ActivityOptions accept either an ms number or a humanized string ("60s",
// "5 minutes"). We use the SDK's string form. Defaults the Python RetryPolicy leaves implicit (the SDK's
// backoff_coefficient default is 2.0, maximum_interval default is 100x the initial) are written out ONLY
// where the Python set them EXPLICITLY — leaving the rest to the SDK defaults so we don't silently encode
// a different curve than the Python's. Where the Python omitted a field, this constant omits it too.
//
// SANDBOX SAFETY (ADR-0065/0066): pure data + a type. NO node:crypto / uuid / clock / RNG / timers. No
// runtime imports beyond type-only contract imports.

import type { ClonedRepoV1 } from "#contracts/cloned_repo.v1.js";
import type { CloneRepoIntoWorkspaceInput } from "#contracts/clone_repo_into_workspace_input.v1.js";
import type { FileRoutingV1 } from "#contracts/file_routing.v1.js";
import type { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import type { ChangedLineRange, ChunkAndRedactInputV1 } from "#contracts/chunk_and_redact.v1.js";
import type { ClassifyFilesInputV1 } from "#contracts/classify_files.v1.js";
import type { StaticAnalysisInputV1 } from "#contracts/static_analysis_input.v1.js";
import type { SelectCarryForwardInputV1 } from "#contracts/select_carry_forward_input.v1.js";
import type { AggregateFindingsInputV1 } from "#contracts/aggregate_findings.v1.js";
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

/** changed_line_ranges wire shape: dict[str, tuple[tuple[int,int], ...]] → keyed by relative path,
 *  ChangedLineRange is the [start, end] tuple ported in chunk_and_redact.v1.ts. Matches the existing TS
 *  activity-side type (`Readonly<Record<string, ReadonlyArray<...>>>`). */
export type ChangedLineRanges = Readonly<Record<string, ReadonlyArray<ChangedLineRange>>>;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Per-activity inputs (finding 9): EVERY port takes its real snake_case `*InputV1` contract directly — the
// SAME contract the registered activity parses. The earlier hand-rolled camelCase envelopes (ClassifyInput,
// ChunkAndRedactInput, StaticAnalysisInput, SelectCarryForwardInput, AggregateInput) were DELETED: they were
// a second, drifting shape that the proxyActivities() type bridge silently dispatched RAW (Temporal does NOT
// translate object keys), so the activity read `input.workspace_path` = undefined and crashed at runtime.
// One contract per dispatch seam — no camelCase/snake_case fork.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// `generateWalkthrough` + `postCheckRun` dispatch the REAL ported activity contracts
// (GenerateWalkthroughInputV1 / PostCheckRunInputV1) rather than a hand-rolled envelope — the orchestrator
// (orchestrator.ts) constructs the typed contract directly. The earlier Stage-0 placeholder envelopes
// (GenerateWalkthroughInput / PostCheckRunInput) were superseded once the real activities landed
// (generate_walkthrough_input.v1 / posted_check_run.v1) with single-positional invariant-11 inputs.

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ReviewActivityPorts — the typed spine activity surface. Stage 1 wires these to proxyActivities(); Stage
// 2-5 ports are added incrementally (mutex/lifecycle/enrichment/arbitration/fix-prompt) as their contracts
// land. Each method takes exactly ONE typed argument (invariant 11 / finding 9).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export type ReviewActivityPorts = {
  clone(input: CloneRepoIntoWorkspaceInput): Promise<ClonedRepoV1>;
  loadRepoConfig(input: LoadRepoConfigInputV1): Promise<CodemasterConfigV1>;
  computePolicyRules(input: ComputePolicyRulesInputV1): Promise<ComputedPolicyRulesV1>;
  classify(input: ClassifyFilesInputV1): Promise<FileRoutingV1>;
  chunkAndRedact(input: ChunkAndRedactInputV1): Promise<ReadonlyArray<DiffChunkV1>>;
  staticAnalysis(input: StaticAnalysisInputV1): Promise<StaticAnalysisResultV1>;
  selectCarryForward(input: SelectCarryForwardInputV1): Promise<CarryForwardSelectionV1>;
  embedQuery(input: EmbedQueryInputV1): Promise<EmbedQueryResultV1>;
  retrieveKnowledge(input: RetrieveKnowledgeInputV1): Promise<RetrieveKnowledgeResultV1>;
  reviewChunk(input: ReviewContextV1): Promise<ReviewChunkResponseV1>;
  dedupFindings(input: DedupFindingsInputV1): Promise<DedupedFindingsV1>;
  aggregate(input: AggregateFindingsInputV1): Promise<AggregatedFindingsV1>;
  persistReviewFindings(input: PersistReviewFindingsInputV1): Promise<ReadonlyArray<string>>;
  generateWalkthrough(input: GenerateWalkthroughInputV1): Promise<WalkthroughV1>;
  persistReviewWalkthrough(input: PersistReviewWalkthroughInputV1): Promise<void>;
  postReview(input: PostReviewInputV1): Promise<PostedReviewV1>;
  postCheckRun(input: PostCheckRunInputV1): Promise<PostedCheckRunV1>;
  cleanup(input: ReleaseWorkspaceInput): Promise<void>;
  // ── Stage-3 ports (citation validation, output-safety audit emit, finding-delivery skip) ──
  // OPTIONAL: when omitted, the orchestrator SKIPS the corresponding step (the Python `is None` branch).
  //   * citationValidate     — Step 7.5 (drops findings citing missing repo_paths; fs syscalls → activity).
  //   * emitOutputSafetyAudit — dispatched when a chunk/walkthrough envelope carries a sanitization_event.
  //   * recordDeliverySkipped — the H-2 inline skip dispatch on the post-review dropped-state failure path.
  citationValidate?(input: CitationValidateInputV1): Promise<CitationValidationResultV1>;
  emitOutputSafetyAudit?(input: EmitOutputSafetyAuditEventInput): Promise<void>;
  recordDeliverySkipped?(input: SkippedInputV1): Promise<number>;
  // ── Stage-4 ports (provenance-backed evidence + PR-description summary) ──
  // OPTIONAL: when omitted, the orchestrator/posting falls back to the pre-Stage-4 behaviour (the Python
  // `is None` branch).
  //   * buildRetrievedEvidence     — per-chunk evidence-manifest producer (mints ev_ ids via node:crypto, so
  //     it MUST run in a Node activity — the workflow sandbox bans crypto, ADR-0065/0066). When omitted,
  //     buildChunkContext threads retrieved_evidence=[] (the Stage-1 default) and the parser's evidence-refs
  //     validation is a no-op. The orchestrator dispatches it per chunk in buildChunkContext.
  //   * updatePrDescriptionSummary — the S19.NOW8.B PR-description appendage (GET-modify-PATCH the PR body
  //     with the codemaster summary block). The Python runs it INSIDE `_post_review` after the review lands
  //     (fail-open per AC3 — the posted review is the value; the appendage is polish). posting.ts dispatches
  //     it after the post succeeds when wired. Returns void (the activity's persisted side effect is the
  //     PATCH).
  buildRetrievedEvidence?(input: BuildRetrievedEvidenceInputV1): Promise<ReadonlyArray<RetrievedEvidenceV1>>;
  updatePrDescriptionSummary?(input: UpdatePrDescriptionInputV1): Promise<void>;
  // ── Stage-5 ports (arbitration layer + fix-prompt) ──
  // OPTIONAL: when omitted, the orchestrator/posting SKIPS the corresponding step (the Python `is None`
  // branch). Stage-5 wires all three in the composition root.
  //   * applyArbitration  — Step 7.7 Tier-1/Tier-2 arbitration apply (after persist, gated on sa != null).
  //     Runs the pure arbitrate() core + persists decisions/rejections; returns the ArbitrationResultV1 the
  //     post-review footer renderer folds in.
  //   * recordToolRuns    — Step 7.7 per-tool review_tool_runs persistence (when sa.tool_statuses non-empty).
  //   * generateFixPrompt — the post-path fix-prompt dispatch (UNCONDITIONAL when aggregated.findings
  //     non-empty; fix-prompt-v1 collapse-on). Builds + persists + posts the advisory copy-pasteable prompt.
  applyArbitration?(input: ApplyArbitrationInputV1): Promise<ArbitrationResultV1>;
  recordToolRuns?(input: RecordToolRunsInputV1): Promise<void>;
  generateFixPrompt?(input: GenerateFixPromptInputV1): Promise<FixPromptActivityResultV1>;
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// RETRY_POLICIES — the EXACT per-activity Temporal ActivityOptions (timeout + retry curve) from the
// Python bridge closures. The shape matches @temporalio/workflow's ActivityOptions so Stage 1 can spread
// each directly into proxyActivities(). Field names use the SDK's camelCase
// (startToCloseTimeout / heartbeatTimeout / scheduleToCloseTimeout / retry.{initialInterval,
// maximumInterval, backoffCoefficient, maximumAttempts, nonRetryableErrorTypes}).
//
// We model the shape locally (RetryActivityOptions) rather than importing ActivityOptions from
// @temporalio/workflow — that import is only valid inside a workflow runtime context and Stage 0 must stay
// runtime-free. Stage 1 asserts assignability when it spreads these into proxyActivities().
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export type RetryActivityOptions = {
  startToCloseTimeout?: string;
  heartbeatTimeout?: string;
  scheduleToCloseTimeout?: string;
  retry?: {
    initialInterval?: string;
    maximumInterval?: string;
    backoffCoefficient?: number;
    maximumAttempts?: number;
    nonRetryableErrorTypes?: ReadonlyArray<string>;
  };
};

export const RETRY_POLICIES = {
  // clone_repo_into_workspace (review_pull_request.py:1084-1088): start_to_close 60s,
  // heartbeat_timeout 30s (_CLONE_HEARTBEAT_TIMEOUT, BF-11), retry initial_interval=2s, max_attempts=3.
  clone: {
    startToCloseTimeout: "60s",
    heartbeatTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // load_repo_config_activity (review_pull_request.py:1221-1234): start_to_close 10s,
  // retry initial_interval=2s, max_attempts=1 (fail-open by design — the stage_outcome wrapper handles
  // failure → review proceeds with default config). repo-config-wiring collapse-on stage.
  loadRepoConfig: {
    startToCloseTimeout: "10s",
    retry: { initialInterval: "2s", maximumAttempts: 1 },
  },

  // compute_policy_rules_activity (review_pull_request.py:1297-1324): start_to_close 5s
  // (_POLICY_COMPUTE_TIMEOUT, review_pull_request.py:89), retry initial_interval=2s, max_attempts=1
  // (A-3-parse-timeout — fail-open by design; retries against pathological inputs just burn budget).
  computePolicyRules: {
    startToCloseTimeout: "5s",
    retry: { initialInterval: "2s", maximumAttempts: 1 },
  },

  // classify_files (review_pull_request.py:1105-1108): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3.
  classify: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // chunk_and_redact_activity (review_pull_request.py:1126-1129): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3.
  chunkAndRedact: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // static_analysis_activity (review_pull_request.py:1445-1448): start_to_close 120s,
  // retry initial_interval=2s, max_attempts=2.
  staticAnalysis: {
    startToCloseTimeout: "120s",
    retry: { initialInterval: "2s", maximumAttempts: 2 },
  },

  // select_carry_forward (review_pull_request.py:1478-1481): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3.
  selectCarryForward: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // embed_query_activity (review_pull_request.py:1671-1683): start_to_close 15s,
  // retry initial_interval=2s, maximum_interval=15s, backoff_coefficient=2.0, max_attempts=3 (R-16).
  embedQuery: {
    startToCloseTimeout: "15s",
    retry: {
      initialInterval: "2s",
      maximumInterval: "15s",
      backoffCoefficient: 2.0,
      maximumAttempts: 3,
    },
  },

  // retrieve_knowledge_activity (review_pull_request.py:1777-1791): start_to_close 20s,
  // retry initial_interval=2s, maximum_interval=20s, backoff_coefficient=2.0, max_attempts=3 (R-16).
  retrieveKnowledge: {
    startToCloseTimeout: "20s",
    retry: {
      initialInterval: "2s",
      maximumInterval: "20s",
      backoffCoefficient: 2.0,
      maximumAttempts: 3,
    },
  },

  // bedrock_review_chunk (review_pull_request.py:1897-1917): start_to_close 90s,
  // retry initial_interval=5s, maximum_interval=60s, backoff_coefficient=2.0, max_attempts=4,
  // non_retryable=[BedrockBudgetExceededError, BedrockOutputUnsafeError, BedrockInvalidRequestError].
  reviewChunk: {
    startToCloseTimeout: "90s",
    retry: {
      initialInterval: "5s",
      maximumInterval: "60s",
      backoffCoefficient: 2.0,
      maximumAttempts: 4,
      nonRetryableErrorTypes: [
        "BedrockBudgetExceededError",
        "BedrockOutputUnsafeError",
        "BedrockInvalidRequestError",
      ],
    },
  },

  // aggregate_findings (review_pull_request.py:1974-1977): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3.
  aggregate: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // dedup_findings — NEW activity introduced DURING the port (the Temporal-activity port of the frozen
  // Python `dedup_linter_with_llm`, which ran INLINE in the orchestrator — not an @activity.defn — so it
  // has no Python dispatch-site retry policy to transcribe). The semantic stage embeds over the network
  // (the platform Qwen consumer) and is FAIL-OPEN by design (DedupedFindingsV1.semantic_skipped on
  // embedder outage), so it mirrors its sibling embed-bearing stage's budget: start_to_close 30s (same as
  // aggregate, the stage it sits beside), retry initial_interval=2s, max_attempts=3.
  dedupFindings: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // persist_review_findings_activity (review_pull_request.py:3056-3063): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3, non_retryable=[StaleWriteError] (the stale-write guard
  // violation is a terminal data-integrity error, never retried).
  persistReviewFindings: {
    startToCloseTimeout: "30s",
    retry: {
      initialInterval: "2s",
      maximumAttempts: 3,
      nonRetryableErrorTypes: ["StaleWriteError"],
    },
  },

  // persist_review_walkthrough_activity (review_pull_request.py:2421-2422): start_to_close 30s,
  // retry max_attempts=3 (NO explicit initial_interval — the Python omitted it, so the SDK default 1s
  // applies; we omit it here too rather than silently encode a different curve, per the module header).
  persistReviewWalkthrough: {
    startToCloseTimeout: "30s",
    retry: { maximumAttempts: 3 },
  },

  // generate_walkthrough (review_pull_request.py:2227-2228): start_to_close 60s,
  // WALKTHROUGH_RETRY_POLICY (review_pull_request.py:95-103): initial_interval=5s, max_attempts=2,
  // non_retryable=[LlmAuthError, LlmRoleNotConfiguredError, LlmRoleDisabledError].
  generateWalkthrough: {
    startToCloseTimeout: "60s",
    retry: {
      initialInterval: "5s",
      maximumAttempts: 2,
      nonRetryableErrorTypes: [
        "LlmAuthError",
        "LlmRoleNotConfiguredError",
        "LlmRoleDisabledError",
      ],
    },
  },

  // post_review_results (review_pull_request.py:2442-2451): start_to_close 60s,
  // retry initial_interval=2s, max_attempts=3,
  // non_retryable=[PrClosedError, PostReviewPermissionError, StaleWriteError].
  postReview: {
    startToCloseTimeout: "60s",
    retry: {
      initialInterval: "2s",
      maximumAttempts: 3,
      nonRetryableErrorTypes: ["PrClosedError", "PostReviewPermissionError", "StaleWriteError"],
    },
  },

  // post_check_run (review_pull_request.py:2865-2868): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3.
  postCheckRun: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // release_workspace_activity (review_pull_request.py:3253-3256): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=2.
  cleanup: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 2 },
  },

  // allocate_workspace_activity (review_pull_request.py:1049-1050): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3. (Not a ReviewActivityPorts method yet — the workspace
  // lifecycle wraps the orchestrator in Stage 2 — but its policy is load-bearing, so it is transcribed
  // here now alongside its spine siblings.)
  allocateWorkspace: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // emit_output_safety_audit_event_activity (review_pull_request.py:1505-1510): schedule_to_close 2min,
  // retry initial_interval=1s, maximum_interval=30s, max_attempts=5. (Idempotent audit emit; independent
  // retry budget so a failed audit-emit never re-triggers the upstream LLM call. Stage 3 surface — policy
  // transcribed now.)
  emitOutputSafetyAudit: {
    scheduleToCloseTimeout: "2 minutes",
    retry: { initialInterval: "1s", maximumInterval: "30s", maximumAttempts: 5 },
  },

  // citation_validate_activity (review_pull_request.py:2055-2059): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3. The validator's fs syscalls run in the activity (sandbox
  // forbids them in the workflow body); Step 7.5 of the orchestrator dispatches it between aggregate +
  // persist.
  citationValidate: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // record_delivery_skipped_activity (review_pull_request.py:3768-3774 lifecycle bookkeeping + the H-2
  // inline post-failure dispatch at ~2561): start_to_close 30s, retry initial_interval=1s,
  // backoff_coefficient=2.0, max_attempts=3. Shared by the orchestrator's H-2 dropped-state path AND the
  // workflow body's lifecycle-bookkeeping block (both dispatch the same registered activity).
  recordDeliverySkipped: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "1s", backoffCoefficient: 2.0, maximumAttempts: 3 },
  },

  // record_delivery_finalized_activity (review_pull_request.py:3686-3693): start_to_close 30s,
  // retry initial_interval=1s, backoff_coefficient=2.0, max_attempts=3. (Lifecycle bookkeeping setter.)
  recordDeliveryFinalized: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "1s", backoffCoefficient: 2.0, maximumAttempts: 3 },
  },

  // record_delivery_degraded_activity (review_pull_request.py:3811-3818): start_to_close 30s,
  // retry initial_interval=1s, backoff_coefficient=2.0, max_attempts=3. (Lifecycle bookkeeping setter.)
  recordDeliveryDegraded: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "1s", backoffCoefficient: 2.0, maximumAttempts: 3 },
  },

  // build_retrieved_evidence — NEW activity introduced DURING the port. The frozen Python calls
  // `build_retrieved_evidence` INLINE in the workflow body (review_pull_request.py:1813) — Python's
  // `mint_evidence_id` is pure stdlib hashlib/uuid, permitted in the Python sandbox. The TS `mintEvidenceId`
  // mints via node:crypto (RESTRICTED in the V8-isolate workflow sandbox; ADR-0065/0066), so the producer
  // MUST move to a Node activity — there is therefore no Python dispatch-site retry policy to transcribe.
  // The producer is pure modulo the crypto hash (no DB / network / GitHub), so it gets a tight curve sized
  // like its sibling pure activities: start_to_close 15s, retry initial_interval=2s, max_attempts=3.
  // Idempotent by construction (deterministic UUIDv5 ev_ids), so a retry recomputes bit-identical output.
  buildRetrievedEvidence: {
    startToCloseTimeout: "15s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // update_pr_description_summary (review_pull_request.py:2740-2744): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=2. Runs INSIDE the post path AFTER the review lands; the
  // posting.ts stage_outcome wrap is fail-open (AC3 — the posted review is the value; the description
  // appendage is polish), so a failure here never fails the workflow.
  updatePrDescriptionSummary: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 2 },
  },

  // record_review_lifecycle_event_activity (review_pull_request.py:678-682 ANALYSIS_STARTED; :3987-3994
  // ANALYZED): start_to_close 30s, retry initial_interval=2s, max_attempts=3, non_retryable=[ValueError]
  // (the allow-list reject is a permanent caller bug, never retried).
  recordReviewLifecycleEvent: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3, nonRetryableErrorTypes: ["ValueError"] },
  },

  // finalize_review_run_activity (review_pull_request.py:4009-4017): start_to_close 30s,
  // retry initial_interval=2s, max_attempts=3, non_retryable=[StateDrift, ValueError] (a drifted run is a
  // permanent terminal state, not a transient failure).
  finalizeReviewRun: {
    startToCloseTimeout: "30s",
    retry: {
      initialInterval: "2s",
      maximumAttempts: 3,
      nonRetryableErrorTypes: ["StateDrift", "ValueError"],
    },
  },

  // record_run_failed_activity (review_pull_request.py:4131-4140) + record_run_cancelled_activity
  // (review_pull_request.py:4067-4076): start_to_close 30s, retry initial_interval=2s, max_attempts=3,
  // non_retryable=[StateDrift, ValueError]. Both BF-5/BF-13 terminal-transition setters share the curve.
  recordRunTerminal: {
    startToCloseTimeout: "30s",
    retry: {
      initialInterval: "2s",
      maximumAttempts: 3,
      nonRetryableErrorTypes: ["StateDrift", "ValueError"],
    },
  },

  // ── Stage-5 (arbitration layer + fix-prompt) ──

  // apply_arbitration_activity (review_pull_request.py:3133-3138): start_to_close 30s, retry
  // initial_interval=2s, max_attempts=3, non_retryable=[StaleWriteError] (a stale-write guard violation is a
  // terminal data-integrity error, never retried). Step 7.7 — dispatched after persist when sa != null.
  applyArbitration: {
    startToCloseTimeout: "30s",
    retry: {
      initialInterval: "2s",
      maximumAttempts: 3,
      nonRetryableErrorTypes: ["StaleWriteError"],
    },
  },

  // record_tool_runs_activity (review_pull_request.py:3200-3204): start_to_close 30s, retry
  // initial_interval=2s, max_attempts=3. Step 7.7 — dispatched after persist when sa.tool_statuses non-empty.
  recordToolRuns: {
    startToCloseTimeout: "30s",
    retry: { initialInterval: "2s", maximumAttempts: 3 },
  },

  // generate_fix_prompt_activity (review_pull_request.py:2789-2790): start_to_close 60s, retry
  // max_attempts=3 (NO explicit initial_interval — the Python omitted it, so the SDK default 1s applies; we
  // omit it here too rather than silently encode a different curve, per the module header). Post-path
  // fix-prompt dispatch (UNCONDITIONAL when aggregated.findings non-empty; fix-prompt-v1 collapse-on).
  generateFixPrompt: {
    startToCloseTimeout: "60s",
    retry: { maximumAttempts: 3 },
  },
} as const satisfies Record<string, RetryActivityOptions>;
