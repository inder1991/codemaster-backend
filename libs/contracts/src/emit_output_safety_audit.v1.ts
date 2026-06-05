import { z } from "zod";

import { OutputSafetySanitizationEventV1 } from "./review_chunk_response.v1.js";

// Zod port of codemaster/activities/_emit_output_safety_audit_inputs.py::EmitOutputSafetyAuditEventInput
// (frozen Python: ConfigDict(extra="forbid", frozen=True), __contract_internal__ = True). A thin envelope
// around OutputSafetySanitizationEventV1 (ported in review_chunk_response.v1.ts — IMPORTED here, not
// redefined). Parity-validated in test/contracts/emit_output_safety_audit.v1.parity.test.ts.
//
// schema_version GOTCHA: the Python field is a bare `int = 1` (NOT Literal) → z.number().int().default(1),
// matching the same decision made for OutputSafetySanitizationEventV1.schema_version in
// review_chunk_response.v1.ts. The Python contract permits any int there.
//
// extra="forbid" → .strict(). frozen=True is a Pydantic runtime-immutability flag with no Zod analogue
// (Zod parse outputs are plain objects); the producer-side behaviour (reject unknown keys, validate the
// nested event) is what the parity test asserts.
export const EmitOutputSafetyAuditEventInput = z
  .object({
    schema_version: z.number().int().default(1),
    event: OutputSafetySanitizationEventV1,
  })
  .strict();
export type EmitOutputSafetyAuditEventInput = z.infer<typeof EmitOutputSafetyAuditEventInput>;
