// Unit-test matrix for orchestrate() — the deterministic review-pipeline driver
// (apps/backend/src/review/pipeline/orchestrator.ts), the 1:1 port of the frozen Python
// orchestrate_review_pipeline (review_pipeline_orchestrator.py) FUSED with the per-chunk ReviewContextV1
// build the workflow body's `_review_chunk` closure performed.
//
// What this asserts (the deterministic orchestration logic, with STUB activity ports):
//   * STAGE ORDER — the exact dispatch sequence matches the Python stage order
//     (clone → load_repo_config → compute_policy_rules → classify → [chunkAndRedact || staticAnalysis] →
//      selectCarryForward → fanOut(embedQuery/retrieveKnowledge/reviewChunk per chunk) → dedupFindings →
//      aggregate → persistReviewFindings → generateWalkthrough → persistReviewWalkthrough →
//      [postReview || postCheckRun] → cleanup).
//   * CLASSIFIER-FAILURE-RATIO degradation note when > 10% of files fail classification.
//   * PATH-FILTERS-EXCLUDED-ALL early exit — advisory review posted, chunk/fan-out skipped.
//   * CARRY-FORWARD fail-open — selector raises → "review every chunk" fallback + degradation note.
//   * DEDUP semantic-skip surfaced as a degradation note.
//   * PERSIST fail-open — persist raises → swallowed, chain continues, degradation note appended.
//   * RETRIEVAL fail-open — embed_query / retrieve_knowledge raise → retrieval_degraded threaded into the
//     per-chunk ReviewContextV1; query-vector cached per unique chunk PATH (one embed per path).
//   * PR-TOPOLOGY MANIFEST + POLICY BUNDLE attached to each per-chunk ReviewContextV1 (collapse-on).
//   * CLEANUP runs in the finally even when a mid-pipeline stage throws.
import { describe, it, expect } from "vitest";

import { orchestrate, type ReviewPipelineContext } from "#backend/review/pipeline/orchestrator.js";
// FIX #6+#9 — the orchestrator no longer ships its own "minimal glob" filterReviewPaths; it delegates to the
// ONE ported gitignore matcher (apps/backend/src/config/path_match.ts), whose byte-parity against the frozen
// Python is proven in test/parity/path_match.parity.test.ts. The describe block below re-imports the matcher
// from its canonical home to assert the orchestrator's path-filters narrowing still uses the real engine.
import { filterReviewPaths, matchPathInstructions } from "#backend/config/path_match.js";
import { ReviewWorkflowState } from "#backend/review/pipeline/state.js";
import { PER_FILE_CAP, PER_REVIEW_CAP } from "#backend/review/aggregation.js";

import type { ReviewActivityPorts, ChangedLineRanges } from "#backend/review/pipeline/activity_ports.js";
import type { ReviewContextV1 } from "#contracts/review_context.v1.js";
import { PrMetaV1 } from "#contracts/walkthrough.v1.js";
import { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";
import { ClonedRepoV1 } from "#contracts/cloned_repo.v1.js";
import { CodemasterConfigV1, PathInstructionV1 } from "#contracts/codemaster_config.v1.js";
import { ComputedPolicyRulesV1 } from "#contracts/policy_compute.v1.js";
import { FileRoutingV1 } from "#contracts/file_routing.v1.js";
import { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";
import { CarryForwardSelectionV1 } from "#contracts/carry_forward.v1.js";
import { EmbedQueryResultV1 } from "#contracts/embed_query.v1.js";
import { RetrieveKnowledgeResultV1 } from "#contracts/retrieve_knowledge.v1.js";
import {
  ReviewChunkResponseV1,
  OutputSafetySanitizationEventV1,
} from "#contracts/review_chunk_response.v1.js";
import { DedupedFindingsV1 } from "#contracts/dedup_findings.v1.js";
import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import { PostedReviewV1, PublicationOutcome } from "#contracts/posted_review.v1.js";
import { PostedCheckRunV1 } from "#contracts/posted_check_run.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";
import { CitationValidationResultV1 } from "#contracts/citation_validation.v1.js";
import type { CitationValidateInputV1 } from "#contracts/citation_validate_input.v1.js";
import type { EmitOutputSafetyAuditEventInput } from "#contracts/emit_output_safety_audit.v1.js";
import { RetrievedEvidenceV1 } from "#contracts/retrieved_evidence.v1.js";
import type { BuildRetrievedEvidenceInputV1 } from "#contracts/build_retrieved_evidence_input.v1.js";
import type { UpdatePrDescriptionInputV1 } from "#contracts/update_pr_description.v1.js";
import type { GenerateWalkthroughInputV1 } from "#contracts/generate_walkthrough_input.v1.js";
import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { ToolStatusV1 } from "#contracts/tool_status.v1.js";
import type { ArbitrationResultV1 } from "#contracts/arbitration_result.v1.js";
import type { ApplyArbitrationInputV1 } from "#contracts/apply_arbitration_input.v1.js";
import type { RecordToolRunsInputV1 } from "#contracts/record_tool_runs_input.v1.js";
import type { GenerateFixPromptInputV1 } from "#contracts/generate_fix_prompt.v1.js";
import type { FixPromptActivityResultV1 } from "#contracts/fix_prompt_activity_result.v1.js";
import { LinkedIssueV1 } from "#contracts/walkthrough.v1.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures — built through the Zod schemas so contract defaults / validators apply.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

function uuidFor(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

const PR_META: PrMetaV1 = PrMetaV1.parse({
  pr_id: uuidFor(1),
  installation_id: uuidFor(2),
  repo: "acme/widgets",
  pr_title: "Add widget",
  pr_description: "A widget.",
});

const HANDLE: WorkspaceHandle = WorkspaceHandle.parse({
  workspace_id: uuidFor(3),
  installation_id: uuidFor(2),
  run_id: uuidFor(4),
  derived_path: "/ws/abc",
  state: "ALLOCATED",
});

const CHANGED_LINE_RANGES: ChangedLineRanges = { "src/a.ts": [[1, 10]], "src/b.ts": [[1, 5]] };

function chunkFor(path: string, idx: number): DiffChunkV1 {
  return DiffChunkV1.parse({
    chunk_id: uuidFor(100 + idx),
    path,
    start_line: 1,
    end_line: 10,
    body: `// ${path}`,
    chunk_kind: "hunk",
    token_estimate: 5,
  });
}

function findingFor(idx: number): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: `src/file_${idx}.ts`,
    start_line: 1,
    end_line: 1,
    severity: "issue",
    category: "bug",
    title: `finding-${idx}`,
    body: `body ${idx}`,
    confidence: 0.9,
  });
}

/** A SECURITY finding at severity 'nit' — below the SI-001 safety floor ('issue'), so the Step-7.2 policy
 *  post-filter floors it to 'issue' (drives the invariant-fired path). */
function securityNitFinding(idx: number): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: `src/sec_${idx}.ts`,
    start_line: 1,
    end_line: 1,
    severity: "nit",
    category: "security",
    title: `sec-finding-${idx}`,
    body: `sec body ${idx}`,
    confidence: 0.9,
  });
}

/** A non-empty ResolvedGuidanceBundleV1 (empty applicable_rules is fine — the post-filter fires on the
 *  presence of ANY bundle, since SYSTEM_INVARIANTS run regardless of the rule set). The bundle keyed by a
 *  changed path makes state.policyBundles non-empty so applyPolicyPostFilter runs. */
function emptyBundle(changedPath: string): ResolvedGuidanceBundleV1 {
  return ResolvedGuidanceBundleV1.parse({ changed_path: changedPath });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Recording stub ports — every call appends its name to `calls` (in dispatch order) and returns a valid
// contract response. Per-call overrides let a test inject failures / branch inputs. Each method records
// AND captures its input so tests can assert the per-chunk context build.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type StubOverrides = {
  reviewFiles?: ReadonlyArray<string>;
  sandboxFiles?: ReadonlyArray<string>;
  classifierFailures?: ReadonlyArray<string>;
  pathFilters?: ReadonlyArray<string>;
  /** FIX #6+#9 — the repo_config.path_instructions the loadRepoConfig stub returns (drives the per-chunk
   *  matched_path_instructions wiring). Default [] (no per-glob instructions). */
  pathInstructions?: ReadonlyArray<PathInstructionV1>;
  bundles?: Record<string, ResolvedGuidanceBundleV1>;
  /** FIX #12 — when true, computePolicyRules THROWS (asserts the policy-compute fail-open wrap). */
  computePolicyThrows?: boolean;
  /** FIX #7 — when true, postCheckRun THROWS (asserts the placeholder teardown is decoupled from it). */
  postCheckRunThrows?: boolean;
  /** FIX #7 — when true, postReview (postReviewResults) THROWS (asserts the placeholder is NOT torn down). */
  postReviewThrows?: boolean;
  selectCarryForwardThrows?: boolean;
  embedThrows?: boolean;
  retrieveThrows?: boolean;
  retrieveDegraded?: boolean;
  /** When set, retrieveKnowledge returns these items (each a KnowledgeChunkV1 wire dict). Drives the
   *  state.retrievedKnowledgeChunkIds accumulation → the allowed knowledge_chunk_ids set on citationValidate. */
  retrievedKnowledgeItems?: ReadonlyArray<Record<string, unknown>>;
  persistThrows?: boolean;
  dedupSemanticSkipped?: boolean;
  reviewChunkThrows?: boolean;
  chunkCount?: number;
  // ── Stage-3 wiring overrides ──
  /** When set, the citationValidate port is injected and drops this many findings (the rest survive). */
  withCitationValidate?: boolean;
  citationDropCount?: number;
  /** When set, the emitOutputSafetyAudit port is injected (the orchestrator dispatches it on events). */
  withAuditEmit?: boolean;
  /** When true, reviewChunk attaches a sanitization_event to its envelope. */
  chunkSanitizationEvent?: boolean;
  /** When true, generateWalkthrough attaches a sanitization_event to its envelope. */
  walkthroughSanitizationEvent?: boolean;
  // ── Stage-4 wiring overrides ──
  /** When set, the buildRetrievedEvidence port is injected (the orchestrator dispatches it per chunk to
   *  populate ReviewContextV1.retrieved_evidence). */
  withBuildEvidence?: boolean;
  /** When set, the updatePrDescriptionSummary port is injected (posting.ts dispatches it after the post). */
  withUpdatePrDescription?: boolean;
  /** When true, the injected updatePrDescriptionSummary port THROWS (asserts the posting fail-open wrap). */
  updatePrDescriptionThrows?: boolean;
  // ── Stage-5 wiring overrides ──
  /** When true, staticAnalysis returns these Tier-1 findings (threaded into apply_arbitration's tier1). */
  tier1Findings?: ReadonlyArray<AnalysisFindingV1>;
  /** When true, staticAnalysis returns these tool statuses (drives record_tool_runs + the footer). */
  toolStatuses?: ReadonlyArray<ToolStatusV1>;
  /** When set, the applyArbitration port is injected (orchestrator Step 7.7). */
  withApplyArbitration?: boolean;
  /** The ArbitrationResultV1 the injected applyArbitration port returns (default empty result). */
  arbitrationResult?: ArbitrationResultV1;
  /** When true, the injected applyArbitration port THROWS (asserts the Step-7.7 fail-open swallow). */
  applyArbitrationThrows?: boolean;
  /** When set, the recordToolRuns port is injected (orchestrator Step 7.7, fires on non-empty tool_statuses). */
  withRecordToolRuns?: boolean;
  /** When set, the generateFixPrompt port is injected (posting.ts, fires on non-empty findings). */
  withGenerateFixPrompt?: boolean;
  /** The FixPromptActivityResultV1 the injected generateFixPrompt port returns (default generated/llm). */
  fixPromptResult?: { generated: boolean; generation_mode: string; comment_posted: boolean };
  /** When true, the injected generateFixPrompt port THROWS (asserts the posting fail-open swallow). */
  generateFixPromptThrows?: boolean;
  /** When true, reviewChunk emits a SECURITY finding at severity 'nit' (drives the SI-001 severity floor). */
  securityNitFinding?: boolean;
};

type RecordingStub = {
  ports: ReviewActivityPorts;
  calls: Array<string>;
  reviewChunkInputs: Array<ReviewContextV1>;
  embedCalls: Array<string>;
  citationInputs: Array<CitationValidateInputV1>;
  auditEvents: Array<EmitOutputSafetyAuditEventInput>;
  buildEvidenceInputs: Array<BuildRetrievedEvidenceInputV1>;
  updatePrDescriptionInputs: Array<UpdatePrDescriptionInputV1>;
  walkthroughInputs: Array<GenerateWalkthroughInputV1>;
  applyArbitrationInputs: Array<ApplyArbitrationInputV1>;
  recordToolRunsInputs: Array<RecordToolRunsInputV1>;
  generateFixPromptInputs: Array<GenerateFixPromptInputV1>;
  cleanupCalled: () => boolean;
};

/** A valid OutputSafetySanitizationEventV1 for the given stage (chunk / walkthrough). */
function sanitizationEventFor(stage: string): OutputSafetySanitizationEventV1 {
  return OutputSafetySanitizationEventV1.parse({
    installation_id: uuidFor(2),
    request_id: uuidFor(700),
    original_text: "secret token AKIA1234",
    redacted_text: "secret token [REDACTED]",
    spans_redacted: 1,
    detector_kinds: ["aws_key"],
    stage,
  });
}

function makeStub(o: StubOverrides = {}): RecordingStub {
  const calls: Array<string> = [];
  const reviewChunkInputs: Array<ReviewContextV1> = [];
  const embedCalls: Array<string> = [];
  const citationInputs: Array<CitationValidateInputV1> = [];
  const auditEvents: Array<EmitOutputSafetyAuditEventInput> = [];
  const buildEvidenceInputs: Array<BuildRetrievedEvidenceInputV1> = [];
  const updatePrDescriptionInputs: Array<UpdatePrDescriptionInputV1> = [];
  const walkthroughInputs: Array<GenerateWalkthroughInputV1> = [];
  const applyArbitrationInputs: Array<ApplyArbitrationInputV1> = [];
  const recordToolRunsInputs: Array<RecordToolRunsInputV1> = [];
  const generateFixPromptInputs: Array<GenerateFixPromptInputV1> = [];
  let cleanupCalled = false;

  const reviewFiles = o.reviewFiles ?? ["src/a.ts", "src/b.ts"];
  const sandboxFiles = o.sandboxFiles ?? ["src/a.ts"];
  const chunkCount = o.chunkCount ?? 2;
  const chunks: Array<DiffChunkV1> = Array.from({ length: chunkCount }, (_v, i) =>
    chunkFor(reviewFiles[i % Math.max(1, reviewFiles.length)] ?? "src/a.ts", i),
  );

  const ports: ReviewActivityPorts = {
    clone: async () => {
      calls.push("clone");
      return ClonedRepoV1.parse({
        workspace_path: "/ws/abc",
        repo_path: "/ws/abc/repo",
        head_sha: "abc1234",
        byte_size: 10,
      });
    },
    loadRepoConfig: async () => {
      calls.push("loadRepoConfig");
      return CodemasterConfigV1.parse({
        path_filters: o.pathFilters ?? [],
        path_instructions: o.pathInstructions ?? [],
      });
    },
    computePolicyRules: async () => {
      calls.push("computePolicyRules");
      if (o.computePolicyThrows) {
        throw new Error("policy-compute boom");
      }
      return ComputedPolicyRulesV1.parse({ bundles: o.bundles ?? {} });
    },
    classify: async () => {
      calls.push("classify");
      return FileRoutingV1.parse({
        review_files: [...reviewFiles],
        sandbox_files: [...sandboxFiles],
        skip_files: [],
        classifier_failures: [...(o.classifierFailures ?? [])],
      });
    },
    chunkAndRedact: async () => {
      calls.push("chunkAndRedact");
      return chunks;
    },
    staticAnalysis: async () => {
      calls.push("staticAnalysis");
      return StaticAnalysisResultV1.parse({
        tier1_findings: [...(o.tier1Findings ?? [])],
        tool_statuses: [...(o.toolStatuses ?? [])],
      });
    },
    selectCarryForward: async (input) => {
      calls.push("selectCarryForward");
      if (o.selectCarryForwardThrows) {
        throw new Error("carry-forward boom");
      }
      return CarryForwardSelectionV1.parse({
        carried: [],
        to_review: [...input.current_chunks],
        parent_review_id: input.parent_review_id,
      });
    },
    embedQuery: async (input) => {
      calls.push("embedQuery");
      embedCalls.push(input.query);
      if (o.embedThrows) {
        throw new Error("embed boom");
      }
      return EmbedQueryResultV1.parse({ vector: [0.1, 0.2, 0.3] });
    },
    retrieveKnowledge: async () => {
      calls.push("retrieveKnowledge");
      if (o.retrieveThrows) {
        throw new Error("retrieve boom");
      }
      return RetrieveKnowledgeResultV1.parse({
        items: o.retrievedKnowledgeItems ?? [],
        retrieval_degraded: o.retrieveDegraded ?? false,
        degradation_reason: o.retrieveDegraded ? "qwen timeout" : "",
      });
    },
    reviewChunk: async (input) => {
      calls.push("reviewChunk");
      reviewChunkInputs.push(input);
      if (o.reviewChunkThrows) {
        throw new Error("review-chunk boom");
      }
      return ReviewChunkResponseV1.parse({
        findings: [o.securityNitFinding ? securityNitFinding(1) : findingFor(1)],
        arbitration_intents: [],
        sanitization_event: o.chunkSanitizationEvent ? sanitizationEventFor("chunk") : null,
      });
    },
    dedupFindings: async (input) => {
      calls.push("dedupFindings");
      return DedupedFindingsV1.parse({
        findings: [...input.llm_findings],
        semantic_skipped: o.dedupSemanticSkipped ?? false,
      });
    },
    aggregate: async (input) => {
      calls.push("aggregate");
      return AggregatedFindingsV1.parse({
        findings: [...input.findings],
        dedupe_stats: {
          input_count: input.findings.length,
          exact_dropped: 0,
          semantic_merged: 0,
          capped: 0,
        },
        policy_revision: input.policy_revision,
      });
    },
    persistReviewFindings: async (input) => {
      calls.push("persistReviewFindings");
      if (o.persistThrows) {
        throw new Error("persist boom");
      }
      return input.aggregated.findings.map((_f, i) => uuidFor(500 + i));
    },
    generateWalkthrough: async (input) => {
      calls.push("generateWalkthrough");
      walkthroughInputs.push(input);
      return WalkthroughV1.parse({
        tldr: "all good",
        sanitization_event: o.walkthroughSanitizationEvent
          ? sanitizationEventFor("walkthrough")
          : null,
      });
    },
    persistReviewWalkthrough: async () => {
      calls.push("persistReviewWalkthrough");
    },
    postReview: async () => {
      calls.push("postReview");
      if (o.postReviewThrows) {
        throw new Error("post-review boom");
      }
      return PostedReviewV1.parse({
        review_id: 7,
        inline_comment_count: 0,
        publication_outcome: PublicationOutcome.enum.inline_posted,
        comment_ids: [],
        kept_finding_indices: [],
      });
    },
    postCheckRun: async () => {
      calls.push("postCheckRun");
      if (o.postCheckRunThrows) {
        throw new Error("post-check-run boom");
      }
      return PostedCheckRunV1.parse({ check_run_id: 9, was_update: false });
    },
    cleanup: async () => {
      calls.push("cleanup");
      cleanupCalled = true;
    },
  };

  // ── Stage-3 optional ports (only attached when the override requests them) ──
  if (o.withCitationValidate) {
    const dropCount = o.citationDropCount ?? 0;
    ports.citationValidate = async (input: CitationValidateInputV1) => {
      calls.push("citationValidate");
      citationInputs.push(input);
      const all = [...input.findings];
      const dropped = all.slice(0, dropCount);
      const surviving = all.slice(dropCount);
      return CitationValidationResultV1.parse({
        surviving,
        dropped: dropped.map((f) => ({ finding: f, reason: "repo_path not found" })),
      });
    };
  }
  if (o.withAuditEmit) {
    ports.emitOutputSafetyAudit = async (input: EmitOutputSafetyAuditEventInput) => {
      calls.push("emitAudit");
      auditEvents.push(input);
    };
  }
  if (o.withBuildEvidence) {
    ports.buildRetrievedEvidence = async (input: BuildRetrievedEvidenceInputV1) => {
      calls.push("buildRetrievedEvidence");
      buildEvidenceInputs.push(input);
      // Return one deterministic evidence entry per chunk (the chunk_body entry the producer always emits).
      // The ev_id is a synthetic but valid `^ev_[0-9a-f]{16}$` string so the ReviewContextV1 carrying it
      // parses; the orchestrator threads whatever the port returns.
      return [
        RetrievedEvidenceV1.parse({
          evidence_id: "ev_" + "a".repeat(16),
          source_type: "chunk_body",
          chunk_id: input.chunk.chunk_id,
          path: input.chunk.path,
          excerpt: input.chunk.body,
        }),
      ];
    };
  }
  if (o.withUpdatePrDescription) {
    ports.updatePrDescriptionSummary = async (input: UpdatePrDescriptionInputV1) => {
      calls.push("updatePrDescription");
      updatePrDescriptionInputs.push(input);
      if (o.updatePrDescriptionThrows) {
        throw new Error("update-pr-description boom");
      }
    };
  }
  // ── Stage-5 optional ports ──
  if (o.withApplyArbitration) {
    ports.applyArbitration = async (input: ApplyArbitrationInputV1) => {
      calls.push("applyArbitration");
      applyArbitrationInputs.push(input);
      if (o.applyArbitrationThrows) {
        throw new Error("apply-arbitration boom");
      }
      return o.arbitrationResult ?? { decisions: [], rejected_intents: [] };
    };
  }
  if (o.withRecordToolRuns) {
    ports.recordToolRuns = async (input: RecordToolRunsInputV1) => {
      calls.push("recordToolRuns");
      recordToolRunsInputs.push(input);
    };
  }
  if (o.withGenerateFixPrompt) {
    ports.generateFixPrompt = async (input: GenerateFixPromptInputV1) => {
      calls.push("generateFixPrompt");
      generateFixPromptInputs.push(input);
      if (o.generateFixPromptThrows) {
        throw new Error("generate-fix-prompt boom");
      }
      return (o.fixPromptResult ?? {
        generated: true,
        generation_mode: "llm",
        comment_posted: true,
      }) as FixPromptActivityResultV1;
    };
  }

  return {
    ports,
    calls,
    reviewChunkInputs,
    embedCalls,
    citationInputs,
    auditEvents,
    buildEvidenceInputs,
    updatePrDescriptionInputs,
    walkthroughInputs,
    applyArbitrationInputs,
    recordToolRunsInputs,
    generateFixPromptInputs,
    cleanupCalled: () => cleanupCalled,
  };
}

function makeCtx(
  stub: RecordingStub,
  logger?: { warning(msg: string): void },
  walkthroughThreading?: {
    linkedIssues?: ReadonlyArray<LinkedIssueV1>;
    suggestedReviewers?: ReadonlyArray<string>;
  },
): ReviewPipelineContext {
  const base: ReviewPipelineContext = {
    repo: {
      repoUrl: "https://example.com/acme/widgets.git",
      changedPaths: ["src/a.ts", "src/b.ts"],
      workspaceHandle: HANDLE,
    },
    pr: {
      prMeta: PR_META,
      githubInstallationId: 4815162342,
      // 40-char git SHA — the confluence-context build (pickPrContext → PRContext.parse) validates
      // head_sha min_length=40/max_length=40 (Sub-spec B T17), so the per-chunk PRContext requires a
      // real-shaped SHA. Production always supplies one (typed_payload.head_sha).
      headSha: "abcdef0123456789abcdef0123456789abcdef01",
      runId: uuidFor(4),
      reviewId: uuidFor(5),
      repositoryId: uuidFor(6),
      policyRevision: 3,
      prNumber: 42,
      changedLineRanges: CHANGED_LINE_RANGES,
      parentFindings: [],
      parentReviewId: null,
    },
    activities: stub.ports,
    limits: { chunkConcurrency: 4 },
    state: new ReviewWorkflowState(),
  };
  let ctx: ReviewPipelineContext = logger === undefined ? base : { ...base, logger };
  if (walkthroughThreading?.linkedIssues !== undefined) {
    ctx = { ...ctx, linkedIssues: walkthroughThreading.linkedIssues };
  }
  if (walkthroughThreading?.suggestedReviewers !== undefined) {
    ctx = { ...ctx, suggestedReviewers: walkthroughThreading.suggestedReviewers };
  }
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("orchestrate — happy-path stage order", () => {
  it("dispatches the spine activities in the Python stage order", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const result = await orchestrate(makeCtx(stub));

    expect(result.status).toBe("accepted");
    expect(result.headSha).toBe("abcdef0123456789abcdef0123456789abcdef01");
    // findingsCount = 1 finding flows through dedup → aggregate.
    expect(result.findingsCount).toBe(1);

    // The exact dispatch order. The two parallel pairs (chunkAndRedact||staticAnalysis and
    // postReview||postCheckRun) are asserted as a set-membership at their position because Promise.all does
    // not fix intra-pair ordering; everything else is strictly sequential.
    expect(stub.calls).toEqual([
      "clone",
      "loadRepoConfig",
      "computePolicyRules",
      "classify",
      // parallel pair:
      "chunkAndRedact",
      "staticAnalysis",
      "selectCarryForward",
      // per-chunk fan-out (1 chunk): embed → retrieve → reviewChunk
      "embedQuery",
      "retrieveKnowledge",
      "reviewChunk",
      "dedupFindings",
      "aggregate",
      "persistReviewFindings",
      "generateWalkthrough",
      "persistReviewWalkthrough",
      // parallel pair:
      "postReview",
      "postCheckRun",
      "cleanup",
    ]);
  });

  it("returns the persisted finding ids + empty arbitration on the happy path", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const result = await orchestrate(makeCtx(stub));
    expect(result.reviewFindingIds).toEqual([uuidFor(500)]);
    expect(result.arbitrationIntents).toEqual([]);
    expect(result.arbitrationResult).toBeNull();
    expect(result.degradationNotes).toEqual([]);
  });
});

describe("orchestrate — per-chunk context build", () => {
  it("caches the query embedding per unique chunk PATH (one embed per path) under sequential fan-out", async () => {
    // 3 chunks across 2 unique paths (a, b, a). The state.queryVectorCache dedups embeds across chunks of
    // the SAME path that run AFTER an earlier same-path chunk filled the cache. With concurrency=1 the
    // fan-out is strictly sequential, so chunk #3 (path a) sees chunk #1's cached vector → 2 embeds, not 3.
    // (Under full parallelism the cache is best-effort, exactly as the Python anyio fan-out — the check+set
    // is not atomic across concurrent tasks; the cache is an RPC reducer, not a hard dedup guarantee.)
    const stub = makeStub({ reviewFiles: ["src/a.ts", "src/b.ts"], chunkCount: 3 });
    const ctx = makeCtx(stub);
    const seqCtx: ReviewPipelineContext = { ...ctx, limits: { chunkConcurrency: 1 } };
    await orchestrate(seqCtx);
    // chunk paths cycle a, b, a → unique paths {a, b} → 2 embeds (the third reuses the cached 'a' vector).
    expect(stub.embedCalls.length).toBe(2);
    const uniqueQueries = new Set(stub.embedCalls);
    expect(uniqueQueries.size).toBe(2);
  });

  it("attaches the per-path policy bundle + pr-topology manifest to each ReviewContextV1", async () => {
    const bundle = ResolvedGuidanceBundleV1.parse({ changed_path: "src/a.ts" });
    const stub = makeStub({
      reviewFiles: ["src/a.ts"],
      chunkCount: 1,
      bundles: { "src/a.ts": bundle },
    });
    await orchestrate(makeCtx(stub));
    const ctxBuilt = stub.reviewChunkInputs[0]!;
    expect(ctxBuilt.applicable_policy?.changed_path).toBe("src/a.ts");
    // pr-topology manifest carries the one to-review chunk.
    expect(ctxBuilt.pr_topology_manifest.length).toBe(1);
    expect(ctxBuilt.pr_topology_manifest[0]!.path).toBe("src/a.ts");
    expect(ctxBuilt.retrieval_degraded).toBe(false);
    expect(ctxBuilt.policy_revision).toBe(3);
  });

  it("threads retrieval_degraded + reason into the context on retrieve degradation", async () => {
    const stub = makeStub({ chunkCount: 1, retrieveDegraded: true });
    await orchestrate(makeCtx(stub));
    const ctxBuilt = stub.reviewChunkInputs[0]!;
    expect(ctxBuilt.retrieval_degraded).toBe(true);
    expect(ctxBuilt.retrieval_degradation_reason).toBe("qwen timeout");
  });

  it("fails open on retrieve_knowledge raising → retrieval_degraded=true, chain continues", async () => {
    const stub = makeStub({ chunkCount: 1, retrieveThrows: true });
    const result = await orchestrate(makeCtx(stub));
    expect(result.status).toBe("accepted");
    const ctxBuilt = stub.reviewChunkInputs[0]!;
    expect(ctxBuilt.retrieval_degraded).toBe(true);
  });

  it("fails open on embed_query raising → no override cached, chain continues", async () => {
    const stub = makeStub({ chunkCount: 1, embedThrows: true });
    const result = await orchestrate(makeCtx(stub));
    expect(result.status).toBe("accepted");
    // reviewChunk still dispatched (the retrieve activity embeds per-chunk as the fallback).
    expect(stub.calls).toContain("reviewChunk");
  });
});

describe("orchestrate — degradation branches", () => {
  it("appends a classifier-failure-ratio note when > 10% of files fail classification", async () => {
    // 2 changed paths, 1 failure → ratio 0.5 > 0.10.
    const stub = makeStub({ chunkCount: 1, classifierFailures: ["src/a.ts"] });
    const result = await orchestrate(makeCtx(stub));
    expect(
      result.degradationNotes.some((n) => n.startsWith("file classification failed for 1/2")),
    ).toBe(true);
  });

  it("does NOT append a classifier note at or below the 10% threshold", async () => {
    // ratio exactly 0.0 (no failures).
    const stub = makeStub({ chunkCount: 1, classifierFailures: [] });
    const result = await orchestrate(makeCtx(stub));
    expect(result.degradationNotes.some((n) => n.startsWith("file classification failed"))).toBe(
      false,
    );
  });

  it("falls open to 'review every chunk' when the carry-forward selector raises", async () => {
    const stub = makeStub({ chunkCount: 2, selectCarryForwardThrows: true });
    const result = await orchestrate(makeCtx(stub));
    expect(result.status).toBe("accepted");
    // both chunks were reviewed (fallback to_review = all chunks).
    expect(stub.calls.filter((c) => c === "reviewChunk").length).toBe(2);
    expect(result.degradationNotes).toContain("select_carry_forward_failed");
    expect(result.degradationNotes).toContain(
      "carry-forward selector failed; every chunk re-reviewed",
    );
  });

  it("surfaces dedup semantic-skip as a degradation note", async () => {
    const stub = makeStub({ chunkCount: 1, dedupSemanticSkipped: true });
    const result = await orchestrate(makeCtx(stub));
    expect(result.degradationNotes).toContain(
      "dedup semantic stage skipped; exact-match dedupe still applied",
    );
  });

  it("fails open when persistReviewFindings raises (chain continues, note appended)", async () => {
    const stub = makeStub({ chunkCount: 1, persistThrows: true });
    const result = await orchestrate(makeCtx(stub));
    expect(result.status).toBe("accepted");
    // persist failed → no rfids; walkthrough + post still ran.
    expect(result.reviewFindingIds).toEqual([]);
    expect(stub.calls).toContain("generateWalkthrough");
    expect(stub.calls).toContain("postReview");
    expect(result.degradationNotes).toContain("persist_findings_failed");
  });
});

describe("orchestrate — path_filters excluded-all early exit", () => {
  it("posts an advisory review and skips chunk/fan-out when path_filters exclude every review file", async () => {
    const stub = makeStub({
      reviewFiles: ["src/a.ts", "src/b.ts"],
      // exclude everything
      pathFilters: ["!**"],
    });
    const result = await orchestrate(makeCtx(stub));

    expect(result.status).toBe("accepted");
    expect(result.degradationNotes).toContain("path_filters_excluded_all");
    // the advisory finding aggregated → 1 finding (the path_filters notice).
    expect(result.findingsCount).toBe(1);
    // chunk / fan-out / dedup / persist were SKIPPED.
    expect(stub.calls).not.toContain("chunkAndRedact");
    expect(stub.calls).not.toContain("reviewChunk");
    expect(stub.calls).not.toContain("dedupFindings");
    expect(stub.calls).not.toContain("persistReviewFindings");
    // advisory review + check-run STILL posted; cleanup STILL runs.
    expect(stub.calls).toContain("aggregate");
    expect(stub.calls).toContain("generateWalkthrough");
    expect(stub.calls).toContain("postReview");
    expect(stub.calls).toContain("postCheckRun");
    expect(stub.cleanupCalled()).toBe(true);
    expect(result.staticAnalysis).toBeNull();
    expect(result.carryForward).toBeNull();
  });

  it("does NOT early-exit when review_files is already empty and there are no path_filters", async () => {
    // empty review set + no filters → normal path (the guard fires ONLY on a non-empty set emptied by
    // filtering). No chunks → fan-out short-circuits but the normal path still runs dedup/aggregate/persist.
    const stub = makeStub({ reviewFiles: [], sandboxFiles: [], chunkCount: 0, pathFilters: [] });
    const result = await orchestrate(makeCtx(stub));
    expect(result.degradationNotes).not.toContain("path_filters_excluded_all");
    expect(stub.calls).toContain("chunkAndRedact");
    expect(stub.calls).toContain("dedupFindings");
  });
});

describe("orchestrate — cleanup is finally-guaranteed", () => {
  it("runs cleanup even when a mid-pipeline stage throws fatally", async () => {
    // reviewChunk throws and is dispatched under stageOutcome(raiseAfterLog) → propagates out of fanOut →
    // out of orchestrate. The finally MUST still release the workspace.
    const stub = makeStub({ chunkCount: 1, reviewChunkThrows: true });
    await expect(orchestrate(makeCtx(stub))).rejects.toThrow(/review-chunk boom/);
    expect(stub.cleanupCalled()).toBe(true);
  });
});

describe("orchestrate — Stage-2 claim-check + placeholder-teardown hooks", () => {
  it("invokes ctx.claimCheck at the FOUR boundaries (clone/classify/aggregate + the FIX #10 before-post)", async () => {
    // The claim-check records the LAST stage dispatched at each invocation, so we can assert it fires
    // BEFORE clone (empty trace), BEFORE classify (after computePolicyRules), BEFORE aggregate (after
    // dedupFindings) — the three Python `_abort_if_claim_lost` sites — AND BEFORE post (after
    // persistReviewWalkthrough), the FIX #10 owner-hardening 4th boundary that closes the
    // aggregate→post supersession window.
    const stub = makeStub({ chunkCount: 1 });
    const ctx = makeCtx(stub);
    const checkPositions: Array<string> = [];
    const ctxWithCheck: ReviewPipelineContext = {
      ...ctx,
      claimCheck: async () => {
        checkPositions.push(stub.calls.length === 0 ? "<before-clone>" : stub.calls[stub.calls.length - 1]!);
      },
    };
    await orchestrate(ctxWithCheck);
    expect(checkPositions).toEqual([
      "<before-clone>",
      "computePolicyRules",
      "dedupFindings",
      "persistReviewWalkthrough",
    ]);
  });

  it("fires claimCheck immediately before classify (right after computePolicyRules)", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const ctx = makeCtx(stub);
    const before: Array<string> = [];
    const ctxWithCheck: ReviewPipelineContext = {
      ...ctx,
      claimCheck: async () => {
        before.push([...stub.calls].join(","));
      },
    };
    await orchestrate(ctxWithCheck);
    // 2nd claim-check (index 1) is the before-classify one: trace at that point is clone,loadRepoConfig,
    // computePolicyRules (classify NOT yet dispatched).
    expect(before[1]).toBe("clone,loadRepoConfig,computePolicyRules");
    // 3rd claim-check (index 2) is the before-aggregate one: dedupFindings has run, aggregate has not.
    expect(before[2]?.endsWith("dedupFindings")).toBe(true);
    expect(before[2]?.includes("aggregate")).toBe(false);
  });

  it("aborts the whole pipeline non-retryably when claimCheck raises before clone (no clone dispatched)", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const ctx = makeCtx(stub);
    const ctxWithCheck: ReviewPipelineContext = {
      ...ctx,
      claimCheck: async () => {
        throw new Error("PrMutexLostClaim");
      },
    };
    await expect(orchestrate(ctxWithCheck)).rejects.toThrow(/PrMutexLostClaim/);
    // The abort fired BEFORE clone → no stages dispatched, cleanup not armed (clone never returned).
    expect(stub.calls).toEqual([]);
    expect(stub.cleanupCalled()).toBe(false);
  });

  it("runs cleanup when claimCheck raises AFTER clone (workspace populated → finally armed)", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const ctx = makeCtx(stub);
    let calls = 0;
    const ctxWithCheck: ReviewPipelineContext = {
      ...ctx,
      claimCheck: async () => {
        calls += 1;
        // first call (before clone) passes; the second (before classify, after clone) aborts.
        if (calls >= 2) {
          throw new Error("PrMutexLostClaim");
        }
      },
    };
    await expect(orchestrate(ctxWithCheck)).rejects.toThrow(/PrMutexLostClaim/);
    // clone ran (finally armed) → cleanup released the workspace even though the abort propagated.
    expect(stub.calls).toContain("clone");
    expect(stub.cleanupCalled()).toBe(true);
  });

  it("invokes onPlaceholderTeardown once, after the post pair (normal path)", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const ctx = makeCtx(stub);
    const teardownAt: Array<string> = [];
    const ctxWithTeardown: ReviewPipelineContext = {
      ...ctx,
      onPlaceholderTeardown: async () => {
        teardownAt.push([...stub.calls].join(","));
      },
    };
    await orchestrate(ctxWithTeardown);
    // Exactly one teardown, fired after BOTH postReview and postCheckRun landed and BEFORE cleanup.
    expect(teardownAt.length).toBe(1);
    expect(teardownAt[0]?.includes("postReview")).toBe(true);
    expect(teardownAt[0]?.includes("postCheckRun")).toBe(true);
    expect(teardownAt[0]?.includes("cleanup")).toBe(false);
  });

  it("invokes onPlaceholderTeardown on the path-filters-excluded-all advisory post", async () => {
    // pathFilters exclude every review file → advisory post path. Teardown must still fire after that post.
    const stub = makeStub({ pathFilters: ["!**"] });
    const ctx = makeCtx(stub);
    let teardowns = 0;
    const ctxWithTeardown: ReviewPipelineContext = {
      ...ctx,
      onPlaceholderTeardown: async () => {
        teardowns += 1;
      },
    };
    const result = await orchestrate(ctxWithTeardown);
    expect(result.degradationNotes).toContain("path_filters_excluded_all");
    expect(teardowns).toBe(1);
  });

  it("is a no-op when neither hook is provided (back-compat: existing callers unaffected)", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const result = await orchestrate(makeCtx(stub));
    expect(result.status).toBe("accepted");
  });
});

describe("orchestrate — logger injection", () => {
  it("emits the stageOutcome WARN line on the injected logger for a degraded stage", async () => {
    const warnings: Array<string> = [];
    const stub = makeStub({ chunkCount: 1, persistThrows: true });
    await orchestrate(makeCtx(stub, { warning: (m) => warnings.push(m) }));
    // the persist_findings stageOutcome emitted a WARN line naming the stage.
    expect(warnings.some((w) => w.includes("persist_findings failed"))).toBe(true);
  });
});

describe("orchestrate — Stage-3 citation validation (Step 7.5)", () => {
  it("is skipped entirely when ctx.activities.citationValidate is omitted (back-compat)", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const result = await orchestrate(makeCtx(stub));
    expect(stub.calls).not.toContain("citationValidate");
    expect(result.findingsCount).toBe(1);
  });

  it("dispatches citationValidate between aggregate and persist; knowledge_chunk_ids=null when NO knowledge retrieved (skip mode)", async () => {
    const stub = makeStub({ chunkCount: 1, withCitationValidate: true, citationDropCount: 0 });
    await orchestrate(makeCtx(stub));
    const aggIdx = stub.calls.indexOf("aggregate");
    const citIdx = stub.calls.indexOf("citationValidate");
    const persistIdx = stub.calls.indexOf("persistReviewFindings");
    expect(aggIdx).toBeGreaterThanOrEqual(0);
    expect(citIdx).toBeGreaterThan(aggIdx);
    expect(persistIdx).toBeGreaterThan(citIdx);
    // EMPTY retrieval → skip mode: knowledge_chunk_ids travels as null (NOT [] — the distinction is
    // load-bearing; null disables knowledge-citation validation, [] forbids ALL knowledge citations).
    expect(stub.citationInputs[0]!.knowledge_chunk_ids).toBeNull();
    // observe-mode policy citation context (empty rule_ids — no bundles in this fixture).
    expect(stub.citationInputs[0]!.policy_citation?.enforcement).toBe("observe");
    expect(stub.citationInputs[0]!.workspace_path).toBe("/ws/abc/repo");
  });

  it("passes the accumulated retrieved knowledge chunk IDs (sorted union) to citationValidate (strict mode)", async () => {
    // The fan-out accumulates each chunk's retrieved knowledge chunk_ids into state.retrievedKnowledgeChunkIds;
    // the post-aggregate citationValidate receives the SORTED union (replay-deterministic), NOT null — so a
    // finding citing a knowledge_chunk outside the retrieved set would be dropped. ENHANCEMENT beyond Python.
    const idA = uuidFor(811);
    const idB = uuidFor(810); // lexically BELOW idA → proves the output is sorted, not insertion-ordered
    const knowledgeItem = (chunkId: string): Record<string, unknown> => ({
      chunk_id: chunkId,
      installation_id: uuidFor(2),
      repo_id: uuidFor(3),
      relative_path: "docs/guide.md",
      chunk_index: 0,
      body: "knowledge body",
      doc_kind: "other",
    });
    const stub = makeStub({
      chunkCount: 1,
      withCitationValidate: true,
      retrievedKnowledgeItems: [knowledgeItem(idA), knowledgeItem(idB)],
    });
    await orchestrate(makeCtx(stub));
    // Sorted union of the two retrieved chunk_ids (idB < idA), regardless of insertion order.
    expect(stub.citationInputs[0]!.knowledge_chunk_ids).toEqual([idA, idB].sort());
  });

  it("drops findings citing missing paths + appends a degradation note + filters the downstream set", async () => {
    // 2 chunks → 2 findings reach aggregate; citation drops 1 → 1 survives into persist/walkthrough/post.
    const stub = makeStub({ chunkCount: 2, withCitationValidate: true, citationDropCount: 1 });
    const result = await orchestrate(makeCtx(stub));
    expect(result.findingsCount).toBe(1); // surviving partition after the drop
    expect(
      result.degradationNotes.some((n) =>
        n.startsWith("citation-validator dropped 1 finding(s) with unresolvable sources"),
      ),
    ).toBe(true);
  });

  it("does NOT append a degradation note when no findings are dropped", async () => {
    const stub = makeStub({ chunkCount: 1, withCitationValidate: true, citationDropCount: 0 });
    const result = await orchestrate(makeCtx(stub));
    expect(result.degradationNotes.some((n) => n.startsWith("citation-validator dropped"))).toBe(
      false,
    );
  });
});

describe("orchestrate — Stage-3 output-safety audit emit", () => {
  it("does NOT dispatch the audit when no sanitization_event is present", async () => {
    const stub = makeStub({ chunkCount: 1, withAuditEmit: true });
    await orchestrate(makeCtx(stub));
    expect(stub.calls).not.toContain("emitAudit");
    expect(stub.auditEvents.length).toBe(0);
  });

  it("dispatches the audit emit when a chunk envelope carries a sanitization_event", async () => {
    const stub = makeStub({ chunkCount: 1, withAuditEmit: true, chunkSanitizationEvent: true });
    await orchestrate(makeCtx(stub));
    expect(stub.calls.filter((c) => c === "emitAudit").length).toBe(1);
    expect(stub.auditEvents[0]!.event.stage).toBe("chunk");
  });

  it("dispatches the audit emit when the walkthrough envelope carries a sanitization_event", async () => {
    const stub = makeStub({
      chunkCount: 1,
      withAuditEmit: true,
      walkthroughSanitizationEvent: true,
    });
    await orchestrate(makeCtx(stub));
    expect(stub.calls.filter((c) => c === "emitAudit").length).toBe(1);
    expect(stub.auditEvents[0]!.event.stage).toBe("walkthrough");
  });

  it("dispatches BOTH chunk + walkthrough audits when both carry a sanitization_event", async () => {
    const stub = makeStub({
      chunkCount: 1,
      withAuditEmit: true,
      chunkSanitizationEvent: true,
      walkthroughSanitizationEvent: true,
    });
    await orchestrate(makeCtx(stub));
    expect(stub.calls.filter((c) => c === "emitAudit").length).toBe(2);
    expect(stub.auditEvents.map((a) => a.event.stage).sort()).toEqual(["chunk", "walkthrough"]);
  });

  it("is a no-op when the emit port is omitted even if a sanitization_event is present", async () => {
    const stub = makeStub({ chunkCount: 1, chunkSanitizationEvent: true });
    const result = await orchestrate(makeCtx(stub));
    expect(stub.calls).not.toContain("emitAudit");
    expect(result.status).toBe("accepted");
  });
});

describe("orchestrate — Stage-3 post capture population (posting.ts)", () => {
  it("populates state.postedReview from the PostedReviewV1 after the post lands", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const ctx = makeCtx(stub);
    await orchestrate(ctx);
    expect(ctx.state.postedReview.reviewId).toBe(7);
    expect(ctx.state.postedReview.publicationOutcome).toBe(PublicationOutcome.enum.inline_posted);
    // posted_review_pr_id is bound to pr_meta.pr_id (the core.posted_reviews PK keyed by PR).
    expect(ctx.state.postedReview.postedReviewPrId).toBe(PR_META.pr_id);
  });
});

describe("orchestrate — Stage-4 enrichment wiring (evidence + walkthrough threading + PR-desc)", () => {
  it("dispatches buildRetrievedEvidence per chunk and threads its result into ReviewContextV1.retrieved_evidence", async () => {
    const stub = makeStub({ chunkCount: 2, withBuildEvidence: true });
    await orchestrate(makeCtx(stub));

    // One dispatch per chunk (the producer is per-chunk).
    expect(stub.calls.filter((c) => c === "buildRetrievedEvidence").length).toBe(2);
    expect(stub.buildEvidenceInputs.length).toBe(2);
    // Each per-chunk ReviewContextV1 carries the evidence the producer returned for THAT chunk (the chunk_body
    // entry whose chunk_id matches the chunk under review) — replacing the Stage-1 empty default.
    for (const ctxInput of stub.reviewChunkInputs) {
      expect(ctxInput.retrieved_evidence.length).toBe(1);
      expect(ctxInput.retrieved_evidence[0]!.chunk_id).toBe(ctxInput.chunk.chunk_id);
      expect(ctxInput.retrieved_evidence[0]!.source_type).toBe("chunk_body");
    }
  });

  it("threads the SAME tier1/tool-status/topology context into buildRetrievedEvidence that the chunk carries", async () => {
    const stub = makeStub({ chunkCount: 1, withBuildEvidence: true });
    await orchestrate(makeCtx(stub));

    expect(stub.buildEvidenceInputs.length).toBe(1);
    const evInput = stub.buildEvidenceInputs[0]!;
    const ctxInput = stub.reviewChunkInputs[0]!;
    // The producer is fed the chunk under review + the fan-out threading (tier1 / tool-status / topology),
    // so the ev_ids the LLM may cite line up with what the prompt renders. Stage-1 staticAnalysis is empty,
    // so these are empty here — the WIRING is what we assert.
    expect(evInput.chunk.chunk_id).toBe(ctxInput.chunk.chunk_id);
    expect(evInput.tier1_findings).toEqual([...ctxInput.tier1_findings]);
    expect(evInput.tool_statuses).toEqual([...ctxInput.tool_statuses]);
    expect(evInput.pr_topology_manifest).toEqual([...ctxInput.pr_topology_manifest]);
    expect(evInput.max_entries).toBe(100);
  });

  it("leaves retrieved_evidence empty when the buildRetrievedEvidence port is omitted (back-compat)", async () => {
    const stub = makeStub({ chunkCount: 1 }); // no withBuildEvidence
    await orchestrate(makeCtx(stub));

    expect(stub.calls).not.toContain("buildRetrievedEvidence");
    expect(stub.reviewChunkInputs[0]!.retrieved_evidence).toEqual([]);
  });

  it("threads context linkedIssues + suggestedReviewers into generateWalkthrough", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const linked = [
      LinkedIssueV1.parse({ issue_number: 7, title: "an issue", state: "open", linkage_kind: "closes" }),
    ];
    const reviewers = ["alice", "bob"];
    await orchestrate(makeCtx(stub, undefined, { linkedIssues: linked, suggestedReviewers: reviewers }));

    expect(stub.walkthroughInputs.length).toBe(1);
    const wInput = stub.walkthroughInputs[0]!;
    expect(wInput.linked_issues).toEqual(linked);
    expect(wInput.suggested_reviewers).toEqual(reviewers);
  });

  it("passes empty linked_issues / suggested_reviewers when the context omits them (default)", async () => {
    const stub = makeStub({ chunkCount: 1 });
    await orchestrate(makeCtx(stub));

    expect(stub.walkthroughInputs[0]!.linked_issues).toEqual([]);
    expect(stub.walkthroughInputs[0]!.suggested_reviewers).toEqual([]);
  });

  it("also threads linkedIssues + suggestedReviewers into the advisory (path-filters-excluded-all) walkthrough", async () => {
    // path_filters that exclude EVERY review file → the advisory early-exit walkthrough.
    const stub = makeStub({ chunkCount: 1, reviewFiles: ["src/a.ts"], pathFilters: ["!**"] });
    const linked = [
      LinkedIssueV1.parse({ issue_number: 3, title: "advisory issue", state: "closed", linkage_kind: "fixes" }),
    ];
    await orchestrate(makeCtx(stub, undefined, { linkedIssues: linked, suggestedReviewers: ["carol"] }));

    // The advisory path skipped chunk/fan-out but still dispatched generateWalkthrough once with the threading.
    expect(stub.calls).not.toContain("reviewChunk");
    expect(stub.walkthroughInputs.length).toBe(1);
    expect(stub.walkthroughInputs[0]!.linked_issues).toEqual(linked);
    expect(stub.walkthroughInputs[0]!.suggested_reviewers).toEqual(["carol"]);
  });

  it("dispatches updatePrDescriptionSummary after the post lands, with owner/repo/pr_number/aggregated", async () => {
    const stub = makeStub({ chunkCount: 1, withUpdatePrDescription: true });
    await orchestrate(makeCtx(stub));

    expect(stub.calls).toContain("updatePrDescription");
    // It runs AFTER the post (the Python `_post_review` ordering).
    expect(stub.calls.indexOf("updatePrDescription")).toBeGreaterThan(stub.calls.indexOf("postReview"));
    expect(stub.updatePrDescriptionInputs.length).toBe(1);
    const u = stub.updatePrDescriptionInputs[0]!;
    expect(u.owner).toBe("acme");
    expect(u.repo).toBe("widgets");
    expect(u.pr_number).toBe(42);
    // The aggregated findings tuple is threaded through (the summary block renders from it).
    expect(u.aggregated.findings.length).toBe(1);
  });

  it("is FAIL-OPEN on an update_pr_description failure (the posted review is the value)", async () => {
    const stub = makeStub({ chunkCount: 1, withUpdatePrDescription: true, updatePrDescriptionThrows: true });
    // The orchestrate() call MUST still resolve cleanly — the description appendage failure is swallowed.
    const result = await orchestrate(makeCtx(stub));

    expect(result.status).toBe("accepted");
    expect(stub.calls).toContain("updatePrDescription");
    // The post + check-run + cleanup still ran (the failure did not short-circuit the post path).
    expect(stub.calls).toContain("postReview");
    expect(stub.calls).toContain("cleanup");
  });

  it("skips updatePrDescriptionSummary when the port is omitted (back-compat)", async () => {
    const stub = makeStub({ chunkCount: 1 }); // no withUpdatePrDescription
    await orchestrate(makeCtx(stub));
    expect(stub.calls).not.toContain("updatePrDescription");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// FIX #6+#9 — the orchestrator delegates BOTH path-config surfaces to the ONE ported gitignore matcher
// (apps/backend/src/config/path_match.ts). These tests assert the orchestrator's USE of it (the matcher's
// own byte-parity-against-Python is proven in test/parity/path_match.parity.test.ts). The filterReviewPaths
// describe below re-exercises the canonical matcher (now imported from path_match.js, NOT the deleted
// orchestrator-local "minimal glob") so the path-filters narrowing contract stays asserted.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("filterReviewPaths — path_filters last-match-wins (canonical path_match matcher)", () => {
  it("is the identity over its input when there are no filters", () => {
    expect(filterReviewPaths(["a.ts", "b.ts"], [])).toEqual(["a.ts", "b.ts"]);
  });

  it("excludes named paths with a '!' exclude marker, keeping the rest", () => {
    expect(filterReviewPaths(["src/a.ts", "docs/x.md"], ["!docs/**"])).toEqual(["src/a.ts"]);
  });

  it("includes only the matching set when an include pattern is present", () => {
    expect(filterReviewPaths(["src/a.ts", "docs/x.md"], ["src/**"])).toEqual(["src/a.ts"]);
  });

  it("applies last-match-wins (a later exclude overrides an earlier include)", () => {
    expect(filterReviewPaths(["src/gen/x.ts", "src/y.ts"], ["src/**", "!src/gen/**"])).toEqual([
      "src/y.ts",
    ]);
  });

  it("excludes EVERY file with a global exclude (the excluded-all trigger)", () => {
    expect(filterReviewPaths(["src/a.ts", "src/b.ts"], ["!**"])).toEqual([]);
  });
});

describe("FIX #6+#9 — orchestrator wires matchPathInstructions into ReviewContextV1", () => {
  it("populates matched_path_instructions for a chunk path that matches a path_instructions rule", async () => {
    // repo_config.path_instructions with a glob that matches the chunk's path → the per-chunk ReviewContextV1
    // carries the matched rule (replacing the Stage-1 `matched_path_instructions: []` placeholder).
    const rule = PathInstructionV1.parse({
      path: "src/**/*.ts",
      instructions: "be strict in src",
    });
    const stub = makeStub({
      reviewFiles: ["src/a.ts"],
      chunkCount: 1,
      pathInstructions: [rule],
    });
    await orchestrate(makeCtx(stub));
    const ctxBuilt = stub.reviewChunkInputs[0]!;
    // chunk path is "src/a.ts" (chunkFor uses the review file); the rule's "src/**/*.ts" glob matches it.
    expect(ctxBuilt.matched_path_instructions.length).toBe(1);
    expect(ctxBuilt.matched_path_instructions[0]!.path).toBe("src/**/*.ts");
    expect(ctxBuilt.matched_path_instructions[0]!.instructions).toBe("be strict in src");
    // Sanity: the same matcher the orchestrator uses agrees on this chunk path.
    expect(matchPathInstructions([rule], "src/a.ts").length).toBe(1);
  });

  it("leaves matched_path_instructions EMPTY when no rule matches the chunk path", async () => {
    const rule = PathInstructionV1.parse({ path: "docs/**", instructions: "docs only" });
    const stub = makeStub({
      reviewFiles: ["src/a.ts"],
      chunkCount: 1,
      pathInstructions: [rule],
    });
    await orchestrate(makeCtx(stub));
    // "docs/**" does NOT match "src/a.ts" → empty.
    expect(stub.reviewChunkInputs[0]!.matched_path_instructions).toEqual([]);
  });

  it("leaves matched_path_instructions EMPTY when the config carries no path_instructions (default)", async () => {
    const stub = makeStub({ reviewFiles: ["src/a.ts"], chunkCount: 1 });
    await orchestrate(makeCtx(stub));
    expect(stub.reviewChunkInputs[0]!.matched_path_instructions).toEqual([]);
  });

  it("returns ALL matching rules in declaration order (ADR-0001)", async () => {
    const ruleA = PathInstructionV1.parse({ path: "**/*.ts", instructions: "all ts" });
    const ruleB = PathInstructionV1.parse({ path: "src/**", instructions: "all src" });
    const stub = makeStub({
      reviewFiles: ["src/a.ts"],
      chunkCount: 1,
      pathInstructions: [ruleA, ruleB],
    });
    await orchestrate(makeCtx(stub));
    const matched = stub.reviewChunkInputs[0]!.matched_path_instructions;
    // Both globs match "src/a.ts"; declaration order preserved.
    expect(matched.map((m) => m.instructions)).toEqual(["all ts", "all src"]);
  });
});

describe("FIX #2 (part 2) — retrieveKnowledge receives payload.repository_id, NOT pr_id", () => {
  it("threads ctx.pr.repositoryId as repo_id (not pr_id) into the retrieve_knowledge dispatch", async () => {
    // Record the retrieveKnowledge input so we can assert repo_id. The repositoryId fixture is uuidFor(6);
    // the pr_id is uuidFor(1) — they are DISTINCT, so a regression to the pr_id stand-in is observable.
    const retrieveInputs: Array<{ repo_id: string }> = [];
    const stub = makeStub({ reviewFiles: ["src/a.ts"], chunkCount: 1 });
    const original = stub.ports.retrieveKnowledge;
    stub.ports.retrieveKnowledge = async (input) => {
      retrieveInputs.push({ repo_id: input.repo_id });
      return original(input);
    };
    const ctx = makeCtx(stub);
    await orchestrate(ctx);
    expect(retrieveInputs.length).toBe(1);
    // repo_id is the threaded repository UUID, NOT the pr_id.
    expect(retrieveInputs[0]!.repo_id).toBe(ctx.pr.repositoryId);
    expect(retrieveInputs[0]!.repo_id).not.toBe(ctx.pr.prMeta.pr_id);
  });
});

describe("FIX #12 — policy-compute fail-open (stage_outcome wrap)", () => {
  it("continues the review with EMPTY policy bundles + a degradation note when computePolicyRules throws", async () => {
    const stub = makeStub({ chunkCount: 1, computePolicyThrows: true });
    const ctx = makeCtx(stub);
    const result = await orchestrate(ctx);
    // The review still completes (the policy step is fail-open).
    expect(result.status).toBe("accepted");
    // The chain proceeded past the failed policy compute (classify → … → post all ran).
    expect(stub.calls).toContain("classify");
    expect(stub.calls).toContain("postReview");
    // No policy bundles populated (the fail-open path left state.policyBundles empty).
    expect(ctx.state.policyBundles.size).toBe(0);
    // The degradation note surfaces the degraded-policy state.
    expect(result.degradationNotes).toContain("policy_compute_failed");
  });

  it("emits the stage_outcome WARN line for the policy_compute failure on the injected logger", async () => {
    const warnings: Array<string> = [];
    const stub = makeStub({ chunkCount: 1, computePolicyThrows: true });
    await orchestrate(makeCtx(stub, { warning: (m) => warnings.push(m) }));
    expect(warnings.some((w) => w.includes("policy_compute failed"))).toBe(true);
  });

  it("does NOT append the policy_compute_failed note on the happy path", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const result = await orchestrate(makeCtx(stub));
    expect(result.degradationNotes).not.toContain("policy_compute_failed");
  });
});

describe("FIX #7 — placeholder teardown decoupled from post_check_run", () => {
  it("tears the placeholder down AND delivers the review when post_check_run throws but post_review succeeds", async () => {
    const stub = makeStub({ chunkCount: 1, postCheckRunThrows: true });
    const ctx = makeCtx(stub);
    let teardowns = 0;
    const ctxWithTeardown: ReviewPipelineContext = {
      ...ctx,
      onPlaceholderTeardown: async () => {
        teardowns += 1;
      },
    };
    const result = await orchestrate(ctxWithTeardown);
    // The review WAS delivered (postReview ran + the run is accepted).
    expect(stub.calls).toContain("postReview");
    expect(result.status).toBe("accepted");
    // The placeholder WAS torn down exactly once despite the check-run failure (the bug: Promise.all rejected
    // before the teardown line and stranded the placeholder).
    expect(teardowns).toBe(1);
    // The check-run failure degrades (not fatal): a degradation note surfaces, the review still posts.
    expect(result.degradationNotes).toContain("post_check_run_failed");
    // cleanup still ran (finally).
    expect(stub.cleanupCalled()).toBe(true);
  });

  it("does NOT tear the placeholder down when post_review itself throws (review failed to deliver)", async () => {
    const stub = makeStub({ chunkCount: 1, postReviewThrows: true });
    const ctx = makeCtx(stub);
    let teardowns = 0;
    const ctxWithTeardown: ReviewPipelineContext = {
      ...ctx,
      onPlaceholderTeardown: async () => {
        teardowns += 1;
      },
    };
    // The review failed to deliver → orchestrate rejects (BF-5/BF-13 terminal path), placeholder NOT torn
    // down (the "reviewing…" notice is still accurate).
    await expect(orchestrate(ctxWithTeardown)).rejects.toThrow(/post-review boom/);
    expect(teardowns).toBe(0);
    // cleanup still ran (the finally is armed once clone returned).
    expect(stub.cleanupCalled()).toBe(true);
  });

  it("post_check_run failure does NOT fail the pipeline even without a teardown hook (degraded-after-delivery)", async () => {
    const stub = makeStub({ chunkCount: 1, postCheckRunThrows: true });
    const result = await orchestrate(makeCtx(stub));
    expect(result.status).toBe("accepted");
    expect(result.degradationNotes).toContain("post_check_run_failed");
  });
});

describe("FIX #10 — final claim-check immediately before the post stage", () => {
  it("fires a FOURTH claim-check just before post (after persist_walkthrough, before postReview)", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const ctx = makeCtx(stub);
    const before: Array<string> = [];
    const ctxWithCheck: ReviewPipelineContext = {
      ...ctx,
      claimCheck: async () => {
        before.push([...stub.calls].join(","));
      },
    };
    await orchestrate(ctxWithCheck);
    // FOUR claim-checks now (was three): before-clone, before-classify, before-aggregate, before-post.
    expect(before.length).toBe(4);
    // The 4th (index 3) is the before-post one: persistReviewWalkthrough has run, postReview has NOT.
    expect(before[3]?.endsWith("persistReviewWalkthrough")).toBe(true);
    expect(before[3]?.includes("postReview")).toBe(false);
  });

  it("a superseded review (lease lost just before post) does NOT post — PrMutexLostClaim, no postReview/postCheckRun", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const ctx = makeCtx(stub);
    let calls = 0;
    const ctxWithCheck: ReviewPipelineContext = {
      ...ctx,
      claimCheck: async () => {
        calls += 1;
        // The first THREE checks (before clone/classify/aggregate) pass; the FOURTH (before post) aborts.
        if (calls >= 4) {
          throw new Error("PrMutexLostClaim");
        }
      },
    };
    await expect(orchestrate(ctxWithCheck)).rejects.toThrow(/PrMutexLostClaim/);
    // The abort fired BEFORE the post stage → no GitHub round-trip.
    expect(stub.calls).not.toContain("postReview");
    expect(stub.calls).not.toContain("postCheckRun");
    // persist + walkthrough already ran (the abort is between persist_walkthrough and post); cleanup still runs.
    expect(stub.calls).toContain("persistReviewWalkthrough");
    expect(stub.cleanupCalled()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Stage-5 — policy post-filter (Step 7.2) + arbitration (Step 7.7) + fix-prompt (post path).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("Step 7.2 — policy post-filter (SI-001 severity floor)", () => {
  it("is a no-op when state.policyBundles is empty (no rules apply)", async () => {
    const stub = makeStub({ chunkCount: 1, securityNitFinding: true });
    const ctx = makeCtx(stub);
    const result = await orchestrate(ctx);
    // No bundles → no post-filter; the security-nit finding flows through unchanged (severity stays 'nit'),
    // and no precomputed metadata is stashed.
    expect(ctx.state.inlinePostFilterMetadata).toBeUndefined();
    expect(result.aggregated?.findings[0]?.severity).toBe("nit");
    expect(stub.calls).not.toContain("policy_post_filter"); // (record_stage is a no-op outside a workflow)
  });

  it("floors a below-floor SECURITY finding to 'issue' and stashes the per-finding metadata", async () => {
    // A non-empty bundle keyed by the changed path makes state.policyBundles non-empty → the filter runs.
    const stub = makeStub({
      chunkCount: 1,
      securityNitFinding: true,
      bundles: { "src/a.ts": emptyBundle("src/a.ts") },
    });
    const ctx = makeCtx(stub);
    const result = await orchestrate(ctx);
    // SI-001 floors the security 'nit' to 'issue'; the surviving aggregated reflects the floored severity so
    // walkthrough + post + persist all see it.
    expect(result.aggregated?.findings[0]?.severity).toBe("issue");
    expect(result.aggregated?.findings[0]?.category).toBe("security");
    // The per-finding metadata is stashed for persist (precomputed_metadata) with the fired invariant id.
    expect(ctx.state.inlinePostFilterMetadata).toBeDefined();
    const meta = ctx.state.inlinePostFilterMetadata![0]!;
    expect(meta.invariant_violation_attempted).toBe(true);
    expect(meta.invariants_fired).toContain("SI-001-security-finding-non-suppressible");
  });

  it("leaves a non-security finding untouched and records no fired invariant", async () => {
    const stub = makeStub({ chunkCount: 1, bundles: { "src/a.ts": emptyBundle("src/a.ts") } });
    const ctx = makeCtx(stub);
    const result = await orchestrate(ctx);
    expect(result.aggregated?.findings[0]?.severity).toBe("issue"); // findingFor() is already 'issue'
    // metadata is stashed (the filter ran) but no invariant fired for the bug-category finding.
    const meta = ctx.state.inlinePostFilterMetadata![0]!;
    expect(meta.invariant_violation_attempted).toBe(false);
    expect(meta.invariants_fired).toEqual([]);
  });
});

describe("Step 7.7 — arbitration apply + tool-run record", () => {
  it("dispatches apply_arbitration after persist and captures the result", async () => {
    const arbResult: ArbitrationResultV1 = { decisions: [], rejected_intents: [] };
    const stub = makeStub({ chunkCount: 1, withApplyArbitration: true, arbitrationResult: arbResult });
    const ctx = makeCtx(stub);
    const result = await orchestrate(ctx);
    expect(stub.calls).toContain("applyArbitration");
    // ordering: applyArbitration runs AFTER persist + BEFORE walkthrough.
    expect(stub.calls.indexOf("applyArbitration")).toBeGreaterThan(
      stub.calls.indexOf("persistReviewFindings"),
    );
    expect(stub.calls.indexOf("applyArbitration")).toBeLessThan(
      stub.calls.indexOf("generateWalkthrough"),
    );
    // the result is captured on state + surfaced on the pipeline result.
    expect(ctx.state.arbitration.result).toEqual(arbResult);
    expect(result.arbitrationResult).toEqual(arbResult);
    // tier-2 pairs were built from the persisted rfid (1 finding → 1 pair); the id-map is the identity.
    const input = stub.applyArbitrationInputs[0]!;
    expect(input.tier2_findings.length).toBe(1);
    const rfid = input.tier2_findings[0]![0];
    expect(input.tier2_review_finding_id_by_arbitration_id[rfid]).toBe(rfid);
  });

  it("skips apply_arbitration when the port is not injected", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const ctx = makeCtx(stub);
    const result = await orchestrate(ctx);
    expect(stub.calls).not.toContain("applyArbitration");
    expect(result.arbitrationResult).toBeNull();
  });

  it("fail-open: an apply_arbitration failure is swallowed and the review still completes", async () => {
    const stub = makeStub({
      chunkCount: 1,
      withApplyArbitration: true,
      applyArbitrationThrows: true,
    });
    const ctx = makeCtx(stub);
    const result = await orchestrate(ctx);
    // the review posts despite the arbitration failure; result is null + a degradation note is appended.
    expect(stub.calls).toContain("postReview");
    expect(result.arbitrationResult).toBeNull();
    expect(result.degradationNotes).toContain("apply_arbitration_failed");
  });

  it("dispatches record_tool_runs only when tool_statuses is non-empty + captures them for the footer", async () => {
    const toolStatus = ToolStatusV1.parse({
      tool_name: "eslint",
      status: "timed_out",
      files_scanned: 7,
      files_total: 10,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: null,
      duration_ms: 1200,
      error_class: "TimeoutError",
    });
    const stub = makeStub({
      chunkCount: 1,
      withApplyArbitration: true,
      withRecordToolRuns: true,
      toolStatuses: [toolStatus],
    });
    const ctx = makeCtx(stub);
    await orchestrate(ctx);
    expect(stub.calls).toContain("recordToolRuns");
    expect(stub.recordToolRunsInputs[0]!.tool_statuses.length).toBe(1);
    // tool statuses captured on state for the post-review footer renderer.
    expect(ctx.state.arbitration.toolStatuses.length).toBe(1);
  });

  it("does NOT dispatch record_tool_runs when tool_statuses is empty", async () => {
    const stub = makeStub({ chunkCount: 1, withApplyArbitration: true, withRecordToolRuns: true });
    const ctx = makeCtx(stub);
    await orchestrate(ctx);
    expect(stub.calls).not.toContain("recordToolRuns");
  });
});

describe("fix-prompt (post path)", () => {
  it("dispatches generate_fix_prompt after the post when findings are non-empty", async () => {
    const stub = makeStub({ chunkCount: 1, withGenerateFixPrompt: true });
    const ctx = makeCtx(stub);
    await orchestrate(ctx);
    expect(stub.calls).toContain("generateFixPrompt");
    expect(stub.calls.indexOf("generateFixPrompt")).toBeGreaterThan(stub.calls.indexOf("postReview"));
    const input = stub.generateFixPromptInputs[0]!;
    expect(input.aggregated.findings.length).toBe(1);
    expect(input.owner).toBe("acme");
  });

  it("fail-open: a generate_fix_prompt failure is swallowed and the review still completes", async () => {
    const stub = makeStub({
      chunkCount: 1,
      withGenerateFixPrompt: true,
      generateFixPromptThrows: true,
    });
    const ctx = makeCtx(stub);
    const result = await orchestrate(ctx);
    expect(stub.calls).toContain("postReview");
    expect(result.status).toBe("accepted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// spec §7 — .codemaster.yaml config-change notice (the cfg.no_spurious_notice smoke surface). The notice
// appears IFF .codemaster.yaml is in the PR's PRE-path_filters changed set (repo.changedPaths), NOT
// otherwise. Wired into orchestrate() right after the aggregate activity (Step 7), AFTER the M-A3 cap and
// BEFORE every downstream consumer, so the notice flows through persist + walkthrough + post.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("config-change notice (spec §7 — cfg.no_spurious_notice)", () => {
  function ctxWithChangedPaths(
    stub: RecordingStub,
    changedPaths: ReadonlyArray<string>,
  ): ReviewPipelineContext {
    const base = makeCtx(stub);
    return { ...base, repo: { ...base.repo, changedPaths: [...changedPaths] } };
  }

  it("APPENDS the notice when .codemaster.yaml is in the changed set", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const result = await orchestrate(
      ctxWithChangedPaths(stub, ["src/a.ts", ".codemaster.yaml"]),
    );
    // 1 LLM finding + the appended config notice = 2.
    expect(result.findingsCount).toBe(2);
    const notice = result.aggregated!.findings.find((f) => f.file === ".codemaster.yaml");
    expect(notice).toBeDefined();
    expect(notice!.category).toBe("config");
    expect(notice!.title).toBe("codemaster: this PR modifies .codemaster.yaml");
    // The notice flows through to the walkthrough + persist (it was appended BEFORE those stages).
    const walkthroughAgg = stub.walkthroughInputs[0]!.aggregated;
    expect(walkthroughAgg.findings.some((f) => f.file === ".codemaster.yaml")).toBe(true);
  });

  it("does NOT append the notice when .codemaster.yaml is absent (no spurious notice)", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const result = await orchestrate(ctxWithChangedPaths(stub, ["src/a.ts", "src/b.ts"]));
    // Only the 1 LLM finding — no notice.
    expect(result.findingsCount).toBe(1);
    expect(result.aggregated!.findings.some((f) => f.file === ".codemaster.yaml")).toBe(false);
    const walkthroughAgg = stub.walkthroughInputs[0]!.aggregated;
    expect(walkthroughAgg.findings.some((f) => f.file === ".codemaster.yaml")).toBe(false);
  });

  it("appends EXACTLY ONE notice (no double-append) on a single pipeline run", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const result = await orchestrate(ctxWithChangedPaths(stub, [".codemaster.yaml"]));
    const notices = result.aggregated!.findings.filter((f) => f.file === ".codemaster.yaml");
    expect(notices.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// M-A5 chunk cap (Python MAX_CHUNKS_PER_REVIEW = 100). The chunk set fed to fanOutReview is truncated to
// at most 100 chunks; on truncation a WARN line + a degradation note surface the partial-review state.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("chunk cap (M-A5 — MAX_CHUNKS_PER_REVIEW = 100)", () => {
  it("truncates the fan-out to 100 chunks and adds a degradation note when 101 chunks are selected", async () => {
    const logs: Array<string> = [];
    const logger = {
      warning(msg: string): void {
        logs.push(msg);
      },
    };
    const stub = makeStub({ chunkCount: 101 });
    const result = await orchestrate(makeCtx(stub, logger));
    // reviewChunk fired EXACTLY 100 times (the cap), not 101.
    expect(stub.calls.filter((c) => c === "reviewChunk").length).toBe(100);
    // The degradation note names the cap + the original count.
    expect(
      result.degradationNotes.some((n) => n.includes("truncated to 100 of 101 chunks")),
    ).toBe(true);
    // The WARN line mirrors the Python `chunks_capped` log.
    expect(logs.some((l) => l.includes("chunks_capped") && l.includes("capped_to=100"))).toBe(true);
  });

  it("does NOT truncate or add a note at exactly the cap (100 chunks)", async () => {
    const stub = makeStub({ chunkCount: 100 });
    const result = await orchestrate(makeCtx(stub));
    expect(stub.calls.filter((c) => c === "reviewChunk").length).toBe(100);
    expect(result.degradationNotes.some((n) => n.includes("truncated"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Aggregate caps — the aggregate ACTIVITY's per-file (10) + per-review (50) caps (rankAndCap) AND the
// workflow-body M-A3 MAX_INLINE_FINDINGS belt-and-suspenders ceiling (250). The cap VALUES are asserted
// against the frozen Python constants (verified via grep on review_pull_request.py / aggregation.py).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("aggregate caps — values match the frozen Python", () => {
  it("PER_FILE_CAP=10 / PER_REVIEW_CAP=50 (rankAndCap) match review/aggregation.py", () => {
    // Asserted directly against the exported activity-side cap constants (the rankAndCap defaults). These
    // are the Python `PER_FILE_CAP: Final = 10` / `PER_REVIEW_CAP: Final = 50` (aggregation.py:85-86).
    expect(PER_FILE_CAP).toBe(10);
    expect(PER_REVIEW_CAP).toBe(50);
  });

  it("M-A3 MAX_INLINE_FINDINGS=250 caps aggregated.findings before the config notice", async () => {
    // Override the aggregate stub to return 300 findings (above the 250 ceiling). The orchestrator's M-A3
    // cap must truncate to 250 BEFORE the config notice would be appended.
    const stub = makeStub({ chunkCount: 1 });
    stub.ports.aggregate = async (input) => {
      stub.calls.push("aggregate");
      const padded = Array.from({ length: 300 }, (_v, i) =>
        ReviewFindingV1.parse({
          file: `src/over_${i}.ts`,
          start_line: 1,
          end_line: 1,
          severity: "issue",
          category: "bug",
          title: `over-${i}`,
          body: `body ${i}`,
          confidence: 0.9,
        }),
      );
      return AggregatedFindingsV1.parse({
        findings: padded,
        dedupe_stats: { input_count: input.findings.length, exact_dropped: 0, semantic_merged: 0, capped: 0 },
        policy_revision: input.policy_revision,
      });
    };
    const logs: Array<string> = [];
    const logger = {
      warning(msg: string): void {
        logs.push(msg);
      },
    };
    // .codemaster.yaml is NOT in the changed set, so the only cap effect is the truncation to 250.
    const result = await orchestrate(makeCtx(stub, logger));
    expect(result.aggregated!.findings.length).toBe(250);
    expect(logs.some((l) => l.includes("findings_capped") && l.includes("capped_to=250"))).toBe(true);
  });
});
