import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  AggregatedFindingsV1,
  DedupeStatsV1,
} from "../../libs/contracts/src/aggregated_findings.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 / review_findings.v1
// template.
const PY = "contracts.aggregated_findings.v1";

// Each nested ReviewFindingV1 carries a bare Python `float` (`confidence`): model_dump(mode="json")
// emits `1.0` while a JS number `1` emits `1`, so the canonicalizer (which REJECTS bare floats) can
// never byte-match that one column. Strip `confidence` out of every nested finding before the
// canonical diff so EVERY other field of the envelope (incl. the rest of each finding) is still
// proven byte-equal; confidence is asserted structurally + range-rejected separately.
function dropNestedConfidence(canon: string): string {
  const o = JSON.parse(canon) as Record<string, unknown>;
  const findings = o.findings;
  if (Array.isArray(findings)) {
    for (const f of findings) {
      if (f && typeof f === "object") delete (f as Record<string, unknown>).confidence;
    }
  }
  // Re-canonicalize so key-sort + scalar rules stay identical to the oracle path.
  return canonicalize(o);
}

// A representative valid nested ReviewFindingV1 payload (confidence is an int here; Pydantic coerces
// int→float, serializing 1.0 on Python / 1 on JS — handled by dropNestedConfidence).
const FINDING = {
  file: "src/app.py",
  start_line: 10,
  end_line: 20,
  severity: "issue",
  category: "bug",
  title: "Null deref",
  body: "Dereferences a possibly-null pointer.",
  suggestion: "Add a guard.",
  confidence: 1,
  sources: [{ kind: "repo_path", locator: "src/app.py", excerpt: "def f():" }],
  scope: "cross_chunk",
  evidence_refs: ["ev_0123456789abcdef"],
} as const;

describe("DedupeStatsV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = {
      input_count: 12,
      exact_dropped: 3,
      semantic_merged: 2,
      capped: 1,
      semantic_skipped: true,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupeStatsV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DedupeStatsV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same semantic_skipped default (false) when omitted", async () => {
    const payload = { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupeStatsV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(DedupeStatsV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    expect((JSON.parse(zodCanon) as { semantic_skipped: boolean }).semantic_skipped).toBe(false);
  }, 30_000);

  it("both REJECT an out-of-range value (capped < 0)", async () => {
    const bad = { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupeStatsV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => DedupeStatsV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (input_count)", async () => {
    const bad = { exact_dropped: 0, semantic_merged: 0, capped: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupeStatsV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DedupeStatsV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DedupeStatsV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DedupeStatsV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("AggregatedFindingsV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (nested confidence excepted)", async () => {
    const payload = {
      schema_version: 1,
      findings: [FINDING],
      dedupe_stats: {
        input_count: 5,
        exact_dropped: 1,
        semantic_merged: 1,
        capped: 0,
        semantic_skipped: false,
      },
      policy_revision: 7,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AggregatedFindingsV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(AggregatedFindingsV1.parse(payload));
    // Every field except each nested float `confidence` is byte-equal between Pydantic and Zod.
    expect(dropNestedConfidence(zodCanon)).toBe(dropNestedConfidence(r.out!));
    // confidence still round-trips structurally in the nested finding.
    const zf = (JSON.parse(zodCanon) as { findings: Array<{ confidence: number }> }).findings[0];
    const pf = (JSON.parse(r.out!) as { findings: Array<{ confidence: number }> }).findings[0];
    expect(zf?.confidence).toBe(1);
    expect(pf?.confidence).toBe(1);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted (empty findings)", async () => {
    const payload = {
      dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
      policy_revision: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AggregatedFindingsV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(AggregatedFindingsV1.parse(payload));
    // No nested float when findings is empty — full byte-equality holds.
    expect(zodCanon).toBe(r.out);
    // Defaults: schema_version=1, findings=[], dedupe_stats.semantic_skipped=false.
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.findings).toEqual([]);
  }, 30_000);

  it("accepts a forward schema_version (int default, NOT z.literal)", async () => {
    // schema_version is a bare int (default 1); a wire payload carrying 2 must be accepted by both.
    const payload = {
      schema_version: 2,
      dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
      policy_revision: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AggregatedFindingsV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(AggregatedFindingsV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-range value (policy_revision < 0)", async () => {
    const bad = {
      dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
      policy_revision: -1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AggregatedFindingsV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => AggregatedFindingsV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (dedupe_stats)", async () => {
    const bad = { policy_revision: 0 };
    const r = await pyRef({ pyModule: PY, pyCallable: "AggregatedFindingsV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AggregatedFindingsV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested finding (start_line < 1 propagates)", async () => {
    const bad = {
      findings: [{ ...FINDING, start_line: 0 }],
      dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
      policy_revision: 0,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AggregatedFindingsV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AggregatedFindingsV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
      policy_revision: 0,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AggregatedFindingsV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AggregatedFindingsV1.parse(bad)).toThrow();
  }, 30_000);
});
