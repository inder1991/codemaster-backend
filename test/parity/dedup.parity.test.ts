import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import { pyDedupLinterWithLlm, shutdownDedupRef, type FindingInput } from "./dedup_oracle.js";
import { doDedupLinterWithLlm, DedupFindingsActivity } from "#backend/activities/dedup_findings.activity.js";
import { RecordingEmbeddingsClient } from "#backend/adapters/embeddings_port.js";
import { DedupedFindingsV1, DedupFindingsInputV1 } from "#contracts/dedup_findings.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

afterAll(() => {
  shutdownDedupRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS `doDedupLinterWithLlm` core (linter+llm concat → exact-dedup →
// semantic-skip) is byte-equal to the frozen Python `dedup_linter_with_llm`
// (vendor/codemaster-py/codemaster/analysis/dedup_with_llm.py), driven over the dedicated ref
// (tools/parity/run_dedup_ref.py).
//
// BOTH sides take the DETERMINISTIC path: the Python ref drives a FAILING embedder (forced fail-open →
// exact-only dedup), and the TS core is driven with NO embedder (the same fail-open seam — exactly how
// the frozen Python workflow body calls the dedup, `embedder=None`, with the real embedder living in the
// activity runtime). This is the same technique the aggregate semantic-skip parity test uses, so the
// merge stage's network dependency is removed from the parity comparison and the dedup is byte-stable.
//
// `confidence` is a bare Python float that cannot byte-round-trip through the canonicalizer (1.0 vs "1");
// it is STRIPPED from the canonical compare on both sides (`stripConfidence`) and asserted STRUCTURALLY
// (`confidences`) — the established bare-float handling (mirrors aggregate.parity.test.ts).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Build one finding wire dict (the shape `ReviewFindingV1(**dict)` / `ReviewFindingV1.parse` accept). */
function f(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    file: "a.py",
    start_line: 1,
    end_line: 1,
    severity: "issue",
    category: "bug",
    title: "t",
    body: "b",
    confidence: 0.5,
    ...overrides,
  };
}

/** Deep-clone with every `confidence` key removed (Python serializes 1.0; JS serializes 1). */
function stripConfidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripConfidence);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "confidence") continue;
      out[k] = stripConfidence(v);
    }
    return out;
  }
  return value;
}

/** The confidence floats of each finding, in order — the structural assertion the canonical strip omits. */
function confidences(findings: ReadonlyArray<Record<string, unknown>>): Array<number> {
  return findings.map((x) => x["confidence"] as number);
}

/**
 * Run the SAME linter + LLM findings through the TS core (no embedder → fail-open) and the frozen Python
 * (failing embedder → fail-open), and assert byte-equality of the findings list + ORDER, with
 * `confidence` stripped from the canonical diff and asserted structurally. Returns the TS skip flag so a
 * caller can make extra structural assertions on it. The Python `dedup_linter_with_llm` does not surface
 * its skip flag, so there is no Python-side skip value to diff — the TS flag is asserted independently.
 */
async function assertParity(
  linter: ReadonlyArray<FindingInput>,
  llm: ReadonlyArray<FindingInput>,
): Promise<{ readonly tsFindings: ReadonlyArray<Record<string, unknown>>; readonly semanticSkipped: boolean }> {
  // Parse each finding through the ported contract first — mirrors the Python ref's `ReviewFindingV1(**dict)`,
  // applying the contract defaults (sources / scope / evidence_refs) before the core consumes them.
  const parsedLinter = linter.map((d) => ReviewFindingV1.parse(d));
  const parsedLlm = llm.map((d) => ReviewFindingV1.parse(d));

  const [tsFindingsArr, semanticSkipped] = await doDedupLinterWithLlm(parsedLinter, parsedLlm);
  const tsFindings = tsFindingsArr as unknown as Array<Record<string, unknown>>;
  const py = await pyDedupLinterWithLlm(linter, llm);

  // Byte-equal findings list (confidence stripped). canonicalize key-sorts recursively + normalizes scalars.
  expect(canonicalize(stripConfidence(tsFindings))).toBe(canonicalize(stripConfidence(py.findings)));
  // Confidence floats match structurally, in order.
  expect(confidences(tsFindings)).toEqual(confidences(py.findings));
  return { tsFindings, semanticSkipped };
}

describe("dedup_linter_with_llm parity (Pydantic ↔ TS)", () => {
  it("both empty → empty output, no skip (short-circuit before the embedder)", async () => {
    const r = await assertParity([], []);
    expect(r.tsFindings).toHaveLength(0);
    // Python `if not linter and not llm: return ()` — never consults the embedder; nothing degraded.
    expect(r.semanticSkipped).toBe(false);
  }, 30_000);

  it("no linter findings → passthrough of llm findings, no skip (short-circuit)", async () => {
    const llm = [
      f({ body: "llm one", start_line: 1, end_line: 1 }),
      f({ body: "llm two", start_line: 5, end_line: 5 }),
    ];
    const r = await assertParity([], llm);
    expect(r.tsFindings).toHaveLength(2);
    // Python `if not linter_findings: return llm_findings` — returns BEFORE the semantic stage.
    expect(r.semanticSkipped).toBe(false);
  }, 30_000);

  it("no llm findings → passthrough of linter findings, no skip (short-circuit)", async () => {
    const linter = [f({ body: "lint one", start_line: 2, end_line: 2 })];
    const r = await assertParity(linter, []);
    expect(r.tsFindings).toHaveLength(1);
    // Python `if not llm_findings: return linter_findings` — returns BEFORE the semantic stage.
    expect(r.semanticSkipped).toBe(false);
  }, 30_000);

  it("combined order — linter finding FIRST, wins title/severity on an exact-key collision", async () => {
    // Same (file, start_line, end_line, category) on both → aggregate_exact collapses them; first
    // occurrence (the LINTER finding) is the base, higher-confidence source wins title/suggestion.
    const linter = [f({ body: "lint body", title: "RUF100 unused", severity: "nit", confidence: 0.9 })];
    const llm = [f({ body: "llm body", title: "llm title", severity: "issue", confidence: 0.4 })];
    const r = await assertParity(linter, llm);
    // 1 merged finding; linter's higher confidence keeps its title; severity = max(nit, issue) = issue.
    expect(r.tsFindings).toHaveLength(1);
    const merged = r.tsFindings[0]!;
    // Body union preserves first-occurrence (linter) order: "lint body\n---\nllm body".
    expect(merged["body"]).toBe("lint body\n---\nllm body");
    expect(merged["title"]).toBe("RUF100 unused");
    expect(merged["severity"]).toBe("issue");
    // The two findings COLLAPSE to a single exact-deduped finding, so only 1 finding reaches the
    // semantic stage → Python `len(findings) < 2` early return → skip False (the embedder is never
    // consulted). The semantic-skip flag is False here even though the exact stage merged a pair.
    expect(r.semanticSkipped).toBe(false);
  }, 30_000);

  it("distinct keys → no exact collapse; both survive in linter-then-llm order; skip True (≥2 reach stage)", async () => {
    const linter = [f({ body: "lint", start_line: 1, end_line: 1, file: "a.py" })];
    const llm = [f({ body: "llm", start_line: 9, end_line: 9, file: "b.py" })];
    const r = await assertParity(linter, llm);
    expect(r.tsFindings).toHaveLength(2);
    // Linter finding is FIRST in the combined order.
    expect(r.tsFindings[0]!["body"]).toBe("lint");
    expect(r.tsFindings[1]!["body"]).toBe("llm");
    expect(r.semanticSkipped).toBe(true);
  }, 30_000);

  it("single combined finding → semantic stage short-circuits (len<2) → skip False", async () => {
    // One linter + one llm on the SAME exact key → exact-dedup collapses to a SINGLE finding, so only
    // 1 finding reaches the semantic stage → Python `len(findings) < 2` early return → skip False.
    const linter = [f({ body: "same" })];
    const llm = [f({ body: "same" })];
    const r = await assertParity(linter, llm);
    expect(r.tsFindings).toHaveLength(1);
    expect(r.semanticSkipped).toBe(false);
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Activity holder — the real-embedder path. With the deterministic RecordingEmbeddingsClient the
// semantic stage actually RUNS (skip=false) over ≥2 same-file findings; an UNREACHABLE embedder
// degrades to the fail-open exact-only path (skip=true). No Python diff here (the activity envelope is
// introduced during the port); this proves the holder threads the embedder + surfaces the skip flag.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("DedupFindingsActivity holder (real embedder seam)", () => {
  it("real embedder runs the semantic stage (skip=false) over ≥2 distinct-key findings", async () => {
    const embedder = new RecordingEmbeddingsClient();
    const activity = new DedupFindingsActivity({ embedder });
    const input = DedupFindingsInputV1.parse({
      linter_findings: [f({ body: "lint distinct", start_line: 1, end_line: 1 })],
      llm_findings: [f({ body: "llm distinct", start_line: 5, end_line: 5 })],
    });
    const out = await activity.dedupFindings(input);
    expect(DedupedFindingsV1.parse(out)).toBeTruthy();
    expect(out.semantic_skipped).toBe(false);
    // The semantic stage embedded the 2 surviving findings' bodies.
    expect(embedder.callCount()).toBe(1);
    expect(out.findings).toHaveLength(2);
  });

  it("unreachable embedder → fail-open exact-only dedup (skip=true), findings preserved", async () => {
    const embedder = new RecordingEmbeddingsClient();
    embedder.simulateUnreachable();
    const activity = new DedupFindingsActivity({ embedder });
    const input = DedupFindingsInputV1.parse({
      linter_findings: [f({ body: "lint distinct", start_line: 1, end_line: 1 })],
      llm_findings: [f({ body: "llm distinct", start_line: 5, end_line: 5 })],
    });
    const out = await activity.dedupFindings(input);
    // Embedder failure is fail-open: exact-dedup still applied, both distinct findings survive.
    expect(out.semantic_skipped).toBe(true);
    expect(out.findings).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DedupFindingsInputV1 / DedupedFindingsV1 — NEW typed envelopes introduced during the port (CLAUDE.md
// invariant 11 / ADR-0047). No Python counterpart to byte-diff → round-trip + validation only.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("DedupFindingsInputV1 envelope (no Python counterpart — validation only)", () => {
  it("accepts {linter_findings, llm_findings} and applies the schema_version default", () => {
    const parsed = DedupFindingsInputV1.parse({
      linter_findings: [f({ body: "x" })],
      llm_findings: [f({ body: "y", start_line: 5, end_line: 5 })],
    });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.linter_findings).toHaveLength(1);
    expect(parsed.llm_findings).toHaveLength(1);
    // The nested findings got the ReviewFindingV1 defaults.
    expect(parsed.linter_findings[0]!.scope).toBe("chunk_observed");
    expect(parsed.linter_findings[0]!.sources).toEqual([]);
    expect(parsed.linter_findings[0]!.evidence_refs).toEqual([]);
  });

  it("defaults both finding lists to [] when omitted", () => {
    const parsed = DedupFindingsInputV1.parse({});
    expect(parsed.linter_findings).toEqual([]);
    expect(parsed.llm_findings).toEqual([]);
  });

  it("rejects unknown top-level keys (.strict())", () => {
    expect(() =>
      DedupFindingsInputV1.parse({ linter_findings: [], llm_findings: [], bogus: true }),
    ).toThrow();
  });

  it("rejects a finding that violates the ReviewFindingV1 contract (end_line < start_line)", () => {
    expect(() =>
      DedupFindingsInputV1.parse({ linter_findings: [f({ start_line: 5, end_line: 1 })], llm_findings: [] }),
    ).toThrow();
  });
});

describe("DedupedFindingsV1 envelope (no Python counterpart — validation only)", () => {
  it("accepts {findings, semantic_skipped} and applies the schema_version default", () => {
    const parsed = DedupedFindingsV1.parse({ findings: [f({ body: "z" })], semantic_skipped: true });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.semantic_skipped).toBe(true);
    expect(parsed.findings).toHaveLength(1);
  });

  it("defaults findings=[] and semantic_skipped=false", () => {
    const parsed = DedupedFindingsV1.parse({});
    expect(parsed.findings).toEqual([]);
    expect(parsed.semantic_skipped).toBe(false);
  });

  it("rejects unknown top-level keys (.strict())", () => {
    expect(() => DedupedFindingsV1.parse({ findings: [], bogus: 1 })).toThrow();
  });
});
