import { z } from "zod";

// Zod port of the inline activity-result model in
// vendor/codemaster-py/codemaster/review/fix_prompt_theme_activity.py::FixPromptActivityResultV1
// (frozen Python). Parity-validated in fix_prompt_activity_result.v1.parity.test.ts.
//
// FixPromptActivityResultV1 is the return shape of `generate_fix_prompt_activity` — a small status
// envelope the workflow body reads (did we generate a prompt? in which mode? did the advisory PR comment
// post succeed?). It lives in `contracts/` (not inline in the activity module) because it crosses the
// Temporal activity boundary: the DataConverter serializes it on the wire, so it is a cross-process data
// interface that needs its own parity-tested contract.
//
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
//
// Source members ported (every public field on the Python model):
//  - schema_version: int = 1                    → z.number().int().default(1) (NOT z.literal — a literal
//                                                  would false-reject a future schema_version=2 payload).
//  - generated: bool                            → z.boolean(). False when there were no findings.
//  - generation_mode: str                       → z.string(). The Python field is a BARE `str` (NOT the
//                                                  Literal of FixPromptV1.generation_mode): it carries
//                                                  "llm" | "deterministic_fallback" on the generated path
//                                                  AND "" (empty) when `generated=False`. A z.enum would
//                                                  reject the empty-string not-generated case, so the port
//                                                  keeps the wider `str` to stay 1:1.
//  - comment_posted: bool                       → z.boolean().

// FixPromptActivityResultV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
export const FixPromptActivityResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    // False when there were no findings (the activity short-circuits before building anything).
    generated: z.boolean(),
    // BARE `str` on the Python side: "llm" | "deterministic_fallback" | "" (empty when not generated).
    generation_mode: z.string(),
    comment_posted: z.boolean(),
  })
  .strict();

export type FixPromptActivityResultV1 = z.infer<typeof FixPromptActivityResultV1>;
