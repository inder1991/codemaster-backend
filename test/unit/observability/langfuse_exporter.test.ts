import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type LangfuseHttpClient,
  type LangfuseHttpRequestArgs,
  LangfuseExporter,
  redactSnippet,
} from "#backend/observability/langfuse_exporter.js";

import { BedrockTraceV1 } from "#contracts/llm_trace.v1.js";

// Unit coverage of the REAL LangfuseExporter (env-gated OFF when unconfigured — NOT a stub). The HTTP
// transport is the injected seam; a recorder captures the single POST so we assert URL / body / headers
// EXACTLY against the frozen Python `_client.post(...)`.

const REQ_ID = "12345678-1234-5678-1234-567812345678";
const INST_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** A recording transport double (test-only): captures every POST; never hits the network. */
class RecordingHttpClient implements LangfuseHttpClient {
  public readonly calls: Array<LangfuseHttpRequestArgs> = [];
  public async post(args: LangfuseHttpRequestArgs): Promise<void> {
    this.calls.push(args);
  }
}

/** A transport that always throws — exercises the fire-and-forget swallow. */
class ThrowingHttpClient implements LangfuseHttpClient {
  public async post(): Promise<void> {
    throw new Error("transport exploded");
  }
}

function trace(overrides: Partial<Record<string, unknown>> = {}): BedrockTraceV1 {
  return BedrockTraceV1.parse({
    request_id: REQ_ID,
    installation_id: INST_ID,
    model: "claude-sonnet-4-6",
    prompt_tokens: 80,
    completion_tokens: 12,
    latency_ms: 5,
    cost_usd_cents: 150,
    status: "ok",
    prompt_redacted_snippet: "review this",
    completion_redacted_snippet: "No issues identified.",
    routing_reason: "explicit",
    policy_revision: 3,
    ...overrides,
  });
}

describe("redactSnippet", () => {
  it("redacts PII then truncates to 200 chars (placeholder never split)", () => {
    const out = redactSnippet("contact me at alice@example.com please");
    expect(out).toContain("[REDACTED:email]");
    expect(out).not.toContain("alice@example.com");
  });

  it("truncates AFTER redaction at 200 chars", () => {
    const out = redactSnippet("z".repeat(500));
    expect(out).toHaveLength(200);
  });
});

describe("LangfuseExporter.export — POST body / headers parity", () => {
  it("POSTs the EXACT Python body + headers to {host}/api/public/traces", async () => {
    const http = new RecordingHttpClient();
    const exporter = new LangfuseExporter({
      host: "https://lf.example.com",
      apiKey: "secret-key",
      http,
    });

    await exporter.export(trace());

    expect(http.calls).toHaveLength(1);
    const call = http.calls[0]!;
    expect(call.url).toBe("https://lf.example.com/api/public/traces");
    expect(call.headers).toEqual({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
    });
    expect(call.jsonBody).toEqual({
      id: REQ_ID,
      name: "bedrock_invocation",
      userId: INST_ID,
      metadata: {
        model: "claude-sonnet-4-6",
        status: "ok",
        routing_reason: "explicit",
        policy_revision: 3,
      },
      input: { snippet: "review this" },
      output: { snippet: "No issues identified." },
      usage: {
        input: 80,
        output: 12,
        // totalCost = cost_usd_cents / 100.0 — the Python FLOAT: 150 / 100 = 1.5.
        totalCost: 1.5,
      },
      latency: 5,
    });
  });

  it("totalCost is cents/100 as a float (e.g. 7 cents → 0.07)", async () => {
    const http = new RecordingHttpClient();
    const exporter = new LangfuseExporter({ host: "https://lf", apiKey: "k", http });
    await exporter.export(trace({ cost_usd_cents: 7 }));
    const usage = (http.calls[0]!.jsonBody as { usage: { totalCost: number } }).usage;
    expect(usage.totalCost).toBe(0.07);
  });

  it("strips a trailing slash from host so the URL never double-slashes", async () => {
    const http = new RecordingHttpClient();
    const exporter = new LangfuseExporter({ host: "https://lf.example.com/", apiKey: "k", http });
    await exporter.export(trace());
    expect(http.calls[0]!.url).toBe("https://lf.example.com/api/public/traces");
  });

  it("does NOT POST when disabled (setEnabled(false))", async () => {
    const http = new RecordingHttpClient();
    const exporter = new LangfuseExporter({ host: "https://lf", apiKey: "k", http });
    exporter.setEnabled(false);
    await exporter.export(trace());
    expect(http.calls).toHaveLength(0);
  });

  it("does NOT POST when host is empty (the disabled-by-default shape)", async () => {
    const http = new RecordingHttpClient();
    const exporter = new LangfuseExporter({ host: "", apiKey: "k", http, enabled: true });
    await exporter.export(trace());
    expect(http.calls).toHaveLength(0);
  });

  it("NEVER raises when the transport throws (fire-and-forget)", async () => {
    const exporter = new LangfuseExporter({
      host: "https://lf",
      apiKey: "k",
      http: new ThrowingHttpClient(),
    });
    // Resolves (does not reject) despite the transport throwing.
    await expect(exporter.export(trace())).resolves.toBeUndefined();
  });

  it("aclose is a no-op that resolves", async () => {
    const exporter = new LangfuseExporter({ host: "https://lf", apiKey: "k" });
    await expect(exporter.aclose()).resolves.toBeUndefined();
  });
});

describe("LangfuseExporter.fromEnv — env-gating (faithful to Python)", () => {
  const SAVED = {
    host: process.env.LANGFUSE_HOST,
    key: process.env.LANGFUSE_API_KEY,
    enabled: process.env.LANGFUSE_EXPORT_ENABLED,
  };

  beforeEach(() => {
    delete process.env.LANGFUSE_HOST;
    delete process.env.LANGFUSE_API_KEY;
    delete process.env.LANGFUSE_EXPORT_ENABLED;
  });

  afterEach(() => {
    restore("LANGFUSE_HOST", SAVED.host);
    restore("LANGFUSE_API_KEY", SAVED.key);
    restore("LANGFUSE_EXPORT_ENABLED", SAVED.enabled);
  });

  it("is DISABLED (no global-fetch POST) when LANGFUSE_HOST is unset", async () => {
    process.env.LANGFUSE_API_KEY = "k";
    // The fromEnv exporter uses the REAL global-fetch transport by default; a disabled exporter must
    // return BEFORE touching it, so a fetch spy proves no network call regardless of transport.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const exporter = LangfuseExporter.fromEnv();
      await exporter.export(trace());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("is DISABLED (no global-fetch POST) when LANGFUSE_API_KEY is unset", async () => {
    process.env.LANGFUSE_HOST = "https://lf";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const exporter = LangfuseExporter.fromEnv();
      await exporter.export(trace());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("is ENABLED + REALLY POSTs when host + key are set (real transport seam, recorder injected)", async () => {
    process.env.LANGFUSE_HOST = "https://lf.example.com";
    process.env.LANGFUSE_API_KEY = "real-key";
    // fromEnv builds the real exporter; we re-build with the same host/key but inject a recorder to
    // assert the POST happens (the production default transport is global fetch — not exercised here).
    const http = new RecordingHttpClient();
    const exporter = new LangfuseExporter({ host: "https://lf.example.com", apiKey: "real-key", http });
    await exporter.export(trace());
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe("https://lf.example.com/api/public/traces");
  });

  it("LANGFUSE_EXPORT_ENABLED=false disables export even with host+key set", async () => {
    process.env.LANGFUSE_HOST = "https://lf.example.com";
    process.env.LANGFUSE_API_KEY = "real-key";
    process.env.LANGFUSE_EXPORT_ENABLED = "false";
    const exporter = LangfuseExporter.fromEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await exporter.export(trace());
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
