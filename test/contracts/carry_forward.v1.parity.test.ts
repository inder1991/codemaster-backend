import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { CarryForwardSelectionV1 } from "../../libs/contracts/src/carry_forward.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `CarryForwardSelectionV1(**payload).model_dump(mode="json")`) and through Zod
// (`CarryForwardSelectionV1.parse(payload)`), then diff canonical JSON. Accept/reject must also
// agree. Follows the markdown_chunk.v1 / review_findings.v1 templates.
const PY = "contracts.carry_forward.v1";

// `carried` elements are ReviewFindingV1, each with a bare Python `float` (`confidence`):
// model_dump(mode="json") emits `1.0` while a JS number `1` emits `1`, so the canonicalizer
// (which REJECTS bare floats) can never byte-match that column. Strip `confidence` from every
// nested finding in BOTH canonical strings so every OTHER field is still proven byte-equal, and
// assert each confidence separately. Re-canonicalize via canonicalize() so the key-sort + scalar
// rules stay identical to the oracle path.
function dropNestedConfidence(canon: string): string {
  const o = JSON.parse(canon) as { carried?: Array<Record<string, unknown>> };
  for (const finding of o.carried ?? []) {
    delete finding.confidence;
  }
  return canonicalize(o);
}

// A valid ReviewFindingV1 payload with an INTEGER-valued confidence (Pydantic coerces int→float;
// serialized 1.0 on Python, 1 on JS — handled by dropNestedConfidence). Lowercase any UUIDs.
function findingPayload(confidence: number): Record<string, unknown> {
  return {
    file: "src/app.py",
    start_line: 10,
    end_line: 20,
    severity: "issue",
    category: "bug",
    title: "Null deref",
    body: "Dereferences a possibly-null pointer.",
    suggestion: "Add a guard.",
    confidence,
    sources: [{ kind: "repo_path", locator: "src/app.py", excerpt: "def f():" }],
    scope: "cross_chunk",
    evidence_refs: ["ev_0123456789abcdef"],
  };
}

// A valid DiffChunkV1 payload (chunk_id is a lowercase UUID; required since R-5).
function chunkPayload(): Record<string, unknown> {
  return {
    chunk_id: "0e2a9f1c-3b4d-4e5f-8a6b-7c8d9e0f1a2b",
    path: "src/app.py",
    language: "python",
    start_line: 1,
    end_line: 40,
    body: "def f():\n    return None\n",
    chunk_kind: "function",
    token_estimate: 12,
  };
}

describe("CarryForwardSelectionV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically (nested float confidence excepted)", async () => {
    const payload = {
      schema_version: 1,
      carried: [findingPayload(1), findingPayload(0)],
      to_review: [chunkPayload()],
      parent_review_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "CarryForwardSelectionV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(CarryForwardSelectionV1.parse(payload));
    // Every field except the nested float `confidence` columns is byte-equal between Pydantic and Zod.
    expect(dropNestedConfidence(zodCanon)).toBe(dropNestedConfidence(r.out!));
    // The confidence columns still round-trip structurally (Zod keeps the bound; Python emits float).
    const zCarried = (JSON.parse(zodCanon) as { carried: Array<{ confidence: number }> }).carried;
    const pCarried = (JSON.parse(r.out!) as { carried: Array<{ confidence: number }> }).carried;
    expect(zCarried.map((c) => c.confidence)).toEqual([1, 0]);
    expect(pCarried.map((c) => c.confidence)).toEqual([1, 0]);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "CarryForwardSelectionV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(CarryForwardSelectionV1.parse(payload));
    // No nested findings → no float columns to strip; full byte-equality holds.
    expect(zodCanon).toBe(r.out);
    // Defaults: schema_version=1, carried=[], to_review=[], parent_review_id=null.
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.carried).toEqual([]);
    expect(z.to_review).toEqual([]);
    expect(z.parent_review_id).toBeNull();
  }, 30_000);

  it("preserves schema_version=2 (plain int, NOT Literal[1])", async () => {
    const payload = { schema_version: 2 };
    const r = await pyRef({ pyModule: PY, pyCallable: "CarryForwardSelectionV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(CarryForwardSelectionV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates a populated to_review with empty carried identically", async () => {
    const payload = { to_review: [chunkPayload()], parent_review_id: null };
    const r = await pyRef({ pyModule: PY, pyCallable: "CarryForwardSelectionV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(CarryForwardSelectionV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a malformed parent_review_id (not a UUID)", async () => {
    const bad = { parent_review_id: "not-a-uuid" };
    const r = await pyRef({ pyModule: PY, pyCallable: "CarryForwardSelectionV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => CarryForwardSelectionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested DiffChunkV1 (to_review end_line < start_line)", async () => {
    const badChunk = { ...chunkPayload(), start_line: 40, end_line: 1 };
    const bad = { to_review: [badChunk] };
    const r = await pyRef({ pyModule: PY, pyCallable: "CarryForwardSelectionV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CarryForwardSelectionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid nested ReviewFindingV1 (carried confidence out of [0,1])", async () => {
    const badFinding = { ...findingPayload(2) };
    const bad = { carried: [badFinding] };
    const r = await pyRef({ pyModule: PY, pyCallable: "CarryForwardSelectionV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CarryForwardSelectionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "CarryForwardSelectionV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => CarryForwardSelectionV1.parse(bad)).toThrow();
  }, 30_000);
});
