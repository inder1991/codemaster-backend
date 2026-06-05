import { z } from "zod";

// Zod port of vendor/codemaster-py/codemaster/integrations/llm/client.py::LlmMessage (frozen Python).
// Parity-validated in test/contracts/llm_message.v1.parity.test.ts.
//
// LlmMessage is the role-tagged message envelope handed to the SDK (`messages=[m.model_dump() for m
// in messages]`). It is a wire contract — the dual-run serializes it and the recorded LLM interaction
// depends on its exact shape — so it lives in contracts with a parity test.
//
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict(). The Python class also sets
// `__contract_internal__ = True` (a marker the contract-lint tool reads to skip the schema_version
// requirement for internal envelopes); that marker is a Python-tooling concern with no wire effect, so
// it has no field counterpart here. Note: LlmMessage carries NO schema_version field.
//
//  - role: Literal["user", "assistant", "system"] → z.enum([...]).
//  - content: str.
export const LlmMessage = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
  })
  .strict();

export type LlmMessage = z.infer<typeof LlmMessage>;
