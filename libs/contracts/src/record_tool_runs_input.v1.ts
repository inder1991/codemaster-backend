import { z } from "zod";

import { ToolStatusV1 } from "./tool_status.v1.js";

// Zod port of the `RecordToolRunsInput` envelope defined inline in the frozen Python activity module
// `vendor/codemaster-py/codemaster/review/arbitration_apply_activity.py`. Parity-validated in
// record_tool_runs_input.v1.parity.test.ts (the oracle imports the class from that Python module).
//
// Typed envelope for `record_tool_runs_activity` (CLAUDE.md invariant 11 — one positional Pydantic
// input per Temporal activity). Pydantic `ConfigDict(extra="forbid", frozen=True)` → .strict() (frozen
// is a TS-side concern, not wire). schema_version is `Literal[1] = 1` → z.literal(1).default(1) (a
// future bump is an explicit contract change here, unlike the bare-int lifecycle inputs).
//
// UUID fields differ from the lifecycle inputs: here `installation_id` / `run_id` / `review_id` are
// genuine `uuid.UUID` in Python (NOT `str`), so Pydantic model_dump(mode="json") emits them as
// lowercase RFC4122 strings — the Zod port validates the string form and lowercases (mirroring the
// finding_lifecycle_inputs.v1 `uuidLower` idiom). `tool_statuses` is `tuple[ToolStatusV1, ...]` →
// z.array(ToolStatusV1); each element round-trips through the already-ported ToolStatusV1 contract
// (its own .strict() + files_scanned<=files_total .superRefine() carry over unchanged).

// uuid.UUID → string; Pydantic model_dump(mode="json") emits lowercase canonical form.
const uuidLower = (): z.ZodEffects<z.ZodString, string, string> =>
  z
    .string()
    .uuid()
    .transform((s) => s.toLowerCase());

export const RecordToolRunsInputV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    installation_id: uuidLower(),
    run_id: uuidLower(),
    review_id: uuidLower(),
    tool_statuses: z.array(ToolStatusV1),
  })
  .strict();

export type RecordToolRunsInputV1 = z.infer<typeof RecordToolRunsInputV1>;
