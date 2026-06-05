import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import { LlmClient, type LlmSdk } from "#backend/integrations/llm/client.js";
import { LlmInvocationError, LlmOutputUnsafeError, LlmTimeoutError } from "#backend/integrations/llm/errors.js";
import { type LangfuseExporterPort } from "#backend/observability/langfuse_exporter.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { BedrockTraceV1 } from "#contracts/llm_trace.v1.js";
import type { LlmMessage } from "#contracts/llm_message.v1.js";

// The LlmClient fires the fire-and-forget Langfuse export on ALL THREE paths the Python does — ok
// (output-safety allow), failed (output-safety block), and the SDK-error paths (failed / timeout) — with
// the right BedrockTraceV1. We inject a recording exporter double to capture the trace.

/** A recording exporter double (test-only): captures every exported trace. */
class RecordingExporter implements LangfuseExporterPort {
  public readonly traces: Array<BedrockTraceV1> = [];
  public async export(trace: BedrockTraceV1): Promise<void> {
    this.traces.push(trace);
  }
}

const MESSAGES: Array<LlmMessage> = [
  { role: "system", content: "sys" },
  { role: "user", content: "review this please" },
];

function newClient(args: {
  sdk: LlmSdk;
  langfuse: LangfuseExporterPort;
}): LlmClient {
  return new LlmClient({
    sdk: args.sdk,
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    blobStore: new InMemoryBlobStoreAdapter(),
    langfuse: args.langfuse,
    clock: new FakeClock(),
  });
}

function stubSdk(response: Record<string, unknown>): LlmSdk {
  return {
    async createMessage(): Promise<Record<string, unknown>> {
      return response;
    },
  };
}

function throwingSdk(err: Error): LlmSdk {
  return {
    async createMessage(): Promise<Record<string, unknown>> {
      throw err;
    },
  };
}

async function invoke(client: LlmClient): Promise<unknown> {
  return client.invokeModel({ role: "primary", model: "claude-sonnet-4-6", messages: MESSAGES });
}

describe("LlmClient Langfuse export wiring", () => {
  it("exports an ok trace on the happy path (status=ok, completion carried, redacted snippets)", async () => {
    const exporter = new RecordingExporter();
    const sdk = stubSdk({
      content: [{ type: "text", text: "No issues identified." }],
      usage: { input_tokens: 80, output_tokens: 12 },
      stop_reason: "end_turn",
    });
    await invoke(newClient({ sdk, langfuse: exporter }));

    expect(exporter.traces).toHaveLength(1);
    const t = exporter.traces[0]!;
    expect(t.status).toBe("ok");
    expect(t.model).toBe("claude-sonnet-4-6");
    expect(t.prompt_tokens).toBe(80);
    expect(t.completion_tokens).toBe(12);
    expect(t.routing_reason).toBe("explicit");
    expect(t.policy_revision).toBe(0);
    // prompt snippet is the first user/system message content (the Python `_first_message_content`).
    expect(t.prompt_redacted_snippet).toBe("sys");
    // completion is carried on the ok path.
    expect(t.completion_redacted_snippet).toBe("No issues identified.");
    expect(t.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("exports a failed trace on an output-safety block (status=failed, completion BLANKED)", async () => {
    const exporter = new RecordingExporter();
    const unsafe = "AWS access key AKIAREALKEY12345678X found at secrets_loader.py:5.";
    const sdk = stubSdk({
      content: [{ type: "text", text: unsafe }],
      usage: { input_tokens: 10, output_tokens: 10 },
      stop_reason: "end_turn",
    });
    await expect(invoke(newClient({ sdk, langfuse: exporter }))).rejects.toBeInstanceOf(
      LlmOutputUnsafeError,
    );

    expect(exporter.traces).toHaveLength(1);
    const t = exporter.traces[0]!;
    expect(t.status).toBe("failed");
    // completion_text is "" when blocked (the unsafe text never leaks into the trace).
    expect(t.completion_redacted_snippet).toBe("");
    expect(t.prompt_tokens).toBe(10);
    expect(t.completion_tokens).toBe(10);
  });

  it("exports a failed trace on a generic SDK error (status=failed, zero tokens)", async () => {
    const exporter = new RecordingExporter();
    const sdk = throwingSdk(new Error("connection reset"));
    await expect(invoke(newClient({ sdk, langfuse: exporter }))).rejects.toBeInstanceOf(
      LlmInvocationError,
    );

    expect(exporter.traces).toHaveLength(1);
    const t = exporter.traces[0]!;
    expect(t.status).toBe("failed");
    expect(t.prompt_tokens).toBe(0);
    expect(t.completion_tokens).toBe(0);
    expect(t.cost_usd_cents).toBe(0);
    expect(t.completion_redacted_snippet).toBe("");
    // prompt snippet still carries the first message (forensics on a failed call).
    expect(t.prompt_redacted_snippet).toBe("sys");
  });

  it("exports a timeout trace on an SDK timeout (status=timeout)", async () => {
    const exporter = new RecordingExporter();
    const sdk = throwingSdk(new LlmTimeoutError("bedrock timeout"));
    await expect(invoke(newClient({ sdk, langfuse: exporter }))).rejects.toBeInstanceOf(
      LlmInvocationError,
    );

    expect(exporter.traces).toHaveLength(1);
    const t = exporter.traces[0]!;
    expect(t.status).toBe("timeout");
    expect(t.prompt_tokens).toBe(0);
    expect(t.completion_tokens).toBe(0);
  });

  it("redacts PII in the prompt snippet before exporting (no raw email reaches the trace)", async () => {
    const exporter = new RecordingExporter();
    const messages: Array<LlmMessage> = [{ role: "user", content: "ping alice@example.com now" }];
    const sdk = stubSdk({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 5, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    const client = new LlmClient({
      sdk,
      costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
      blobStore: new InMemoryBlobStoreAdapter(),
      langfuse: exporter,
      clock: new FakeClock(),
    });
    await client.invokeModel({ role: "primary", model: "claude-sonnet-4-6", messages });

    const t = exporter.traces[0]!;
    expect(t.prompt_redacted_snippet).toContain("[REDACTED:email]");
    expect(t.prompt_redacted_snippet).not.toContain("alice@example.com");
  });

  it("a throwing exporter NEVER masks the caller's return (fire-and-forget on the ok path)", async () => {
    const throwingExporter: LangfuseExporterPort = {
      async export(): Promise<void> {
        throw new Error("exporter exploded");
      },
    };
    const sdk = stubSdk({
      content: [{ type: "text", text: "fine" }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    // The client still returns its result despite the exporter throwing (the maybeExport guard swallows).
    const result = await invoke(newClient({ sdk, langfuse: throwingExporter }));
    expect((result as { content: string }).content).toBe("fine");
  });

  it("defaults to the disabled no-op exporter (no langfuse injected) without affecting the result", async () => {
    const sdk = stubSdk({
      content: [{ type: "text", text: "default ok" }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    // No `langfuse` arg → DISABLED_LANGFUSE_EXPORTER default (the Python `self._langfuse is None`).
    const client = new LlmClient({
      sdk,
      costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
      blobStore: new InMemoryBlobStoreAdapter(),
      clock: new FakeClock(),
    });
    const result = await client.invokeModel({
      role: "primary",
      model: "claude-sonnet-4-6",
      messages: MESSAGES,
    });
    expect((result as { content: string }).content).toBe("default ok");
  });
});
