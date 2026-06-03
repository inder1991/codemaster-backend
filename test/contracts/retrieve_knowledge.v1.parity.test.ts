import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  RetrieveKnowledgeInputV1,
  RetrieveKnowledgeResultV1,
} from "../../libs/contracts/src/retrieve_knowledge.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the knowledge_chunks / markdown_chunk
// template.
const PY = "contracts.retrieve_knowledge.v1";

// Lowercase UUIDs — Pydantic dumps UUIDs lowercase, so payloads must be lowercase for a byte-equal
// canonical compare.
const IID = "00000000-0000-0000-0000-000000000002";
const RID = "00000000-0000-0000-0000-000000000003";
const CID = "00000000-0000-0000-0000-000000000001";
const PRID = "00000000-0000-0000-0000-0000000000aa";

type Rec = Record<string, unknown>;

// BARE-FLOAT columns rejected by the repo canonicalizer (test/parity/canonical.ts). They cannot
// byte-round-trip (Python emits `0.0`; JS emits `0`), so strip them — including nested copies inside
// pr_context / items chunks — before the canonical diff, then assert structurally + range-reject
// separately.
function stripChunkFloats(chunk: unknown): unknown {
  if (chunk && typeof chunk === "object") {
    const c = { ...(chunk as Rec) };
    delete c.age_days;
    return c;
  }
  return chunk;
}

function stripInputFloats(o: unknown): string {
  const obj = { ...(o as Rec) };
  // RetrieveKnowledgeInputV1.query_vector_override : tuple[float, ...] | None.
  if ("query_vector_override" in obj) delete obj.query_vector_override;
  return canonicalize(obj);
}

function stripResultFloats(o: unknown): string {
  const obj = { ...(o as Rec) };
  // RetrieveKnowledgeResultV1.items[*].age_days : nested KnowledgeChunkV1 bare float.
  if (Array.isArray(obj.items)) obj.items = obj.items.map(stripChunkFloats);
  return canonicalize(obj);
}

// A valid nested PRContext payload (built per pr_context.v1's real fields). head_sha is a full
// 40-char git SHA; changed_files omits `classification` so it dumps the FileClassification default.
const PR_CONTEXT = {
  pr_id: PRID,
  head_sha: "a".repeat(40),
  changed_files: [{ path: "src/x.py", additions: 3, deletions: 1 }],
  manifests: [],
  repo_default_branch: "main",
} as const;

// A valid nested CodemasterConfigV1 payload (built per codemaster_config.v1's real fields). Only
// non-default fields are set; the rest exercise the nested defaults (knowledge / model_overrides).
const YAML_CONFIG = {
  enabled: true,
  severity_min: "issue",
  path_filters: ["src/**"],
  enabled_tools: ["ruff"],
} as const;

// A valid nested KnowledgeChunkV1 payload (built per knowledge_chunks.v1's real fields) for result
// items. doc_kind is required (no default).
const CHUNK = {
  chunk_id: CID,
  installation_id: IID,
  repo_id: RID,
  relative_path: "docs/adr/0001.md",
  chunk_index: 0,
  body: "We will use Postgres for everything.",
  doc_kind: "adr",
} as const;

describe("RetrieveKnowledgeInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full nested payload identically (query_vector_override float excepted)", async () => {
    // platform_exposed_labels uses a single element so the frozenset's nondeterministic dump order is
    // order-invariant for the byte-equal compare.
    const payload = {
      schema_version: 1,
      installation_id: IID,
      repo_id: RID,
      query: "Add caching to the retrieval path",
      top_k: 7,
      query_vector_override: [0.1, -0.2, 0.3],
      include_confluence: true,
      pr_context: PR_CONTEXT,
      yaml_config: YAML_CONFIG,
      platform_exposed_labels: ["lang:python"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = RetrieveKnowledgeInputV1.parse(payload);
    expect(stripInputFloats(parsed)).toBe(stripInputFloats(JSON.parse(r.out ?? "{}")));
    // The float-bearing column round-trips structurally.
    expect(parsed.query_vector_override).toEqual([0.1, -0.2, 0.3]);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted", async () => {
    const payload = { installation_id: IID, repo_id: RID, query: "q" };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = RetrieveKnowledgeInputV1.parse(payload);
    // No float present when query_vector_override is null — full byte-equality holds.
    expect(canonicalize(parsed)).toBe(r.out);
    // Defaults: schema_version=1, top_k=5, query_vector_override=null, include_confluence=false,
    // pr_context=null, yaml_config=null, platform_exposed_labels=[].
    expect(parsed.schema_version).toBe(1);
    expect(parsed.top_k).toBe(5);
    expect(parsed.query_vector_override).toBeNull();
    expect(parsed.include_confluence).toBe(false);
    expect(parsed.pr_context).toBeNull();
    expect(parsed.yaml_config).toBeNull();
    expect(parsed.platform_exposed_labels).toEqual([]);
  }, 30_000);

  it("accepts a forward schema_version (int default, NOT z.literal)", async () => {
    const payload = { schema_version: 2, installation_id: IID, repo_id: RID, query: "q" };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(RetrieveKnowledgeInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a bad UUID (installation_id)", async () => {
    const bad = { installation_id: "not-a-uuid", repo_id: RID, query: "q" };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeInputV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => RetrieveKnowledgeInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty query (min_length=1)", async () => {
    const bad = { installation_id: IID, repo_id: RID, query: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrieveKnowledgeInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a too-long query (max_length=8000)", async () => {
    const bad = { installation_id: IID, repo_id: RID, query: "x".repeat(8001) };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrieveKnowledgeInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT top_k below the floor (ge=1)", async () => {
    const bad = { installation_id: IID, repo_id: RID, query: "q", top_k: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrieveKnowledgeInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT top_k above the ceiling (le=20)", async () => {
    const bad = { installation_id: IID, repo_id: RID, query: "q", top_k: 21 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrieveKnowledgeInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested pr_context (short head_sha propagates)", async () => {
    const bad = {
      installation_id: IID,
      repo_id: RID,
      query: "q",
      pr_context: { ...PR_CONTEXT, head_sha: "abc" },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrieveKnowledgeInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested yaml_config (bad enabled_tools enum propagates)", async () => {
    const bad = {
      installation_id: IID,
      repo_id: RID,
      query: "q",
      yaml_config: { ...YAML_CONFIG, enabled_tools: ["bogus-tool"] },
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrieveKnowledgeInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { installation_id: IID, repo_id: RID, query: "q", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrieveKnowledgeInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("RetrieveKnowledgeResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (nested age_days float excepted)", async () => {
    const payload = {
      schema_version: 1,
      items: [CHUNK],
      retrieval_degraded: true,
      degradation_reason: "ann->bm25 fallback",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = RetrieveKnowledgeResultV1.parse(payload);
    expect(stripResultFloats(parsed)).toBe(stripResultFloats(JSON.parse(r.out ?? "{}")));
    // Nested chunk age_days round-trips structurally (default 0).
    expect(parsed.items[0]?.age_days).toBe(0);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted (empty items)", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = RetrieveKnowledgeResultV1.parse(payload);
    // No nested float when items is empty — full byte-equality holds.
    expect(canonicalize(parsed)).toBe(r.out);
    // Defaults: schema_version=1, items=[], retrieval_degraded=false, degradation_reason="".
    expect(parsed.schema_version).toBe(1);
    expect(parsed.items).toEqual([]);
    expect(parsed.retrieval_degraded).toBe(false);
    expect(parsed.degradation_reason).toBe("");
  }, 30_000);

  it("both REJECT a too-long degradation_reason (max_length=200)", async () => {
    const bad = { degradation_reason: "x".repeat(201) };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrieveKnowledgeResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested item (bad doc_kind enum propagates)", async () => {
    const bad = { items: [{ ...CHUNK, doc_kind: "bogus_kind" }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrieveKnowledgeResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { retrieval_degraded: false, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "RetrieveKnowledgeResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => RetrieveKnowledgeResultV1.parse(bad)).toThrow();
  }, 30_000);
});
