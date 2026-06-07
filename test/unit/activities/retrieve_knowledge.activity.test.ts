// Unit tests for RetrieveKnowledgeActivity — port of the frozen Python
//   vendor/codemaster-py/tests/unit/activities/test_retrieve_knowledge.py
//   (+ the Sub-spec B T12 confluence-gating cases from
//    vendor/codemaster-py/tests/unit/activities/test_retrieve_knowledge_confluence.py).
//
// The retrievers + hybrid retriever are stubbed structurally (the orchestration composition under test is
// the GATE + the legacy-vs-hybrid dispatch, NOT the underlying fusion — that is covered by the retriever
// + hybrid_retriever unit suites). Pure unit (no DB / network).

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { RetrieveKnowledgeActivity } from "#backend/activities/retrieve_knowledge.activity.js";
import type { AnnRetriever } from "#backend/retrieval/ann_retriever.js";
import type { Bm25Retriever } from "#backend/retrieval/bm25_retriever.js";
import type { HybridRetriever } from "#backend/retrieval/hybrid_retriever.js";

import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import type {
  KnowledgeChunkV1,
  KnowledgeQueryV1,
  RetrievedKnowledgeV1,
  ScoredKnowledgeChunkV1,
} from "#contracts/knowledge_chunks.v1.js";
import { PRContext } from "#contracts/pr_context.v1.js";
import type { RetrieveKnowledgeInputV1 } from "#contracts/retrieve_knowledge.v1.js";

const IID = randomUUID();
const RID = randomUUID();

function knowledgeChunk(path: string): KnowledgeChunkV1 {
  return {
    schema_version: 2,
    chunk_id: randomUUID(),
    installation_id: IID,
    repo_id: RID,
    relative_path: path,
    chunk_index: 0,
    heading_path: [],
    body: `body of ${path}`,
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

function scored(path: string, score: number): ScoredKnowledgeChunkV1 {
  return { schema_version: 1, chunk: knowledgeChunk(path), score, stage: "ann" };
}

/** A retriever stub that records the query it was handed and returns a fixed envelope. */
class RecordingRetriever {
  public lastQuery: KnowledgeQueryV1 | null = null;
  public constructor(private readonly items: ReadonlyArray<ScoredKnowledgeChunkV1>) {}
  public async retrieve(query: KnowledgeQueryV1): Promise<RetrievedKnowledgeV1> {
    this.lastQuery = query;
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

/** A HybridRetriever stub recording the query + returning a hybrid envelope (degraded + reason exercised). */
class RecordingHybrid {
  public called = false;
  public lastQuery: KnowledgeQueryV1 | null = null;
  public constructor(
    private readonly result: RetrievedKnowledgeV1,
  ) {}
  public async retrieve(query: KnowledgeQueryV1): Promise<RetrievedKnowledgeV1> {
    this.called = true;
    this.lastQuery = query;
    return this.result;
  }
}

function hybridEnvelope(items: ReadonlyArray<ScoredKnowledgeChunkV1>): RetrievedKnowledgeV1 {
  return {
    schema_version: 1,
    items: [...items],
    degraded: false,
    degradation_reason: "",
    starvation_tiers: [],
    source_counts: { repo: 0, knowledge: items.length, confluence: 1, deduped: 0 },
  };
}

const PR_CTX = PRContext.parse({
  pr_id: randomUUID(),
  head_sha: "a".repeat(40),
  repo_default_branch: "main",
  changed_files: [{ path: "services/api/main.py", additions: 10, deletions: 2 }],
});
const YAML_CFG = CodemasterConfigV1.parse({});
const PLATFORM_LABELS = ["default", "lang:python"];
const QVEC = [0.1, 0.2, 0.3];

/** A fully-gated hybrid input (all five preconditions satisfied). */
function gatedInput(overrides: Partial<RetrieveKnowledgeInputV1> = {}): RetrieveKnowledgeInputV1 {
  return {
    schema_version: 1,
    installation_id: IID,
    repo_id: RID,
    query: "services/api/main.py PR title",
    top_k: 5,
    query_vector_override: QVEC,
    include_confluence: true,
    pr_context: PR_CTX,
    yaml_config: YAML_CFG,
    platform_exposed_labels: PLATFORM_LABELS,
    ...overrides,
  };
}

function buildActivity(opts: {
  bm25?: RecordingRetriever;
  ann?: RecordingRetriever;
  hybrid?: RecordingHybrid;
}): {
  activity: RetrieveKnowledgeActivity;
  bm25: RecordingRetriever;
  ann: RecordingRetriever;
} {
  const bm25 = opts.bm25 ?? new RecordingRetriever([scored("docs/a.md", 0.9)]);
  const ann = opts.ann ?? new RecordingRetriever([scored("docs/b.md", 0.8)]);
  const activity = new RetrieveKnowledgeActivity({
    bm25Retriever: bm25 as unknown as Bm25Retriever,
    annRetriever: ann as unknown as AnnRetriever,
    ...(opts.hybrid === undefined
      ? {}
      : { hybridRetriever: opts.hybrid as unknown as HybridRetriever }),
  });
  return { activity, bm25, ann };
}

describe("RetrieveKnowledgeActivity — legacy BM25+ANN+RRF path (no hybrid retriever)", () => {
  it("runs BM25+ANN+RRF when no hybrid retriever is wired", async () => {
    const { activity, bm25, ann } = buildActivity({});
    const result = await activity.retrieveKnowledge(gatedInput());
    // Legacy fused both stub retrievers.
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.retrieval_degraded).toBe(false);
    // Both legacy retrievers were called with the wide (PRE_FUSION_TOP_K) query, include_confluence=false.
    expect(bm25.lastQuery?.include_confluence).toBe(false);
    expect(ann.lastQuery?.include_confluence).toBe(false);
    expect(bm25.lastQuery?.query_vector_override).toEqual(QVEC);
  });
});

describe("RetrieveKnowledgeActivity — _should_use_hybrid gate (1:1 with the Python preconditions)", () => {
  it("takes the legacy path when include_confluence=false", async () => {
    const hybrid = new RecordingHybrid(hybridEnvelope([scored("confluence/x/y", 0.95)]));
    const { activity } = buildActivity({ hybrid });
    await activity.retrieveKnowledge(gatedInput({ include_confluence: false }));
    expect(hybrid.called).toBe(false);
  });

  it("takes the legacy path when pr_context is null", async () => {
    const hybrid = new RecordingHybrid(hybridEnvelope([]));
    const { activity } = buildActivity({ hybrid });
    await activity.retrieveKnowledge(gatedInput({ pr_context: null }));
    expect(hybrid.called).toBe(false);
  });

  it("takes the legacy path when yaml_config is null", async () => {
    const hybrid = new RecordingHybrid(hybridEnvelope([]));
    const { activity } = buildActivity({ hybrid });
    await activity.retrieveKnowledge(gatedInput({ yaml_config: null }));
    expect(hybrid.called).toBe(false);
  });

  it("takes the legacy path when platform_exposed_labels is empty", async () => {
    const hybrid = new RecordingHybrid(hybridEnvelope([]));
    const { activity } = buildActivity({ hybrid });
    await activity.retrieveKnowledge(gatedInput({ platform_exposed_labels: [] }));
    expect(hybrid.called).toBe(false);
  });

  it("takes the legacy path when query_vector_override is null", async () => {
    const hybrid = new RecordingHybrid(hybridEnvelope([]));
    const { activity } = buildActivity({ hybrid });
    await activity.retrieveKnowledge(gatedInput({ query_vector_override: null }));
    expect(hybrid.called).toBe(false);
  });

  it("takes the legacy path when NO hybrid retriever is wired (even if all inputs present)", async () => {
    const { activity } = buildActivity({});
    const result = await activity.retrieveKnowledge(gatedInput());
    // No hybrid: legacy fusion. (Asserted indirectly — the legacy stubs returned non-confluence chunks.)
    expect(result.items.every((c) => c.source !== "confluence")).toBe(true);
  });

  it("takes the HYBRID path when ALL five preconditions + the hybrid retriever are present", async () => {
    const hybrid = new RecordingHybrid(hybridEnvelope([scored("confluence/space/page", 0.99)]));
    const { activity } = buildActivity({ hybrid });
    const result = await activity.retrieveKnowledge(gatedInput());
    expect(hybrid.called).toBe(true);
    // The activity unwraps the scored chunks back to bare KnowledgeChunkV1 (ReviewContext shape).
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.relative_path).toBe("confluence/space/page");
  });
});

describe("RetrieveKnowledgeActivity — _retrieve_with_confluence wiring (1:1 with the Python)", () => {
  it("computes effective_labels and threads include_confluence=true into the hybrid query", async () => {
    const hybrid = new RecordingHybrid(hybridEnvelope([scored("confluence/s/p", 0.95)]));
    const { activity } = buildActivity({ hybrid });
    await activity.retrieveKnowledge(gatedInput());
    expect(hybrid.lastQuery?.include_confluence).toBe(true);
    // effective_labels = (detected ∪ {default}) ∩ platform — the python file has lang:python →
    // detector emits lang:python (a .py changed file), default always present, both on the platform list.
    const labels = new Set(hybrid.lastQuery?.effective_labels ?? []);
    expect(labels.has("default")).toBe(true);
    expect(labels.has("lang:python")).toBe(true);
    // default_pool_token_reservation_pct uses the contract default (platform_config cache unported).
    expect(hybrid.lastQuery?.default_pool_token_reservation_pct).toBe(0.15);
    // top_k + the query_vector_override are threaded through verbatim.
    expect(hybrid.lastQuery?.top_k).toBe(5);
    expect(hybrid.lastQuery?.query_vector_override).toEqual(QVEC);
  });

  it("propagates the hybrid envelope's degraded + degradation_reason onto the result", async () => {
    const degradedEnvelope: RetrievedKnowledgeV1 = {
      schema_version: 1,
      items: [scored("confluence/s/p", 0.9)],
      degraded: true,
      degradation_reason: "rerank LLM unavailable",
      starvation_tiers: [],
      source_counts: {},
    };
    const hybrid = new RecordingHybrid(degradedEnvelope);
    const { activity } = buildActivity({ hybrid });
    const result = await activity.retrieveKnowledge(gatedInput());
    expect(result.retrieval_degraded).toBe(true);
    expect(result.degradation_reason).toBe("rerank LLM unavailable");
  });
});
