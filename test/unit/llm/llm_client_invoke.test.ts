import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import { LlmClient, type LlmSdk } from "#backend/integrations/llm/client.js";
import { LlmInvocationError, LlmOutputUnsafeError } from "#backend/integrations/llm/errors.js";

import type { LlmMessage } from "#contracts/llm_message.v1.js";

// Unit coverage of the PARITY-CRITICAL invoke_model transform (client.py lines 491-584): content_text
// extraction, raw_content_blocks, token usage, the output-safety blocking step, and the result build.
// The SDK is a stub returning a constructed response dict (the cassette replay seam reduced to one
// call); cost-cap is the in-memory allow-all the Python cassette test wires.

/** A stub SDK returning a fixed response dict (mirrors the cassette `_CassetteSdk`). */
function stubSdk(response: Record<string, unknown>): LlmSdk {
  return {
    async createMessage(): Promise<Record<string, unknown>> {
      return response;
    },
  };
}

function newClient(response: Record<string, unknown>): LlmClient {
  // Real ported OutputSafetyValidator (the LlmClient default) — output-safety IS on the observable path.
  return new LlmClient({
    sdk: stubSdk(response),
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    clock: new FakeClock(),
  });
}

const MESSAGES: Array<LlmMessage> = [
  { role: "system", content: "sys" },
  { role: "user", content: "review this" },
];

async function invoke(client: LlmClient) {
  return client.invokeModel({ role: "primary", model: "claude-sonnet-4-6", messages: MESSAGES });
}

describe("LlmClient.invokeModel — pure transform", () => {
  it("extracts content_text from the first text block + all dict blocks as raw_content_blocks", async () => {
    const response = {
      content: [
        { type: "text", text: "I'll surface findings." },
        { type: "tool_use", id: "t1", name: "report_finding", input: { file: "a.py" } },
      ],
      usage: { input_tokens: 220, output_tokens: 180 },
      stop_reason: "tool_use",
    };
    const result = await invoke(newClient(response));

    expect(result.content).toBe("I'll surface findings.");
    expect(result.raw_content_blocks).toEqual(response.content);
    expect(result.prompt_tokens).toBe(220);
    expect(result.completion_tokens).toBe(180);
    expect(result.stop_reason).toBe("tool_use");
    expect(result.provider).toBe("bedrock");
    expect(result.role).toBe("primary");
    expect(result.model).toBe("claude-sonnet-4-6");
    // payload_blob_ref is a well-formed BlobRef from the in-memory default.
    expect(result.payload_blob_ref.content_type).toBe("application/json");
    expect(result.payload_blob_ref.key).toContain(`/${result.request_id}/response.json`);
  });

  it("content_text is empty when the first block has no text (Python str(get('text',''))→'')", async () => {
    const response = {
      content: [{ type: "tool_use", id: "t1", name: "report_finding", input: {} }],
      usage: { input_tokens: 5, output_tokens: 0 },
      stop_reason: "tool_use",
    };
    const result = await invoke(newClient(response));
    expect(result.content).toBe("");
    expect(result.raw_content_blocks).toHaveLength(1);
  });

  it("content_text is empty when content is missing entirely (Python `or [{}]`)", async () => {
    const response = { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };
    const result = await invoke(newClient(response));
    expect(result.content).toBe("");
    // `[{}]` fallback → first block is {}, raw_blocks = [{}].
    expect(result.raw_content_blocks).toEqual([{}]);
  });

  it("token usage defaults to 0 when fields missing/None (Python int(... or 0))", async () => {
    const response = { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" };
    const result = await invoke(newClient(response));
    expect(result.prompt_tokens).toBe(0);
    expect(result.completion_tokens).toBe(0);
    expect(result.stop_reason).toBe("end_turn");
  });

  it("blocks unsafe output: raises LlmOutputUnsafeError carrying decision + raw blocks + request_id", async () => {
    const unsafeText = "AWS access key AKIAREALKEY12345678X found at secrets_loader.py:5.";
    const response = {
      content: [
        { type: "text", text: unsafeText },
        { type: "tool_use", id: "t1", name: "report_finding", input: { file: "a.py" } },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
      stop_reason: "tool_use",
    };
    await expect(invoke(newClient(response))).rejects.toBeInstanceOf(LlmOutputUnsafeError);

    let err: LlmOutputUnsafeError | undefined;
    try {
      await invoke(newClient(response));
    } catch (e) {
      err = e as LlmOutputUnsafeError;
    }
    expect(err).toBeInstanceOf(LlmOutputUnsafeError);
    expect(err!.decision.reasons).toContain("secret_leaked");
    expect(err!.decision.findings).toHaveLength(1);
    // raw_content_blocks survive untouched (the validator's scan is text-only).
    expect(err!.rawContentBlocks).toEqual(response.content);
    expect(err!.contentText).toBe(unsafeText);
    // request_id is always set before the raise (Sprint-1-v2 M3 invariant).
    expect(err!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("requires an explicit model (ADR-0060: no in-client routing fallback)", async () => {
    const client = newClient({ content: [{ type: "text", text: "x" }] });
    await expect(
      client.invokeModel({ role: "primary", model: null, messages: MESSAGES }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("wraps an SDK error as LlmInvocationError", async () => {
    const client = new LlmClient({
      sdk: {
        async createMessage(): Promise<Record<string, unknown>> {
          throw new Error("connection reset");
        },
      },
      costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
      clock: new FakeClock(),
    });
    await expect(invoke(client)).rejects.toBeInstanceOf(LlmInvocationError);
  });
});
