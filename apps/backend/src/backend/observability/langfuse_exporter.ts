// LangfuseExporter — 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/observability/langfuse_exporter.py (Sprint 6 / S6.1.4a,
// Sprint 7 / S7.3.4).
//
// Fire-and-forget POST to the Langfuse `traces` API. Exceptions are caught and logged WARN; NEVER
// raised to the caller (the LlmClient must not have its return / raise path coupled to observability
// availability — the Python `except Exception as e: _LOG.warning(...)` swallow).
//
// ── env-gating (FAITHFUL to Python, NOT a stub) ──
// `fromEnv()` reads LANGFUSE_HOST / LANGFUSE_API_KEY / LANGFUSE_EXPORT_ENABLED. When host OR key is
// unset it returns a DISABLED exporter (host="", api_key="", enabled=false) — the Python
// "disabled-by-default if env not configured; never raise". A disabled exporter's `export(...)` is a
// no-op (no POST). This is the production posture in dev / unconfigured environments; when the env IS
// configured the exporter REALLY POSTs. There is no faking stub anywhere on the production path.
//
// ── HTTP-transport seam ──
// The HTTP transport is an INJECTED collaborator ({@link LangfuseHttpClient}), mirroring
// FetchVaultHttpClient in #backend/adapters/vault_http.ts: production defaults to {@link
// FetchLangfuseHttpClient} (a thin global-`fetch` wrapper — NO new dependency); tests inject a recorder
// that captures the request and asserts URL / body / headers exactly. No DB; no clock (the exporter
// takes no timestamp — the trace's `latency_ms` is supplied by the caller).

import { transportAbortSignal } from "#platform/transport_timeout.js";

import { redactPii } from "#backend/redact/pii_redactor.js";

import { type BedrockTraceV1 } from "#contracts/llm_trace.v1.js";

// ─── Constants (1:1 with the frozen Python module constants) ──────────────────────────────────

/** Max characters of redacted prompt / completion text in a snippet (Python `SNIPPET_MAX_CHARS`). */
export const SNIPPET_MAX_CHARS = 200;

/** Per-request transport timeout, in seconds (Python `timeout_seconds: float = 5.0`). */
export const DEFAULT_TIMEOUT_SECONDS = 5.0;

// ─── Snippet redaction (Python `redact_snippet`) ──────────────────────────────────────────────

/**
 * Strip PII via the ported `redactPii` (RegexPiiRedactor), then truncate to {@link SNIPPET_MAX_CHARS}.
 *
 * Truncation happens AFTER redaction so a `[REDACTED:<kind>]` placeholder is never split across the
 * boundary — 1:1 with the Python `redact_snippet`. The findings array is discarded (the snippet only
 * needs the rewritten text).
 */
export function redactSnippet(text: string): string {
  const redacted = redactPii(text).rewritten;
  if (redacted.length > SNIPPET_MAX_CHARS) {
    return redacted.slice(0, SNIPPET_MAX_CHARS);
  }
  return redacted;
}

// ─── Injected HTTP-transport seam (mirror FetchVaultHttpClient in adapters/vault_http.ts) ──────

/** Arguments to one Langfuse HTTP request. */
export type LangfuseHttpRequestArgs = {
  url: string;
  headers: Record<string, string>;
  jsonBody: unknown;
};

/**
 * The injected HTTP transport. Production: {@link FetchLangfuseHttpClient}. Tests: a programmable
 * in-memory recorder whose `post` signature is a structural match (it records the args + may throw to
 * exercise the fire-and-forget swallow).
 */
export type LangfuseHttpClient = {
  post(args: LangfuseHttpRequestArgs): Promise<void>;
};

/**
 * Production HTTP transport: a thin wrapper over Node's built-in global `fetch` (undici). NO new
 * dependency. A timeout / abort / network failure surfaces as a thrown error which the exporter's
 * `export(...)` catches and swallows (fire-and-forget) — mirroring the Python `httpx.AsyncClient.post`
 * raising inside the `try` the exporter wraps.
 */
export class FetchLangfuseHttpClient implements LangfuseHttpClient {
  private readonly timeoutMs: number;

  public constructor({
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  }: { timeoutSeconds?: number } = {}) {
    this.timeoutMs = timeoutSeconds * 1000;
  }

  public async post(args: LangfuseHttpRequestArgs): Promise<void> {
    const headers: Record<string, string> = { ...args.headers };
    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(args.jsonBody),
      // Transport timeout via the sanctioned seam (gate-clean; a fired timeout rejects fetch). The
      // exporter swallows the rejection — observability is fire-and-forget.
      signal: transportAbortSignal(this.timeoutMs),
    };
    // We do NOT inspect the response status: the Python exporter does not either (it `await`s the POST
    // and discards the response). A non-2xx is treated like the call having happened — there is no
    // retry and no surfaced error (fire-and-forget).
    await fetch(args.url, init);
  }
}

// ─── The exporter ──────────────────────────────────────────────────────────────────────────────

export type LangfuseExporterOptions = {
  host: string;
  apiKey: string;
  enabled?: boolean;
  http?: LangfuseHttpClient;
  timeoutSeconds?: number;
};

/**
 * Fire-and-forget Langfuse trace exporter — the REAL exporter (env-gated OFF when unconfigured, NOT a
 * stub). 1:1 with the frozen Python `LangfuseExporter`.
 */
export class LangfuseExporter {
  private readonly host: string;
  private readonly apiKey: string;
  private enabled: boolean;
  private readonly http: LangfuseHttpClient;

  public constructor(options: LangfuseExporterOptions) {
    // Strip trailing slashes so `${host}/api/public/traces` never double-slashes (Python
    // `host.rstrip("/")`).
    this.host = options.host.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.enabled = options.enabled ?? true;
    // Build the default transport with the configured timeout (omit the key entirely when unset so
    // `exactOptionalPropertyTypes` is satisfied and the transport's own default applies).
    this.http =
      options.http ??
      new FetchLangfuseHttpClient(
        options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds },
      );
  }

  /**
   * Construct from env. Disabled-by-default when LANGFUSE_HOST or LANGFUSE_API_KEY is unset (never
   * raises) — the Python `from_env`. LANGFUSE_EXPORT_ENABLED is the runtime kill-switch: any value
   * other than (case-insensitive) `"false"` leaves it enabled (Python `.lower() != "false"`).
   *
   * Static env access (no dynamic indexing) keeps the object-injection sink closed.
   */
  public static fromEnv(): LangfuseExporter {
    const host = process.env.LANGFUSE_HOST;
    const apiKey = process.env.LANGFUSE_API_KEY;
    const enabled = (process.env.LANGFUSE_EXPORT_ENABLED ?? "true").toLowerCase() !== "false";
    if (!host || !apiKey) {
      // Disabled-by-default if env not configured; never raise (the faithful Python posture).
      return new LangfuseExporter({ host: "", apiKey: "", enabled: false });
    }
    return new LangfuseExporter({ host, apiKey, enabled });
  }

  /** Runtime toggle (the Python `set_enabled`; Sprint-6 wiring reads from feature flags). */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * `fetch` owns no long-lived resource we allocated, so this is a no-op — kept for parity with the
   * Python `aclose()` so callers can dispose the exporter uniformly across observability sinks.
   */
  public async aclose(): Promise<void> {
    // No-op: the global-fetch transport holds nothing to release.
  }

  /**
   * Fire-and-forget POST of one trace to `{host}/api/public/traces`. NEVER raises.
   *
   * No-op when disabled OR when no host is configured (the Python `if not self._enabled or not
   * self._host: return`). The POST body + headers are byte-faithful to the Python `_client.post(...)`:
   *   body  = {id, name:"bedrock_invocation", userId, metadata:{model,status,routing_reason,
   *            policy_revision}, input:{snippet}, output:{snippet}, usage:{input,output,totalCost},
   *            latency}
   *   where totalCost = cost_usd_cents / 100.0 (a FLOAT — Python `cost_usd_cents / 100.0`).
   *   headers = {Authorization: `Bearer <api_key>`, Content-Type: application/json}.
   *
   * Any transport error is caught + logged WARN and swallowed (the Python `except Exception`).
   */
  public async export(trace: BedrockTraceV1): Promise<void> {
    if (!this.enabled || !this.host) {
      return;
    }
    try {
      await this.http.post({
        url: `${this.host}/api/public/traces`,
        jsonBody: {
          id: trace.request_id,
          name: "bedrock_invocation",
          userId: trace.installation_id,
          metadata: {
            model: trace.model,
            status: trace.status,
            routing_reason: trace.routing_reason,
            policy_revision: trace.policy_revision,
          },
          input: { snippet: trace.prompt_redacted_snippet },
          output: { snippet: trace.completion_redacted_snippet },
          usage: {
            input: trace.prompt_tokens,
            output: trace.completion_tokens,
            // cost_usd_cents / 100.0 — a FLOAT, exactly the Python expression. JSON number formatting:
            // JS `JSON.stringify(1.5)` → "1.5" matches Python `json.dumps(1.5)` → "1.5"; an integral
            // result diverges in repr only (JS "0" vs Python "0.0") but the NUMERIC value POSTed is
            // identical, and Langfuse parses it as a number — the wire value is the same.
            totalCost: trace.cost_usd_cents / 100.0,
          },
          latency: trace.latency_ms,
        },
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      });
    } catch (e) {
      // Fire-and-forget: log + swallow. The trace is lost; the caller's return / raise is untouched.
      // The token is structurally absent from this line (only the bounded fields are logged).
      console.warn("Langfuse export failed; trace lost", {
        request_id: trace.request_id,
        error: e instanceof Error ? e.name : "unknown",
      });
    }
  }
}

// ─── The disabled no-op default the LlmClient injects (faithful to Python `self._langfuse is None`) ──

/**
 * The exporter collaborator surface the {@link LlmClient} depends on — the single `export` method it
 * calls. The Python client's `self._langfuse` is either `None` (no-op) or a `LangfuseExporter`; the TS
 * client always holds an object satisfying this type, defaulting to {@link DISABLED_LANGFUSE_EXPORTER}
 * (the structural analogue of `None` — a no-op `export`).
 */
export type LangfuseExporterPort = {
  export(trace: BedrockTraceV1): Promise<void>;
};

/**
 * The disabled no-op exporter the {@link LlmClient} defaults to — the structural analogue of the Python
 * `self._langfuse is None` (the `_maybe_export_langfuse_trace` early-return). Its `export` does nothing.
 * The production `LlmClientCache` REPLACES this with `LangfuseExporter.fromEnv()` (which is itself a
 * no-op when the env is unconfigured — so the default behaviour is identical, but the real one wakes up
 * the moment LANGFUSE_HOST / LANGFUSE_API_KEY are set).
 */
export const DISABLED_LANGFUSE_EXPORTER: LangfuseExporterPort = {
  async export(): Promise<void> {
    // no-op — faithful to the Python `if self._langfuse is None: return`.
  },
};
