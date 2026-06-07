// Unit tests for confluence_source pure helpers: mergeSources (simhash near-dup dedup), sourceBreakdown,
// and the simhash math. Tier-1 PARITY values (jaccard / simhash) were extracted by running the frozen
// Python `vendor/codemaster-py/codemaster/retrieval/confluence_source.py::_simhash` / `merge_sources`
// directly (see the inline PARITY comments). Pure-function tests — no DB.

import { describe, expect, it } from "vitest";

import {
  NEAR_DUPLICATE_THRESHOLD,
  jaccardSimilarity,
  mergeSources,
  simhash,
  sourceBreakdown,
  type ConfluenceRetrievedChunk,
} from "#backend/retrieval/confluence_source.js";

/** A minimal object carrying a `chunk_text` attr (mergeSources reads via `text_attr="chunk_text"`). */
function repoLike(text: string): { chunk_text: string } {
  return { chunk_text: text };
}

function confluenceChunk(text: string): ConfluenceRetrievedChunk {
  return {
    chunk_id: "11111111-1111-1111-1111-111111111111",
    space_key: "ENG",
    page_id: "100",
    page_title: "Title",
    version: 1,
    chunk_text: text,
    score: 0.5,
    redaction_applied: false,
    source: "confluence",
    labels: [],
    age_days: 0,
    token_count: 0,
    match_specificity_score: 0,
  };
}

describe("simhash + jaccardSimilarity (Tier-1 parity vs frozen Python)", () => {
  it("identical text → similarity 1.0", () => {
    const a = simhash("The quick brown fox jumps over the lazy dog");
    const b = simhash("The quick brown fox jumps over the lazy dog");
    // PARITY: Python `jac(a,b) == 1.0`.
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it("completely different text → similarity 0.0", () => {
    const a = simhash("The quick brown fox jumps over the lazy dog");
    const c = simhash("Completely different content here, nothing alike at all zzz");
    // PARITY: Python `round(jac(a,c),6) == 0.0`.
    expect(jaccardSimilarity(a, c)).toBe(0);
  });

  it("near-duplicate one-word change → ~0.857143 (below 0.92 threshold)", () => {
    const a = simhash("The quick brown fox jumps over the lazy dog");
    const d = simhash("The quick brown fox jumps over the lazy cat");
    // PARITY: Python `round(jac(a,d),6) == 0.857143`.
    expect(jaccardSimilarity(a, d)).toBeCloseTo(0.857143, 6);
    expect(jaccardSimilarity(a, d)).toBeLessThan(NEAR_DUPLICATE_THRESHOLD);
  });

  it("strips the <doc trust=\"untrusted\"> wrapper before fingerprinting", () => {
    const e = simhash('<doc trust="untrusted">hello world paragraph text</doc>');
    const f = simhash("hello world paragraph text");
    // PARITY: Python `e == f` (sets equal) → sim 1.0.
    expect(jaccardSimilarity(e, f)).toBe(1);
  });

  it("empty / too-short text → empty fingerprint set", () => {
    expect(simhash("").size).toBe(0);
    // len("abcd")=4 < n_grams(5) → no shingles. PARITY: Python `simhash('abcd') == set()`.
    expect(simhash("abcd").size).toBe(0);
  });

  it("either-empty fingerprint → similarity 0.0 (never NaN)", () => {
    expect(jaccardSimilarity(new Set<number>(), new Set([1, 2]))).toBe(0);
    expect(jaccardSimilarity(new Set([1, 2]), new Set<number>())).toBe(0);
  });
});

describe("mergeSources (cross-source near-dup dedup)", () => {
  it("drops a Confluence chunk that near-duplicates a kept repo chunk", () => {
    const repo = repoLike("The quick brown fox jumps over the lazy dog and runs away fast");
    const conf = confluenceChunk("The quick brown fox jumps over the lazy dog and runs away fast");
    const [kept, counters] = mergeSources({
      repoChunks: [repo],
      knowledgeChunks: [],
      confluenceChunks: [conf],
    });
    // repo seeds the dedup set; the identical confluence chunk is dropped.
    expect(kept).toEqual([repo]);
    expect(counters).toEqual({ repo: 1, knowledge: 0, confluence: 0, deduped: 1 });
  });

  it("keeps a distinct Confluence chunk alongside repo + knowledge", () => {
    const repo = repoLike("Database connection pooling guidance for the platform service tier");
    const knowledge = repoLike("Frontend accessibility checklist for keyboard navigation support");
    const conf = confluenceChunk("Incident response runbook for the on-call rotation escalation path");
    const [kept, counters] = mergeSources({
      repoChunks: [repo],
      knowledgeChunks: [knowledge],
      confluenceChunks: [conf],
    });
    expect(kept).toEqual([repo, knowledge, conf]);
    expect(counters).toEqual({ repo: 1, knowledge: 1, confluence: 1, deduped: 0 });
  });

  it("preserves repo > knowledge > confluence insertion order (dedup set seeds repo/knowledge first)", () => {
    // A confluence chunk identical to a LATER knowledge chunk is dropped because knowledge is
    // considered before confluence — the bias is toward code citations.
    const knowledge = repoLike("Shared paragraph text appearing in both knowledge and confluence here");
    const conf = confluenceChunk("Shared paragraph text appearing in both knowledge and confluence here");
    const [kept, counters] = mergeSources({
      repoChunks: [],
      knowledgeChunks: [knowledge],
      confluenceChunks: [conf],
    });
    expect(kept).toEqual([knowledge]);
    expect(counters.deduped).toBe(1);
    expect(counters.confluence).toBe(0);
  });

  it("a near-dup BELOW the 0.92 threshold is NOT dropped", () => {
    const repo = repoLike("The quick brown fox jumps over the lazy dog");
    const conf = confluenceChunk("The quick brown fox jumps over the lazy cat");
    const [kept, counters] = mergeSources({
      repoChunks: [repo],
      knowledgeChunks: [],
      confluenceChunks: [conf],
    });
    // sim ≈ 0.857 < 0.92 → both kept.
    expect(kept.length).toBe(2);
    expect(counters.deduped).toBe(0);
  });

  it("dedups near-duplicate WRAPPED chunks whose text is at .chunk.body (not .chunk_text)", () => {
    // The HybridRetriever feeds ScoredKnowledgeChunkV1 envelopes (text at `.chunk.body`) into
    // mergeSources, NOT raw rows (text at `.chunk_text`). Pre-fix getText only read `chunk_text` → "" for
    // every wrapped envelope, so dedup was INERT for the entire hybrid path (faithful to frozen Python's
    // same latent gap). After teaching getText the wrapped shape, identical wrapped chunks dedup.
    const body =
      "The quick brown fox jumps over the lazy dog and runs away fast across the open field at dawn";
    const wrappedKnowledge = {
      schema_version: 1,
      chunk: { body, source: "repo_knowledge" },
      score: 0.9,
      stage: "bm25",
    };
    const wrappedConfluence = {
      schema_version: 1,
      chunk: { body, source: "confluence" },
      score: 0.8,
      stage: "ann",
    };
    const [kept, counters] = mergeSources({
      repoChunks: [],
      knowledgeChunks: [wrappedKnowledge],
      confluenceChunks: [wrappedConfluence] as unknown as ReadonlyArray<ConfluenceRetrievedChunk>,
    });
    // knowledge seeds the dedup set; the identical wrapped confluence chunk is dropped.
    expect(kept).toEqual([wrappedKnowledge]);
    expect(counters.deduped).toBe(1);
    expect(counters.confluence).toBe(0);
  });
});

describe("sourceBreakdown", () => {
  it("builds the locked telemetry dict", () => {
    expect(sourceBreakdown({ repoCount: 3, knowledgeCount: 5, confluenceCount: 2 })).toEqual({
      repo: 3,
      knowledge: 5,
      confluence: 2,
    });
  });
});

describe("NEAR_DUPLICATE_THRESHOLD constant", () => {
  it("is 0.92 (locked AC #1 from S13.3.1c)", () => {
    expect(NEAR_DUPLICATE_THRESHOLD).toBe(0.92);
  });
});
