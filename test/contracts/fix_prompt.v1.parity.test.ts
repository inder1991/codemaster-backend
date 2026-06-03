import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { FixPromptV1 } from "../../libs/contracts/src/fix_prompt.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `FixPromptV1(**payload).model_dump(mode="json")`) and through
// Zod (`FixPromptV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
// Follows the markdown_chunk.v1 template; for the datetime field it follows tool_status.v1.
//
// FixPromptV1 carries a `generated_at` datetime. Pydantic emits a "Z"-suffixed ISO string while Zod
// passes the input string through verbatim — the canonicalizer normalizes both to microsecond UTC.
// We therefore re-canonicalize the oracle's raw output (`canonicalize(JSON.parse(r.out))`) so the
// datetime normalization applies to BOTH sides, rather than comparing against the raw "Z" form.
const PY = "contracts.fix_prompt.v1";

// Lowercase UUID (Pydantic lowercases on dump; using a lowercase literal keeps both sides byte-equal).
const REVIEW_ID = "2b9d4e7a-1c3f-4a8b-9e0d-5f6a7b8c9d0e";

describe("FixPromptV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      review_id: REVIEW_ID,
      prompt: "Fix the null-deref in src/app.py and add the missing guard.",
      generation_mode: "llm",
      finding_count: 3,
      truncated: false,
      generated_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FixPromptV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = {
      review_id: REVIEW_ID,
      prompt: "x",
      generation_mode: "deterministic_fallback",
      finding_count: 0,
      truncated: true,
      generated_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(FixPromptV1.parse(payload));
    expect(zodCanon).toBe(canonicalize(JSON.parse(r.out!)));
    expect((JSON.parse(zodCanon) as { schema_version: number }).schema_version).toBe(1);
  }, 30_000);

  it("normalizes a microsecond-precision datetime identically (Z ↔ +00:00 offset)", async () => {
    // Pydantic dumps "...123456+00:00" as "...123456Z"; the canonicalizer collapses both spellings
    // to microsecond UTC, so a "+00:00" payload still byte-matches.
    const payload = {
      review_id: REVIEW_ID,
      prompt: "x",
      generation_mode: "llm",
      finding_count: 1,
      truncated: false,
      generated_at: "2026-06-03T10:00:00.123456+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FixPromptV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("accepts a non-1 schema_version (bare int, NOT a Literal)", async () => {
    const payload = {
      schema_version: 2,
      review_id: REVIEW_ID,
      prompt: "x",
      generation_mode: "llm",
      finding_count: 0,
      truncated: false,
      generated_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(FixPromptV1.parse(payload));
    expect(zodCanon).toBe(canonicalize(JSON.parse(r.out!)));
    expect((JSON.parse(zodCanon) as { schema_version: number }).schema_version).toBe(2);
  }, 30_000);

  it("both REJECT an invalid generation_mode (out of vocabulary)", async () => {
    const bad = {
      review_id: REVIEW_ID,
      prompt: "x",
      generation_mode: "manual",
      finding_count: 0,
      truncated: false,
      generated_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FixPromptV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed review_id (not a UUID)", async () => {
    const bad = {
      review_id: "not-a-uuid",
      prompt: "x",
      generation_mode: "llm",
      finding_count: 0,
      truncated: false,
      generated_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FixPromptV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty prompt (min_length=1)", async () => {
    const bad = {
      review_id: REVIEW_ID,
      prompt: "",
      generation_mode: "llm",
      finding_count: 0,
      truncated: false,
      generated_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FixPromptV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an over-length prompt (max_length=60000)", async () => {
    const bad = {
      review_id: REVIEW_ID,
      prompt: "a".repeat(60001),
      generation_mode: "llm",
      finding_count: 0,
      truncated: false,
      generated_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FixPromptV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a negative finding_count (ge=0)", async () => {
    const bad = {
      review_id: REVIEW_ID,
      prompt: "x",
      generation_mode: "llm",
      finding_count: -1,
      truncated: false,
      generated_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FixPromptV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      review_id: REVIEW_ID,
      prompt: "x",
      generation_mode: "llm",
      finding_count: 0,
      truncated: false,
      generated_at: "2026-06-03T10:00:00+00:00",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FixPromptV1.parse(bad)).toThrow();
  }, 30_000);
});
