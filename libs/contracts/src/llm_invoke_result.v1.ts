import { z } from "zod";

import { BlobRef } from "./blob_ref.v1.js";

// Zod port of vendor/codemaster-py/codemaster/integrations/llm/client.py::LlmInvokeResultV1
// (frozen Python). Parity-validated in test/contracts/llm_invoke_result.v1.parity.test.ts.
//
// LlmInvokeResultV1 is the structured result of one LlmClient.invoke_model call: the request id, the
// resolved model, token usage, latency, cost, the archived-payload BlobRef, the first text block's
// text (`content`), the stop reason, ALL content blocks (`raw_content_blocks` — so the review activity
// can inspect tool_use blocks, which never appear in `content`), and the provider/role attribution.
//
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
//
// FIELD NOTES (mirroring the Python field declarations):
//  - schema_version: Python `int = 1` (NOT Literal) → z.number().int().default(1).
//  - request_id: uuid.UUID → Pydantic model_dump(mode="json") emits lowercase canonical; the Zod port
//    validates + lowercases the string form.
//  - prompt_tokens / completion_tokens / latency_ms / cost_usd_cents: bare int → z.number().int().
//  - payload_blob_ref: BlobRef (imported sibling, not redefined).
//  - content: str.
//  - stop_reason: `str = ""` → default("").
//  - raw_content_blocks: `tuple[dict[str, Any], ...] = Field(default_factory=tuple)` → an array of
//    arbitrary JSON objects (Record<string, unknown>) defaulting to [].
//  - provider: Literal["bedrock", "anthropic_direct"] → z.enum([...]).
//  - role: Literal["primary", "secondary"] → z.enum([...]).
export const LlmInvokeResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    request_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    model: z.string(),
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    latency_ms: z.number().int(),
    cost_usd_cents: z.number().int(),
    payload_blob_ref: BlobRef,
    content: z.string(),
    stop_reason: z.string().default(""),
    raw_content_blocks: z.array(z.record(z.string(), z.unknown())).default([]),
    provider: z.enum(["bedrock", "anthropic_direct"]),
    role: z.enum(["primary", "secondary"]),
  })
  .strict();

export type LlmInvokeResultV1 = z.infer<typeof LlmInvokeResultV1>;
