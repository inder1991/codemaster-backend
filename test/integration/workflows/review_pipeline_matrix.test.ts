// WORKFLOW-LEVEL matrix + REPLAY-DETERMINISM proof — the standing regression suite for the spine's
// workflow-body decision surface AND its replay-safety guarantee, run through the REAL Temporal machinery.
//
// This is the workflow-level counterpart to review_pipeline_composition.test.ts (which proves the happy-path
// stage order composes) and review_pipeline_mutex_lifecycle.test.ts (which proves the mutex/workspace
// release invariants). THIS suite covers the remaining WORKFLOW-BODY matrix cells + the LOAD-BEARING
// replay-determinism proof:
//
//   1. REPO DISABLED BY CONFIG. The gate returns `skipped_disabled` (repository.enabled=false; NO mutex
//      acquired) → the workflow returns the gate result verbatim and does NO pipeline work. `calls` is
//      exactly `["gate"]` — no placeholder, no enrich, no allocate, no orchestrate, no post, no
//      mutex/workspace release. The straight-line gate short-circuit (`if (pre.status !== "accepted") return
//      pre`) is the same code path for every non-accepted status; skipped_disabled is the config-deny cell.
//
//   2. CLONE FAILURE AT WORKFLOW LEVEL. The clone activity (dispatched INSIDE orchestrate, inside the BF-5
//      outer try) throws on every attempt → orchestrate rejects → the INNER non-cancellable finally releases
//      BOTH the mutex and the workspace → the OUTER BF-5 catch flips the run RUNNING → FAILED (record_run_
//      failed, a non-cancellation exception) → the original failure re-propagates. NOTHING is posted; the run
//      is NOT marked CANCELLED; ANALYZED + finalize never fire.
//
//   3. REPLAY DETERMINISM (the load-bearing one). Capture a SUCCESSFUL workflow's history (run it once in the
//      TestWorkflowEnvironment, then `handle.fetchHistory()`), then REPLAY that history through
//      `Worker.runReplayHistory(...)` against the SAME workflow bundle + data converter. A replay that
//      produces a different command stream than the recorded history throws `DeterminismViolationError`; we
//      assert it does NOT — proving the gate-collapse straight-line body + orchestrate() + the index-ordered
//      fan-out/fan-in are replay-safe (no wall-clock / crypto / RNG inside the sandbox; the only `now` is the
//      SDK-provided replay-deterministic `workflowInfo().startTime`).
//
//   4. ACTIVITY-REGISTRY COVERAGE is asserted in test/unit/worker/build_activities.test.ts (the FULL proxied
//      set — parsed from the two proxyActivities() source modules — is registered in buildActivities(), so no
//      ActivityNotRegistered at dispatch). This suite cross-references that guard; see the doc-comment on the
//      derive-the-proxied-set test there.
//
// ── MODELED ON review_pipeline_composition.test.ts ──
// Same `@temporalio/testing` TestWorkflowEnvironment + `makeStubActivities` harness shape + seeded v2 payload
// + call-trace recording. The stub surface registers EVERY activity the workflow proxies (the 41-name union
// of the workflow body's direct proxies + the orchestrator's activity_proxy bridge), so no dispatch hits an
// unregistered name. Two cells override a single stub (the gate's status; the clone's body).
//
// ── GATING (keep validate-fast fast) ──
// The heavier TestWorkflowEnvironment (it boots an ephemeral test server) is gated behind
// `CODEMASTER_TEST_TEMPORAL=1`, mirroring the sibling composition + mutex-lifecycle suites. `npm run test`
// (in validate-fast) runs WITHOUT the flag → the suite is skipped, keeping validate-fast green + fast.

import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { WorkflowFailedError } from "@temporalio/client";
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

/** A seeded, fully-formed v2 payload (parsed through the Zod schema so every default is materialized). The
 *  non-null github_installation_id ARMS the enrich-pr-files + linked-issues + suggested-reviewers body steps
 *  (the Python `github_installation_id is not None` gate) so the happy path drives the full Stage-4 surface
 *  (load-bearing for the replay-determinism cell — the recorded history must exercise the whole spine). */
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
  github_installation_id: 555,
});

// ─── stub config (lets a cell override the gate status / make clone throw) ──────────────────────────

type StubConfig = {
  /** The gate status the startReviewForWebhook stub returns (default "accepted" → full pipeline). When a
   *  non-accepted status is given, the workflow short-circuits and returns the gate result verbatim. */
  readonly gateStatus?: ReviewPullRequestResultV1["status"];
  /** When true, the clone activity THROWS on every attempt (the workflow-level clone-failure cell). */
  readonly cloneThrows?: boolean;
};

// ─── the stub activity surface (registered under the WORKER's REGISTERED names) ─────────────────────
//
// The SAME full activity surface the composition test registers (the 41-name proxied union: 18 orchestrator
// pipeline + the Stage-2 lifecycle + Stage-3 run-lifecycle/delivery/citation/audit + Stage-4 enrichment +
// Stage-5 arbitration/fix-prompt), so NO dispatch hits an unregistered name. Each stub records its dispatch
// into `calls` + returns a canned VALID contract instance. Parameterized by StubConfig so a cell can script
// the gate status or make clone throw.

function makeStubActivities(
  calls: Array<string>,
  config: StubConfig = {},
): Record<string, (input: never) => Promise<unknown>> {
  const acts = {
    // ── Stage-2 lifecycle: GATE — returns the SCRIPTED status (default "accepted"; mints a mutex_id only on
    //    accept, exactly like the real gate which acquires the mutex ONLY on the accepted branch). ──
    startReviewForWebhook: async (): Promise<unknown> => {
      calls.push("gate");
      const status = config.gateStatus ?? "accepted";
      if (status === "accepted") {
        return ReviewPullRequestResultV1.parse({
          status: "accepted",
          pr_number: PAYLOAD.pr_number,
          mutex_id: uuidFor(900),
        });
      }
      // Non-accepted: no mutex acquired (mutex_id stays its null default), mirroring the real gate.
      return ReviewPullRequestResultV1.parse({ status, pr_number: PAYLOAD.pr_number });
    },
    postReviewPlaceholder: async (): Promise<void> => {
      calls.push("postPlaceholder");
    },
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
    recordReviewLifecycleEvent: async (input: { event_type?: string }): Promise<void> => {
      calls.push(input.event_type === "ANALYZED" ? "analyzed" : "analysisStarted");
    },
    finalizeReviewRun: async (): Promise<void> => {
      calls.push("finalizeReviewRun");
    },
    recordRunFailed: async (): Promise<void> => {
      calls.push("recordRunFailed");
    },
    recordRunCancelled: async (): Promise<void> => {
      calls.push("recordRunCancelled");
    },
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
    citationValidate: async (input: { findings?: ReadonlyArray<unknown> }): Promise<unknown> => {
      calls.push("citationValidate");
      return CitationValidationResultV1.parse({ surviving: [...(input.findings ?? [])], dropped: [] });
    },
    emitOutputSafetyAuditEvent: async (): Promise<void> => {
      calls.push("emitAudit");
    },
    renewPrReviewMutexLeaseActivity: async (): Promise<boolean> => {
      calls.push("renewLease");
      return true;
    },
    deleteReviewPlaceholder: async (): Promise<void> => {
      calls.push("deletePlaceholder");
    },
    releasePrReviewMutexActivity: async (): Promise<void> => {
      calls.push("releaseMutex");
    },
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
    fetchLinkedIssues: async (): Promise<unknown> => {
      calls.push("fetchLinkedIssues");
      return [];
    },
    fetchSuggestedReviewers: async (): Promise<unknown> => {
      calls.push("fetchSuggestedReviewers");
      return [];
    },
    buildRetrievedEvidence: async (input: {
      chunk?: { chunk_id?: string; path?: string };
    }): Promise<unknown> => {
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
      // The clone-failure cell makes clone throw on every attempt (a plain Error → retryable; the activity
      // exhausts its 3 attempts then the failure propagates out of orchestrate into the BF-5 outer try).
      if (config.cloneThrows === true) {
        throw new Error("clone failed (workflow-level clone-failure matrix cell)");
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
      calls.push("cleanup");
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

describeTemporal("review-pipeline WORKFLOW matrix + replay determinism (TestWorkflowEnvironment)", () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  }, 60_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  // ── CELL 1: repo disabled by config ──────────────────────────────────────────────────────────────
  it("repo disabled by config (gate=skipped_disabled) returns verbatim and does NO pipeline work", async () => {
    const calls: Array<string> = [];

    // The gate denies the repo (repository.enabled=false → skipped_disabled, NO mutex acquired). The body's
    // `if (pre.status !== "accepted") return pre` short-circuits the ENTIRE workflow before any pipeline work.
    const stubs = makeStubActivities(calls, { gateStatus: "skipped_disabled" });

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.namespace ?? "default",
      taskQueue: "matrix-repo-disabled",
      workflowsPath: WORKFLOWS_PATH,
      dataConverter: { payloadConverterPath: DATA_CONVERTER_PATH },
      activities: stubs,
    });

    const result: ReviewPullRequestResultV1 = await worker.runUntil(
      testEnv.client.workflow.execute("reviewPullRequest", {
        taskQueue: "matrix-repo-disabled",
        workflowId: `matrix-repo-disabled-${PAYLOAD.run_id}`,
        args: [PAYLOAD],
      }),
    );

    // The gate result is returned verbatim — skipped_disabled short-circuits BEFORE any pipeline work.
    expect(result.status).toBe("skipped_disabled");
    expect(result.pr_number).toBe(PAYLOAD.pr_number);
    expect(() => ReviewPullRequestResultV1.parse(result)).not.toThrow();

    // ONLY the gate ran — no placeholder, no enrich, no allocate, no clone, no orchestrate, no post, and
    // critically NO mutex/workspace release (no mutex was ever acquired on the disabled branch).
    expect(calls).toEqual(["gate"]);
    expect(calls).not.toContain("clone");
    expect(calls).not.toContain("postReview");
    expect(calls).not.toContain("releaseMutex");
    expect(calls).not.toContain("cleanup");
  }, 60_000);

  // ── CELL 2: clone failure at the workflow level ──────────────────────────────────────────────────
  it("clone failure fails the workflow, records run FAILED (BF-5), releases BOTH resources, posts NOTHING", async () => {
    const calls: Array<string> = [];

    // The gate accepts (mutex acquired); the clone activity then throws on every attempt. Clone is dispatched
    // INSIDE orchestrate (inside the BF-5 outer try), so its failure propagates: orchestrate rejects → the
    // inner non-cancellable finally releases mutex + workspace → the outer BF-5 catch flips RUNNING → FAILED →
    // the original failure re-propagates (the workflow fails).
    const stubs = makeStubActivities(calls, { cloneThrows: true });

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.namespace ?? "default",
      taskQueue: "matrix-clone-fail",
      workflowsPath: WORKFLOWS_PATH,
      dataConverter: { payloadConverterPath: DATA_CONVERTER_PATH },
      activities: stubs,
    });

    let caught: unknown;
    try {
      await worker.runUntil(
        testEnv.client.workflow.execute("reviewPullRequest", {
          taskQueue: "matrix-clone-fail",
          workflowId: `matrix-clone-fail-${PAYLOAD.run_id}`,
          args: [PAYLOAD],
        }),
      );
    } catch (err) {
      caught = err;
    }

    // ── (a) the workflow FAILED (the clone failure propagated out as a WorkflowFailedError) ──
    expect(caught).toBeInstanceOf(WorkflowFailedError);

    // ── (b) the clone really ran (and threw) — the failure landed at the clone boundary, not vacuously ──
    expect(calls).toContain("clone");

    // ── (c) NOTHING downstream of clone ran: no classify, no aggregate, no post ──
    expect(calls).not.toContain("classify");
    expect(calls).not.toContain("aggregate");
    expect(calls).not.toContain("postReview");
    expect(calls).not.toContain("postCheckRun");

    // ── (d) BF-5: the run was flipped RUNNING → FAILED (a non-cancellation exception), NOT CANCELLED. The
    // cleanup finally already ran before recordRunFailed (the body's outer try/catch order). ANALYZED +
    // finalize never fired (the pipeline aborted at clone). ──
    expect(calls).toContain("recordRunFailed");
    expect(calls).not.toContain("recordRunCancelled");
    expect(calls).not.toContain("analyzed");
    expect(calls).not.toContain("finalizeReviewRun");

    // ── (e) the non-cancellable finally released BOTH resources (no leak on the failure path). The body
    // dispatches releaseMutex + a releaseWorkspace ("cleanup") backstop even on the failure exit. ──
    expect(calls).toContain("releaseMutex");
    expect(calls).toContain("cleanup");
  }, 60_000);

  // ── CELL 3: REPLAY DETERMINISM (the load-bearing one) ────────────────────────────────────────────
  it("a successful workflow history replays WITHOUT a non-determinism error (replay-safe spine + fan-out)", async () => {
    const calls: Array<string> = [];
    const stubs = makeStubActivities(calls); // full happy path (gate accepts; nothing throws)

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.namespace ?? "default",
      taskQueue: "matrix-replay",
      workflowsPath: WORKFLOWS_PATH,
      dataConverter: { payloadConverterPath: DATA_CONVERTER_PATH },
      activities: stubs,
    });

    // Run the happy path to completion, capturing the typed result AND the workflow handle (so we can fetch
    // its committed history). `start` + `result()` gives us the handle; runUntil drives the worker until the
    // execution completes.
    const workflowId = `matrix-replay-${PAYLOAD.run_id}`;
    const handle = await worker.runUntil(async () => {
      const h = await testEnv.client.workflow.start("reviewPullRequest", {
        taskQueue: "matrix-replay",
        workflowId,
        args: [PAYLOAD],
      });
      const result: ReviewPullRequestResultV1 = await h.result();
      // Sanity: the recorded run is the spine happy path (so the history we replay is the full exercised
      // pipeline, not a degenerate short-circuit). A replay of a 1-event history would prove nothing.
      expect(result.status).toBe("accepted");
      expect(result.findings_count).toBe(1);
      return h;
    });

    // Cross-check the recorded run drove the full spine before we replay it — the history is load-bearing
    // (gate → clone → fan-out → aggregate → post → cleanup). A vacuous history would make the replay assertion
    // meaningless.
    expect(calls).toContain("clone");
    expect(calls).toContain("reviewChunk");
    expect(calls).toContain("aggregate");
    expect(calls).toContain("postReview");
    expect(calls).toContain("cleanup");

    // Fetch the COMMITTED history of the successful run (the durable event stream Temporal persisted).
    const history = await handle.fetchHistory();
    expect(history.events?.length ?? 0).toBeGreaterThan(0);

    // ── THE LOAD-BEARING ASSERTION ──
    // Replay the recorded history through a replay Worker built from the SAME workflow bundle + data
    // converter (NO activities — replay never executes activities; it feeds the recorded results back). If
    // the workflow body / orchestrate() / the fan-out produced a DIFFERENT command stream on replay than the
    // recorded history, `runReplayHistory` throws a `DeterminismViolationError`. A clean resolve PROVES the
    // gate-collapse straight-line body + the index-ordered fan-in are replay-safe (no wall-clock / crypto /
    // RNG inside the sandbox; the only `now` is the SDK-provided replay-deterministic workflowInfo().startTime).
    await expect(
      Worker.runReplayHistory(
        {
          workflowsPath: WORKFLOWS_PATH,
          dataConverter: { payloadConverterPath: DATA_CONVERTER_PATH },
          replayName: "matrix-replay-determinism",
        },
        history,
        workflowId,
      ),
    ).resolves.toBeUndefined();
  }, 120_000);
});
