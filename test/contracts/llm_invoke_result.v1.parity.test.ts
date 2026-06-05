import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { LlmInvokeResultV1 } from "#contracts/llm_invoke_result.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the contract
// class via the oracle — `LlmInvokeResultV1(**payload).model_dump(mode="json")`) and through Zod
// (`LlmInvokeResultV1.parse(payload)`), then diff canonical JSON. Accept/reject agree.
const PY = "codemaster.integrations.llm.client";
const UUID = "12345678-1234-5678-1234-567812345678";

function blobRef(): Record<string, unknown> {
  return {
    installation_id: "iid-1",
    key: "llm-payloads/x/response.json",
    byte_size: 42,
    content_type: "application/json",
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("LlmInvokeResultV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      request_id: UUID,
      model: "claude-sonnet-4-6",
      prompt_tokens: 80,
      completion_tokens: 12,
      latency_ms: 5,
      cost_usd_cents: 1,
      payload_blob_ref: blobRef(),
      content: "No issues identified.",
      stop_reason: "end_turn",
      raw_content_blocks: [{ type: "text", text: "No issues identified." }],
      provider: "bedrock",
      role: "primary",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmInvokeResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(LlmInvokeResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults when schema_version / stop_reason / raw_content_blocks omitted", async () => {
    const payload = {
      request_id: UUID,
      model: "claude-sonnet-4-6",
      prompt_tokens: 1,
      completion_tokens: 1,
      latency_ms: 1,
      cost_usd_cents: 1,
      payload_blob_ref: blobRef(),
      content: "",
      provider: "bedrock",
      role: "primary",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmInvokeResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(LlmInvokeResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("preserves multi-block raw_content_blocks (text + tool_use) in order", async () => {
    const payload = {
      request_id: UUID,
      model: "claude-sonnet-4-6",
      prompt_tokens: 220,
      completion_tokens: 180,
      latency_ms: 9,
      cost_usd_cents: 1,
      payload_blob_ref: blobRef(),
      content: "I'll surface findings.",
      stop_reason: "tool_use",
      raw_content_blocks: [
        { type: "text", text: "I'll surface findings." },
        { type: "tool_use", id: "t1", name: "report_finding", input: { file: "a.py" } },
      ],
      provider: "bedrock",
      role: "primary",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmInvokeResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(LlmInvokeResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("normalizes an uppercase request_id UUID to lowercase identically (both sides)", async () => {
    const payload = {
      request_id: UUID.toUpperCase(),
      model: "claude-sonnet-4-6",
      prompt_tokens: 1,
      completion_tokens: 1,
      latency_ms: 1,
      cost_usd_cents: 1,
      payload_blob_ref: blobRef(),
      content: "x",
      provider: "bedrock",
      role: "primary",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmInvokeResultV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(LlmInvokeResultV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an invalid provider literal", async () => {
    const bad = {
      request_id: UUID,
      model: "claude-sonnet-4-6",
      prompt_tokens: 1,
      completion_tokens: 1,
      latency_ms: 1,
      cost_usd_cents: 1,
      payload_blob_ref: blobRef(),
      content: "x",
      provider: "openai",
      role: "primary",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmInvokeResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LlmInvokeResultV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      request_id: UUID,
      model: "claude-sonnet-4-6",
      prompt_tokens: 1,
      completion_tokens: 1,
      latency_ms: 1,
      cost_usd_cents: 1,
      payload_blob_ref: blobRef(),
      content: "x",
      provider: "bedrock",
      role: "primary",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmInvokeResultV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LlmInvokeResultV1.parse(bad)).toThrow();
  }, 30_000);
});
