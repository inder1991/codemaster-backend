import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { BedrockTraceV1, LlmTraceV1 } from "#contracts/llm_trace.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the contract
// class via the oracle — `LlmTraceV1(**payload).model_dump(mode="json")`) and through Zod
// (`LlmTraceV1.parse(payload)`), then diff canonical JSON. Accept/reject agree.
const PY = "contracts.observability.v1";
const REQ_ID = "12345678-1234-5678-1234-567812345678";
const INST_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("LlmTraceV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      request_id: REQ_ID,
      installation_id: INST_ID,
      model: "claude-sonnet-4-6",
      prompt_tokens: 80,
      completion_tokens: 12,
      latency_ms: 5,
      cost_usd_cents: 150,
      status: "ok",
      prompt_redacted_snippet: "review this [REDACTED:email]",
      completion_redacted_snippet: "No issues identified.",
      routing_reason: "explicit",
      policy_revision: 3,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmTraceV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(LlmTraceV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults when schema_version / routing_reason / policy_revision omitted", async () => {
    const payload = {
      request_id: REQ_ID,
      installation_id: INST_ID,
      model: "claude-haiku-4-5-20251001",
      prompt_tokens: 0,
      completion_tokens: 0,
      latency_ms: 0,
      cost_usd_cents: 0,
      status: "timeout",
      prompt_redacted_snippet: "",
      completion_redacted_snippet: "",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmTraceV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(LlmTraceV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("rejects a snippet over 200 chars in BOTH impls (max_length=200)", async () => {
    const payload = {
      request_id: REQ_ID,
      installation_id: INST_ID,
      model: "claude-sonnet-4-6",
      prompt_tokens: 1,
      completion_tokens: 1,
      latency_ms: 1,
      cost_usd_cents: 1,
      status: "failed",
      prompt_redacted_snippet: "x".repeat(201),
      completion_redacted_snippet: "",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmTraceV1", kwargs: payload });
    expect(r.ok).toBe(false); // Pydantic rejects (max_length)
    expect(LlmTraceV1.safeParse(payload).success).toBe(false); // Zod rejects (.max(200))
  }, 30_000);

  it("rejects a negative token count in BOTH impls (Field(ge=0))", async () => {
    const payload = {
      request_id: REQ_ID,
      installation_id: INST_ID,
      model: "claude-sonnet-4-6",
      prompt_tokens: -1,
      completion_tokens: 1,
      latency_ms: 1,
      cost_usd_cents: 1,
      status: "ok",
      prompt_redacted_snippet: "",
      completion_redacted_snippet: "",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmTraceV1", kwargs: payload });
    expect(r.ok).toBe(false); // Pydantic rejects (ge=0)
    expect(LlmTraceV1.safeParse(payload).success).toBe(false); // Zod rejects (.min(0))
  }, 30_000);

  it("rejects a status outside the literal set in BOTH impls", async () => {
    const payload = {
      request_id: REQ_ID,
      installation_id: INST_ID,
      model: "claude-sonnet-4-6",
      prompt_tokens: 1,
      completion_tokens: 1,
      latency_ms: 1,
      cost_usd_cents: 1,
      status: "degraded",
      prompt_redacted_snippet: "",
      completion_redacted_snippet: "",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmTraceV1", kwargs: payload });
    expect(r.ok).toBe(false);
    expect(LlmTraceV1.safeParse(payload).success).toBe(false);
  }, 30_000);

  it("BedrockTraceV1 alias is the SAME schema as LlmTraceV1 (Python `BedrockTraceV1 = LlmTraceV1`)", () => {
    // Same Zod schema object identity — the alias re-exports the SAME const.
    expect(BedrockTraceV1).toBe(LlmTraceV1);
  });
});
