// Tier-1 parity: the TS rerank-fallback + pr_context build vs the FROZEN Python.
//
// The expected constants below were extracted by running the frozen Python directly (Python 3.14
// vendored venv):
//   - codemaster.retrieval.llm_rerank.LlmRerank.apply (UNAVAILABLE fallback path)
//   - codemaster.review.pr_context_builder.build_pr_context_full / build_pr_context_mvp
// See the extraction script in the task notes; the values are reproduced here as the parity oracle so a
// future regression in the TS port is caught against the frozen reference, not a re-derivation.

import { describe, expect, it } from "vitest";

import {
  LlmRerank,
  type LlmRerankerPort,
  LlmRerankUnavailableError,
} from "#backend/retrieval/llm_rerank.js";
import {
  buildPrContextFull,
  buildPrContextMvp,
} from "#backend/retrieval/pr_context_builder.js";

import type {
  KnowledgeChunkV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";
import type { PrFileV1 } from "#contracts/pr_file.v1.js";
import type { PrFilesEnrichmentResultV1 } from "#contracts/pr_files_enrichment.v1.js";

/** Deterministic UUID matching the Python `uuid.UUID(int=n)` extraction fixtures. */
function u(n: number): string {
  return `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
}

// ─── FROZEN-PYTHON REFERENCE OUTPUTS ────────────────────────────────────────────────────────────────

const FROZEN_RERANK_FALLBACK = {
  degraded: true,
  reason: "rerank LLM unavailable",
  len: 5,
  paths: ["d0.md", "d1.md", "d2.md", "d3.md", "d4.md"],
  stages: ["rerank"],
} as const;

const FROZEN_FULL = {
  paths: ["src/a.py", "src/b.py", "tests/test_a.py", "docs/README.md"],
  counts: [
    [1, 2],
    [3, 0],
    [5, 1],
    [0, 10],
  ],
  headSha: "d".repeat(40),
  manifests: [] as const,
  // Frozen Python's real classify_files flags tests/test_a.py is_test=true. The TS detection-classifier
  // port is DEFERRED (FOLLOW-UP-pr-context-classifier-port), so the TS identity classifier emits all
  // false. Recorded here as the parity DELTA the follow-up closes.
  pythonTestCls: [false, false, true, false],
} as const;

const FROZEN_MVP = {
  path: "src/some/file.py",
  addDel: [0, 0],
  clsTest: false,
  manifests: [] as const,
} as const;

// ─── Rerank fallback parity ─────────────────────────────────────────────────────────────────────────

class Unreachable implements LlmRerankerPort {
  public async rerank(): Promise<ReadonlyArray<number>> {
    throw new LlmRerankUnavailableError("simulated outage");
  }
}

function chunk(i: number): KnowledgeChunkV1 {
  return {
    schema_version: 2,
    chunk_id: u(100 + i),
    installation_id: u(1),
    repo_id: u(2),
    relative_path: `d${i}.md`,
    chunk_index: 0,
    heading_path: [],
    body: "b",
    doc_kind: "other",
    doc_status: "active",
    source: "repo_knowledge",
    space_key: null,
    page_id: null,
    page_version: null,
    labels: [],
    match_specificity_score: 0,
    age_days: 0,
  };
}

describe("Tier-1 parity: LlmRerank UNAVAILABLE fallback", () => {
  it("matches the frozen Python fallback (degraded, reason, top-5, paths, stage rewrite)", async () => {
    const items: Array<ScoredKnowledgeChunkV1> = Array.from({ length: 8 }, (_, i) => ({
      schema_version: 1,
      chunk: chunk(i),
      score: 0.1 * (i + 1),
      stage: "rrf",
    }));
    const candidates: RetrievedKnowledgeV1 = {
      schema_version: 1,
      items,
      degraded: false,
      degradation_reason: "",
      starvation_tiers: [],
      source_counts: {},
    };
    const out = await new LlmRerank({ port: new Unreachable() }).apply({ query: "x", candidates });
    expect(out.degraded).toBe(FROZEN_RERANK_FALLBACK.degraded);
    expect(out.degradation_reason).toBe(FROZEN_RERANK_FALLBACK.reason);
    expect(out.items.length).toBe(FROZEN_RERANK_FALLBACK.len);
    expect(out.items.map((i) => i.chunk.relative_path)).toEqual(FROZEN_RERANK_FALLBACK.paths);
    expect([...new Set(out.items.map((i) => i.stage))].sort()).toEqual(FROZEN_RERANK_FALLBACK.stages);
  });
});

// ─── pr_context build parity ──────────────────────────────────────────────────────────────────────

function pf(path: string, additions: number, deletions: number): PrFileV1 {
  return {
    schema_version: 1,
    pr_file_id: u(900),
    pr_id: u(10),
    installation_id: u(1),
    repository_id: u(2),
    file_path: path,
    status: "modified",
    additions,
    deletions,
    previous_path: null,
    language: null,
    created_at: "2026-05-27T12:00:00.000Z",
  };
}

describe("Tier-1 parity: build_pr_context_full", () => {
  it("matches the frozen Python multi-file order + counts + head_sha + manifests", () => {
    const enrichment: PrFilesEnrichmentResultV1 = {
      schema_version: 1,
      files: [
        pf("src/a.py", 1, 2),
        pf("src/b.py", 3, 0),
        pf("tests/test_a.py", 5, 1),
        pf("docs/README.md", 0, 10),
      ],
      changed_line_ranges: {},
      truncated_at: null,
    };
    const ctx = buildPrContextFull({
      prId: u(10),
      headSha: "d".repeat(40),
      repoDefaultBranch: "main",
      enrichment,
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.changed_files.map((cf) => cf.path)).toEqual(FROZEN_FULL.paths);
    expect(ctx!.changed_files.map((cf) => [cf.additions, cf.deletions])).toEqual(FROZEN_FULL.counts);
    expect(ctx!.head_sha).toBe(FROZEN_FULL.headSha);
    expect(ctx!.manifests).toEqual(FROZEN_FULL.manifests);
  });

  it("classification is_test matches frozen classify_files (tests/test_a.py → true)", () => {
    // The default classifier is now the real detection-pipeline classify_files, so TS classification
    // matches the frozen Python output — closes the former FOLLOW-UP-pr-context-classifier-port delta.
    const enrichment: PrFilesEnrichmentResultV1 = {
      schema_version: 1,
      files: [
        pf("src/a.py", 1, 2),
        pf("src/b.py", 3, 0),
        pf("tests/test_a.py", 5, 1),
        pf("docs/README.md", 0, 10),
      ],
      changed_line_ranges: {},
      truncated_at: null,
    };
    const ctx = buildPrContextFull({
      prId: u(10),
      headSha: "d".repeat(40),
      repoDefaultBranch: "main",
      enrichment,
    });
    expect(ctx).not.toBeNull();
    const tsTestCls = ctx!.changed_files.map((cf) => cf.classification.is_test);
    // TS now MATCHES the frozen Python classify_files output (parity, not a delta).
    expect(tsTestCls).toEqual(FROZEN_FULL.pythonTestCls);
    expect(tsTestCls).toEqual([false, false, true, false]);
  });
});

describe("Tier-1 parity: build_pr_context_mvp", () => {
  it("matches the frozen Python single-file MVP (path, placeholder add/del, no cls, no manifests)", () => {
    const mvp = buildPrContextMvp({
      prId: u(10),
      headSha: "9".repeat(40),
      repoDefaultBranch: "main",
      chunkPath: "src/some/file.py",
    });
    expect(mvp.changed_files[0]!.path).toBe(FROZEN_MVP.path);
    expect([mvp.changed_files[0]!.additions, mvp.changed_files[0]!.deletions]).toEqual(
      FROZEN_MVP.addDel,
    );
    expect(mvp.changed_files[0]!.classification.is_test).toBe(FROZEN_MVP.clsTest);
    expect(mvp.manifests).toEqual(FROZEN_MVP.manifests);
  });
});
