// Unit tests for the bounded LLM reranker (#5). Stubs the LlmClientCache seam (no real LLM): proves the
// happy path + every failure axis (timeout / cost-cap / malformed / role-resolution) maps to
// LlmRerankUnavailableError, and that LlmRerank.apply then falls back to the RRF order with degraded=true.

import { describe, expect, it } from "vitest";

import { BedrockBudgetExceededError } from "#backend/cost/enforcer.js";
import type { LlmClient } from "#backend/integrations/llm/client.js";
import { LlmBackedRerankPort, type RerankLlmCacheLike } from "#backend/retrieval/llm_backed_rerank.js";
import { LlmRerank, LlmRerankUnavailableError } from "#backend/retrieval/llm_rerank.js";

import type {
  KnowledgeChunkV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";

function knowledgeChunk(id: string, body: string): KnowledgeChunkV1 {
  return {
    schema_version: 2,
    chunk_id: id,
    installation_id: "11111111-1111-1111-1111-111111111111",
    repo_id: "22222222-2222-2222-2222-222222222222",
    relative_path: `docs/${id}.md`,
    chunk_index: 0,
    heading_path: [],
    body,
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
  return { schema_version: 1, chunk, score: 0.5, stage: "rrf" };
}

/** Stub LlmClient whose invokeModel runs the injected behavior; only raw_content_blocks is read. */
function stubClient(invoke: () => Promise<unknown>): LlmClient {
  return { invokeModel: invoke } as unknown as LlmClient;
}

function cacheReturning(client: LlmClient): RerankLlmCacheLike {
  return { forRole: async () => client };
}

function cacheThrowing(err: Error): RerankLlmCacheLike {
  return {
    forRole: async () => {
      throw err;
    },
  };
}

/** A well-formed submit_relevance_scores tool_use response. */
function scoresResult(scores: ReadonlyArray<number>): unknown {
  return {
    raw_content_blocks: [
      { type: "tool_use", name: "submit_relevance_scores", input: { scores: [...scores] } },
    ],
  };
}

const CANDIDATES = [knowledgeChunk("a", "alpha body text"), knowledgeChunk("b", "beta body text")];

describe("LlmBackedRerankPort", () => {
  it("returns the parsed scores on the happy path", async () => {
    const port = new LlmBackedRerankPort({
      cache: cacheReturning(stubClient(async () => scoresResult([0.9, 0.1]))),
      installationId: "iid",
    });
    const scores = await port.rerank({ query: "find auth", candidates: CANDIDATES });
    expect(scores).toEqual([0.9, 0.1]);
  });

  it("empty candidates → [] without calling the LLM", async () => {
    let called = false;
    const port = new LlmBackedRerankPort({
      cache: cacheReturning(
        stubClient(async () => {
          called = true;
          return scoresResult([]);
        }),
      ),
      installationId: "iid",
    });
    expect(await port.rerank({ query: "q", candidates: [] })).toEqual([]);
    expect(called).toBe(false);
  });

  it("a soft TIMEOUT maps to LlmRerankUnavailableError", async () => {
    const port = new LlmBackedRerankPort({
      // invokeModel never resolves → the soft timeout fires.
      cache: cacheReturning(stubClient(() => new Promise<unknown>(() => {}))),
      installationId: "iid",
      timeoutMs: 15,
    });
    await expect(port.rerank({ query: "q", candidates: CANDIDATES })).rejects.toBeInstanceOf(
      LlmRerankUnavailableError,
    );
  });

  it("a COST-CAP breach maps to LlmRerankUnavailableError (NOT re-raised — rerank is optional)", async () => {
    const port = new LlmBackedRerankPort({
      cache: cacheReturning(
        stubClient(async () => {
          throw new BedrockBudgetExceededError({ reason: "daily cap", scope: "installation", scopeId: "iid" });
        }),
      ),
      installationId: "iid",
    });
    await expect(port.rerank({ query: "q", candidates: CANDIDATES })).rejects.toBeInstanceOf(
      LlmRerankUnavailableError,
    );
  });

  it("a malformed response (no scores tool_use block) maps to LlmRerankUnavailableError", async () => {
    const port = new LlmBackedRerankPort({
      cache: cacheReturning(
        stubClient(async () => ({ raw_content_blocks: [{ type: "text", text: "no tool here" }] })),
      ),
      installationId: "iid",
    });
    await expect(port.rerank({ query: "q", candidates: CANDIDATES })).rejects.toBeInstanceOf(
      LlmRerankUnavailableError,
    );
  });

  it("a role-resolution failure maps to LlmRerankUnavailableError", async () => {
    const port = new LlmBackedRerankPort({
      cache: cacheThrowing(new Error("role not configured")),
      installationId: "iid",
    });
    await expect(port.rerank({ query: "q", candidates: CANDIDATES })).rejects.toBeInstanceOf(
      LlmRerankUnavailableError,
    );
  });
});

describe("LlmBackedRerankPort composed with LlmRerank.apply", () => {
  it("a timeout falls back to the RRF order with degraded=true (rerank flake never fails the review)", async () => {
    const port = new LlmBackedRerankPort({
      cache: cacheReturning(stubClient(() => new Promise<unknown>(() => {}))),
      installationId: "iid",
      timeoutMs: 15,
    });
    const rerank = new LlmRerank({ port });
    const candidates: RetrievedKnowledgeV1 = {
      schema_version: 1,
      items: [scored(CANDIDATES[0]!), scored(CANDIDATES[1]!)],
      degraded: false,
      degradation_reason: "",
      starvation_tiers: [],
      source_counts: {},
    };
    const out = await rerank.apply({ query: "q", candidates });
    expect(out.degraded).toBe(true);
    expect(out.degradation_reason).toContain("rerank LLM unavailable");
    // Fallback keeps the input (RRF) order + the same items, just with stage rewritten to "rerank".
    expect(out.items.map((i) => i.chunk.chunk_id)).toEqual(["a", "b"]);
    expect(out.items.every((i) => i.stage === "rerank")).toBe(true);
  });

  it("a real rerank reorders by score DESC and keeps the top-5", async () => {
    const port = new LlmBackedRerankPort({
      // b scores higher than a → b ranks first after rerank.
      cache: cacheReturning(stubClient(async () => scoresResult([0.2, 0.95]))),
      installationId: "iid",
    });
    const rerank = new LlmRerank({ port });
    const candidates: RetrievedKnowledgeV1 = {
      schema_version: 1,
      items: [scored(CANDIDATES[0]!), scored(CANDIDATES[1]!)],
      degraded: false,
      degradation_reason: "",
      starvation_tiers: [],
      source_counts: {},
    };
    const out = await rerank.apply({ query: "q", candidates });
    expect(out.degraded).toBe(false);
    expect(out.items.map((i) => i.chunk.chunk_id)).toEqual(["b", "a"]);
  });
});
