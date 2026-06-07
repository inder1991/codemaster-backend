// Orchestrate-level FAILURE / FAIL-OPEN / CAP matrix for orchestrate()
// (apps/backend/src/review/pipeline/orchestrator.ts) — the 1:1 port of the frozen Python
// orchestrate_review_pipeline (review_pipeline_orchestrator.py) FUSED with the workflow body's
// `_review_chunk` per-chunk context build.
//
// This file is the COMPANION to test/unit/review/pipeline/orchestrator.test.ts (which it does NOT
// clobber). orchestrator.test.ts covers the happy-path stage order, per-chunk context build, the
// already-wired degradation branches (classifier ratio, carry-forward fallback, dedup skip, persist
// fail-open, retrieval fail-open), the path-filters-excluded-all early exit, the Stage-3/4/5 wiring
// (citation / audit-emit / evidence / arbitration / fix-prompt), the config notice, and the caps.
//
// THIS file adds the failure-mode scenarios that were NOT yet asserted at orchestrate() level, each
// pinned to the FROZEN Python behaviour (hard-fail-vs-fail-open; the exact degradation-note text;
// cleanup-always-runs). The behaviour each scenario asserts was confirmed against the frozen Python
// (vendor/codemaster-py) — the subtle ones (clone HARD-fail outside the try; LLM single-chunk failure
// propagating the WHOLE review per anyio.create_task_group; static-analysis tool-error note text;
// walkthrough fallback living INSIDE the activity) are documented inline at each block.
//
// Scenarios added here (see the matrix audit in the task):
//   * CLONE failure → propagates (HARD fail, no degrade; clone is OUTSIDE the try → cleanup NOT armed).
//   * CLASSIFY partial failure (> 10%) → degradation note AND the review still posts (end-to-end).
//   * STATIC-ANALYSIS tool failures (per_tool_errors / truncated_per_tool, reported as DATA) →
//     degradation note(s), review continues. PLUS: the static-analysis ACTIVITY raising → HARD fail
//     (Promise.all branch propagates), cleanup still runs.
//   * LLM single-chunk failure (one of N reviewChunk dispatches throws) → the WHOLE review FAILS
//     (fan-out re-raises; the other chunks' results are discarded), cleanup still runs.
//   * WALKTHROUGH: the synthesized-fallback WalkthroughV1 (degradation_note + synthesized file_rows,
//     the activity's collapsed-on fallback) FLOWS THROUGH to post normally; a genuine (non-fallback)
//     walkthrough-port throw PROPAGATES (orchestrate bare-awaits it), cleanup still runs.
//   * CLEANUP failure → swallowed via stageOutcome (does NOT fail the review).
import { describe, it, expect } from "vitest";

import {
  orchestrate,
  type ReviewPipelineContext,
} from "#backend/review/pipeline/orchestrator.js";
import { ReviewWorkflowState } from "#backend/review/pipeline/state.js";
import { synthesizeFileRowsFromAggregated } from "#backend/review/file_rows_synthesizer.js";

import type { ReviewActivityPorts, ChangedLineRanges } from "#backend/review/pipeline/activity_ports.js";
import type { ReviewContextV1 } from "#contracts/review_context.v1.js";
import { PrMetaV1 } from "#contracts/walkthrough.v1.js";
import { WorkspaceHandle } from "#contracts/workspace_handle.v1.js";
import { ClonedRepoV1 } from "#contracts/cloned_repo.v1.js";
import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import { ComputedPolicyRulesV1 } from "#contracts/policy_compute.v1.js";
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures — built through the Zod schemas so contract defaults / validators apply (1:1 with the
// orchestrator.test.ts fixtures so the two files exercise identical inputs).
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

type StubOverrides = {
  reviewFiles?: ReadonlyArray<string>;
  sandboxFiles?: ReadonlyArray<string>;
  classifierFailures?: ReadonlyArray<string>;
  chunkCount?: number;
  // ── failure-mode overrides ──
  /** clone activity throws (HARD fail; clone is OUTSIDE the try → cleanup NOT armed). */
  cloneThrows?: boolean;
  /** staticAnalysis returns these per_tool_errors (reported as DATA → degradation note). */
  perToolErrors?: Record<string, string>;
  /** staticAnalysis returns these truncated_per_tool counts (reported as DATA → degradation note). */
  truncatedPerTool?: Record<string, number>;
  /** the staticAnalysis ACTIVITY itself throws (HARD fail via the Promise.all branch). */
  staticAnalysisThrows?: boolean;
  /** the chunk_id suffix whose reviewChunk dispatch throws (LLM single-chunk failure). */
  reviewChunkThrowsForChunkIndex?: number;
  /** generateWalkthrough returns the synthesized-fallback WalkthroughV1 (the activity's collapsed-on
   *  fallback: degradation_note + synthesized file_rows) — NOT a throw. */
  walkthroughFallback?: boolean;
  /** generateWalkthrough activity itself throws (a genuine non-fallback failure → propagates). */
  walkthroughThrows?: boolean;
  /** cleanup activity throws (must be SWALLOWED by the finally's stageOutcome). */
  cleanupThrows?: boolean;
};

type RecordingStub = {
  ports: ReviewActivityPorts;
  calls: Array<string>;
  reviewChunkInputs: Array<ReviewContextV1>;
  cleanupCalled: () => boolean;
};

function makeStub(o: StubOverrides = {}): RecordingStub {
  const calls: Array<string> = [];
  const reviewChunkInputs: Array<ReviewContextV1> = [];
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
      if (o.cloneThrows) {
        throw new Error("clone boom");
      }
      return ClonedRepoV1.parse({
        workspace_path: "/ws/abc",
        repo_path: "/ws/abc/repo",
        head_sha: "abc1234",
        byte_size: 10,
      });
    },
    loadRepoConfig: async () => {
      calls.push("loadRepoConfig");
      return CodemasterConfigV1.parse({ path_filters: [] });
    },
    computePolicyRules: async () => {
      calls.push("computePolicyRules");
      return ComputedPolicyRulesV1.parse({ bundles: {} });
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
      if (o.staticAnalysisThrows) {
        throw new Error("static-analysis boom");
      }
      return StaticAnalysisResultV1.parse({
        per_tool_errors: o.perToolErrors ?? {},
        truncated_per_tool: o.truncatedPerTool ?? {},
      });
    },
    selectCarryForward: async (input) => {
      calls.push("selectCarryForward");
      return CarryForwardSelectionV1.parse({
        carried: [],
        to_review: [...input.currentChunks],
        parent_review_id: input.parentReviewId,
      });
    },
    embedQuery: async () => {
      calls.push("embedQuery");
      return EmbedQueryResultV1.parse({ vector: [0.1, 0.2, 0.3] });
    },
    retrieveKnowledge: async () => {
      calls.push("retrieveKnowledge");
      return RetrieveKnowledgeResultV1.parse({
        items: [],
        retrieval_degraded: false,
        degradation_reason: "",
      });
    },
    reviewChunk: async (input) => {
      calls.push("reviewChunk");
      reviewChunkInputs.push(input);
      // LLM single-chunk failure: the chunk whose chunk_id matches the requested failing index throws.
      // (chunkFor mints chunk_id = uuidFor(100 + i), so the suffix encodes 100 + i.)
      if (o.reviewChunkThrowsForChunkIndex !== undefined) {
        const failingChunkId = uuidFor(100 + o.reviewChunkThrowsForChunkIndex);
        if (input.chunk.chunk_id === failingChunkId) {
          throw new Error(`review-chunk boom for index ${o.reviewChunkThrowsForChunkIndex}`);
        }
      }
      return ReviewChunkResponseV1.parse({
        findings: [findingFor(1)],
        arbitration_intents: [],
        sanitization_event: null,
      });
    },
    dedupFindings: async (input) => {
      calls.push("dedupFindings");
      return DedupedFindingsV1.parse({
        findings: [...input.llm_findings],
        semantic_skipped: false,
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
        policy_revision: input.policyRevision,
      });
    },
    persistReviewFindings: async (input) => {
      calls.push("persistReviewFindings");
      return input.aggregated.findings.map((_f, i) => uuidFor(500 + i));
    },
    generateWalkthrough: async (input) => {
      calls.push("generateWalkthrough");
      if (o.walkthroughThrows) {
        // A genuine (non-fallback) walkthrough failure. In the TS port the activity's collapsed-on
        // fallback handles cost-cap/output-safety/parse-error by RETURNING a synthesized walkthrough;
        // a throw here models an UNHANDLED infra failure that the orchestrator bare-awaits → propagate.
        throw new Error("walkthrough boom");
      }
      if (o.walkthroughFallback) {
        // The activity's collapsed-on fallback shape: synthesized file_rows + the degradation_note. The
        // activity NEVER throws for the fallback case — it returns this WalkthroughV1 directly, which the
        // orchestrator's bare await flows straight through to post.
        return WalkthroughV1.parse({
          tldr:
            "Walkthrough generation temporarily unavailable. " +
            `${input.aggregated.findings.length} finding(s) detected; see inline comments below.`,
          file_rows: synthesizeFileRowsFromAggregated(input.aggregated.findings),
          configuration_section_md: "",
          truncated: false,
          degradation_note:
            "walkthrough generation failed; per-file table synthesized from aggregated findings",
          sanitization_event: null,
        });
      }
      return WalkthroughV1.parse({ tldr: "all good", sanitization_event: null });
    },
    persistReviewWalkthrough: async () => {
      calls.push("persistReviewWalkthrough");
    },
    postReview: async () => {
      calls.push("postReview");
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
      return PostedCheckRunV1.parse({ check_run_id: 9, was_update: false });
    },
    cleanup: async () => {
      calls.push("cleanup");
      if (o.cleanupThrows) {
        throw new Error("cleanup boom");
      }
      cleanupCalled = true;
    },
  };

  return {
    ports,
    calls,
    reviewChunkInputs,
    cleanupCalled: () => cleanupCalled,
  };
}

function makeCtx(stub: RecordingStub, logger?: { warning(msg: string): void }): ReviewPipelineContext {
  const base: ReviewPipelineContext = {
    repo: {
      repoUrl: "https://example.com/acme/widgets.git",
      changedPaths: ["src/a.ts", "src/b.ts"],
      workspaceHandle: HANDLE,
    },
    pr: {
      prMeta: PR_META,
      // 40-char git SHA — the Sub-spec B T17 confluence-context build (pickPrContext → PRContext.parse)
      // validates head_sha min/max_length=40, so the per-chunk PRContext requires a real-shaped SHA.
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
  return logger === undefined ? base : { ...base, logger };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLONE failure — HARD fail, no degradation. Clone is OUTSIDE the try (Python orchestrator
// review_pipeline_orchestrator.py:511 — `cloned = await clone(...)` BEFORE `try:`), so a clone
// failure ends the workflow with NO partial review and the finally-block cleanup is NOT armed (the
// workspace was never populated). The workflow body's BF-5 maps this terminal rejection to a
// run_failed lifecycle row; at orchestrate() level the contract is simply "the rejection propagates".
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("orchestrate — CLONE failure propagates (HARD fail, no degrade)", () => {
  it("rejects when the clone activity throws (no downstream stage runs)", async () => {
    const stub = makeStub({ cloneThrows: true });
    await expect(orchestrate(makeCtx(stub))).rejects.toThrow(/clone boom/);
    // clone was attempted, but NOTHING downstream ran.
    expect(stub.calls).toEqual(["clone"]);
    expect(stub.calls).not.toContain("loadRepoConfig");
    expect(stub.calls).not.toContain("classify");
    expect(stub.calls).not.toContain("reviewChunk");
    expect(stub.calls).not.toContain("postReview");
  });

  it("does NOT run cleanup on a clone failure (clone is OUTSIDE the try → finally not armed)", async () => {
    const stub = makeStub({ cloneThrows: true });
    await expect(orchestrate(makeCtx(stub))).rejects.toThrow(/clone boom/);
    // The finally arms only once clone returns; a clone throw never enters the try → cleanup not called.
    expect(stub.calls).not.toContain("cleanup");
    expect(stub.cleanupCalled()).toBe(false);
  });

  it("appends NO degradation note on a clone failure (it is a hard fail, not a degrade)", async () => {
    const stub = makeStub({ cloneThrows: true });
    const ctx = makeCtx(stub);
    await expect(orchestrate(ctx)).rejects.toThrow(/clone boom/);
    // clone failure is terminal — the orchestrator never reaches a degradation-note site.
    expect(ctx.state.degradation.notes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLASSIFY partial failure (classifier_failure_ratio > 0.10) — degradation note, review CONTINUES to
// post end-to-end. (review_pipeline_orchestrator.py:551 — `failure_ratio = len(failures)/max(1,n)`;
// the note fires when the ratio exceeds _CLASSIFIER_FAILURE_THRESHOLD = 0.10.) This complements the
// note-presence assertion in orchestrator.test.ts with the full end-to-end "review still posts" path.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("orchestrate — CLASSIFY partial failure (> 10%) degrades but continues", () => {
  it("appends the classifier note AND posts the review end-to-end (1/2 files failed → ratio 0.5)", async () => {
    const stub = makeStub({ chunkCount: 1, classifierFailures: ["src/a.ts"] });
    const result = await orchestrate(makeCtx(stub));
    expect(result.status).toBe("accepted");
    // The degradation note carries the exact Python text (verified against the frozen module).
    expect(result.degradationNotes).toContain(
      "file classification failed for 1/2 files; results may be incomplete",
    );
    // The review continues through the WHOLE chain despite the partial classification failure.
    expect(stub.calls).toContain("reviewChunk");
    expect(stub.calls).toContain("aggregate");
    expect(stub.calls).toContain("persistReviewFindings");
    expect(stub.calls).toContain("generateWalkthrough");
    expect(stub.calls).toContain("postReview");
    expect(stub.calls).toContain("cleanup");
    expect(result.classifierFailureRatio).toBeCloseTo(0.5);
  });

  it("does NOT append the note at or below the threshold (1/11 → ratio ~0.09)", async () => {
    // 11 changed paths, 1 failure → ratio ≈ 0.0909 ≤ 0.10 → no note.
    const manyPaths = Array.from({ length: 11 }, (_v, i) => `src/f${i}.ts`);
    const stub = makeStub({ chunkCount: 1, reviewFiles: manyPaths, classifierFailures: ["src/f0.ts"] });
    const ctx = makeCtx(stub);
    // override the orchestrator's changed-paths denominator to the 11-path set.
    const ctx11: ReviewPipelineContext = { ...ctx, repo: { ...ctx.repo, changedPaths: manyPaths } };
    const result = await orchestrate(ctx11);
    expect(result.degradationNotes.some((n) => n.startsWith("file classification failed"))).toBe(
      false,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// STATIC-ANALYSIS failures — two distinct shapes:
//   (a) TOOL-level failures reported as DATA on StaticAnalysisResultV1.per_tool_errors /
//       .truncated_per_tool → degradation note(s), review CONTINUES. (The Python orchestrator
//       review_pipeline_orchestrator.py:638-649 appends "static-analysis tool failures: <sorted>"
//       and "static-analysis truncated: <tool=count,...>".)
//   (b) the static-analysis ACTIVITY itself RAISING → HARD fail: in the Python it runs in an
//       anyio.create_task_group branch (`_sa_branch`) so a raise propagates; the TS port runs it in
//       Promise.all alongside chunkAndRedact, so a rejection propagates out of orchestrate. Cleanup
//       still runs (we are inside the try). The per_tool_errors path is the DEGRADE; the activity
//       RAISING is the HARD fail.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("orchestrate — STATIC-ANALYSIS tool failures degrade but continue", () => {
  it("appends the per_tool_errors note (sorted tool names) and continues to post", async () => {
    const stub = makeStub({
      chunkCount: 1,
      perToolErrors: { ruff: "boom", eslint: "timeout" },
    });
    const result = await orchestrate(makeCtx(stub));
    expect(result.status).toBe("accepted");
    // sorted tool names (eslint before ruff) — exact Python text.
    expect(result.degradationNotes).toContain("static-analysis tool failures: eslint, ruff");
    expect(stub.calls).toContain("postReview");
  });

  it("appends the truncated_per_tool note (sorted tool=count) and continues", async () => {
    const stub = makeStub({
      chunkCount: 1,
      truncatedPerTool: { eslint: 100, bandit: 5 },
    });
    const result = await orchestrate(makeCtx(stub));
    // sorted by tool name (bandit before eslint) — exact Python text.
    expect(result.degradationNotes).toContain("static-analysis truncated: bandit=5, eslint=100");
    expect(stub.calls).toContain("postReview");
  });

  it("appends BOTH notes when per_tool_errors AND truncated_per_tool are populated", async () => {
    const stub = makeStub({
      chunkCount: 1,
      perToolErrors: { eslint: "boom" },
      truncatedPerTool: { eslint: 100 },
    });
    const result = await orchestrate(makeCtx(stub));
    expect(result.degradationNotes).toContain("static-analysis tool failures: eslint");
    expect(result.degradationNotes).toContain("static-analysis truncated: eslint=100");
  });

  it("appends NO static-analysis note on a clean static-analysis result", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const result = await orchestrate(makeCtx(stub));
    expect(result.degradationNotes.some((n) => n.startsWith("static-analysis"))).toBe(false);
  });
});

describe("orchestrate — STATIC-ANALYSIS activity raising is a HARD fail", () => {
  it("propagates when the static-analysis activity throws, but cleanup still runs", async () => {
    // staticAnalysis runs in the Promise.all branch (alongside chunkAndRedact); a throw propagates out
    // of orchestrate. The throw happens INSIDE the try → the finally-block cleanup still releases.
    const stub = makeStub({ chunkCount: 1, staticAnalysisThrows: true });
    await expect(orchestrate(makeCtx(stub))).rejects.toThrow(/static-analysis boom/);
    // We never reached the post stages.
    expect(stub.calls).not.toContain("reviewChunk");
    expect(stub.calls).not.toContain("postReview");
    // …but cleanup ran (the throw was inside the try → finally armed).
    expect(stub.cleanupCalled()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// LLM single-chunk failure — one of N reviewChunk dispatches throws. PORTED BEHAVIOUR (confirmed
// empirically against the frozen Python fan_out_review, parallelism.py): a single chunk activity
// raising propagates through the anyio.create_task_group → the WHOLE review FAILS (it does NOT drop
// the offending chunk and continue). The TS fanOutReview mirrors this — the rejection propagates
// through Promise.all, and the orchestrator wraps reviewChunk in stageOutcome(raiseAfterLog:true) which
// re-raises. So one bad chunk in a multi-chunk PR fails the whole review; cleanup still runs (try).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("orchestrate — LLM single-chunk failure FAILS the whole review (no drop-the-chunk)", () => {
  it("propagates when ONE of several chunks throws (the review does not silently drop it)", async () => {
    // 3 chunks; the SECOND (index 1 → chunk_id suffix 101) throws. fanOutReview re-raises → orchestrate
    // rejects. The other chunks' partial results are discarded (the whole fan-in is thrown away).
    const stub = makeStub({ chunkCount: 3, reviewChunkThrowsForChunkIndex: 1 });
    await expect(orchestrate(makeCtx(stub))).rejects.toThrow(/review-chunk boom for index 1/);
    // The review never reached dedup/aggregate/persist/post — the single chunk failure was fatal.
    expect(stub.calls).not.toContain("dedupFindings");
    expect(stub.calls).not.toContain("aggregate");
    expect(stub.calls).not.toContain("postReview");
  });

  it("still runs cleanup when a single chunk failure propagates (finally armed)", async () => {
    const stub = makeStub({ chunkCount: 3, reviewChunkThrowsForChunkIndex: 0 });
    await expect(orchestrate(makeCtx(stub))).rejects.toThrow(/review-chunk boom/);
    expect(stub.cleanupCalled()).toBe(true);
  });

  it("does NOT throw when every chunk succeeds (control: the matrix isolates the single-failure axis)", async () => {
    const stub = makeStub({ chunkCount: 3 }); // no failing index
    const result = await orchestrate(makeCtx(stub));
    expect(result.status).toBe("accepted");
    expect(stub.calls.filter((c) => c === "reviewChunk").length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WALKTHROUGH — two distinct shapes at orchestrate() level (the fallback restructure moved INTO the
// activity during the port, walkthrough_activity.ts):
//   (a) the synthesized-fallback WalkthroughV1 (degradation_note + synthesized file_rows) is RETURNED
//       by the activity (NOT thrown) for cost-cap / output-safety / parse-error. At orchestrate()
//       level this flows straight through the bare `await generateWalkthrough(...)` to post — the
//       degradation_note + synthesized table land on the posted walkthrough.
//   (b) a genuine (non-fallback / infra) walkthrough-port THROW propagates (the orchestrator
//       bare-awaits generateWalkthrough — Python review_pipeline_orchestrator.py:926 is also a bare
//       `await generate_walkthrough(...)`), cleanup still runs.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("orchestrate — WALKTHROUGH synthesized-fallback flows through to post", () => {
  it("posts the synthesized-fallback walkthrough (degradation_note + synthesized file_rows) unchanged", async () => {
    const stub = makeStub({ chunkCount: 1, walkthroughFallback: true });
    const result = await orchestrate(makeCtx(stub));
    expect(result.status).toBe("accepted");
    // The fallback walkthrough's degradation_note + synthesized table survived onto the result.
    expect(result.walkthrough?.degradation_note).toBe(
      "walkthrough generation failed; per-file table synthesized from aggregated findings",
    );
    expect(result.walkthrough?.file_rows.length).toBe(1); // synthesized from the 1 aggregated finding
    expect(result.walkthrough?.tldr).toContain("temporarily unavailable");
    // post + cleanup still ran — the fallback is a normal (non-error) return value at this seam.
    expect(stub.calls).toContain("postReview");
    expect(stub.calls).toContain("postCheckRun");
    expect(stub.cleanupCalled()).toBe(true);
  });
});

describe("orchestrate — WALKTHROUGH genuine (non-fallback) throw propagates", () => {
  it("propagates an unhandled walkthrough-port throw, but cleanup still runs", async () => {
    const stub = makeStub({ chunkCount: 1, walkthroughThrows: true });
    await expect(orchestrate(makeCtx(stub))).rejects.toThrow(/walkthrough boom/);
    // generateWalkthrough is bare-awaited (no stageOutcome) → the throw is fatal AND happens before post.
    expect(stub.calls).toContain("generateWalkthrough");
    expect(stub.calls).not.toContain("postReview");
    // cleanup still released (the throw was inside the try → finally armed).
    expect(stub.cleanupCalled()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLEANUP failure — swallowed via the finally's stageOutcome (review_pipeline_orchestrator.py:973-1010
// — the cleanup stage_outcome on the failure path appends `cleanup_failed` + emits record_stage(error)
// but SWALLOWS; cleanup must NEVER fail an already-completed review). At orchestrate() level: a
// successful review whose cleanup throws still RESOLVES "accepted", with a `cleanup_failed` note.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("orchestrate — CLEANUP failure is swallowed (does not fail the review)", () => {
  it("resolves 'accepted' even when the cleanup activity throws", async () => {
    const stub = makeStub({ chunkCount: 1, cleanupThrows: true });
    const ctx = makeCtx(stub);
    const result = await orchestrate(ctx);
    // The review COMPLETED (posted) — the cleanup failure was swallowed by the finally's stageOutcome.
    expect(result.status).toBe("accepted");
    expect(stub.calls).toContain("postReview");
    expect(stub.calls).toContain("cleanup");
    // The swallowed failure is surfaced as a `cleanup_failed` marker on the LIVE degradation collector —
    // NOT on result.degradationNotes. LOAD-BEARING parity detail: makeReviewPipelineResult snapshots
    // state.degradation.notes INSIDE the try (orchestrator.ts:752-774), and cleanup runs in the finally
    // AFTER that snapshot — so the marker lands on state but not the already-built result. Mirrors the
    // frozen Python, which builds ReviewPipelineResult(degradation_notes=tuple(...)) at
    // review_pipeline_orchestrator.py:958-972 (in the try) before the finally cleanup at :974. The
    // workflow body reads the LIVE collector after orchestrate returns, so the marker is not lost.
    expect(result.degradationNotes).not.toContain("cleanup_failed");
    expect(ctx.state.degradation.notes).toContain("cleanup_failed");
  });

  it("emits the cleanup WARN line on the injected logger but still resolves", async () => {
    const warnings: Array<string> = [];
    const stub = makeStub({ chunkCount: 1, cleanupThrows: true });
    const result = await orchestrate(makeCtx(stub, { warning: (m) => warnings.push(m) }));
    expect(result.status).toBe("accepted");
    expect(warnings.some((w) => w.includes("cleanup failed"))).toBe(true);
  });
});
