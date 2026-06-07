// Unit tests for buildRerankOverride (E) — the flag-gated per-invocation LLM rerank construction in the
// retrieve_knowledge activity. The HybridRetriever-honors-the-override behavior is covered in
// test/unit/retrieval/hybrid_retriever.test.ts; here we cover the flag/cache gating of the builder.

import { describe, expect, it } from "vitest";

import { buildRerankOverride } from "#backend/activities/retrieve_knowledge.activity.js";
import type { RerankLlmCacheLike } from "#backend/retrieval/llm_backed_rerank.js";
import { LlmRerank } from "#backend/retrieval/llm_rerank.js";

// A cache stub whose forRole is never invoked by buildRerankOverride (construction only — no rerank call).
const fakeCache: RerankLlmCacheLike = {
  forRole: async () => {
    throw new Error("forRole must not be called during construction");
  },
};

describe("buildRerankOverride (E flag-gated LLM reranker)", () => {
  it("disabled → undefined (HybridRetriever runs its static IdentityRerankPort no-op)", () => {
    expect(
      buildRerankOverride({ enabled: false, cache: fakeCache, installationId: "i1" }),
    ).toBeUndefined();
  });

  it("enabled but no cache wired → undefined (cannot build an LLM-backed port without a cache)", () => {
    expect(
      buildRerankOverride({ enabled: true, cache: undefined, installationId: "i1" }),
    ).toBeUndefined();
  });

  it("enabled + cache → an LlmRerank (the LLM-backed override)", () => {
    const override = buildRerankOverride({ enabled: true, cache: fakeCache, installationId: "i1" });
    expect(override).toBeInstanceOf(LlmRerank);
  });
});
