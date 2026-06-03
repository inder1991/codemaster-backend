import { z } from "zod";

// Zod port of contracts/fix_prompt/v1.py::FixPromptV1 (frozen Python — the consolidated
// "paste into Claude Code" fix-it artifact, output of generate_fix_prompt_activity).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in fix_prompt.v1.parity.test.ts.
//
// Source members ported (every public one in v1.py):
//  - FixPromptV1 (the only model; no enums/constants/helper-fns live in the module).
//    - generation_mode: Literal["llm", "deterministic_fallback"] → z.enum.
//
// Port notes:
//  - schema_version is a bare `int = 1` (NOT Literal[1]), so z.number().int().default(1) — a
//    z.literal would false-reject a future schema_version=2 the wire might carry.
//  - review_id: uuid.UUID → string on the wire. Pydantic model_dump(mode="json") emits a LOWERCASE
//    RFC4122 string, so the Zod port validates the lowercase string form (z.string().uuid()).
//  - generated_at: datetime → ISO-8601 string on the wire. Pydantic normalizes a "+00:00" offset to
//    a trailing "Z"; the repo canonicalizer collapses both spellings to microsecond UTC, so parity
//    holds. z.string().datetime({ offset: true }) accepts both the "Z" and explicit-offset forms.

// generation_mode = Literal["llm", "deterministic_fallback"] → z.enum.
export const GenerationMode = z.enum(["llm", "deterministic_fallback"]);
export type GenerationMode = z.infer<typeof GenerationMode>;

// prompt min/max mirror the Python Field bounds, themselves mirrored by the DB CHECK
// (length(prompt) <= 60000) so neither layer persists a pathological multi-MB prompt.
export const MAX_FIX_PROMPT_CHARS = 60000;

export const FixPromptV1 = z
  .object({
    schema_version: z.number().int().default(1),
    review_id: z.string().uuid(),
    prompt: z.string().min(1).max(MAX_FIX_PROMPT_CHARS),
    generation_mode: GenerationMode,
    // findings INCLUDED (post-truncation).
    finding_count: z.number().int().gte(0),
    truncated: z.boolean(),
    generated_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type FixPromptV1 = z.infer<typeof FixPromptV1>;
