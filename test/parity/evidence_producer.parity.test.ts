import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import {
  pyBuildRetrievedEvidence,
  shutdownEvidenceProducerRef,
  type ModelInput,
} from "./evidence_producer_oracle.js";
import {
  buildRetrievedEvidence,
  buildRetrievedEvidenceEntries,
  DEFAULT_ENTRY_CAP,
} from "#backend/activities/build_retrieved_evidence.activity.js";
import { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { BuildRetrievedEvidenceInputV1 } from "#contracts/build_retrieved_evidence_input.v1.js";
import { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import { KnowledgeChunkV1 } from "#contracts/knowledge_chunks.v1.js";
import { PRTopologyEntryV1 } from "#contracts/pr_topology.v1.js";
import { ToolStatusV1 } from "#contracts/tool_status.v1.js";

afterAll(() => {
  shutdownEvidenceProducerRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS `buildRetrievedEvidenceEntries` core (the producer the
// `buildRetrievedEvidence` activity runs) is byte-equal to the frozen Python `build_retrieved_evidence`
// (vendor/codemaster-py/codemaster/review/evidence_producer.py), driven over the dedicated ref
// (tools/parity/run_evidence_producer_ref.py).
//
// SAME ENTRIES, SAME ev_ids, SAME priority-cap drop order — exercised over adversarial inputs (>100
// entries spanning ALL FIVE source types). RetrievedEvidenceV1 has NO bare floats (all str / uuid-string
// / Literal), so the canonical diff is a full byte-equality compare with no field stripping.
//
// The whole reason this is an ACTIVITY (not inline workflow code like the frozen Python) is that the TS
// `mintEvidenceId` uses node:crypto — restricted in the Temporal workflow V8 sandbox. The parity here
// proves the crypto-minted ev_ids match the Python `mint_evidence_id` UUIDv5 byte-for-byte across all
// five source types and the index-disambiguated tool_status keys (R-21).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// Canonical-lowercase UUIDs (Pydantic lowercases on dump; Zod .uuid() does not — keep inputs canonical).
const U = (n: number): string => {
  const h = n.toString(16).padStart(8, "0");
  return `${h}-0000-4000-8000-000000000000`;
};

/** A valid DiffChunkV1 wire dict (the shape `DiffChunkV1(**dict)` / `.parse` accept). */
function chunk(overrides: Partial<ModelInput> = {}): ModelInput {
  return {
    chunk_id: U(1),
    path: "src/app.ts",
    language: "typescript",
    start_line: 10,
    end_line: 42,
    body: "export function add(a: number, b: number) {\n  return a + b;\n}\n",
    chunk_kind: "function",
    token_estimate: 30,
    ...overrides,
  };
}

/** A valid KnowledgeChunkV1 wire dict. */
function knowledge(n: number, overrides: Partial<ModelInput> = {}): ModelInput {
  return {
    chunk_id: U(100 + n),
    installation_id: U(900),
    repo_id: U(901),
    relative_path: `docs/adr/${n}.md`,
    chunk_index: 0,
    body: `Knowledge body ${n}: prefer X over Y.`,
    doc_kind: "adr",
    ...overrides,
  };
}

/** A valid AnalysisFindingV1 wire dict. */
function tier1(n: number, overrides: Partial<ModelInput> = {}): ModelInput {
  return {
    finding_id: U(200 + n),
    tool: "ruff",
    rule_id: `RUF${String(n).padStart(3, "0")}`,
    file: `src/mod${n}.py`,
    start_line: 1,
    end_line: 1,
    severity_raw: "error",
    message: `Unused import number ${n}.`,
    ...overrides,
  };
}

/** A valid ToolStatusV1 wire dict (RFC3339 datetimes; finished_at nullable-but-required). */
function toolStatus(overrides: Partial<ModelInput> = {}): ModelInput {
  return {
    tool_name: "ruff",
    status: "completed",
    files_scanned: 3,
    files_total: 3,
    started_at: "2026-06-03T10:00:00+00:00",
    finished_at: "2026-06-03T10:00:01+00:00",
    duration_ms: 1000,
    ...overrides,
  };
}

/** A valid PRTopologyEntryV1 wire dict. */
function topology(n: number, overrides: Partial<ModelInput> = {}): ModelInput {
  return {
    chunk_id: U(300 + n),
    path: `src/topo${n}.ts`,
    start_line: 1,
    end_line: 5,
    kind: "code",
    ...overrides,
  };
}

/**
 * Run the SAME per-chunk inputs through the TS core and the frozen Python, and assert byte-equality of
 * the emitted entries (full RetrievedEvidenceV1 dumps — ev_id, source_type, chunk_id, knowledge_chunk_id,
 * path, excerpt — in priority order). Returns the TS entries so a caller can make extra structural
 * assertions. Parses each input through the ported contract first (mirrors the Python ref's
 * `<Model>(**dict)`, applying contract defaults before the producer consumes them).
 */
async function assertParity(args: {
  readonly chunk: ModelInput;
  readonly retrievedKnowledge?: ReadonlyArray<ModelInput>;
  readonly tier1Findings?: ReadonlyArray<ModelInput>;
  readonly toolStatuses?: ReadonlyArray<ModelInput>;
  readonly prTopologyManifest?: ReadonlyArray<ModelInput>;
  readonly maxEntries?: number;
}): Promise<Array<Record<string, unknown>>> {
  const tsEntries = buildRetrievedEvidenceEntries({
    chunk: DiffChunkV1.parse(args.chunk),
    retrievedKnowledge: (args.retrievedKnowledge ?? []).map((d) => KnowledgeChunkV1.parse(d)),
    tier1Findings: (args.tier1Findings ?? []).map((d) => AnalysisFindingV1.parse(d)),
    toolStatuses: (args.toolStatuses ?? []).map((d) => ToolStatusV1.parse(d)),
    prTopologyManifest: (args.prTopologyManifest ?? []).map((d) => PRTopologyEntryV1.parse(d)),
    ...(args.maxEntries === undefined ? {} : { maxEntries: args.maxEntries }),
  });

  const py = await pyBuildRetrievedEvidence({
    chunk: args.chunk,
    ...(args.retrievedKnowledge === undefined ? {} : { retrievedKnowledge: args.retrievedKnowledge }),
    ...(args.tier1Findings === undefined ? {} : { tier1Findings: args.tier1Findings }),
    ...(args.toolStatuses === undefined ? {} : { toolStatuses: args.toolStatuses }),
    ...(args.prTopologyManifest === undefined ? {} : { prTopologyManifest: args.prTopologyManifest }),
    ...(args.maxEntries === undefined ? {} : { maxEntries: args.maxEntries }),
  });

  // Byte-equal entries list (full RetrievedEvidenceV1 dumps, in priority order). canonicalize key-sorts.
  const tsDict = tsEntries as unknown as Array<Record<string, unknown>>;
  expect(canonicalize(tsDict)).toBe(canonicalize(py.entries));
  return tsDict;
}

describe("build_retrieved_evidence parity (Pydantic ↔ TS)", () => {
  it("chunk_body is ALWAYS emitted (all auxiliary sources empty) → exactly 1 entry", async () => {
    const r = await assertParity({ chunk: chunk() });
    expect(r).toHaveLength(1);
    expect(r[0]!["source_type"]).toBe("chunk_body");
    expect(r[0]!["chunk_id"]).toBe(U(1));
    expect(r[0]!["path"]).toBe("src/app.ts");
    expect(String(r[0]!["evidence_id"])).toMatch(/^ev_[0-9a-f]{16}$/);
  }, 30_000);

  it("empty chunk body → `(empty <chunk_kind>)` fallback excerpt", async () => {
    const r = await assertParity({ chunk: chunk({ body: "", chunk_kind: "hunk" }) });
    expect(r[0]!["excerpt"]).toBe("(empty hunk)");
  }, 30_000);

  it("chunk body > 2000 chars → excerpt truncated to 2000 (both sides)", async () => {
    const big = "x".repeat(5000);
    const r = await assertParity({ chunk: chunk({ body: big }) });
    expect((r[0]!["excerpt"] as string).length).toBe(2000);
  }, 30_000);

  it("retrieved_knowledge entries follow chunk_body in priority order", async () => {
    const r = await assertParity({
      chunk: chunk(),
      retrievedKnowledge: [knowledge(1), knowledge(2)],
    });
    expect(r.map((e) => e["source_type"])).toEqual([
      "chunk_body",
      "retrieved_knowledge",
      "retrieved_knowledge",
    ]);
    // knowledge_chunk_id is populated; chunk_id is null on knowledge entries.
    expect(r[1]!["knowledge_chunk_id"]).toBe(U(101));
    expect(r[1]!["chunk_id"]).toBeNull();
    expect(r[1]!["path"]).toBe("docs/adr/1.md");
  }, 30_000);

  it("knowledge excerpt = body (R-20 empty fallback is defensive — body min_length=1 in the contract)", async () => {
    // The Python `_knowledge_evidence` R-20 fallback `(empty <doc_kind> knowledge chunk)` is defensive:
    // KnowledgeChunkV1.body has min_length=1, so an empty body cannot reach the producer through the
    // contract on EITHER side. We assert the truthy-body path (excerpt = body) instead, which both
    // sides take identically; the fallback branch is unreachable-by-contract dead code preserved 1:1.
    const r = await assertParity({ chunk: chunk(), retrievedKnowledge: [knowledge(1, { body: "z" })] });
    expect(r[1]!["excerpt"]).toBe("z");
  }, 30_000);

  it("tier1 findings: ev_id keyed on finding_id, excerpt = `rule_id: message`", async () => {
    const r = await assertParity({ chunk: chunk(), tier1Findings: [tier1(1)] });
    expect(r[1]!["source_type"]).toBe("tier1_finding");
    expect(r[1]!["excerpt"]).toBe("RUF001: Unused import number 1.");
    expect(r[1]!["path"]).toBe("src/mod1.py");
    // tier1 entries carry no chunk_id / knowledge_chunk_id.
    expect(r[1]!["chunk_id"]).toBeNull();
    expect(r[1]!["knowledge_chunk_id"]).toBeNull();
  }, 30_000);

  it("pr_topology excerpt = `<kind> <path>:<start>-<end>`", async () => {
    const r = await assertParity({ chunk: chunk(), prTopologyManifest: [topology(1)] });
    expect(r[1]!["source_type"]).toBe("pr_topology");
    expect(r[1]!["excerpt"]).toBe("code src/topo1.ts:1-5");
    expect(r[1]!["chunk_id"]).toBe(U(301));
  }, 30_000);

  it("tool_status: index disambiguates duplicate (tool_name, status) → DISTINCT ev_ids (R-21)", async () => {
    // Two IDENTICAL tool statuses; without the sequence index in the mint key they would collide.
    const r = await assertParity({
      chunk: chunk(),
      toolStatuses: [toolStatus(), toolStatus()],
    });
    expect(r.map((e) => e["source_type"])).toEqual(["chunk_body", "tool_status", "tool_status"]);
    expect(r[1]!["excerpt"]).toBe("ruff completed");
    expect(r[2]!["excerpt"]).toBe("ruff completed");
    // Same excerpt, DIFFERENT ev_ids (index 0 vs 1 in the mint key).
    expect(r[1]!["evidence_id"]).not.toBe(r[2]!["evidence_id"]);
  }, 30_000);

  it("FULL priority order across all five source types", async () => {
    const r = await assertParity({
      chunk: chunk(),
      retrievedKnowledge: [knowledge(1)],
      tier1Findings: [tier1(1)],
      toolStatuses: [toolStatus()],
      prTopologyManifest: [topology(1)],
    });
    expect(r.map((e) => e["source_type"])).toEqual([
      "chunk_body",
      "retrieved_knowledge",
      "tier1_finding",
      "pr_topology",
      "tool_status",
    ]);
  }, 30_000);

  it("ADVERSARIAL: >100 entries across all five types → cap at 100, lowest-priority dropped FIRST", async () => {
    // 1 chunk_body + 40 knowledge + 40 tier1 + 40 topology + 40 tool_status = 161 pre-cap.
    // Priority order: chunk_body(1) → knowledge(40) → tier1(40) → topology(40) → tool_status(40).
    // Cap 100 keeps: chunk_body(1) + knowledge(40) + tier1(40) + topology(19) = 100; topology[19:] and
    // ALL tool_status dropped (lowest priority first).
    const retrievedKnowledge = Array.from({ length: 40 }, (_, i) => knowledge(i + 1));
    const tier1Findings = Array.from({ length: 40 }, (_, i) => tier1(i + 1));
    const prTopologyManifest = Array.from({ length: 40 }, (_, i) => topology(i + 1));
    const toolStatuses = Array.from({ length: 40 }, (_, i) =>
      toolStatus({ tool_name: `tool${i}` }),
    );

    const r = await assertParity({
      chunk: chunk(),
      retrievedKnowledge,
      tier1Findings,
      prTopologyManifest,
      toolStatuses,
    });
    expect(r).toHaveLength(DEFAULT_ENTRY_CAP);
    const kinds = r.map((e) => e["source_type"]);
    expect(kinds.filter((k) => k === "chunk_body")).toHaveLength(1);
    expect(kinds.filter((k) => k === "retrieved_knowledge")).toHaveLength(40);
    expect(kinds.filter((k) => k === "tier1_finding")).toHaveLength(40);
    expect(kinds.filter((k) => k === "pr_topology")).toHaveLength(19);
    // Lowest priority (tool_status) fully dropped under cap pressure.
    expect(kinds.filter((k) => k === "tool_status")).toHaveLength(0);
  }, 30_000);

  it("ADVERSARIAL: explicit max_entries cap drops the tail deterministically", async () => {
    const r = await assertParity({
      chunk: chunk(),
      retrievedKnowledge: [knowledge(1), knowledge(2), knowledge(3)],
      maxEntries: 2,
    });
    // chunk_body + 1 knowledge survive; knowledge(2)/(3) dropped (tail).
    expect(r).toHaveLength(2);
    expect(r.map((e) => e["source_type"])).toEqual(["chunk_body", "retrieved_knowledge"]);
  }, 30_000);

  it("max_entries=0 drops EVERYTHING (even chunk_body)", async () => {
    const r = await assertParity({ chunk: chunk(), maxEntries: 0 });
    expect(r).toHaveLength(0);
  }, 30_000);

  it("ACTIVITY round-trip: buildRetrievedEvidence over the typed envelope matches the frozen Python", async () => {
    const input = BuildRetrievedEvidenceInputV1.parse({
      chunk: chunk(),
      retrieved_knowledge: [knowledge(1)],
      tier1_findings: [tier1(1)],
      tool_statuses: [toolStatus()],
      pr_topology_manifest: [topology(1)],
    });
    const out = await buildRetrievedEvidence(input);

    const py = await pyBuildRetrievedEvidence({
      chunk: chunk(),
      retrievedKnowledge: [knowledge(1)],
      tier1Findings: [tier1(1)],
      toolStatuses: [toolStatus()],
      prTopologyManifest: [topology(1)],
    });
    expect(canonicalize(out)).toBe(canonicalize(py.entries));
    expect(out.map((e) => e.source_type)).toEqual([
      "chunk_body",
      "retrieved_knowledge",
      "tier1_finding",
      "pr_topology",
      "tool_status",
    ]);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// BuildRetrievedEvidenceInputV1 — NEW typed envelope introduced during the port (CLAUDE.md invariant 11 /
// ADR-0047). No Python counterpart to byte-diff → round-trip + validation only.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("BuildRetrievedEvidenceInputV1 envelope (no Python counterpart — validation only)", () => {
  it("accepts a minimal {chunk} and applies all defaults", () => {
    const parsed = BuildRetrievedEvidenceInputV1.parse({ chunk: chunk() });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.retrieved_knowledge).toEqual([]);
    expect(parsed.tier1_findings).toEqual([]);
    expect(parsed.tool_statuses).toEqual([]);
    expect(parsed.pr_topology_manifest).toEqual([]);
    expect(parsed.max_entries).toBe(100);
  });

  it("rejects an unknown top-level key (.strict() ↔ Pydantic extra=forbid)", () => {
    expect(() => BuildRetrievedEvidenceInputV1.parse({ chunk: chunk(), bogus: true })).toThrow();
  });

  it("rejects a missing chunk (required, no default)", () => {
    expect(() => BuildRetrievedEvidenceInputV1.parse({ retrieved_knowledge: [] })).toThrow();
  });

  it("rejects a chunk that violates the DiffChunkV1 contract (end_line < start_line)", () => {
    expect(() =>
      BuildRetrievedEvidenceInputV1.parse({ chunk: chunk({ start_line: 9, end_line: 1 }) }),
    ).toThrow();
  });

  it("rejects a negative max_entries (ge=0)", () => {
    expect(() => BuildRetrievedEvidenceInputV1.parse({ chunk: chunk(), max_entries: -1 })).toThrow();
  });

  it("rejects a knowledge entry that violates KnowledgeChunkV1 (missing doc_kind)", () => {
    const bad = knowledge(1) as Record<string, unknown>;
    delete bad["doc_kind"];
    expect(() =>
      BuildRetrievedEvidenceInputV1.parse({ chunk: chunk(), retrieved_knowledge: [bad] }),
    ).toThrow();
  });
});
