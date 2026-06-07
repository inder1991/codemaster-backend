// Mutex + workspace LIFECYCLE proof — the DURABLE committed counterpart of the ephemeral verifier test that
// proved two LOAD-BEARING Stage-2 safety properties of the review-pipeline workflow body
// (apps/backend/src/workflows/review_pull_request.workflow.ts) and was then DELETED. Both properties are
// required scenarios in the project test matrix, so they live here as standing regression tests.
//
// The two properties:
//
//   1. CLAIM-LOST-BEFORE-POST POSTS NOTHING. When the PR-mutex lease is definitively lost at the
//      before-aggregate claim-check (the third `_abort_if_claim_lost` boundary — renewLease returns false),
//      the workflow MUST abort with a non-retryable `PrMutexLostClaim` ApplicationFailure BEFORE aggregating
//      or posting anything (no aggregate, no postReview, no postCheckRun) — a superseding review owns the
//      result, so spending Bedrock budget + posting a stale review would be a correctness bug. AND the
//      non-cancellable cleanup finally MUST still run, releasing BOTH the mutex and the workspace (no resource
//      leak on the abort path — a leaked mutex blocks every future review of the PR).
//
//   2. CANCELLATION RELEASES BOTH RESOURCES. When the workflow is Temporal-cancelled mid-activity (here:
//      while the clone activity is in flight), the body's `CancellationScope.nonCancellable` cleanup finally
//      MUST still release BOTH the mutex and the workspace before the `CancelledFailure` re-propagates — the
//      Python try/finally analogue (the finally runs even under cancellation). And NOTHING is posted (the
//      cancel landed before the pipeline reached the post stage).
//
// ── MODELED ON review_pipeline_composition.test.ts ──
// Same `@temporalio/testing` TestWorkflowEnvironment + stub-activity harness + seeded v2 payload + call-trace
// recording pattern. The stub surface is the SAME 18 pipeline activities + 7 Stage-2 lifecycle activities the
// composition test registers, here parameterized so a test can (a) script the renewPrReviewMutexLeaseActivity
// return sequence and (b) make the clone activity block on a caller-controlled promise.
//
// ── GATING (keep validate-fast fast) ──
// Like the composition test, the heavier TestWorkflowEnvironment (it boots an ephemeral test server) is gated
// behind `CODEMASTER_TEST_TEMPORAL=1`. `npm run test` (in validate-fast) runs WITHOUT the flag → the suite is
// skipped, keeping validate-fast green + fast. Run it explicitly with the flag to execute the proofs.

import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { WorkflowFailedError } from "@temporalio/client";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ClonedRepoV1 } from "#contracts/cloned_repo.v1.js";
import { FileRoutingV1 } from "#contracts/file_routing.v1.js";
import { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";
import { CarryForwardSelectionV1 } from "#contracts/carry_forward.v1.js";
import { EmbedQueryResultV1 } from "#contracts/embed_query.v1.js";
import { RetrieveKnowledgeResultV1 } from "#contracts/retrieve_knowledge.v1.js";
import { ReviewChunkResponseV1 } from "#contracts/review_chunk_response.v1.js";
import { DedupedFindingsV1 } from "#contracts/dedup_findings.v1.js";
import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import { PostedReviewV1, PublicationOutcome } from "#contracts/posted_review.v1.js";
import { PostedCheckRunV1 } from "#contracts/posted_check_run.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { CitationValidationResultV1 } from "#contracts/citation_validation.v1.js";
import { PrFilesEnrichmentResultV1 } from "#contracts/pr_files_enrichment.v1.js";
import { RetrievedEvidenceV1 } from "#contracts/retrieved_evidence.v1.js";
import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import { ComputedPolicyRulesV1 } from "#contracts/policy_compute.v1.js";
import { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";
// Dispatch-contract guard: the stubs `.parse()` their received input against these so this real-proxy test
// also catches a camelCase/snake_case dispatch drift (parity with review_pipeline_composition.test.ts).
import { ClassifyFilesInputV1 } from "#contracts/classify_files.v1.js";
import { ChunkAndRedactInputV1 } from "#contracts/chunk_and_redact.v1.js";
import { StaticAnalysisInputV1 } from "#contracts/static_analysis_input.v1.js";
import { SelectCarryForwardInputV1 } from "#contracts/select_carry_forward_input.v1.js";
import { AggregateFindingsInputV1 } from "#contracts/aggregate_findings.v1.js";
import {
  ReviewPullRequestPayloadV1,
  ReviewPullRequestResultV1,
} from "#contracts/review_pull_request.v1.js";

// `CODEMASTER_TEST_TEMPORAL` gate — see header. When unset, the whole suite is skipped.
const RUN_TEMPORAL = process.env["CODEMASTER_TEST_TEMPORAL"] === "1";
const describeTemporal = RUN_TEMPORAL ? describe : describe.skip;

// ─── deterministic fixtures (UUIDs / sha built without a mint — pure string helpers) ─────────────────

function uuidFor(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

const HEAD_SHA = "a".repeat(40); // 40-char head_sha (the payload contract requires exactly 40).
const ONE_CHUNK_ID = uuidFor(100);

/** The one DiffChunkV1 the chunkAndRedact stub returns + selectCarryForward routes to_review. */
const THE_CHUNK = DiffChunkV1.parse({
  chunk_id: ONE_CHUNK_ID,
  path: "src/a.ts",
  start_line: 1,
  end_line: 10,
  body: "// src/a.ts",
  chunk_kind: "hunk",
  token_estimate: 5,
});

/** The one finding bedrockReviewChunk emits → flows through dedup → (would) aggregate. */
const THE_FINDING = ReviewFindingV1.parse({
  file: "src/a.ts",
  start_line: 1,
  end_line: 1,
  severity: "issue",
  category: "bug",
  title: "the-finding",
  body: "the finding body",
  confidence: 0.9,
});

/** A seeded, fully-formed v2 payload (parsed through the Zod schema so every default is materialized).
 *  `github_installation_id` defaults to null → the body SKIPS enrich/issues/reviewers (the FIX #1 + claim-lost
 *  + cancellation tests don't need them). */
const PAYLOAD = ReviewPullRequestPayloadV1.parse({
  schema_version: 2,
  installation_id: uuidFor(2),
  repository_id: uuidFor(6),
  pr_id: uuidFor(1),
  pr_number: 42,
  head_sha: HEAD_SHA,
  gh_owner: "acme",
  gh_repo_name: "widgets",
  pr_title: "Add widget",
  pr_description: "A widget.",
  delivery_id: "delivery-abc",
  policy_revision: 3,
  run_id: uuidFor(4),
  review_id: uuidFor(5),
});

/** FIX #3 payload variant — same shape but `github_installation_id` SET (non-null), so the enrich branch
 *  actually dispatches `enrich_pr_files_activity_v2`. The enrich-degraded test scripts that activity to throw. */
const PAYLOAD_WITH_GH_INSTALL = ReviewPullRequestPayloadV1.parse({
  schema_version: 2,
  installation_id: uuidFor(2),
  repository_id: uuidFor(6),
  pr_id: uuidFor(1),
  pr_number: 42,
  head_sha: HEAD_SHA,
  gh_owner: "acme",
  gh_repo_name: "widgets",
  pr_title: "Add widget",
  pr_description: "A widget.",
  delivery_id: "delivery-abc",
  policy_revision: 3,
  run_id: uuidFor(4),
  review_id: uuidFor(5),
  github_installation_id: 123456,
});

// ─── a deferred promise primitive (caller-controlled release for the cancellation test's clone block) ──

type Deferred = {
  readonly promise: Promise<void>;
  resolve: () => void;
};

function makeDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ─── the stub activity surface (registered under the WORKER's REGISTERED names) ─────────────────────
//
// Identical 25-activity surface to the composition test (18 pipeline + 7 Stage-2 lifecycle), parameterized:
//   * `renewSequence` scripts the renewPrReviewMutexLeaseActivity returns (one per claim-check boundary:
//     before-clone, before-classify, before-aggregate). A `false` at a boundary makes that claim-check abort.
//   * `cloneStarted` / `cloneBlock` let a test make the clone activity SIGNAL it started then BLOCK until the
//     caller releases it (the cancellation test cancels while clone is in flight, then releases the block).

type StubConfig = {
  /** renewPrReviewMutexLeaseActivity returns, consumed in dispatch order (one per claim-check boundary). */
  readonly renewSequence: ReadonlyArray<boolean>;
  /** Resolved by the clone stub the moment it begins (lets the cancellation test know clone is in flight). */
  readonly cloneStarted?: Deferred;
  /** Awaited by the clone stub before it returns (lets the cancellation test cancel while clone blocks). */
  readonly cloneBlock?: Deferred;
  /** FIX #1 — make `allocateWorkspace` THROW (proves: mutex released, NO orchestrate, NO workspace release). */
  readonly failAllocateWorkspace?: boolean;
  /** FIX #1 — make `recordReviewLifecycleEvent(ANALYSIS_STARTED)` THROW (proves: mutex AND workspace released). */
  readonly failAnalysisStarted?: boolean;
  /** FIX #3 — make `enrichPrFilesV2` THROW (the activity raises → the body's stageOutcome swallows → the
   *  body marks the run DEGRADED with `pr_file_enrichment_failed`). Requires a payload whose
   *  `github_installation_id` is non-null so the enrich branch actually dispatches. */
  readonly failEnrich?: boolean;
  /** FIX #3 — captures the ANALYZED milestone payload (`pipeline_degradation_notes` is the degraded-state
   *  provenance the posted check-run inherits) so the test can assert the degradation flowed through. */
  readonly analyzedPayloads?: Array<Record<string, unknown>>;
};

function makeStubActivities(
  calls: Array<string>,
  config: StubConfig,
): Record<string, (input: never) => Promise<unknown>> {
  let renewIdx = 0;
  const acts = {
    // ── Stage-2 lifecycle: GATE (accepts; mints a mutex_id) ──
    startReviewForWebhook: async (): Promise<unknown> => {
      calls.push("gate");
      return ReviewPullRequestResultV1.parse({
        status: "accepted",
        pr_number: PAYLOAD.pr_number,
        mutex_id: uuidFor(900),
      });
    },
    // ── Stage-2 lifecycle: placeholder post (best-effort void) ──
    postReviewPlaceholder: async (): Promise<void> => {
      calls.push("postPlaceholder");
    },
    // ── Stage-2 lifecycle: allocate the REAL workspace handle ──
    allocateWorkspace: async (): Promise<unknown> => {
      calls.push("allocateWorkspace");
      // FIX #1: when scripted to fail, throw BEFORE returning a handle. The body's outer try/finally must
      // still release the mutex; the workspace release must NOT fire (no handle was ever minted).
      if (config.failAllocateWorkspace === true) {
        throw new Error("allocate_workspace boom (FIX #1 leak-window proof)");
      }
      return WorkspaceHandle.parse({
        workspace_id: uuidFor(901),
        installation_id: PAYLOAD.installation_id,
        run_id: PAYLOAD.run_id,
        derived_path: "/ws/abc",
        state: "ALLOCATED",
      });
    },
    // ── Stage-3 run-lifecycle (milestones + terminal transitions) ──
    recordReviewLifecycleEvent: async (input: {
      event_type?: string;
      payload?: Record<string, unknown>;
    }): Promise<void> => {
      if (input.event_type === "ANALYZED") {
        calls.push("analyzed");
        // FIX #3: capture the ANALYZED milestone payload — `pipeline_degradation_notes` carries the
        // degraded-state provenance the posted check-run inherits.
        config.analyzedPayloads?.push(input.payload ?? {});
        return;
      }
      calls.push("analysisStarted");
      // FIX #1: when scripted to fail ANALYSIS_STARTED, throw AFTER allocate already minted the handle. The
      // body's outer try/finally must release BOTH the mutex AND the workspace.
      if (config.failAnalysisStarted === true) {
        throw new Error("record ANALYSIS_STARTED boom (FIX #1 leak-window proof)");
      }
    },
    finalizeReviewRun: async (): Promise<void> => {
      calls.push("finalizeReviewRun");
    },
    // BF-5: the workflow body dispatches recordRunFailed on any non-cancellation exception (e.g. the
    // PrMutexLostClaim abort at the before-aggregate boundary).
    recordRunFailed: async (): Promise<void> => {
      calls.push("recordRunFailed");
    },
    // BF-13: the workflow body dispatches recordRunCancelled on a Temporal cancellation.
    recordRunCancelled: async (): Promise<void> => {
      calls.push("recordRunCancelled");
    },
    // ── Stage-3 finding-delivery setters (registered so the body's bookkeeping dispatches resolve) ──
    recordDeliveryFinalized: async (): Promise<number> => {
      calls.push("recordDeliveryFinalized");
      return 0;
    },
    recordDeliverySkipped: async (): Promise<number> => {
      calls.push("recordDeliverySkipped");
      return 0;
    },
    recordDeliveryDegraded: async (): Promise<number> => {
      calls.push("recordDeliveryDegraded");
      return 0;
    },
    // ── Stage-3 citation validation (Step 7.5) + audit emit (registered; happy-path no-drops/no-events) ──
    citationValidate: async (input: { findings?: ReadonlyArray<unknown> }): Promise<unknown> => {
      calls.push("citationValidate");
      return CitationValidationResultV1.parse({ surviving: [...(input.findings ?? [])], dropped: [] });
    },
    emitOutputSafetyAuditEvent: async (): Promise<void> => {
      calls.push("emitAudit");
    },
    // ── Stage-2 lifecycle: lease renewal — fired by the claim-check at clone/classify/aggregate. Returns
    //    the SCRIPTED value for this boundary (default true past the end of the script). ──
    renewPrReviewMutexLeaseActivity: async (): Promise<boolean> => {
      calls.push("renewLease");
      const next = config.renewSequence[renewIdx] ?? true;
      renewIdx += 1;
      return next;
    },
    // ── Stage-2 lifecycle: placeholder delete (best-effort void) ──
    deleteReviewPlaceholder: async (): Promise<void> => {
      calls.push("deletePlaceholder");
    },
    // ── Stage-2 lifecycle: mutex release (body non-cancellable finally; void) ──
    releasePrReviewMutexActivity: async (): Promise<void> => {
      calls.push("releasePrReviewMutexActivity");
    },
    // ── Stage-4 enrichment surface (mirrors review_pipeline_composition.test.ts). These tests seed a
    //    payload with github_installation_id=null, so enrich/issues/reviewers are body-skipped; but
    //    buildRetrievedEvidence is dispatched UNGATED per-chunk in orchestrate() and MUST be registered, or
    //    the workflow dies with ActivityNotRegistered before reaching the before-aggregate claim-check. ──
    enrichPrFilesV2: async (): Promise<unknown> => {
      calls.push("enrichPrFiles");
      // FIX #3: when scripted to fail, throw — the body's stageOutcome swallows it (fail-open on the DATA),
      // then the body marks the run DEGRADED (`pr_file_enrichment_failed`). A genuinely-empty SUCCESSFUL
      // enrichment (the default below) is NOT flagged.
      if (config.failEnrich === true) {
        throw new Error("enrich_pr_files boom (FIX #3 degraded-on-error proof)");
      }
      return PrFilesEnrichmentResultV1.parse({
        files: [],
        changed_line_ranges: {},
        truncated_at: null,
      });
    },
    fetchLinkedIssues: async (): Promise<unknown> => {
      calls.push("fetchLinkedIssues");
      return [];
    },
    fetchSuggestedReviewers: async (): Promise<unknown> => {
      calls.push("fetchSuggestedReviewers");
      return [];
    },
    buildRetrievedEvidence: async (input: { chunk?: { chunk_id?: string; path?: string } }): Promise<unknown> => {
      calls.push("buildRetrievedEvidence");
      return [
        RetrievedEvidenceV1.parse({
          evidence_id: "ev_" + "b".repeat(16),
          source_type: "chunk_body",
          chunk_id: input.chunk?.chunk_id ?? ONE_CHUNK_ID,
          path: input.chunk?.path ?? "src/a.ts",
          excerpt: "// src/a.ts",
        }),
      ];
    },
    updatePrDescriptionSummary: async (): Promise<void> => {
      calls.push("updatePrDescription");
    },
    // ── Stage-5: arbitration apply + tool-run record + fix-prompt. Neither mutex-lifecycle test completes
    //    through post (both abort before persist / during clone), so these never fire — registered so a
    //    future happy-path fixture here does not ActivityNotRegistered. ──
    applyArbitrationActivity: async (): Promise<unknown> => {
      calls.push("applyArbitration");
      return { decisions: [], rejected_intents: [] };
    },
    recordToolRuns: async (): Promise<void> => {
      calls.push("recordToolRuns");
    },
    generateFixPrompt: async (): Promise<unknown> => {
      calls.push("fixPrompt");
      return { schema_version: 1, generated: true, generation_mode: "llm", comment_posted: true };
    },
    cloneRepoIntoWorkspace: async (): Promise<unknown> => {
      calls.push("clone");
      // The cancellation test wires cloneStarted + cloneBlock so it can cancel WHILE clone is in flight: the
      // stub signals it has begun, then awaits the caller-controlled block before returning. Absent the
      // config (the claim-lost test) clone returns immediately.
      config.cloneStarted?.resolve();
      if (config.cloneBlock !== undefined) {
        await config.cloneBlock.promise;
      }
      return ClonedRepoV1.parse({
        workspace_path: "/ws/abc",
        repo_path: "/ws/abc/repo",
        head_sha: HEAD_SHA,
        byte_size: 10,
      });
    },
    loadRepoConfigActivity: async (): Promise<unknown> => {
      calls.push("loadRepoConfig");
      return CodemasterConfigV1.parse({});
    },
    computePolicyRules: async (): Promise<unknown> => {
      calls.push("computePolicyRules");
      return ComputedPolicyRulesV1.parse({ bundles: {} });
    },
    classifyFiles: async (input: unknown): Promise<unknown> => {
      calls.push("classify");
      ClassifyFilesInputV1.parse(input);
      return FileRoutingV1.parse({
        review_files: ["src/a.ts"],
        sandbox_files: [],
        skip_files: [],
        classifier_failures: [],
      });
    },
    chunkAndRedact: async (input: unknown): Promise<unknown> => {
      calls.push("chunkAndRedact");
      ChunkAndRedactInputV1.parse(input);
      return [THE_CHUNK];
    },
    staticAnalysis: async (input: unknown): Promise<unknown> => {
      calls.push("staticAnalysis");
      StaticAnalysisInputV1.parse(input);
      return StaticAnalysisResultV1.parse({});
    },
    // #6 carry-forward loader is ALWAYS dispatched now; with the env flag off it returns the empty set.
    loadParentReviewFindings: async (): Promise<unknown> => ({
      parent_review_id: null,
      parent_findings: [],
    }),
    selectCarryForward: async (input: unknown): Promise<unknown> => {
      calls.push("selectCarryForward");
      SelectCarryForwardInputV1.parse(input);
      return CarryForwardSelectionV1.parse({
        carried: [],
        to_review: [THE_CHUNK],
        parent_review_id: null,
      });
    },
    embedQuery: async (): Promise<unknown> => {
      calls.push("embedQuery");
      return EmbedQueryResultV1.parse({ vector: Array.from({ length: 1024 }, () => 0.01) });
    },
    retrieveKnowledge: async (): Promise<unknown> => {
      calls.push("retrieveKnowledge");
      return RetrieveKnowledgeResultV1.parse({ items: [] });
    },
    bedrockReviewChunk: async (): Promise<unknown> => {
      calls.push("reviewChunk");
      return ReviewChunkResponseV1.parse({ findings: [THE_FINDING], arbitration_intents: [] });
    },
    dedupFindings: async (input: { llm_findings?: ReadonlyArray<unknown> }): Promise<unknown> => {
      calls.push("dedupFindings");
      return DedupedFindingsV1.parse({
        findings: [...(input.llm_findings ?? [])],
        semantic_skipped: false,
      });
    },
    aggregateFindings: async (input: unknown): Promise<unknown> => {
      calls.push("aggregate");
      const parsed = AggregateFindingsInputV1.parse(input);
      const findings = [...parsed.findings];
      return AggregatedFindingsV1.parse({
        findings,
        dedupe_stats: {
          input_count: findings.length,
          exact_dropped: 0,
          semantic_merged: 0,
          capped: 0,
        },
        policy_revision: parsed.policy_revision,
      });
    },
    persistReviewFindings: async (input: {
      aggregated?: { findings?: ReadonlyArray<unknown> };
    }): Promise<unknown> => {
      calls.push("persistReviewFindings");
      return (input.aggregated?.findings ?? []).map((_f, i) => uuidFor(500 + i));
    },
    generateWalkthrough: async (): Promise<unknown> => {
      calls.push("generateWalkthrough");
      return WalkthroughV1.parse({ tldr: "all good" });
    },
    persistReviewWalkthrough: async (): Promise<void> => {
      calls.push("persistReviewWalkthrough");
    },
    postReviewResults: async (): Promise<unknown> => {
      calls.push("postReview");
      return PostedReviewV1.parse({
        review_id: 7,
        inline_comment_count: 0,
        publication_outcome: PublicationOutcome.enum.inline_posted,
        comment_ids: [],
        kept_finding_indices: [],
      });
    },
    postCheckRun: async (): Promise<unknown> => {
      calls.push("postCheckRun");
      return PostedCheckRunV1.parse({ check_run_id: 9, was_update: false });
    },
    releaseWorkspace: async (): Promise<void> => {
      calls.push("releaseWorkspace");
    },
  };
  return acts as Record<string, (input: never) => Promise<unknown>>;
}

const WORKFLOWS_PATH = fileURLToPath(
  new URL("../../../apps/backend/src/workflows/review_pull_request.workflow.ts", import.meta.url),
);
const DATA_CONVERTER_PATH = fileURLToPath(
  new URL("../../../apps/backend/src/worker/data_converter.ts", import.meta.url),
);

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describeTemporal("review-pipeline mutex + workspace lifecycle (in-process TestWorkflowEnvironment)", () => {
  // PROPERTY 1 uses the time-skipping env (matches the composition test; no real wall-clock waits). PROPERTY 2
  // uses createLocal() (a real local server) so a mid-activity cancel lands as a real cancellation rather than
  // the time-skipping env fast-forwarding to the clone activity's start-to-close deadline first.
  let skipEnv: TestWorkflowEnvironment;
  let localEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    skipEnv = await TestWorkflowEnvironment.createTimeSkipping();
    localEnv = await TestWorkflowEnvironment.createLocal();
  }, 120_000);

  afterAll(async () => {
    await skipEnv?.teardown();
    await localEnv?.teardown();
  });

  // ── PROPERTY 1 ────────────────────────────────────────────────────────────────────────────────────
  it("claim-lost before the before-aggregate boundary posts NOTHING and still releases BOTH resources", async () => {
    const calls: Array<string> = [];

    // The claim-check fires THREE times (before clone, before classify, before aggregate — orchestrator.ts
    // :214,:269,:442). Scripting [true, true, false] makes the THIRD renew (the before-aggregate boundary)
    // return false → the body's `_abort_if_claim_lost` throws the non-retryable `PrMutexLostClaim` BEFORE the
    // aggregate dispatch. (Confirmed by reading the renew call sites: the trace shows exactly 3 `renewLease`,
    // the last one false.)
    const stubs = makeStubActivities(calls, { renewSequence: [true, true, false] });

    const worker = await Worker.create({
      connection: skipEnv.nativeConnection,
      namespace: skipEnv.namespace ?? "default",
      taskQueue: "mutex-lifecycle-claim-lost",
      workflowsPath: WORKFLOWS_PATH,
      dataConverter: { payloadConverterPath: DATA_CONVERTER_PATH },
      activities: stubs,
    });

    // The workflow MUST reject (the lost-claim abort). Capture the rejection.
    let caught: unknown;
    try {
      await worker.runUntil(
        skipEnv.client.workflow.execute("reviewPullRequest", {
          taskQueue: "mutex-lifecycle-claim-lost",
          workflowId: `mutex-claim-lost-${PAYLOAD.run_id}`,
          args: [PAYLOAD],
        }),
      );
    } catch (err) {
      caught = err;
    }

    // ── (a) FAILS with an ApplicationFailure of type `PrMutexLostClaim` ──
    // The client surfaces a workflow that raised an ApplicationFailure as a WorkflowFailedError whose `.cause`
    // is that ApplicationFailure (preserving its `.type`).
    expect(caught).toBeInstanceOf(WorkflowFailedError);
    const cause = (caught as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe("PrMutexLostClaim");

    // ── (b) the trace contains NO aggregate, NO postReview, NO postCheckRun ──
    // The abort fired at the before-aggregate boundary, so the review was never aggregated or posted.
    expect(calls).not.toContain("aggregate");
    expect(calls).not.toContain("postReview");
    expect(calls).not.toContain("postCheckRun");
    // Positive cross-check that the abort landed at the THIRD (before-aggregate) boundary, not earlier: clone,
    // classify, and the per-chunk review all ran (they precede the before-aggregate claim-check), and the
    // renew fired exactly 3 times. This guards against the assertions passing vacuously because the workflow
    // aborted somewhere upstream of where we intend.
    expect(calls).toContain("clone");
    expect(calls).toContain("classify");
    expect(calls).toContain("reviewChunk");
    expect(calls).toContain("dedupFindings");
    expect(calls.filter((c) => c === "renewLease").length).toBe(3);

    // ── (c) BOTH releaseMutex AND releaseWorkspace still ran (no resource leak on the abort path) ──
    // The body's non-cancellable finally releases the mutex; the orchestrator's finally + the body backstop
    // release the workspace. Both MUST appear despite the abort.
    expect(calls).toContain("releasePrReviewMutexActivity");
    expect(calls).toContain("releaseWorkspace");

    // ── (d) BF-5: the run was flipped RUNNING → FAILED (the lost-claim abort is a non-cancellation
    // exception), NOT RUNNING → CANCELLED. The cleanup finally already ran (assertion (c)) before the
    // recordRunFailed dispatch — the body's outer try/catch order. ANALYZED + finalize never fired (the
    // pipeline aborted before they could run). ──
    expect(calls).toContain("recordRunFailed");
    expect(calls).not.toContain("recordRunCancelled");
    expect(calls).not.toContain("finalizeReviewRun");
    expect(calls).not.toContain("analyzed");
  }, 120_000);

  // ── PROPERTY 2 ────────────────────────────────────────────────────────────────────────────────────
  it("cancellation mid-clone releases BOTH resources via the non-cancellable finally and posts NOTHING", async () => {
    const calls: Array<string> = [];

    // Make the clone activity SIGNAL it started, then BLOCK until we release it. We cancel WHILE it blocks, so
    // the cancellation lands mid-activity — then we release the block so the worker can finish unwinding the
    // workflow (running the non-cancellable cleanup finally) and surface the CancelledFailure.
    const cloneStarted = makeDeferred();
    const cloneBlock = makeDeferred();
    const stubs = makeStubActivities(calls, {
      renewSequence: [true, true, true],
      cloneStarted,
      cloneBlock,
    });

    const worker = await Worker.create({
      connection: localEnv.nativeConnection,
      namespace: localEnv.namespace ?? "default",
      taskQueue: "mutex-lifecycle-cancel",
      workflowsPath: WORKFLOWS_PATH,
      dataConverter: { payloadConverterPath: DATA_CONVERTER_PATH },
      activities: stubs,
    });

    // runUntil drives the worker only as long as the inner async fn is in flight: start the workflow, wait
    // until clone is in flight, cancel, release the clone block, then await the (rejecting) result.
    let caught: unknown;
    await worker.runUntil(async (): Promise<void> => {
      const handle = await localEnv.client.workflow.start("reviewPullRequest", {
        taskQueue: "mutex-lifecycle-cancel",
        workflowId: `mutex-cancel-${PAYLOAD.run_id}`,
        args: [PAYLOAD],
      });

      // Wait until the clone activity is actually in flight before cancelling (so the cancel lands mid-clone,
      // not before the workflow has even reached the orchestrator).
      await cloneStarted.promise;
      await handle.cancel();
      // Release the clone block so the in-flight clone activity completes and the workflow can unwind into its
      // non-cancellable cleanup finally (which runs even under cancellation).
      cloneBlock.resolve();

      try {
        await handle.result();
      } catch (err) {
        caught = err;
      }
    });

    // ── (a) FAILS with a WorkflowFailedError whose cause is a CancelledFailure ──
    expect(caught).toBeInstanceOf(WorkflowFailedError);
    expect((caught as WorkflowFailedError).cause).toBeInstanceOf(CancelledFailure);

    // ── (b) the trace contains BOTH releaseMutex AND releaseWorkspace (the non-cancellable finally ran) ──
    // This is the core property: a Temporal cancellation MUST NOT leak the mutex or the workspace. The body's
    // `CancellationScope.nonCancellable` cleanup runs the two release activities before the CancelledFailure
    // re-propagates.
    expect(calls).toContain("releasePrReviewMutexActivity");
    expect(calls).toContain("releaseWorkspace");

    // ── (c) NO postReview in the trace (the cancel landed before the post stage) ──
    expect(calls).not.toContain("postReview");
    // Cross-check the cancel really landed mid-clone (not after the pipeline already posted): clone began but
    // the pipeline never reached aggregate/post. Guards against a vacuous pass where the workflow somehow
    // completed normally.
    expect(calls).toContain("clone");
    expect(calls).not.toContain("aggregate");
    expect(calls).not.toContain("postCheckRun");

    // ── (d) BF-13: the run was flipped RUNNING → CANCELLED (the cancellation path), NOT FAILED. The
    // cleanup finally already ran (assertion (b)) before the recordRunCancelled dispatch. ANALYZED +
    // finalize never fired (the cancel landed mid-clone). ──
    expect(calls).toContain("recordRunCancelled");
    expect(calls).not.toContain("recordRunFailed");
    expect(calls).not.toContain("finalizeReviewRun");
  }, 120_000);

  // ── PROPERTY 3 — FIX #1: allocate_workspace failure releases the MUTEX (no orchestrate, no workspace release) ──
  // The leak window FIX #1 closes: in the pre-fix body, allocate_workspace ran OUTSIDE the mutex-release
  // try/finally, so an allocate failure leaked the held mutex until lease-expiry. After the restructure the
  // OUTER try/finally opens the instant the gate hands over `mutexId`, so an allocate failure ALWAYS releases
  // the mutex. The workspace release MUST NOT fire — no handle was ever minted. orchestrate (clone, …) never
  // runs (allocate precedes it). The run flips RUNNING → FAILED (BF-5; allocate failure is a non-cancellation
  // exception).
  it("FIX #1: allocate_workspace failure releases the mutex, runs NO orchestrate, releases NO workspace", async () => {
    const calls: Array<string> = [];
    const stubs = makeStubActivities(calls, {
      renewSequence: [true, true, true],
      failAllocateWorkspace: true,
    });

    const worker = await Worker.create({
      connection: skipEnv.nativeConnection,
      namespace: skipEnv.namespace ?? "default",
      taskQueue: "mutex-lifecycle-allocate-fail",
      workflowsPath: WORKFLOWS_PATH,
      dataConverter: { payloadConverterPath: DATA_CONVERTER_PATH },
      activities: stubs,
    });

    let caught: unknown;
    try {
      await worker.runUntil(
        skipEnv.client.workflow.execute("reviewPullRequest", {
          taskQueue: "mutex-lifecycle-allocate-fail",
          workflowId: `mutex-allocate-fail-${PAYLOAD.run_id}`,
          args: [PAYLOAD],
        }),
      );
    } catch (err) {
      caught = err;
    }

    // ── (a) the workflow FAILS (the allocate error propagates out of the body) ──
    expect(caught).toBeInstanceOf(WorkflowFailedError);

    // ── (b) the mutex WAS released (the core FIX #1 property — no leak on the allocate-failure path) ──
    expect(calls).toContain("allocateWorkspace");
    expect(calls).toContain("releasePrReviewMutexActivity");

    // ── (c) NO workspace release (no handle was minted — the guarded `if (workspaceHandle !== null)` skips it) ──
    expect(calls).not.toContain("releaseWorkspace");

    // ── (d) orchestrate NEVER ran — allocate precedes clone, so no pipeline stage fired ──
    expect(calls).not.toContain("clone");
    expect(calls).not.toContain("classify");
    expect(calls).not.toContain("aggregate");
    expect(calls).not.toContain("postReview");
    expect(calls).not.toContain("postCheckRun");

    // ── (e) BF-5: RUNNING → FAILED (allocate failure is a non-cancellation exception), cleanup ran first ──
    expect(calls).toContain("recordRunFailed");
    expect(calls).not.toContain("recordRunCancelled");
    expect(calls).not.toContain("finalizeReviewRun");
    expect(calls).not.toContain("analyzed");
  }, 120_000);

  // ── PROPERTY 4 — FIX #1: ANALYSIS_STARTED failure releases BOTH the mutex AND the workspace ──
  // The OTHER half of the leak window: ANALYSIS_STARTED ran AFTER allocate but still OUTSIDE the pre-fix
  // mutex-release try/finally, so a failure there leaked BOTH the held mutex AND the just-allocated workspace.
  // After the restructure both are released by the outer try/finally — the workspace release fires because the
  // handle WAS minted (allocate succeeded before ANALYSIS_STARTED). orchestrate never runs (ANALYSIS_STARTED
  // precedes it). The run flips RUNNING → FAILED.
  it("FIX #1: ANALYSIS_STARTED failure releases BOTH the mutex and the workspace, runs NO orchestrate", async () => {
    const calls: Array<string> = [];
    const stubs = makeStubActivities(calls, {
      renewSequence: [true, true, true],
      failAnalysisStarted: true,
    });

    const worker = await Worker.create({
      connection: skipEnv.nativeConnection,
      namespace: skipEnv.namespace ?? "default",
      taskQueue: "mutex-lifecycle-analysis-started-fail",
      workflowsPath: WORKFLOWS_PATH,
      dataConverter: { payloadConverterPath: DATA_CONVERTER_PATH },
      activities: stubs,
    });

    let caught: unknown;
    try {
      await worker.runUntil(
        skipEnv.client.workflow.execute("reviewPullRequest", {
          taskQueue: "mutex-lifecycle-analysis-started-fail",
          workflowId: `mutex-analysis-started-fail-${PAYLOAD.run_id}`,
          args: [PAYLOAD],
        }),
      );
    } catch (err) {
      caught = err;
    }

    // ── (a) the workflow FAILS (the ANALYSIS_STARTED error propagates out of the body) ──
    expect(caught).toBeInstanceOf(WorkflowFailedError);

    // ── (b) allocate succeeded + ANALYSIS_STARTED was attempted (positive cross-check of where we failed) ──
    expect(calls).toContain("allocateWorkspace");
    expect(calls).toContain("analysisStarted");

    // ── (c) BOTH the mutex AND the workspace were released (the handle WAS minted → workspace release fires) ──
    expect(calls).toContain("releasePrReviewMutexActivity");
    expect(calls).toContain("releaseWorkspace");

    // ── (d) orchestrate NEVER ran — ANALYSIS_STARTED precedes clone ──
    expect(calls).not.toContain("clone");
    expect(calls).not.toContain("aggregate");
    expect(calls).not.toContain("postReview");

    // ── (e) BF-5: RUNNING → FAILED, cleanup ran first ──
    expect(calls).toContain("recordRunFailed");
    expect(calls).not.toContain("recordRunCancelled");
    expect(calls).not.toContain("finalizeReviewRun");
    expect(calls).not.toContain("analyzed");
  }, 120_000);

  // ── PROPERTY 5 — FIX #3: enrich-ERROR marks the run DEGRADED (not a silent clean pass) ──
  // The frozen Python fail-OPENs on an enrich failure: empty changed_paths, INDISTINGUISHABLE from a
  // genuinely-empty PR → a silent CLEAN "no findings" review. FIX #3 DISTINGUISHES enrich-ERROR from
  // genuinely-empty and marks the run DEGRADED: `pr_file_enrichment_failed` is added to state.degradation
  // BEFORE orchestrate, so it flows into ReviewPipelineResult.degradation_notes → the ANALYZED milestone's
  // `pipeline_degradation_notes` (the degraded-state provenance the posted check-run inherits). The data path
  // still fail-OPENs (the pipeline completes + posts) — the divergence is the DEGRADED MARK, not a hard fail.
  it("FIX #3: enrich-ERROR marks the run DEGRADED (pipeline_degradation_notes carries pr_file_enrichment_failed)", async () => {
    const calls: Array<string> = [];
    const analyzedPayloads: Array<Record<string, unknown>> = [];
    const stubs = makeStubActivities(calls, {
      renewSequence: [true, true, true],
      failEnrich: true,
      analyzedPayloads,
    });

    const worker = await Worker.create({
      connection: skipEnv.nativeConnection,
      namespace: skipEnv.namespace ?? "default",
      taskQueue: "mutex-lifecycle-enrich-degraded",
      workflowsPath: WORKFLOWS_PATH,
      dataConverter: { payloadConverterPath: DATA_CONVERTER_PATH },
      activities: stubs,
    });

    // The pipeline COMPLETES (enrich fail-opens on the data) → status accepted. The degradation surfaces in the
    // ANALYZED milestone provenance, not as a hard failure.
    const out = (await worker.runUntil(
      skipEnv.client.workflow.execute("reviewPullRequest", {
        taskQueue: "mutex-lifecycle-enrich-degraded",
        workflowId: `mutex-enrich-degraded-${PAYLOAD_WITH_GH_INSTALL.run_id}`,
        args: [PAYLOAD_WITH_GH_INSTALL],
      }),
    )) as { status?: string };

    // ── (a) the workflow COMPLETED accepted (data fail-open — the enrich error did NOT hard-fail the run) ──
    expect(out.status).toBe("accepted");

    // ── (b) the enrich activity was DISPATCHED then threw (github_installation_id non-null → enrich branch) ──
    expect(calls).toContain("enrichPrFiles");

    // ── (c) the pipeline still ran to completion + posted (data fail-open) ──
    expect(calls).toContain("clone");
    expect(calls).toContain("aggregate");
    expect(calls).toContain("postReview");
    expect(calls).toContain("postCheckRun");

    // ── (d) the run was marked DEGRADED: the ANALYZED milestone's pipeline_degradation_notes carries
    // `pr_file_enrichment_failed` — the degraded-state provenance the posted check-run inherits (NOT a clean
    // "no findings" pass). This is the load-bearing FIX #3 assertion. ──
    expect(calls).toContain("analyzed");
    expect(analyzedPayloads.length).toBe(1);
    const pipelineDegradationNotes = analyzedPayloads[0]?.["pipeline_degradation_notes"];
    expect(Array.isArray(pipelineDegradationNotes)).toBe(true);
    expect(pipelineDegradationNotes as Array<string>).toContain("pr_file_enrichment_failed");

    // ── (e) the mutex + workspace were released on the (successful) exit path; the run finalized COMPLETED ──
    expect(calls).toContain("releasePrReviewMutexActivity");
    expect(calls).toContain("releaseWorkspace");
    expect(calls).toContain("finalizeReviewRun");
    expect(calls).not.toContain("recordRunFailed");
  }, 120_000);

  // ── PROPERTY 6 — FIX #3 negative: a genuinely-empty SUCCESSFUL enrichment is NOT flagged degraded ──
  // The counterpart to PROPERTY 5: when enrich SUCCEEDS with an empty file list (a real empty PR), the run is
  // NOT marked degraded — `pr_file_enrichment_failed` is absent from the ANALYZED provenance. This proves the
  // error-vs-empty distinction the FIX #3 divergence hinges on (a successful empty enrichment ≠ an enrich error).
  it("FIX #3 negative: a genuinely-empty SUCCESSFUL enrichment is NOT flagged pr_file_enrichment_failed", async () => {
    const calls: Array<string> = [];
    const analyzedPayloads: Array<Record<string, unknown>> = [];
    const stubs = makeStubActivities(calls, {
      renewSequence: [true, true, true],
      // failEnrich omitted → the enrich stub returns a SUCCESSFUL empty PrFilesEnrichmentResultV1 (files: []).
      analyzedPayloads,
    });

    const worker = await Worker.create({
      connection: skipEnv.nativeConnection,
      namespace: skipEnv.namespace ?? "default",
      taskQueue: "mutex-lifecycle-enrich-empty-ok",
      workflowsPath: WORKFLOWS_PATH,
      dataConverter: { payloadConverterPath: DATA_CONVERTER_PATH },
      activities: stubs,
    });

    const out = (await worker.runUntil(
      skipEnv.client.workflow.execute("reviewPullRequest", {
        taskQueue: "mutex-lifecycle-enrich-empty-ok",
        workflowId: `mutex-enrich-empty-ok-${PAYLOAD_WITH_GH_INSTALL.run_id}`,
        args: [PAYLOAD_WITH_GH_INSTALL],
      }),
    )) as { status?: string };

    expect(out.status).toBe("accepted");
    expect(calls).toContain("enrichPrFiles");
    expect(calls).toContain("analyzed");
    expect(analyzedPayloads.length).toBe(1);
    // The SUCCESSFUL-empty enrichment must NOT add the degradation note.
    const pipelineDegradationNotes = analyzedPayloads[0]?.["pipeline_degradation_notes"];
    expect(Array.isArray(pipelineDegradationNotes)).toBe(true);
    expect(pipelineDegradationNotes as Array<string>).not.toContain("pr_file_enrichment_failed");
  }, 120_000);
});
