import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { ReviewContextV1 } from "../../libs/contracts/src/review_context.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `ReviewContextV1(**payload).model_dump(mode="json")`) and through Zod (`ReviewContextV1.parse(payload)`),
// then diff canonical JSON. Accept/reject must also agree. ReviewContextV1 is the LARGEST contract
// (~11 cross-contract deps); the valid payloads below build a real sub-payload per embedded contract.
const PY = "contracts.review_context.v1";

// Lowercase UUIDs — Pydantic dumps UUIDs lowercase, so the payloads must be lowercase for a byte-equal
// canonical compare.
const PR_ID = "00000000-0000-0000-0000-0000000000a1";
const IID = "00000000-0000-0000-0000-0000000000a2";
const CHUNK_ID = "00000000-0000-0000-0000-0000000000b1";
const KCHUNK_ID = "00000000-0000-0000-0000-0000000000c1";
const REPO_ID = "00000000-0000-0000-0000-0000000000c2";
const SYMBOL_ID = "00000000-0000-0000-0000-0000000000d1";
const CONSUMER_REPO_ID = "00000000-0000-0000-0000-0000000000d2";
const FINDING_ID = "00000000-0000-0000-0000-0000000000e1";

const SHA64 = "a".repeat(64);

// ── Valid nested sub-payloads (one per embedded contract; real fields per the dep contract) ──────────

// DiffChunkV1 — required `chunk` field.
const CHUNK = {
  chunk_id: CHUNK_ID,
  path: "src/app.ts",
  language: "typescript",
  start_line: 10,
  end_line: 42,
  body: "export const x = 1;",
  chunk_kind: "function",
  token_estimate: 120,
} as const;

// ReviewFindingV1 — carries the bare-float `confidence` (stripped from the canonical diff).
const PRIOR_FINDING = {
  file: "src/app.ts",
  start_line: 10,
  end_line: 12,
  severity: "issue",
  category: "bug",
  title: "Off-by-one",
  body: "The loop bound is wrong.",
  confidence: 1, // pydantic coerces int→float; serialized 1.0 on Python, 1 on JS (stripped below).
} as const;

// PathInstructionV1.
const PATH_INSTRUCTION = { path: "src/**", instructions: "No console.log in src." } as const;

// KnowledgeChunkV1 — carries the bare-float `age_days` (stripped from the canonical diff).
const KNOWLEDGE_CHUNK = {
  chunk_id: KCHUNK_ID,
  installation_id: IID,
  repo_id: REPO_ID,
  relative_path: "docs/adr/0001.md",
  chunk_index: 0,
  body: "We will use Postgres for everything.",
  doc_kind: "adr",
} as const;

// ExtractedRuleV1 — nested inside DedupedRuleV1 inside ResolvedGuidanceBundleV1 (applicable_policy).
const EXTRACTED_RULE = {
  rule_id: "sec-src-no-eval-abcd1234",
  normalized_hash: SHA64,
  source_file: "CLAUDE.md",
  source_file_sha256: SHA64,
  scope_dir: "",
  rule_index: 0,
  title: "No eval",
  body: "Never call eval() on untrusted input.",
  category: "security",
  intent: "forbid",
  priority: 100,
} as const;

const APPLICABLE_POLICY = {
  changed_path: "src/app.ts",
  applicable_rules: [{ rule: EXTRACTED_RULE, sources: [EXTRACTED_RULE] }],
  resolution_explanation: ["Applied CLAUDE.md (root) — nearest ancestor; category=security"],
} as const;

// RemovedOrChangedSymbolV1.
const REMOVED_SYMBOL = {
  target_symbol_id: SYMBOL_ID,
  qualified_name: "app.foo",
  change_kind: "removed",
} as const;

// ConsumerHitV1.
const CONSUMER_HIT = {
  consumer_repo_id: CONSUMER_REPO_ID,
  consumer_relative_path: "other/bar.ts",
  consumer_line: 7,
  confidence: "high",
} as const;

// AnalysisFindingV1 (Tier-1).
const TIER1_FINDING = {
  finding_id: FINDING_ID,
  tool: "eslint",
  rule_id: "no-console",
  file: "src/app.ts",
  start_line: 10,
  end_line: 10,
  severity_raw: "error",
  message: "Unexpected console statement.",
} as const;

// ToolStatusV1 (datetime fields are ISO-8601 strings).
const TOOL_STATUS = {
  tool_name: "eslint",
  status: "completed",
  files_scanned: 5,
  files_total: 5,
  started_at: "2026-06-03T10:00:00+00:00",
  finished_at: "2026-06-03T10:00:01+00:00",
  duration_ms: 1000,
} as const;

// RetrievedEvidenceV1 (evidence_id matches ^ev_[0-9a-f]{16}$).
const EVIDENCE = {
  evidence_id: "ev_0123456789abcdef",
  source_type: "chunk_body",
  chunk_id: CHUNK_ID,
  excerpt: "export const x = 1;",
} as const;

// PRTopologyEntryV1.
const TOPOLOGY_ENTRY = {
  chunk_id: CHUNK_ID,
  path: "src/app.ts",
  start_line: 10,
  end_line: 42,
  kind: "code",
} as const;

// ManifestSnapshot (contracts.retrieval.pr_context).
const MANIFEST = {
  path: "package.json",
  raw_body: '{"name":"app"}',
} as const;

// ── Bare-float strip: prior_findings[*].confidence + retrieved_knowledge[*].age_days cannot byte-
// round-trip (Python emits `1.0` / `0.0`; JS emits `1` / `0`). Strip them recursively before the
// canonical diff, then assert structure separately — same pattern as knowledge_chunks.v1.parity.test.ts.
type Rec = Record<string, unknown>;

function stripFinding(f: unknown): unknown {
  if (f && typeof f === "object") {
    const c = { ...(f as Rec) };
    delete c.confidence;
    return c;
  }
  return f;
}

function stripChunk(c: unknown): unknown {
  if (c && typeof c === "object") {
    const o = { ...(c as Rec) };
    delete o.age_days;
    return o;
  }
  return c;
}

// Re-canonicalize after dropping every bare-float column the envelope carries (in nested arrays) so
// both sides run through the identical key-sort + scalar rules.
function stripFloats(o: unknown): string {
  const obj = { ...(o as Rec) };
  if (Array.isArray(obj.prior_findings)) obj.prior_findings = obj.prior_findings.map(stripFinding);
  if (Array.isArray(obj.retrieved_knowledge)) {
    obj.retrieved_knowledge = obj.retrieved_knowledge.map(stripChunk);
  }
  return canonicalize(obj);
}

describe("ReviewContextV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a FULL payload identically (bare floats excepted)", async () => {
    const payload = {
      schema_version: 1,
      pr_id: PR_ID,
      installation_id: IID,
      repo: "acme/widgets",
      pr_title: "Add caching",
      pr_description: "This PR adds a cache layer.",
      chunk: CHUNK,
      policy_revision: 7,
      prior_findings: [PRIOR_FINDING],
      matched_path_instructions: [PATH_INSTRUCTION],
      repo_config: {}, // exercises the shared-frozen-default fully-defaulted dump shape.
      retrieved_knowledge: [KNOWLEDGE_CHUNK],
      retrieval_degraded: true,
      retrieval_degradation_reason: "embed service rate-limited",
      budget_enforcement: true,
      applicable_policy: APPLICABLE_POLICY,
      removed_or_changed_symbols: [REMOVED_SYMBOL],
      consumer_hits: [CONSUMER_HIT],
      consumer_hits_truncated: true,
      tier1_findings: [TIER1_FINDING],
      tool_statuses: [TOOL_STATUS],
      retrieved_evidence: [EVIDENCE],
      pr_topology_manifest: [TOPOLOGY_ENTRY],
      manifests: [MANIFEST],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = ReviewContextV1.parse(payload);
    expect(stripFloats(parsed)).toBe(stripFloats(JSON.parse(r.out ?? "{}")));
    // The bare-float columns round-trip structurally.
    expect(parsed.prior_findings[0]?.confidence).toBe(1);
    expect(parsed.retrieved_knowledge[0]?.age_days).toBe(0);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted (minimal payload)", async () => {
    const payload = {
      pr_id: PR_ID,
      installation_id: IID,
      repo: "acme/widgets",
      pr_title: "",
      pr_description: "",
      chunk: CHUNK,
      policy_revision: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const parsed = ReviewContextV1.parse(payload);
    // No nested float when prior_findings/retrieved_knowledge are empty — full byte-equality holds.
    expect(canonicalize(parsed)).toBe(r.out);
    // Defaults.
    expect(parsed.schema_version).toBe(1);
    expect(parsed.prior_findings).toEqual([]);
    expect(parsed.matched_path_instructions).toEqual([]);
    expect(parsed.retrieved_knowledge).toEqual([]);
    expect(parsed.retrieval_degraded).toBe(false);
    expect(parsed.retrieval_degradation_reason).toBe("");
    expect(parsed.budget_enforcement).toBe(false);
    expect(parsed.applicable_policy).toBeNull();
    expect(parsed.removed_or_changed_symbols).toEqual([]);
    expect(parsed.consumer_hits).toEqual([]);
    expect(parsed.consumer_hits_truncated).toBe(false);
    expect(parsed.tier1_findings).toEqual([]);
    expect(parsed.tool_statuses).toEqual([]);
    expect(parsed.retrieved_evidence).toEqual([]);
    expect(parsed.pr_topology_manifest).toEqual([]);
    expect(parsed.manifests).toEqual([]);
    // The shared-frozen-default repo_config dumps its full nested-default shape.
    expect(parsed.repo_config.schema_version).toBe(1);
    expect(parsed.repo_config.enabled).toBe(true);
  }, 30_000);

  it("accepts a forward schema_version (int default, NOT z.literal)", async () => {
    const payload = {
      schema_version: 2,
      pr_id: PR_ID,
      installation_id: IID,
      repo: "acme/widgets",
      pr_title: "",
      pr_description: "",
      chunk: CHUNK,
      policy_revision: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ReviewContextV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a bad UUID (pr_id)", async () => {
    const bad = {
      pr_id: "not-a-uuid",
      installation_id: IID,
      repo: "acme/widgets",
      pr_title: "",
      pr_description: "",
      chunk: CHUNK,
      policy_revision: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => ReviewContextV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative policy_revision (ge=0)", async () => {
    const bad = {
      pr_id: PR_ID,
      installation_id: IID,
      repo: "acme/widgets",
      pr_title: "",
      pr_description: "",
      chunk: CHUNK,
      policy_revision: -1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewContextV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty repo (min_length=1)", async () => {
    const bad = {
      pr_id: PR_ID,
      installation_id: IID,
      repo: "",
      pr_title: "",
      pr_description: "",
      chunk: CHUNK,
      policy_revision: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewContextV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a too-long retrieval_degradation_reason (max_length=200)", async () => {
    const bad = {
      pr_id: PR_ID,
      installation_id: IID,
      repo: "acme/widgets",
      pr_title: "",
      pr_description: "",
      chunk: CHUNK,
      policy_revision: 0,
      retrieval_degradation_reason: "x".repeat(201),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewContextV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested chunk (end_line < start_line propagates)", async () => {
    const bad = {
      pr_id: PR_ID,
      installation_id: IID,
      repo: "acme/widgets",
      pr_title: "",
      pr_description: "",
      chunk: { ...CHUNK, start_line: 50, end_line: 10 },
      policy_revision: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewContextV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested evidence_id (pattern propagates)", async () => {
    const bad = {
      pr_id: PR_ID,
      installation_id: IID,
      repo: "acme/widgets",
      pr_title: "",
      pr_description: "",
      chunk: CHUNK,
      policy_revision: 0,
      retrieved_evidence: [{ ...EVIDENCE, evidence_id: "not_an_ev_id" }],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewContextV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT too many retrieved_evidence entries (max_length=100)", async () => {
    const many = Array.from({ length: 101 }, (_v, i) => ({
      ...EVIDENCE,
      evidence_id: `ev_${i.toString(16).padStart(16, "0")}`,
    }));
    const bad = {
      pr_id: PR_ID,
      installation_id: IID,
      repo: "acme/widgets",
      pr_title: "",
      pr_description: "",
      chunk: CHUNK,
      policy_revision: 0,
      retrieved_evidence: many,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewContextV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT too many manifests (max_length=50)", async () => {
    const many = Array.from({ length: 51 }, (_v, i) => ({ path: `m${i}.json`, raw_body: "{}" }));
    const bad = {
      pr_id: PR_ID,
      installation_id: IID,
      repo: "acme/widgets",
      pr_title: "",
      pr_description: "",
      chunk: CHUNK,
      policy_revision: 0,
      manifests: many,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewContextV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      pr_id: PR_ID,
      installation_id: IID,
      repo: "acme/widgets",
      pr_title: "",
      pr_description: "",
      chunk: CHUNK,
      policy_revision: 0,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ReviewContextV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ReviewContextV1.parse(bad)).toThrow();
  }, 30_000);
});
