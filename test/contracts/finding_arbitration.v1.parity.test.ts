import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { ArbitrationDecisionV1 } from "../../libs/contracts/src/finding_arbitration.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `ArbitrationDecisionV1(**payload).model_dump(mode="json")`) and
// through Zod (`ArbitrationDecisionV1.parse(payload)`), then diff canonical JSON. Accept/reject agree.
// suppression_confidence is a Pydantic Decimal carried as a canonical decimal STRING; suppressed_at
// is a Pydantic datetime carried as an RFC3339 STRING — both round-trip byte-for-byte (the repo
// canonicalizer normalizes the RFC3339 form on both sides).
const PY = "contracts.finding_arbitration.v1";
const FINDING_ID = "12345678-1234-5678-1234-567812345678";
const OTHER_ID = "abcdef00-1234-5678-1234-567812345678";

describe("ArbitrationDecisionV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a NONE-state payload identically (all metadata null)", async () => {
    const payload = { finding_id: FINDING_ID, suppression_state: "NONE" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ArbitrationDecisionV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates + dumps a fully-specified SUPPRESSED_BY_LLM payload identically", async () => {
    const payload = {
      schema_version: 1,
      finding_id: FINDING_ID,
      suppression_state: "SUPPRESSED_BY_LLM",
      suppression_reason: "false positive",
      suppression_confidence: "0.5",
      suppression_model: "claude",
      suppression_prompt_version: "v3",
      suppressed_at: "2026-06-03T10:00:00+00:00",
      suppressed_by_finding_id: OTHER_ID,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ArbitrationDecisionV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("validates + dumps a POLICY payload (model/prompt_version null) with sub-second timestamp", async () => {
    const payload = {
      finding_id: FINDING_ID,
      suppression_state: "SUPPRESSED_BY_POLICY",
      suppression_reason: "global allow-list",
      suppression_confidence: "1",
      suppressed_at: "2026-06-03T10:00:00.123456+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ArbitrationDecisionV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = { finding_id: FINDING_ID, suppression_state: "NONE" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ArbitrationDecisionV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("preserves trailing/extra fractional digits in the confidence decimal string (no decimal_places cap)", async () => {
    const payload = {
      finding_id: FINDING_ID,
      suppression_state: "SUPPRESSED_BY_LLM",
      suppression_reason: "borderline",
      suppression_confidence: "0.1234",
      suppressed_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ArbitrationDecisionV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("normalizes uppercase UUIDs to lowercase identically (both sides)", async () => {
    const payload = {
      finding_id: FINDING_ID.toUpperCase(),
      suppression_state: "SUPPRESSED_BY_LLM",
      suppression_reason: "r",
      suppression_confidence: "0",
      suppressed_at: "2026-06-03T10:00:00+00:00",
      suppressed_by_finding_id: OTHER_ID.toUpperCase(),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ArbitrationDecisionV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT confidence out of [0, 1] range (1.5)", async () => {
    const bad = {
      finding_id: FINDING_ID,
      suppression_state: "SUPPRESSED_BY_LLM",
      suppression_reason: "r",
      suppression_confidence: "1.5",
      suppressed_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => ArbitrationDecisionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a bad suppression_state value", async () => {
    const bad = { finding_id: FINDING_ID, suppression_state: "WAT" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ArbitrationDecisionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT NONE-state with a populated suppression field (all-or-nothing invariant)", async () => {
    const bad = { finding_id: FINDING_ID, suppression_state: "NONE", suppression_reason: "should-be-null" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ArbitrationDecisionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT non-NONE state missing a required metadata field (no reason)", async () => {
    const bad = {
      finding_id: FINDING_ID,
      suppression_state: "SUPPRESSED_BY_LLM",
      suppression_confidence: "0.5",
      suppressed_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ArbitrationDecisionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a suppression_reason over the 2048-char cap", async () => {
    const bad = {
      finding_id: FINDING_ID,
      suppression_state: "SUPPRESSED_BY_LLM",
      suppression_reason: "x".repeat(2049),
      suppression_confidence: "0.5",
      suppressed_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ArbitrationDecisionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-UUID finding_id", async () => {
    const bad = { finding_id: "not-a-uuid", suppression_state: "NONE" };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ArbitrationDecisionV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { finding_id: FINDING_ID, suppression_state: "NONE", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ArbitrationDecisionV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ArbitrationDecisionV1.parse(bad)).toThrow();
  }, 30_000);
});
