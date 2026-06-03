import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { EmbedQueryInputV1, EmbedQueryResultV1 } from "../../libs/contracts/src/embed_query.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `<Model>(**payload).model_dump(mode="json")`) and through Zod
// (`<Model>.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
const PY = "contracts.embed_query.v1";

// Drop the float-bearing `vector` column so the canonicalizer (which rejects bare floats) can
// compare the remaining structurally-identical fields on both sides.
function stripVector(value: unknown): Record<string, unknown> {
  const { vector, ...rest } = value as Record<string, unknown>;
  void vector;
  return rest;
}

describe("EmbedQueryInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { schema_version: 1, query: "path/to/file.py + Add caching" };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedQueryInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(EmbedQueryInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = { query: "q" };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedQueryInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(EmbedQueryInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both ACCEPT a forward schema_version (2) — int field, not a literal", async () => {
    const payload = { schema_version: 2, query: "q" };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedQueryInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(EmbedQueryInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty query (min_length=1)", async () => {
    const bad = { query: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedQueryInputV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => EmbedQueryInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a too-long query (max_length=8000)", async () => {
    const bad = { query: "x".repeat(8001) };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedQueryInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => EmbedQueryInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { query: "q", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedQueryInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => EmbedQueryInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("EmbedQueryResultV1 parity (Pydantic ↔ Zod)", () => {
  // `vector` is tuple[float, ...]; Pydantic dumps floats (2.0) that the canonicalizer rejects.
  // So we strip `vector` from the canonical compare, compare the rest, and assert the vector
  // structurally (Zod-parsed length + numeric values match what we fed in).
  it("validates a valid payload; non-float fields canonicalize identically", async () => {
    const payload = { schema_version: 1, vector: [1.5, 2.0, -0.25, 3.0] };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedQueryResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);

    const parsed = EmbedQueryResultV1.parse(payload);

    // Structural assertion on the float-bearing column (cannot byte-round-trip a bare float).
    expect(parsed.vector).toEqual(payload.vector);
    expect(parsed.vector.length).toBe(payload.vector.length);

    // Canonical compare with `vector` excluded on BOTH sides (Python float-serialization quirk).
    expect(canonicalize(stripVector(parsed))).toBe(canonicalize(stripVector(JSON.parse(r.out ?? "{}"))));
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = { vector: [0.1, 0.2] };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedQueryResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);

    const parsed = EmbedQueryResultV1.parse(payload);
    expect(parsed.schema_version).toBe(1);

    expect(canonicalize(stripVector(parsed))).toBe(canonicalize(stripVector(JSON.parse(r.out ?? "{}"))));
  }, 30_000);

  it("both REJECT an empty vector (min_length=1)", async () => {
    const bad = { vector: [] as ReadonlyArray<number> };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedQueryResultV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => EmbedQueryResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { vector: [1.0], bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "EmbedQueryResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => EmbedQueryResultV1.parse(bad)).toThrow();
  }, 30_000);
});
