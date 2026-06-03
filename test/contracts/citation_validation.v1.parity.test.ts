import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  CitationValidationResultV1,
  DroppedFindingV1,
} from "../../libs/contracts/src/citation_validation.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 / review_findings.v1
// templates.
const PY = "contracts.citation_validation.v1";

// Every embedded `ReviewFindingV1` carries a bare-float `confidence` (model_dump emits `1.0` on
// Python vs `1` on JS), which the canonicalizer rejects / can't byte-match. Strip `confidence` from
// EVERY nested finding object (recursively) so every OTHER field is still proven byte-equal, then
// assert the confidence values structurally. Mirrors review_findings.v1's dropConfidence helper.
function stripConfidence(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripConfidence);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "confidence") continue;
      o[k] = stripConfidence(val);
    }
    return o;
  }
  return v;
}

// Canonicalize after stripping every nested `confidence` so key-sort + scalar rules stay identical to
// the oracle path. Accepts either a parsed object (Zod) or an oracle canonical-JSON string.
function canonNoConfidence(value: unknown): string {
  const obj = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return canonicalize(stripConfidence(obj));
}

// A valid ReviewFindingV1 payload (confidence is an int that Pydantic coerces to float).
const FINDING_A = {
  file: "src/app.py",
  start_line: 10,
  end_line: 20,
  severity: "issue",
  category: "bug",
  title: "Null deref",
  body: "Dereferences a possibly-null pointer.",
  suggestion: "Add a guard.",
  confidence: 1,
  sources: [
    { kind: "repo_path", locator: "src/app.py", excerpt: "def f():" },
    { kind: "knowledge_chunk", locator: "kc_123" },
  ],
  scope: "cross_chunk",
  evidence_refs: ["ev_0123456789abcdef", "ev_fedcba9876543210"],
};

const FINDING_B = {
  file: "a.py",
  start_line: 1,
  end_line: 1,
  severity: "nit",
  category: "style",
  title: "t",
  body: "b",
  confidence: 0,
};

describe("DroppedFindingV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically (nested confidence excepted)", async () => {
    const payload = { finding: FINDING_A, reason: "repo_path 'foo.py' does not exist in workspace" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedFindingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(DroppedFindingV1.parse(payload));
    expect(canonNoConfidence(zodCanon)).toBe(canonNoConfidence(r.out!));
    // Nested confidence still round-trips structurally (int → 1.0 Python / 1 JS).
    const z = JSON.parse(zodCanon) as { finding: { confidence: number } };
    const p = JSON.parse(r.out!) as { finding: { confidence: number } };
    expect(z.finding.confidence).toBe(1);
    expect(p.finding.confidence).toBe(1);
  }, 30_000);

  it("both REJECT an empty reason (min_length=1)", async () => {
    const bad = { finding: FINDING_B, reason: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedFindingV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => DroppedFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a reason over max_length=500", async () => {
    const bad = { finding: FINDING_B, reason: "x".repeat(501) };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DroppedFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested finding (propagates ReviewFindingV1 validation)", async () => {
    const bad = { finding: { ...FINDING_B, start_line: 0 }, reason: "x" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DroppedFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { finding: FINDING_B, reason: "x", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DroppedFindingV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("CitationValidationResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (nested confidence excepted)", async () => {
    const payload = {
      surviving: [FINDING_A, FINDING_B],
      dropped: [{ finding: FINDING_A, reason: "linter_rule 'E999' is not in workspace ruleset" }],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CitationValidationResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(CitationValidationResultV1.parse(payload));
    expect(canonNoConfidence(zodCanon)).toBe(canonNoConfidence(r.out!));
    // schema_version default = 1 applied identically.
    expect((JSON.parse(zodCanon) as { schema_version: number }).schema_version).toBe(1);
    expect((JSON.parse(r.out!) as { schema_version: number }).schema_version).toBe(1);
  }, 30_000);

  it("applies the same schema_version default (1) and empty collections when omitted", async () => {
    const payload = { surviving: [], dropped: [] };
    const r = await pyRef({ pyModule: PY, pyCallable: "CitationValidationResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(CitationValidationResultV1.parse(payload));
    expect(canonNoConfidence(zodCanon)).toBe(canonNoConfidence(r.out!));
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.surviving).toEqual([]);
    expect(z.dropped).toEqual([]);
  }, 30_000);

  it("accepts an explicit schema_version=2 (int field, NOT a literal-1)", async () => {
    const payload = { schema_version: 2, surviving: [], dropped: [] };
    const r = await pyRef({ pyModule: PY, pyCallable: "CitationValidationResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(CitationValidationResultV1.parse(payload));
    expect(canonNoConfidence(zodCanon)).toBe(canonNoConfidence(r.out!));
    expect((JSON.parse(zodCanon) as { schema_version: number }).schema_version).toBe(2);
  }, 30_000);

  it("both REJECT an invalid nested dropped entry (propagates DroppedFindingV1 validation)", async () => {
    const bad = { surviving: [], dropped: [{ finding: FINDING_B, reason: "" }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "CitationValidationResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CitationValidationResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested surviving finding", async () => {
    const bad = { surviving: [{ ...FINDING_B, confidence: 2 }], dropped: [] };
    const r = await pyRef({ pyModule: PY, pyCallable: "CitationValidationResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CitationValidationResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { surviving: [], dropped: [], bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "CitationValidationResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CitationValidationResultV1.parse(bad)).toThrow();
  }, 30_000);
});
