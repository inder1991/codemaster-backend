// Composition proof — the IN-PROCESS, end-to-end Temporal proof that the review-pipeline SPINE composes.
//
// This is the safety net the Stage-1 task calls for: a `@temporalio/testing` `TestWorkflowEnvironment`
// (time-skipping, IN-PROCESS — no external Temporal server) running a real `Worker` registered with the
// THIN spine workflow (review_pull_request.workflow) + STUB activities that each return a canned VALID
// contract instance. We execute the workflow with a seeded v2 payload and assert it drives
// clone → … → post and returns a valid `ReviewPullRequestResultV1` (status=accepted, findings_count=1).
//
// Why this matters: every OTHER test tier exercises the spine's components in ISOLATION against
// stubs/mocks (the orchestrator unit test drives orchestrate() with stub ports; the contract parity tests
// validate one contract at a time). THIS test is the only one that proves the whole chain composes through
// the real Temporal machinery: the workflow body's payload parse, the proxyActivities() name-bridge
// (activity_proxy.ts maps the compact port names onto the registered activity names), the data converter's
// wire round-trip of every contract, the orchestrator's stage order, and the result mapping — all wired
// together and executed by a real worker. A green here means the spine is dispatch-ready in-process.
//
// ── GATING (keep validate-fast fast) ──
// The time-skipping env downloads + boots an ephemeral test server, which is heavier than a unit test, so
// this suite is gated behind `CODEMASTER_TEST_TEMPORAL=1` (mirroring the `CODEMASTER_TEST_MAGIKA` gate on
// the magika-agreement parity test). `npm run test` (in validate-fast) runs WITHOUT the flag → the suite
// is skipped, keeping validate-fast green + fast. Run it explicitly with the flag set (or via
// `npm run test:integration` with the flag) to execute the proof.

import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
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
import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import { ComputedPolicyRulesV1 } from "#contracts/policy_compute.v1.js";
import { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";
import { PrFilesEnrichmentResultV1 } from "#contracts/pr_files_enrichment.v1.js";
import { RetrievedEvidenceV1 } from "#contracts/retrieved_evidence.v1.js";
// The five formerly-camelCase dispatch envelopes — the stubs below `.parse()` their received input against
// these so the REAL workflow→proxyActivities→data-converter→activity-boundary is asserted to carry the
// snake_case contract keys (the dispatch-contract-drift regression guard).
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

/** The one finding bedrockReviewChunk emits → flows through dedup → aggregate → findings_count=1. */
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

/** A seeded, fully-formed v2 payload (parsed through the Zod schema so every default is materialized). */
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
  // Stage-4: a non-null github_installation_id ARMS the enrich-pr-files + linked-issues + suggested-reviewers
  // body steps (the Python `github_installation_id is not None` gate). With it null they'd all be skipped.
  github_installation_id: 555,
});

// ─── the stub activity surface (registered under the WORKER's REGISTERED names) ─────────────────────
//
// Each stub records its dispatch into the shared `calls` array (the stage trace the test asserts) and
// returns a canned VALID contract instance. The names MUST match the registered names the workflow's
// proxyActivities() bridge (activity_proxy.ts) dispatches: cloneRepoIntoWorkspace, loadRepoConfigActivity,
// classifyFiles, bedrockReviewChunk, aggregateFindings, postReviewResults, releaseWorkspace, etc.

function makeStubActivities(calls: Array<string>): Record<string, (input: never) => Promise<unknown>> {
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
      return WorkspaceHandle.parse({
        workspace_id: uuidFor(901),
        installation_id: PAYLOAD.installation_id,
        run_id: PAYLOAD.run_id,
        derived_path: "/ws/abc",
        state: "ALLOCATED",
      });
    },
    // ── Stage-3 run-lifecycle: ANALYSIS_STARTED (before orchestrate) + ANALYZED (after bookkeeping) ──
    // The body dispatches recordReviewLifecycleEvent for both event types; the stub records the event_type
    // so the trace distinguishes the two milestone emits.
    recordReviewLifecycleEvent: async (input: { event_type?: string }): Promise<void> => {
      calls.push(input.event_type === "ANALYZED" ? "analyzed" : "analysisStarted");
    },
    // ── Stage-3 run-lifecycle: RUNNING → COMPLETED (after ANALYZED) ──
    finalizeReviewRun: async (): Promise<void> => {
      calls.push("finalizeReviewRun");
    },
    // ── Stage-3 run-lifecycle: terminal-transition setters (not fired on the happy path) ──
    recordRunFailed: async (): Promise<void> => {
      calls.push("recordRunFailed");
    },
    recordRunCancelled: async (): Promise<void> => {
      calls.push("recordRunCancelled");
    },
    // ── Stage-3 finding-delivery setters (the lifecycle-bookkeeping block + the H-2 inline skip) ──
    // The happy-path post returns publication_outcome=inline_posted with empty comment_ids/kept_indices,
    // so NONE of these fire (keptRfids is empty → no finalized; no dropped → no skipped; inline → no
    // degraded). They are registered so a future fixture that exercises them does not ActivityNotRegistered.
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
    // ── Stage-3 citation validation (Step 7.5) — surviving=input findings, no drops (happy path) ──
    citationValidate: async (input: { findings?: ReadonlyArray<unknown> }): Promise<unknown> => {
      calls.push("citationValidate");
      return CitationValidationResultV1.parse({ surviving: [...(input.findings ?? [])], dropped: [] });
    },
    // ── Stage-3 output-safety audit emit (no sanitization_event in the happy-path fixtures → never fires) ──
    emitOutputSafetyAuditEvent: async (): Promise<void> => {
      calls.push("emitAudit");
    },
    // ── Stage-2 lifecycle: lease renewal (still-held=true) — fired by the claim-check at clone/classify/
    //    aggregate. The result type comes from the string-name proxy's interface (boolean). ──
    renewPrReviewMutexLeaseActivity: async (): Promise<boolean> => {
      calls.push("renewLease");
      return true;
    },
    // ── Stage-2 lifecycle: placeholder delete (best-effort void) — fired after the real post lands ──
    deleteReviewPlaceholder: async (): Promise<void> => {
      calls.push("deletePlaceholder");
    },
    // ── Stage-2 lifecycle: mutex release (body finally; void) ──
    releasePrReviewMutexActivity: async (): Promise<void> => {
      calls.push("releaseMutex");
    },
    // ── Stage-4 enrichment: changed-files enrich (body, before allocate). Returns the PR's changed file +
    //    its post-image hunk range so the orchestrator reviews the REAL file (src/a.ts, matching THE_CHUNK). ──
    enrichPrFilesV2: async (): Promise<unknown> => {
      calls.push("enrichPrFiles");
      return PrFilesEnrichmentResultV1.parse({
        files: [
          {
            pr_file_id: uuidFor(601),
            pr_id: PAYLOAD.pr_id,
            installation_id: PAYLOAD.installation_id,
            repository_id: PAYLOAD.repository_id,
            file_path: "src/a.ts",
            status: "modified",
            additions: 3,
            deletions: 1,
            previous_path: null,
            language: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        changed_line_ranges: { "src/a.ts": [[1, 10]] },
        truncated_at: null,
      });
    },
    // ── Stage-4: linked issues (body, before orchestrate) — fed into generateWalkthrough. ──
    fetchLinkedIssues: async (): Promise<unknown> => {
      calls.push("fetchLinkedIssues");
      return [];
    },
    // ── Stage-4: suggested reviewers (body, before orchestrate) — fed into generateWalkthrough. ──
    fetchSuggestedReviewers: async (): Promise<unknown> => {
      calls.push("fetchSuggestedReviewers");
      return [];
    },
    // ── Stage-4: per-chunk evidence manifest (orchestrator buildChunkContext) — returns the chunk_body
    //    entry the producer always emits, threaded into ReviewContextV1.retrieved_evidence. ──
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
    // ── Stage-4: PR-description summary (orchestrator posting, after the post lands; fail-open). ──
    updatePrDescriptionSummary: async (): Promise<void> => {
      calls.push("updatePrDescription");
    },
    // ── Stage-5: arbitration apply (orchestrator Step 7.7, after persist; sa non-null so it fires). Returns
    //    an empty ArbitrationResultV1 — no suppressed decisions → the footer renderer is a no-op. ──
    applyArbitrationActivity: async (): Promise<unknown> => {
      calls.push("applyArbitration");
      return { decisions: [], rejected_intents: [] };
    },
    // ── Stage-5: record tool runs (orchestrator Step 7.7) — only fires when sa.tool_statuses is non-empty.
    //    The happy-path staticAnalysis stub returns empty tool_statuses, so this never fires; registered so a
    //    future fixture does not ActivityNotRegistered. ──
    recordToolRuns: async (): Promise<void> => {
      calls.push("recordToolRuns");
    },
    // ── Stage-5: fix-prompt (posting.ts, after the post lands; aggregated.findings non-empty so it fires).
    //    Returns generated=true / mode=llm (→ fix_prompt stage outcome=ok); advisory, fail-open. ──
    generateFixPrompt: async (): Promise<unknown> => {
      calls.push("fixPrompt");
      return { schema_version: 1, generated: true, generation_mode: "llm", comment_posted: true };
    },
    cloneRepoIntoWorkspace: async (): Promise<unknown> => {
      calls.push("clone");
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
      // a 1024-vec (the Qwen3-embed-0.6b dimension) — non-empty so the orchestrator caches + threads it.
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
      calls.push("cleanup");
    },
  };
  return acts as Record<string, (input: never) => Promise<unknown>>;
}

/**
 * Collapse the (consecutive) members of each parallel pair in `calls` into a single stable token, so the
 * surrounding strictly-sequential stage order can be asserted with an exact `toEqual` regardless of which
 * member of a pair the worker executed first. Each pair's two members appear CONSECUTIVELY (the orchestrator
 * awaits the pair via Promise.all between two sequential stages, so no other stage interleaves them); we
 * replace the FIRST occurrence of either member with the pair token and DROP the second.
 */
function collapsePairs(
  calls: ReadonlyArray<string>,
  pair1: Set<string>,
  token1: string,
  pair2: Set<string>,
  token2: string,
): Array<string> {
  const out: Array<string> = [];
  let i = 0;
  while (i < calls.length) {
    const c = calls[i]!;
    if (pair1.has(c)) {
      out.push(token1);
      i += 2; // skip the consecutive pair member
      continue;
    }
    if (pair2.has(c)) {
      out.push(token2);
      i += 2;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describeTemporal("review-pipeline composition (in-process TestWorkflowEnvironment)", () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  }, 60_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it("composes clone→…→post end-to-end and returns a valid ReviewPullRequestResultV1", async () => {
    const calls: Array<string> = [];

    // The worker bundles the SPINE workflow (review_pull_request.workflow) + the custom data converter, and
    // registers the STUB activities under the registered names. connection = the in-process test env's
    // native connection (no external server). A dedicated task queue isolates this run.
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.namespace ?? "default",
      taskQueue: "review-pipeline-composition",
      workflowsPath: fileURLToPath(
        new URL(
          "../../../apps/backend/src/workflows/review_pull_request.workflow.ts",
          import.meta.url,
        ),
      ),
      dataConverter: {
        payloadConverterPath: fileURLToPath(
          new URL("../../../apps/backend/src/worker/data_converter.ts", import.meta.url),
        ),
      },
      activities: makeStubActivities(calls),
    });

    // Execute the workflow IN-PROCESS: runUntil runs the worker just long enough to drive the one
    // execution to completion, then shuts it down. The result is the typed ReviewPullRequestResultV1.
    const result: ReviewPullRequestResultV1 = await worker.runUntil(
      testEnv.client.workflow.execute("reviewPullRequest", {
        taskQueue: "review-pipeline-composition",
        workflowId: `composition-${PAYLOAD.run_id}`,
        args: [PAYLOAD],
      }),
    );

    // ── PROOF 1: the result envelope is the spine happy-path shape ──
    expect(result.status).toBe("accepted");
    expect(result.findings_count).toBe(1);
    expect(result.pr_number).toBe(42);
    expect(result.installation_id).toBe(PAYLOAD.installation_id);
    expect(result.pr_id).toBe(PAYLOAD.pr_id);
    // Re-parse through the contract to prove the returned value is a VALID ReviewPullRequestResultV1.
    expect(() => ReviewPullRequestResultV1.parse(result)).not.toThrow();

    // ── PROOF 2: the spine drove the GATE → lifecycle → clone → … → post → cleanup stage order ──
    // The two parallel pairs ({chunkAndRedact, staticAnalysis} and {postReview, postCheckRun}) cross the
    // Temporal wire concurrently, so the WORKER may execute either member of a pair first — their relative
    // order within the pair is NOT deterministic. We therefore assert the SEQUENTIAL spine order with each
    // parallel pair collapsed to a position-stable set, plus membership of the pair members.
    //
    // Stage-2 lifecycle threading (vs the Stage-1 thin body):
    //   * `gate` runs FIRST (start_review_for_webhook → accepted, mints mutex_id).
    //   * `postPlaceholder` then `allocateWorkspace` precede the orchestrator.
    //   * `renewLease` fires FOUR times — the claim-check at the before-clone, before-classify,
    //     before-aggregate, AND (FIX #10) the before-post boundaries (the orchestrator's ctx.claimCheck
    //     seam → renew activity). The 4th closes the aggregate→post supersession window so a stolen-lease
    //     review never publishes.
    //   * `deletePlaceholder` fires after the post pair (the onPlaceholderTeardown seam).
    //   * `cleanup` (releaseWorkspace) fires once from the orchestrator's finally; then the body's
    //     non-cancellable finally fires `releaseMutex` + a backstop `cleanup` (releaseWorkspace again,
    //     idempotent — both are dispatched to the same releaseWorkspace stub which pushes "cleanup").
    const PAIR1 = new Set(["chunkAndRedact", "staticAnalysis"]);
    const PAIR2 = new Set(["postReview", "postCheckRun"]);
    // `updatePrDescription` AND `fixPrompt` are dispatched INSIDE postReviewResults (the postReview branch of
    // the post Promise.all), so they interleave non-deterministically with `postCheckRun` (the other pair
    // member) and would break the consecutive-pair assumption collapsePairs relies on. Filter both out of the
    // sequential trace (their membership + after-post ordering are asserted separately below) so the PAIR2
    // collapse stays valid. Everything else — including the Stage-4 body steps (enrichPrFiles,
    // fetchLinkedIssues, fetchSuggestedReviewers), the fan-out buildRetrievedEvidence, and the Stage-5
    // applyArbitration (Step 7.7, strictly sequential between persist and walkthrough) — is sequential.
    const sequentialCalls = calls.filter((c) => c !== "updatePrDescription" && c !== "fixPrompt");
    const sequential = collapsePairs(sequentialCalls, PAIR1, "PAIR1", PAIR2, "PAIR2");
    expect(sequential).toEqual([
      "gate",
      "postPlaceholder",
      "enrichPrFiles", // Stage-4: enrich BEFORE allocate (derives the REAL changed_paths / ranges)
      "allocateWorkspace",
      "analysisStarted", // ANALYSIS_STARTED milestone (before the BF-5 try opens / orchestrate)
      "fetchLinkedIssues", // Stage-4: resolved before orchestrate, threaded into generateWalkthrough
      "fetchSuggestedReviewers", // Stage-4: resolved before orchestrate, threaded into generateWalkthrough
      "renewLease", // claim-check before clone
      "clone",
      "loadRepoConfig",
      "computePolicyRules",
      "renewLease", // claim-check before classify
      "classify",
      "PAIR1", // {chunkAndRedact, staticAnalysis} (order-free within the pair)
      "selectCarryForward",
      "embedQuery",
      "retrieveKnowledge",
      "buildRetrievedEvidence", // Stage-4: per-chunk evidence manifest (after retrieve, before reviewChunk)
      "reviewChunk",
      "dedupFindings",
      "renewLease", // claim-check before aggregate
      "aggregate",
      "citationValidate", // Step 7.5 — between aggregate and persist
      "persistReviewFindings",
      "applyArbitration", // Step 7.7 — between persist and walkthrough (sa non-null; tool_statuses empty)
      "generateWalkthrough",
      "persistReviewWalkthrough",
      "renewLease", // FIX #10 — 4th claim-check before the post stage (closes the aggregate→post window)
      "PAIR2", // {postReview, postCheckRun} (order-free within the pair)
      "deletePlaceholder", // onPlaceholderTeardown after the post pair (decoupled from post_check_run — FIX #7)
      "cleanup", // orchestrator finally (releaseWorkspace)
      "analyzed", // ANALYZED milestone (after orchestrate + bookkeeping, inside the BF-5 try)
      "finalizeReviewRun", // RUNNING → COMPLETED
      "releaseMutex", // body non-cancellable finally (releasePrReviewMutex)
      "cleanup", // body backstop (releaseWorkspace again — idempotent)
    ]);
    // Both members of each parallel pair were actually dispatched.
    expect(calls).toContain("chunkAndRedact");
    expect(calls).toContain("staticAnalysis");
    expect(calls).toContain("postReview");
    expect(calls).toContain("postCheckRun");
    // The mutex was released by the body's finally.
    expect(calls).toContain("releaseMutex");
    // The lease was renewed at all FOUR claim-check boundaries (clone/classify/aggregate + FIX #10 post).
    expect(calls.filter((c) => c === "renewLease").length).toBe(4);
    // ── PROOF 2b: the Stage-4 enrichment wiring composed end-to-end ──
    // enrich fired ONCE before allocate; linked-issues + suggested-reviewers fired ONCE each before clone;
    // buildRetrievedEvidence fired ONCE per chunk (1 chunk); updatePrDescription fired ONCE after the post.
    expect(calls.filter((c) => c === "enrichPrFiles").length).toBe(1);
    expect(calls.filter((c) => c === "fetchLinkedIssues").length).toBe(1);
    expect(calls.filter((c) => c === "fetchSuggestedReviewers").length).toBe(1);
    expect(calls.filter((c) => c === "buildRetrievedEvidence").length).toBe(1);
    expect(calls.filter((c) => c === "updatePrDescription").length).toBe(1);
    // update_pr_description runs AFTER the review post lands (the Python `_post_review` ordering).
    expect(calls.indexOf("updatePrDescription")).toBeGreaterThan(calls.indexOf("postReview"));
    // enrich precedes allocate (ENRICH BEFORE ALLOCATE); the issues/reviewers fetch precedes the clone.
    expect(calls.indexOf("enrichPrFiles")).toBeLessThan(calls.indexOf("allocateWorkspace"));
    expect(calls.indexOf("fetchLinkedIssues")).toBeLessThan(calls.indexOf("clone"));
    expect(calls.indexOf("fetchSuggestedReviewers")).toBeLessThan(calls.indexOf("clone"));

    // ── PROOF 2c: the Stage-5 arbitration + fix-prompt wiring composed end-to-end ──
    // applyArbitration fired ONCE (Step 7.7, sa non-null) AFTER persist + BEFORE walkthrough. recordToolRuns
    // did NOT fire (the happy-path staticAnalysis has empty tool_statuses). fixPrompt fired ONCE (findings
    // non-empty) AFTER the post lands.
    expect(calls.filter((c) => c === "applyArbitration").length).toBe(1);
    expect(calls).not.toContain("recordToolRuns");
    expect(calls.filter((c) => c === "fixPrompt").length).toBe(1);
    expect(calls.indexOf("applyArbitration")).toBeGreaterThan(calls.indexOf("persistReviewFindings"));
    expect(calls.indexOf("applyArbitration")).toBeLessThan(calls.indexOf("generateWalkthrough"));
    expect(calls.indexOf("fixPrompt")).toBeGreaterThan(calls.indexOf("postReview"));

    // ── PROOF 3: the Stage-3 run-lifecycle milestones fired (ANALYSIS_STARTED → ANALYZED → COMPLETED) ──
    expect(calls.filter((c) => c === "analysisStarted").length).toBe(1);
    expect(calls.filter((c) => c === "analyzed").length).toBe(1);
    expect(calls.filter((c) => c === "finalizeReviewRun").length).toBe(1);
    // No FAILED / CANCELLED transition on the happy path.
    expect(calls).not.toContain("recordRunFailed");
    expect(calls).not.toContain("recordRunCancelled");
    // ── PROOF 4: NO finding-delivery setter fired (post returned inline_posted with no kept/dropped rfids,
    // so the bookkeeping block's three gated dispatches are all inert) AND no audit emit (no
    // sanitization_event in the happy-path fixtures). ──
    expect(calls).not.toContain("recordDeliveryFinalized");
    expect(calls).not.toContain("recordDeliverySkipped");
    expect(calls).not.toContain("recordDeliveryDegraded");
    expect(calls).not.toContain("emitAudit");
  }, 60_000);

  it("short-circuits the whole workflow when the gate does NOT accept (skipped_busy)", async () => {
    const calls: Array<string> = [];

    // A gate that returns skipped_busy MUST short-circuit: no placeholder, no allocate, no orchestrate, no
    // mutex/workspace release — the workflow returns the gate result verbatim. Override the gate stub.
    const stubs = makeStubActivities(calls);
    stubs["startReviewForWebhook"] = (async (): Promise<unknown> => {
      calls.push("gate");
      return ReviewPullRequestResultV1.parse({ status: "skipped_busy", pr_number: PAYLOAD.pr_number });
    }) as (input: never) => Promise<unknown>;

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.namespace ?? "default",
      taskQueue: "review-pipeline-composition-gate-skip",
      workflowsPath: fileURLToPath(
        new URL(
          "../../../apps/backend/src/workflows/review_pull_request.workflow.ts",
          import.meta.url,
        ),
      ),
      dataConverter: {
        payloadConverterPath: fileURLToPath(
          new URL("../../../apps/backend/src/worker/data_converter.ts", import.meta.url),
        ),
      },
      activities: stubs,
    });

    const result: ReviewPullRequestResultV1 = await worker.runUntil(
      testEnv.client.workflow.execute("reviewPullRequest", {
        taskQueue: "review-pipeline-composition-gate-skip",
        workflowId: `composition-gate-skip-${PAYLOAD.run_id}`,
        args: [PAYLOAD],
      }),
    );

    // The gate result is returned verbatim — skipped_busy short-circuits BEFORE any pipeline work.
    expect(result.status).toBe("skipped_busy");
    expect(result.pr_number).toBe(PAYLOAD.pr_number);
    expect(() => ReviewPullRequestResultV1.parse(result)).not.toThrow();
    // ONLY the gate ran — no placeholder, no allocate, no clone, no post, no cleanup, no mutex release.
    expect(calls).toEqual(["gate"]);
  }, 60_000);
});
