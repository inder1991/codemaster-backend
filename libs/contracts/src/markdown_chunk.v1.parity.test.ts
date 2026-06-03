import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../../../test/parity/canonical.js";
import { pyRef, shutdownRef } from "../../../test/parity/oracle.js";
import { MarkdownChunkV1 } from "./markdown_chunk.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `MarkdownChunkV1(**payload).model_dump(mode="json")`) and through
// Zod (`MarkdownChunkV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
// This is the template every contract port follows (Task 0.5).
const PY = "contracts.markdown_chunks.v1";

describe("MarkdownChunkV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = {
      relative_path: "a.md",
      chunk_index: 0,
      heading_path: ["Naming", "Variables"],
      body: "some body",
      start_line: 1,
      end_line: 2,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkdownChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(MarkdownChunkV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same heading_path default ([]) when omitted", async () => {
    const payload = { relative_path: "a.md", chunk_index: 0, body: "x", start_line: 1, end_line: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkdownChunkV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(MarkdownChunkV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an out-of-range value (chunk_index < 0)", async () => {
    const bad = { relative_path: "a.md", chunk_index: -1, body: "x", start_line: 1, end_line: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkdownChunkV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => MarkdownChunkV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { relative_path: "a.md", chunk_index: 0, body: "x", start_line: 1, end_line: 1, bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "MarkdownChunkV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => MarkdownChunkV1.parse(bad)).toThrow();
  }, 30_000);
});
