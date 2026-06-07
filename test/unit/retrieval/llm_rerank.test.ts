// Unit tests for retrieval/llm_rerank.ts — 1:1 with the frozen Python
// vendor/codemaster-py/tests/unit/retrieval/test_llm_rerank.py (Sprint 10 / S10.3.5).
//
// Covers: empty-input passthrough, top-K cap, score-driven ordering, stage="rerank" rewrite, query
// threading, the UNAVAILABLE fallback (degraded=true, input top_k preserved), and input-degradation
// propagation. The score-count MISMATCH fallback is an additional case the port guards (Python
// `len(scores) != len(chunks)` branch).

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  IdentityRerankPort,
  LlmRerank,
  type LlmRerankerPort,
  LlmRerankUnavailableError,
  RERANK_TOP_K,
} from "#backend/retrieval/llm_rerank.js";

import type {
  KnowledgeChunkV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";

function chunk(args: { rel: string; body?: string }): KnowledgeChunkV1 {
  return {
    schema_version: 2,
    chunk_id: randomUUID(),
    installation_id: randomUUID(),
    repo_id: randomUUID(),
    relative_path: args.rel,
    chunk_index: 0,
    heading_path: [],
    body: args.body ?? "b",
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

/** Wrap chunks as RRF-stage input to the reranker (1:1 with the Python `_candidates`). */
function candidates(chunks: ReadonlyArray<KnowledgeChunkV1>): RetrievedKnowledgeV1 {
  const items: Array<ScoredKnowledgeChunkV1> = chunks.map((c, i) => ({
    schema_version: 1,
    chunk: c,
    score: 0.1 * (i + 1),
    stage: "rrf",
  }));
  return {
    schema_version: 1,
    items,
    degraded: false,
    degradation_reason: "",
    starvation_tiers: [],
    source_counts: {},
  };
}

/** Returns LLM-style scores: top of `preferred` gets 10, then 9, ...; chunks absent get 0. */
class OrderingStub implements LlmRerankerPort {
  public readonly calls: Array<{ query: string; candidates: ReadonlyArray<KnowledgeChunkV1> }> = [];
  private readonly preferred: ReadonlyArray<string>;

  public constructor(preferred: ReadonlyArray<string>) {
    this.preferred = preferred;
  }

  public async rerank(args: {
    query: string;
    candidates: ReadonlyArray<KnowledgeChunkV1>;
  }): Promise<ReadonlyArray<number>> {
    this.calls.push({ query: args.query, candidates: args.candidates });
    return args.candidates.map((c) => {
      const rank = this.preferred.indexOf(c.relative_path);
      return rank === -1 ? 0 : 10 - rank;
    });
  }
}

class UnreachableStub implements LlmRerankerPort {
  public async rerank(): Promise<ReadonlyArray<number>> {
    throw new LlmRerankUnavailableError("simulated outage");
  }
}

/** Returns the WRONG number of scores (one fewer) → triggers the score-count-mismatch fallback. */
class ShortScoreStub implements LlmRerankerPort {
  public async rerank(args: {
    query: string;
    candidates: ReadonlyArray<KnowledgeChunkV1>;
  }): Promise<ReadonlyArray<number>> {
    return args.candidates.slice(1).map(() => 1);
  }
}

describe("LlmRerank basics", () => {
  it("empty input returns empty", async () => {
    const rerank = new LlmRerank({ port: new OrderingStub([]) });
    const out = await rerank.apply({ query: "x", candidates: candidates([]) });
    expect(out.items).toEqual([]);
  });

  it("RERANK_TOP_K is 5", () => {
    expect(RERANK_TOP_K).toBe(5);
  });

  it("output is capped at top_k", async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => chunk({ rel: `d${i}.md` }));
    const stub = new OrderingStub(chunks.map((c) => c.relative_path));
    const out = await new LlmRerank({ port: stub }).apply({
      query: "anything",
      candidates: candidates(chunks),
    });
    expect(out.items.length).toBe(RERANK_TOP_K);
  });

  it("reranked order reflects LLM scores", async () => {
    const a = chunk({ rel: "a.md" });
    const b = chunk({ rel: "b.md" });
    const c = chunk({ rel: "c.md" });
    const stub = new OrderingStub(["c.md", "b.md", "a.md"]);
    const out = await new LlmRerank({ port: stub }).apply({
      query: "anything",
      candidates: candidates([a, b, c]),
    });
    expect(out.items.map((i) => i.chunk.relative_path)).toEqual(["c.md", "b.md", "a.md"]);
  });

  it("every item carries stage='rerank'", async () => {
    const stub = new OrderingStub(["a.md"]);
    const out = await new LlmRerank({ port: stub }).apply({
      query: "x",
      candidates: candidates([chunk({ rel: "a.md" })]),
    });
    expect(out.items.every((i) => i.stage === "rerank")).toBe(true);
  });
});

describe("LlmRerank prompt boundaries", () => {
  it("threads the query to the port", async () => {
    const stub = new OrderingStub(["a.md"]);
    await new LlmRerank({ port: stub }).apply({
      query: "how does auth work",
      candidates: candidates([chunk({ rel: "a.md" })]),
    });
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]!.query).toBe("how does auth work");
  });
});

describe("LlmRerank degradation", () => {
  it("LLM unavailable → falls back to input order top_k with degraded=true", async () => {
    const chunks = Array.from({ length: 8 }, (_, i) => chunk({ rel: `d${i}.md` }));
    const out = await new LlmRerank({ port: new UnreachableStub() }).apply({
      query: "x",
      candidates: candidates(chunks),
    });
    expect(out.degraded).toBe(true);
    expect(out.degradation_reason.toLowerCase()).toContain("rerank");
    expect(out.items.length).toBe(RERANK_TOP_K);
    expect(out.items.map((i) => i.chunk.relative_path)).toEqual(
      chunks.slice(0, RERANK_TOP_K).map((c) => c.relative_path),
    );
  });

  it("score-count mismatch → falls back to input order top_k with degraded=true", async () => {
    const chunks = Array.from({ length: 7 }, (_, i) => chunk({ rel: `d${i}.md` }));
    const out = await new LlmRerank({ port: new ShortScoreStub() }).apply({
      query: "x",
      candidates: candidates(chunks),
    });
    expect(out.degraded).toBe(true);
    expect(out.degradation_reason.toLowerCase()).toContain("mismatch");
    expect(out.items.length).toBe(RERANK_TOP_K);
    // Fallback preserves the PRE-rerank order (the ShortScoreStub never reordered).
    expect(out.items.map((i) => i.chunk.relative_path)).toEqual(
      chunks.slice(0, RERANK_TOP_K).map((c) => c.relative_path),
    );
  });

  it("input degradation is preserved through a successful rerank", async () => {
    const a = chunk({ rel: "a.md" });
    const cand: RetrievedKnowledgeV1 = {
      schema_version: 1,
      items: [{ schema_version: 1, chunk: a, score: 0.5, stage: "rrf" }],
      degraded: true,
      degradation_reason: "ann fallback to bm25",
      starvation_tiers: [],
      source_counts: {},
    };
    const out = await new LlmRerank({ port: new OrderingStub(["a.md"]) }).apply({
      query: "x",
      candidates: cand,
    });
    expect(out.degraded).toBe(true);
    expect(out.degradation_reason).toContain("ann fallback");
  });
});

describe("IdentityRerankPort", () => {
  it("returns score=1.0 per candidate, preserving the input order (no-op rerank)", async () => {
    const a = chunk({ rel: "a.md" });
    const b = chunk({ rel: "b.md" });
    const c = chunk({ rel: "c.md" });
    const out = await new LlmRerank({ port: new IdentityRerankPort() }).apply({
      query: "x",
      candidates: candidates([a, b, c]),
    });
    // All scores equal → stable sort preserves input order.
    expect(out.items.map((i) => i.chunk.relative_path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(out.items.every((i) => i.score === 1)).toBe(true);
  });
});
