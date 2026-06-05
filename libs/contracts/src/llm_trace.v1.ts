import { z } from "zod";

// Zod port of vendor/codemaster-py/contracts/observability/v1.py::LlmTraceV1
// (frozen Python, Sprint 6 / S6.1.4a). Parity-validated in test/contracts/llm_trace.v1.parity.test.ts.
//
// LlmTraceV1 is the single trace exported to Langfuse per LLM invocation. The redacted snippets carry at
// most 200 characters of prompt / completion text with PII masked (the LangfuseExporter's
// `redactSnippet` runs `redactPii` then truncates to 200 before constructing this contract).
//
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
//
// FIELD NOTES (mirroring the Python field declarations):
//  - schema_version: Python `int = 1` (NOT Literal) → z.number().int().default(1).
//  - request_id / installation_id: uuid.UUID → Pydantic model_dump(mode="json") emits lowercase
//    canonical; the Zod port validates + lowercases the string form.
//  - model: str.
//  - prompt_tokens / completion_tokens / latency_ms / cost_usd_cents: `Field(ge=0)` int → .int().min(0).
//  - status: Literal["ok", "failed", "timeout"] → z.enum([...]).
//  - prompt_redacted_snippet / completion_redacted_snippet: `Field(max_length=200)` → .max(200).
//  - routing_reason: `str = ""` → default("").
//  - policy_revision: `Field(default=0, ge=0)` → .int().min(0).default(0).
export const LlmTraceV1 = z
  .object({
    schema_version: z.number().int().default(1),
    request_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    installation_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    model: z.string(),
    prompt_tokens: z.number().int().min(0),
    completion_tokens: z.number().int().min(0),
    latency_ms: z.number().int().min(0),
    cost_usd_cents: z.number().int().min(0),
    status: z.enum(["ok", "failed", "timeout"]),
    prompt_redacted_snippet: z.string().max(200),
    completion_redacted_snippet: z.string().max(200),
    routing_reason: z.string().default(""),
    policy_revision: z.number().int().min(0).default(0),
  })
  .strict();

export type LlmTraceV1 = z.infer<typeof LlmTraceV1>;

// Phase 0 / S21.LLM-DUAL.0 — backward-compatibility alias. Same Python source line:
// `BedrockTraceV1 = LlmTraceV1`. Same object identity in Python; here the alias re-exports the SAME
// Zod schema object + the SAME inferred type, so `BedrockTraceV1.parse(...)` and `LlmTraceV1.parse(...)`
// are interchangeable (the exporter ports the name it actually uses — see langfuse_exporter.ts, which
// imports BedrockTraceV1, mirroring the frozen Python exporter's `from contracts.observability.v1 import
// BedrockTraceV1`).
export const BedrockTraceV1 = LlmTraceV1;
export type BedrockTraceV1 = LlmTraceV1;
