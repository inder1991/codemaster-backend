import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { DroppedClassificationV1 } from "../../libs/contracts/src/dropped_classification.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `DroppedClassificationV1(**payload).model_dump(mode="json")`)
// and through Zod (`DroppedClassificationV1.parse(payload)`), then diff canonical JSON. Accept /
// reject must also agree. This follows the markdown_chunk.v1.parity template (Task 0.5).
const PY = "contracts.dropped_classification.v1";

describe("DroppedClassificationV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = {
      schema_version: 1,
      index: 7,
      eligibility_reason: "file_not_in_diff",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedClassificationV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DroppedClassificationV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = { index: 0, eligibility_reason: "line_after_last_hunk" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedClassificationV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DroppedClassificationV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts the index boundary values (0 and 200) identically", async () => {
    for (const index of [0, 200]) {
      const payload = { index, eligibility_reason: "line_spans_hunks" };
      const r = await pyRef({ pyModule: PY, pyCallable: "DroppedClassificationV1", kwargs: payload });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(DroppedClassificationV1.parse(payload))).toBe(r.out);
    }
  }, 30_000);

  it("accepts a future schema_version (int default, NOT a literal) identically", async () => {
    const payload = { schema_version: 2, index: 3, eligibility_reason: "line_in_unchanged_gap" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedClassificationV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DroppedClassificationV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT index below the lower bound (index < 0)", async () => {
    const bad = { index: -1, eligibility_reason: "file_not_in_diff" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedClassificationV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => DroppedClassificationV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT index above the upper bound (index > 200)", async () => {
    const bad = { index: 201, eligibility_reason: "file_not_in_diff" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedClassificationV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DroppedClassificationV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty eligibility_reason (min_length=1)", async () => {
    const bad = { index: 1, eligibility_reason: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedClassificationV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DroppedClassificationV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an over-length eligibility_reason (max_length=64)", async () => {
    const bad = { index: 1, eligibility_reason: "x".repeat(65) };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedClassificationV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DroppedClassificationV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { index: 1, eligibility_reason: "file_not_in_diff", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DroppedClassificationV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DroppedClassificationV1.parse(bad)).toThrow();
  }, 30_000);
});
