import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { FixPromptActivityResultV1 } from "#contracts/fix_prompt_activity_result.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the inline
// activity-result model via the oracle — `FixPromptActivityResultV1(**payload).model_dump(mode="json")`)
// and through Zod (`FixPromptActivityResultV1.parse(payload)`), then diff canonical JSON. Accept/reject
// must also agree. Follows the fix_prompt.v1 template (no datetime field here, so no normalization).
//
// The Python model lives INLINE in the theme-activity module (not a contracts/ submodule), so the oracle
// targets `codemaster.review.fix_prompt_theme_activity::FixPromptActivityResultV1`.
const PY = "codemaster.review.fix_prompt_theme_activity";

describe("FixPromptActivityResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps the generated llm-mode result identically", async () => {
    const payload = {
      schema_version: 1,
      generated: true,
      generation_mode: "llm",
      comment_posted: true,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptActivityResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FixPromptActivityResultV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("validates + dumps the deterministic-fallback result identically", async () => {
    const payload = {
      generated: true,
      generation_mode: "deterministic_fallback",
      comment_posted: false,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptActivityResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(FixPromptActivityResultV1.parse(payload));
    expect(zodCanon).toBe(canonicalize(JSON.parse(r.out!)));
    // schema_version defaults to 1 when omitted (bare int default, not Literal).
    expect((JSON.parse(zodCanon) as { schema_version: number }).schema_version).toBe(1);
  }, 30_000);

  it("validates + dumps the not-generated result (empty generation_mode) identically", async () => {
    // generation_mode is a BARE `str` on the Python side; the not-generated path emits "" (empty). A
    // z.enum port would reject this — the wider z.string() keeps it 1:1.
    const payload = {
      generated: false,
      generation_mode: "",
      comment_posted: false,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptActivityResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FixPromptActivityResultV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("accepts a non-1 schema_version (bare int, NOT a Literal)", async () => {
    const payload = {
      schema_version: 2,
      generated: true,
      generation_mode: "llm",
      comment_posted: true,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptActivityResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(FixPromptActivityResultV1.parse(payload));
    expect(zodCanon).toBe(canonicalize(JSON.parse(r.out!)));
    expect((JSON.parse(zodCanon) as { schema_version: number }).schema_version).toBe(2);
  }, 30_000);

  it("both REJECT an unknown extra field (extra='forbid' → .strict())", async () => {
    const bad = {
      generated: true,
      generation_mode: "llm",
      comment_posted: true,
      surprise: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptActivityResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FixPromptActivityResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required field (generated)", async () => {
    // generated has no default → required on BOTH sides. (We do NOT cross-check non-boolean string
    // coercion of generated: Pydantic v2 lax-mode coerces "yes"/"true" → True while Zod z.boolean()
    // rejects them — a documented Pydantic-vs-Zod boolean-coercion divergence the ported contracts do
    // not attempt to replicate. The required-field reject is unambiguous on both sides.)
    const bad = {
      generation_mode: "llm",
      comment_posted: true,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FixPromptActivityResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FixPromptActivityResultV1.parse(bad)).toThrow();
  }, 30_000);
});
