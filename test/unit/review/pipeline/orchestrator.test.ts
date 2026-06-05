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

import {
  orchestrate,
  filterReviewPaths,
  type ReviewPipelineContext,
} from "#backend/review/pipeline/orchestrator.js";
import { ReviewWorkflowState } from "#backend/review/pipeline/state.js";

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
  bundles?: Record<string, ResolvedGuidanceBundleV1>;
  selectCarryForwardThrows?: boolean;
  embedThrows?: boolean;
  retrieveThrows?: boolean;
  retrieveDegraded?: boolean;
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
};

type RecordingStub = {
  ports: ReviewActivityPorts;
  calls: Array<string>;
  reviewChunkInputs: Array<ReviewContextV1>;
  embedCalls: Array<string>;
  citationInputs: Array<CitationValidateInputV1>;
  auditEvents: Array<EmitOutputSafetyAuditEventInput>;
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
      return CodemasterConfigV1.parse({ path_filters: o.pathFilters ?? [] });
    },
    computePolicyRules: async () => {
      calls.push("computePolicyRules");
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
      return StaticAnalysisResultV1.parse({});
    },
    selectCarryForward: async (input) => {
      calls.push("selectCarryForward");
      if (o.selectCarryForwardThrows) {
        throw new Error("carry-forward boom");
      }
      return CarryForwardSelectionV1.parse({
        carried: [],
        to_review: [...input.currentChunks],
        parent_review_id: input.parentReviewId,
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
        items: [],
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
        findings: [findingFor(1)],
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
        policy_revision: input.policyRevision,
      });
    },
    persistReviewFindings: async (input) => {
      calls.push("persistReviewFindings");
      if (o.persistThrows) {
        throw new Error("persist boom");
      }
      return input.aggregated.findings.map((_f, i) => uuidFor(500 + i));
    },
    generateWalkthrough: async () => {
      calls.push("generateWalkthrough");
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

  return {
    ports,
    calls,
    reviewChunkInputs,
    embedCalls,
    citationInputs,
    auditEvents,
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
      headSha: "abc1234",
      runId: uuidFor(4),
      reviewId: uuidFor(5),
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
// Tests
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("orchestrate — happy-path stage order", () => {
  it("dispatches the spine activities in the Python stage order", async () => {
    const stub = makeStub({ chunkCount: 1 });
    const result = await orchestrate(makeCtx(stub));

    expect(result.status).toBe("accepted");
    expect(result.headSha).toBe("abc1234");
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
  it("invokes ctx.claimCheck exactly three times at the Python boundaries (clone/classify/aggregate)", async () => {
    // The claim-check records the LAST stage dispatched at each invocation, so we can assert it fires
    // BEFORE clone (empty trace), BEFORE classify (after computePolicyRules), and BEFORE aggregate
    // (after dedupFindings) — the three `_abort_if_claim_lost` sites.
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
    expect(checkPositions).toEqual(["<before-clone>", "computePolicyRules", "dedupFindings"]);
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

  it("dispatches citationValidate between aggregate and persist (skip-mode knowledge_chunk_ids=null)", async () => {
    const stub = makeStub({ chunkCount: 1, withCitationValidate: true, citationDropCount: 0 });
    await orchestrate(makeCtx(stub));
    const aggIdx = stub.calls.indexOf("aggregate");
    const citIdx = stub.calls.indexOf("citationValidate");
    const persistIdx = stub.calls.indexOf("persistReviewFindings");
    expect(aggIdx).toBeGreaterThanOrEqual(0);
    expect(citIdx).toBeGreaterThan(aggIdx);
    expect(persistIdx).toBeGreaterThan(citIdx);
    // skip-mode: knowledge_chunk_ids travels as null (NOT [] — the null/array distinction is load-bearing).
    expect(stub.citationInputs[0]!.knowledge_chunk_ids).toBeNull();
    // observe-mode policy citation context (empty rule_ids — no bundles in this fixture).
    expect(stub.citationInputs[0]!.policy_citation?.enforcement).toBe("observe");
    expect(stub.citationInputs[0]!.workspace_path).toBe("/ws/abc/repo");
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

describe("filterReviewPaths — path_filters last-match-wins", () => {
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
