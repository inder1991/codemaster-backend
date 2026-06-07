/**
 * Contract parity for EmitOutputSafetyAuditEventInput — the input envelope of the
 * `emit_output_safety_audit_event_activity`. 1:1 with the frozen Python
 * codemaster/activities/_emit_output_safety_audit_inputs.py::EmitOutputSafetyAuditEventInput.
 *
 * Parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
 * `EmitOutputSafetyAuditEventInput(**payload).model_dump(mode="json")`) and through Zod
 * (`EmitOutputSafetyAuditEventInput.parse(payload)`), then diff canonical JSON. Accept/reject must
 * also agree. Follows the review_chunk_response.v1 / review_findings.v1 template.
 */
import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";

import { EmitOutputSafetyAuditEventInput } from "#contracts/emit_output_safety_audit.v1.js";

afterAll(() => shutdownRef());

const PY = "codemaster.activities._emit_output_safety_audit_inputs";
const PY_CALLABLE = "EmitOutputSafetyAuditEventInput";

const VALID_EVENT = {
  schema_version: 1,
  installation_id: "11111111-1111-4111-8111-111111111111",
  request_id: "22222222-2222-4222-8222-222222222222",
  original_text: "sk-SECRET-leaked-here in the model preamble",
  redacted_text: "sk-[REDACTED] in the model preamble",
  spans_redacted: 1,
  detector_kinds: ["secret_leaked", "aws_access_key"],
  stage: "review_chunk",
};

/** Canonicalize the Python oracle JSON string and the Zod-parsed object the same way, then diff. */
async function assertEnvelopeParity(payload: Record<string, unknown>): Promise<void> {
  const r = await pyRef({ pyModule: PY, pyCallable: PY_CALLABLE, kwargs: payload });
  expect(r.ok).toBe(true);
  const ts = canonicalize(EmitOutputSafetyAuditEventInput.parse(payload));
  expect(ts).toBe(r.out);
}

describe("EmitOutputSafetyAuditEventInput parity (Pydantic <-> Zod)", () => {
  it("round-trips a full envelope byte-identically", async () => {
    await assertEnvelopeParity({ event: VALID_EVENT });
  });

  it("round-trips with an explicit schema_version (bare int, not Literal)", async () => {
    await assertEnvelopeParity({ schema_version: 1, event: VALID_EVENT });
  });

  it("defaults schema_version to 1 when omitted (both impls)", () => {
    const parsed = EmitOutputSafetyAuditEventInput.parse({ event: VALID_EVENT });
    expect(parsed.schema_version).toBe(1);
  });

  it("rejects an unknown top-level key (extra='forbid' / .strict())", async () => {
    // The Python ctor raises on the extra key; the oracle returns ok=false. Zod .strict() also throws.
    const bad = { event: VALID_EVENT, surprise: true };
    const r = await pyRef({ pyModule: PY, pyCallable: PY_CALLABLE, kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => EmitOutputSafetyAuditEventInput.parse(bad)).toThrow();
  });

  it("rejects a missing required `event`", async () => {
    const r = await pyRef({ pyModule: PY, pyCallable: PY_CALLABLE, kwargs: { schema_version: 1 } });
    expect(r.ok).toBe(false);
    expect(() => EmitOutputSafetyAuditEventInput.parse({ schema_version: 1 })).toThrow();
  });

  it("rejects an empty detector_kinds (nested min_length=1)", () => {
    const bad = { event: { ...VALID_EVENT, detector_kinds: [] } };
    expect(() => EmitOutputSafetyAuditEventInput.parse(bad)).toThrow();
  });

  it("rejects spans_redacted=0 (nested ge=1)", () => {
    const bad = { event: { ...VALID_EVENT, spans_redacted: 0 } };
    expect(() => EmitOutputSafetyAuditEventInput.parse(bad)).toThrow();
  });
});
