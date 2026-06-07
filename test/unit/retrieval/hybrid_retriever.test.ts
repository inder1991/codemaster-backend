// Unit tests for retrieval/hybrid_retriever.ts — 1:1 with the frozen Python
//   vendor/codemaster-py/tests/unit/retrieval/test_hybrid_retriever.py        (legacy composition)
//   vendor/codemaster-py/tests/unit/retrieval/test_hybrid_retriever_confluence.py (Sub-spec B T11)
//
// The retrievers + rerank + confluence port are stubbed structurally (the Python tests use duck-typed
// `_StubBM25` / `_StubConfluence` with `# type: ignore[arg-type]`; the TS analogue casts the stub to the
// concrete class type). The composition under test is the ORDER + gating + merge/floors/rerank wiring.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import type { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";
import type {
  ConfluenceRetrievalPort,
  ConfluenceRetrievedChunk,
} from "#backend/retrieval/confluence_source.js";
import {
  HybridRetriever,
  confluenceToScored,
} from "#backend/retrieval/hybrid_retriever.js";
import { IdentityRerankPort, LlmRerank, type LlmRerankerPort } from "#backend/retrieval/llm_rerank.js";

import type {
  KnowledgeChunkV1,
  KnowledgeQueryV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";

// ─── Stubs ──────────────────────────────────────────────────────────────────────────────────────

class StubRetriever {
  public constructor(private readonly items: ReadonlyArray<ScoredKnowledgeChunkV1>) {}
  public async retrieve(_query: KnowledgeQueryV1): Promise<RetrievedKnowledgeV1> {
    void _query;
    return {
      schema_version: 1,
      items: [...this.items],
      degraded: false,
      degradation_reason: "",
      starvation_tiers: [],
      source_counts: {},
    };
  }
}

/** A retriever that returns degraded=true (embed service down) for the BM25-only-fallback test. */
class DegradedRetriever {
  public constructor(private readonly items: ReadonlyArray<ScoredKnowledgeChunkV1>) {}
  public async retrieve(_query: KnowledgeQueryV1): Promise<RetrievedKnowledgeV1> {
    void _query;
    return {
      schema_version: 1,
      items: [...this.items],
      degraded: true,
      degradation_reason: "embed service unreachable",
      starvation_tiers: [],
      source_counts: {},
    };
  }
}

class StubConfluence implements ConfluenceRetrievalPort {
  public lastEffectiveLabels: ReadonlySet<string> | null = null;
  public lastQueryEmbedding: ReadonlyArray<number> | null = null;
  public constructor(private readonly chunks: ReadonlyArray<ConfluenceRetrievedChunk>) {}
  public async search(args: {
    queryEmbedding: ReadonlyArray<number>;
    topK: number;
    effectiveLabels?: ReadonlySet<string>;
  }): Promise<ReadonlyArray<ConfluenceRetrievedChunk>> {
    this.lastEffectiveLabels = args.effectiveLabels ?? new Set();
    this.lastQueryEmbedding = args.queryEmbedding;
    return this.chunks;
  }
}

function asBm25(r: StubRetriever | DegradedRetriever): Bm25Retriever {
  return r as unknown as Bm25Retriever;
}
function asAnn(r: StubRetriever | DegradedRetriever): AnnRetriever {
  return r as unknown as AnnRetriever;
}

function knowledgeChunk(args: {
  rel: string;
  body?: string;
  repoId?: string;
  installationId?: string;
}): KnowledgeChunkV1 {
  return {
    schema_version: 2,
    chunk_id: randomUUID(),
    installation_id: args.installationId ?? randomUUID(),
    repo_id: args.repoId ?? randomUUID(),
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

function scored(chunk: KnowledgeChunkV1): ScoredKnowledgeChunkV1 {
  return { schema_version: 1, chunk, score: 0.9, stage: "bm25" };
}

function confluenceChunk(args: {
  pageId?: string;
  labels?: ReadonlyArray<string>;
  score?: number;
}): ConfluenceRetrievedChunk {
  const pageId = args.pageId ?? "p1";
  return {
    chunk_id: randomUUID(),
    space_key: "ENG",
    page_id: pageId,
    page_title: `Page ${pageId}`,
    version: 1,
    chunk_text: `body of ${pageId}`,
    score: args.score ?? 0.9,
    redaction_applied: false,
    source: "confluence",
    labels: args.labels ?? ["lang:python"],
    age_days: 0,
    token_count: 0,
    match_specificity_score: 0,
  };
}

function query(args: {
  installationId?: string;
  repoId?: string;
  topK?: number;
  includeConfluence?: boolean;
  effectiveLabels?: ReadonlyArray<string>;
  queryVectorOverride?: ReadonlyArray<number> | null;
}): KnowledgeQueryV1 {
  return {
    schema_version: 2,
    query: "find auth code",
    installation_id: args.installationId ?? randomUUID(),
    repo_id: args.repoId ?? randomUUID(),
    top_k: args.topK ?? 10,
    query_vector_override:
      args.queryVectorOverride === undefined || args.queryVectorOverride === null
        ? null
        : [...args.queryVectorOverride],
    include_confluence: args.includeConfluence ?? false,
    effective_labels: args.effectiveLabels === undefined ? [] : [...args.effectiveLabels],
    default_pool_token_reservation_pct: 0.15,
  };
}

function buildLegacy(args: {
  bm25Items: ReadonlyArray<ScoredKnowledgeChunkV1>;
  annItems: ReadonlyArray<ScoredKnowledgeChunkV1>;
}): HybridRetriever {
  return new HybridRetriever({
    bm25: asBm25(new StubRetriever(args.bm25Items)),
    ann: asAnn(new StubRetriever(args.annItems)),
    rerank: new LlmRerank({ port: new IdentityRerankPort() }),
  });
}

// ─── Legacy composition (test_hybrid_retriever.py) ─────────────────────────────────────────────────

describe("HybridRetriever legacy path", () => {
  it("empty indexes yield an empty result", async () => {
    const out = await buildLegacy({ bm25Items: [], annItems: [] }).retrieve(query({}));
    expect(out.items).toEqual([]);
  });

  it("a single chunk in both indexes returns it with stage='rerank'", async () => {
    const a = knowledgeChunk({ rel: "docs/auth.md", body: "auth flow content" });
    const out = await buildLegacy({ bm25Items: [scored(a)], annItems: [scored(a)] }).retrieve(
      query({}),
    );
    expect(out.items.length).toBe(1);
    expect(out.items[0]!.stage).toBe("rerank");
    expect(out.items[0]!.chunk.chunk_id).toBe(a.chunk_id);
  });

  it("output is capped at the rerank top-5", async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => knowledgeChunk({ rel: `d${i}.md` }));
    const items = chunks.map(scored);
    const out = await buildLegacy({ bm25Items: items, annItems: items }).retrieve(query({}));
    expect(out.items.length).toBeLessThanOrEqual(5);
  });

  it("retrieve() uses the per-call rerank OVERRIDE instead of the static reranker (E)", async () => {
    // The retrieve_knowledge activity constructs a per-invocation LlmBackedRerankPort (carrying the
    // query's installation_id) and passes it as the override; the static factory reranker must NOT run.
    let staticCalled = false;
    let overrideCalled = false;
    const port = (mark: () => void): LlmRerankerPort => ({
      rerank: async ({ candidates }) => {
        mark();
        return candidates.map((_, i) => candidates.length - i);
      },
    });
    const a = scored(knowledgeChunk({ rel: "a.ts" }));
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([a])),
      ann: asAnn(new StubRetriever([a])),
      rerank: new LlmRerank({ port: port(() => (staticCalled = true)) }),
    });
    await retriever.retrieve(query({}), new LlmRerank({ port: port(() => (overrideCalled = true)) }));
    expect(overrideCalled).toBe(true);
    expect(staticCalled).toBe(false);
  });

  it("ANN degraded → BM25-only result with degraded=true propagated", async () => {
    const a = knowledgeChunk({ rel: "docs/a.md", body: "alpha auth" });
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([scored(a)])),
      ann: asAnn(new DegradedRetriever([])),
      rerank: new LlmRerank({ port: new IdentityRerankPort() }),
    });
    const out = await retriever.retrieve(query({}));
    expect(out.degraded).toBe(true);
    expect(out.items.length).toBeGreaterThanOrEqual(1);
    expect(out.items[0]!.chunk.chunk_id).toBe(a.chunk_id);
  });
});

// ─── Gating: confluence path SKIPPED (test_hybrid_retriever_confluence.py) ──────────────────────────

describe("HybridRetriever confluence gating (skips → legacy path)", () => {
  it("no confluence port → skip (source_counts stays {})", async () => {
    const spy = new StubConfluence([confluenceChunk({})]);
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([])),
      ann: asAnn(new StubRetriever([])),
      rerank: new LlmRerank({ port: new IdentityRerankPort() }),
      // confluence omitted
    });
    const out = await retriever.retrieve(
      query({ includeConfluence: true, effectiveLabels: ["default"], queryVectorOverride: Array(1024).fill(0.1) }),
    );
    expect(out.source_counts).toEqual({});
    expect(spy.lastEffectiveLabels).toBeNull();
  });

  it("include_confluence=false → skip", async () => {
    const spy = new StubConfluence([confluenceChunk({})]);
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([])),
      ann: asAnn(new StubRetriever([])),
      rerank: new LlmRerank({ port: new IdentityRerankPort() }),
      confluence: spy,
    });
    const out = await retriever.retrieve(
      query({ includeConfluence: false, effectiveLabels: ["default"], queryVectorOverride: Array(1024).fill(0.1) }),
    );
    expect(spy.lastEffectiveLabels).toBeNull();
    expect(out.source_counts).toEqual({});
  });

  it("empty effective_labels → skip", async () => {
    const spy = new StubConfluence([confluenceChunk({})]);
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([])),
      ann: asAnn(new StubRetriever([])),
      rerank: new LlmRerank({ port: new IdentityRerankPort() }),
      confluence: spy,
    });
    await retriever.retrieve(
      query({ includeConfluence: true, effectiveLabels: [], queryVectorOverride: Array(1024).fill(0.1) }),
    );
    expect(spy.lastEffectiveLabels).toBeNull();
  });

  it("no query_vector_override → skip", async () => {
    const spy = new StubConfluence([confluenceChunk({})]);
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([])),
      ann: asAnn(new StubRetriever([])),
      rerank: new LlmRerank({ port: new IdentityRerankPort() }),
      confluence: spy,
    });
    await retriever.retrieve(
      query({ includeConfluence: true, effectiveLabels: ["default"], queryVectorOverride: null }),
    );
    expect(spy.lastEffectiveLabels).toBeNull();
  });
});

// ─── Compose: all gates satisfied ──────────────────────────────────────────────────────────────────

describe("HybridRetriever confluence composed", () => {
  it("confluence chunk appears in the results + source_counts.confluence == 1", async () => {
    const spy = new StubConfluence([confluenceChunk({ pageId: "p-fast" })]);
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([])),
      ann: asAnn(new StubRetriever([])),
      rerank: new LlmRerank({ port: new IdentityRerankPort() }),
      confluence: spy,
    });
    const out = await retriever.retrieve(
      query({
        includeConfluence: true,
        effectiveLabels: ["default", "lang:python"],
        queryVectorOverride: Array(1024).fill(0.1),
      }),
    );
    const confluenceItems = out.items.filter((i) => i.chunk.source === "confluence");
    expect(confluenceItems.length).toBe(1);
    expect(confluenceItems[0]!.chunk.page_id).toBe("p-fast");
    expect(out.source_counts.confluence).toBe(1);
  });

  it("threads effective_labels to the adapter", async () => {
    const spy = new StubConfluence([confluenceChunk({})]);
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([])),
      ann: asAnn(new StubRetriever([])),
      rerank: new LlmRerank({ port: new IdentityRerankPort() }),
      confluence: spy,
    });
    const labels = ["default", "framework:fastapi"];
    await retriever.retrieve(
      query({ includeConfluence: true, effectiveLabels: labels, queryVectorOverride: Array(1024).fill(0.1) }),
    );
    expect([...(spy.lastEffectiveLabels ?? new Set())].sort()).toEqual([...labels].sort());
  });

  it("threads query_vector_override to the adapter", async () => {
    const spy = new StubConfluence([confluenceChunk({})]);
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([])),
      ann: asAnn(new StubRetriever([])),
      rerank: new LlmRerank({ port: new IdentityRerankPort() }),
      confluence: spy,
    });
    const vec = Array(1024).fill(0.5);
    await retriever.retrieve(
      query({ includeConfluence: true, effectiveLabels: ["default"], queryVectorOverride: vec }),
    );
    expect(spy.lastQueryEmbedding).toEqual(vec);
  });

  it("merges BM25 + ANN + confluence: all three sources reach the results", async () => {
    const repoChunk = knowledgeChunk({ rel: "docs/repo.md", body: "unique repo body" });
    const spy = new StubConfluence([confluenceChunk({ pageId: "p-conf" })]);
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([scored(repoChunk)])),
      ann: asAnn(new StubRetriever([scored(repoChunk)])),
      rerank: new LlmRerank({ port: new IdentityRerankPort() }),
      confluence: spy,
    });
    const out = await retriever.retrieve(
      query({
        includeConfluence: true,
        effectiveLabels: ["default", "lang:python"],
        queryVectorOverride: Array(1024).fill(0.1),
      }),
    );
    const sources = new Set(out.items.map((i) => i.chunk.source));
    expect(sources.has("repo_knowledge")).toBe(true);
    expect(sources.has("confluence")).toBe(true);
    // RRF deduped the repo chunk (same id in BM25 + ANN) → one knowledge entry; one confluence entry.
    expect(out.source_counts.knowledge).toBe(1);
    expect(out.source_counts.confluence).toBe(1);
  });
});

// ─── Floors reserved BEFORE rerank ────────────────────────────────────────────────────────────────

describe("HybridRetriever floors reserved before rerank", () => {
  /**
   * A rerank port that DROPS every candidate it sees (returns no scores → mismatch → fallback to its
   * input). Used to prove a security_policy floor pick bypasses the rerank input entirely: if the floor
   * were NOT reserved before rerank, the security chunk would have to survive the rerank input to appear.
   */
  class CountingRerankPort implements LlmRerankerPort {
    public lastInputPaths: ReadonlyArray<string> = [];
    public async rerank(args: {
      query: string;
      candidates: ReadonlyArray<KnowledgeChunkV1>;
    }): Promise<ReadonlyArray<number>> {
      this.lastInputPaths = args.candidates.map((c) => c.relative_path);
      return args.candidates.map(() => 1);
    }
  }

  it("a SECURITY_POLICY confluence chunk is reserved by floors, NOT passed into the rerank input", async () => {
    // A confluence chunk tagged topic:security_policy → priorityTier=SECURITY_POLICY → floor pick.
    const secChunk = confluenceChunk({ pageId: "sec", labels: ["topic:security_policy"] });
    const plainChunk = knowledgeChunk({ rel: "docs/plain.md", body: "plain repo content" });
    const countingPort = new CountingRerankPort();
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([scored(plainChunk)])),
      ann: asAnn(new StubRetriever([scored(plainChunk)])),
      rerank: new LlmRerank({ port: countingPort }),
      confluence: new StubConfluence([secChunk]),
    });
    const out = await retriever.retrieve(
      query({
        includeConfluence: true,
        effectiveLabels: ["topic:security_policy", "default"],
        queryVectorOverride: Array(1024).fill(0.1),
      }),
    );
    // The security chunk reached the FINAL result (floor priority slot)...
    const secInResult = out.items.some(
      (i) => i.chunk.source === "confluence" && i.chunk.relative_path === "confluence/ENG/sec",
    );
    expect(secInResult).toBe(true);
    // ...but it was NEVER part of the rerank INPUT (floors reserved it before rerank).
    expect(countingPort.lastInputPaths).not.toContain("confluence/ENG/sec");
    // The plain repo chunk DID go through the rerank pass.
    expect(countingPort.lastInputPaths).toContain("docs/plain.md");
  });
});

// ─── confluenceToScored wrapper helper ─────────────────────────────────────────────────────────────

// ─── Confluence outage isolation (divergence from frozen Python's fail-all gather) ──────────────────

describe("HybridRetriever confluence outage isolation", () => {
  class ThrowingConfluence implements ConfluenceRetrievalPort {
    public async search(): Promise<ReadonlyArray<ConfluenceRetrievedChunk>> {
      throw new Error("confluence DB unreachable");
    }
  }

  it("a Confluence failure degrades gracefully — BM25/ANN results survive, degraded=true", async () => {
    // Frozen Python's bare `asyncio.gather(bm25, ann, confluence)` fails the WHOLE retrieval if confluence
    // throws (its docstring claims best-effort on failure, but the code doesn't deliver). This port
    // isolates the confluence failure so repo BM25/ANN context survives, and surfaces degraded=true.
    const repoChunk = knowledgeChunk({ rel: "docs/repo.md", body: "unique repo body content here" });
    const retriever = new HybridRetriever({
      bm25: asBm25(new StubRetriever([scored(repoChunk)])),
      ann: asAnn(new StubRetriever([scored(repoChunk)])),
      rerank: new LlmRerank({ port: new IdentityRerankPort() }),
      confluence: new ThrowingConfluence(),
    });
    const out = await retriever.retrieve(
      query({
        includeConfluence: true,
        effectiveLabels: ["default", "lang:python"],
        queryVectorOverride: Array(1024).fill(0.1),
      }),
    );
    // repo context survived the confluence outage...
    expect(out.items.some((i) => i.chunk.source === "repo_knowledge")).toBe(true);
    // ...no confluence items (that source failed)...
    expect(out.items.some((i) => i.chunk.source === "confluence")).toBe(false);
    // ...and the degradation is surfaced (not a thrown error).
    expect(out.degraded).toBe(true);
    expect(out.degradation_reason).toContain("confluence");
  });
});

describe("confluenceToScored", () => {
  it("wraps a confluence chunk into a ScoredKnowledgeChunkV1 with source='confluence'", () => {
    const c = confluenceChunk({ pageId: "p1", labels: ["default", "lang:python"] });
    const iid = randomUUID();
    const rid = randomUUID();
    const wrapped = confluenceToScored(c, { installationId: iid, repoId: rid });
    expect(wrapped.chunk.source).toBe("confluence");
    expect(wrapped.chunk.space_key).toBe("ENG");
    expect(wrapped.chunk.page_id).toBe("p1");
    expect(wrapped.chunk.labels).toEqual(["default", "lang:python"]);
    expect(wrapped.chunk.installation_id).toBe(iid);
    expect(wrapped.chunk.repo_id).toBe(rid);
    expect(wrapped.chunk.doc_kind).toBe("other");
    expect(wrapped.chunk.relative_path).toBe("confluence/ENG/p1");
    expect(wrapped.score).toBe(c.score);
    expect(wrapped.stage).toBe("ann");
  });
});
