import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { FileRoutingV1 } from "../../libs/contracts/src/file_routing.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `FileRoutingV1(**payload).model_dump(mode="json")`) and through
// Zod (`FileRoutingV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
const PY = "contracts.file_routing.v1";

describe("FileRoutingV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      schema_version: 1,
      review_files: ["src/a.py", "src/b.py"],
      sandbox_files: ["scripts/run.sh"],
      skip_files: ["vendor/lib.min.js"],
      classifications: [
        {
          schema_version: 1,
          path: "src/a.py",
          byte_size: 1234,
          magika_label: "python",
          language: "python",
          is_binary: false,
          is_generated: false,
        },
        {
          schema_version: 1,
          path: "vendor/lib.min.js",
          byte_size: 9999,
          magika_label: "javascript",
          language: null,
          is_binary: false,
          is_generated: true,
        },
      ],
      classifier_failures: ["src/weird.bin"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRoutingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FileRoutingV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same empty-tuple defaults when every collection field is omitted", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRoutingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FileRoutingV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same nested FileClassificationV1 defaults (schema_version, language) when omitted", async () => {
    const payload = {
      review_files: ["src/a.py"],
      classifications: [
        // omit schema_version + language → both sides fill 1 / null.
        { path: "src/a.py", byte_size: 0, magika_label: "empty", is_binary: false, is_generated: false },
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRoutingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FileRoutingV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("preserves a non-default schema_version (int field, NOT a literal) identically", async () => {
    const payload = { schema_version: 2, review_files: ["src/a.py"] };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRoutingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FileRoutingV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a wrong-typed element (review_files entry is not a string)", async () => {
    const bad = { review_files: [123] };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRoutingV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => FileRoutingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a nested classification that violates its own constraint (path min_length=1)", async () => {
    const bad = {
      classifications: [
        { path: "", byte_size: 0, magika_label: "empty", is_binary: false, is_generated: false },
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRoutingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FileRoutingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { review_files: [], bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRoutingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FileRoutingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field nested in a classification (extra=forbid ↔ .strict())", async () => {
    const bad = {
      classifications: [
        {
          path: "src/a.py",
          byte_size: 0,
          magika_label: "empty",
          is_binary: false,
          is_generated: false,
          bogus: 1,
        },
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FileRoutingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FileRoutingV1.parse(bad)).toThrow();
  }, 30_000);
});
