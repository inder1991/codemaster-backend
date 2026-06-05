// LLM invocation error hierarchy — 1:1 port of the frozen Python
//   - vendor/codemaster-py/codemaster/integrations/llm/error_types.py (the dependency-free hierarchy)
//   - vendor/codemaster-py/codemaster/integrations/llm/client.py:86-120 (LlmOutputUnsafeError)
//
// Why this module is dependency-free of the SDK stack (ADR-0061 D3): the Python error_types module is
// the single source of truth for the LLM invocation error hierarchy precisely so the Temporal workflow
// body can `catch` them WITHOUT importing the anthropic/httpx client stack into the workflow sandbox.
// The TS port preserves that: these classes import nothing from the client/SDK.
//
// LlmOutputUnsafeError lives in client.py (not error_types.py) in Python because it depends on the
// OutputSafetyDecisionV1 contract; the workflow body never references it. It is ported HERE alongside
// the rest of the hierarchy (with that same contract dependency) so the review activity can
// `instanceof`-dispatch the whole family from one import.

import type { OutputSafetyDecisionV1 } from "#contracts/output_safety.v1.js";

// ─── error_types.py hierarchy ─────────────────────────────────────────────────────────────────────

/** Raised on 4xx (non-retryable) or 5xx after retries are exhausted. */
export class LlmInvocationError extends Error {
  public constructor(message?: string) {
    super(message);
    this.name = "LlmInvocationError";
  }
}

/** SDK call exceeded its timeout. Activity-level retry: YES. */
export class LlmTimeoutError extends LlmInvocationError {
  public constructor(message?: string) {
    super(message);
    this.name = "LlmTimeoutError";
  }
}

/** Provider returned 5xx. Activity-level retry: YES. */
export class LlmServerError extends LlmInvocationError {
  public constructor(message?: string) {
    super(message);
    this.name = "LlmServerError";
  }
}

/** Provider returned 429 / quota exhausted. Activity-level retry: YES with backoff. */
export class LlmRateLimitError extends LlmInvocationError {
  public constructor(message?: string) {
    super(message);
    this.name = "LlmRateLimitError";
  }
}

/** Provider returned 401/403. Activity-level retry: NO (operator-visible misconfiguration). */
export class LlmAuthError extends LlmInvocationError {
  public constructor(message?: string) {
    super(message);
    this.name = "LlmAuthError";
  }
}

/**
 * No row exists for (installation_id, role) in core.llm_provider_settings. Operator hasn't seeded via
 * /admin/llm yet. Activity-level retry: NO. Workflow falls into the existing graceful-degrade catch.
 */
export class LlmRoleNotConfiguredError extends LlmInvocationError {
  public constructor(message?: string) {
    super(message);
    this.name = "LlmRoleNotConfiguredError";
  }
}

/**
 * Row exists but enabled=false for (installation_id, role). Operator deliberately disabled this
 * provider slot. Activity-level retry: NO. Workflow falls into the graceful-degrade catch.
 */
export class LlmRoleDisabledError extends LlmInvocationError {
  public constructor(message?: string) {
    super(message);
    this.name = "LlmRoleDisabledError";
  }
}

// ─── client.py:86-120 — LlmOutputUnsafeError ──────────────────────────────────────────────────────

/**
 * Raised when OutputSafetyValidator blocks a completion (S7.5.2).
 *
 * Carries `rawContentBlocks`, `contentText`, AND `requestId` so downstream sanitize-and-continue
 * handlers can parse the structured tool_use blocks (unaffected by the validator's text-only scan),
 * redact the preamble in-place, and construct a deterministic audit_event_id from the request_id.
 *
 * Backward-compat (mirroring the Python defaults): every constructor arg except `decision` defaults to
 * an empty value, so call-sites that only pass `decision` keep working.
 *
 * NOTE the message format is byte-identical to the Python `super().__init__(...)` f-string so any log
 * scrape / message-substring assertion matches: `bedrock output blocked by validator: reasons=[...];
 * detail=<repr>`. The `detail!r` repr is reproduced as Python's `repr()` for a str (single-quoted).
 */
export class LlmOutputUnsafeError extends Error {
  public readonly decision: OutputSafetyDecisionV1;
  public readonly rawContentBlocks: ReadonlyArray<Record<string, unknown>>;
  public readonly contentText: string;
  public readonly requestId: string | null;

  public constructor(args: {
    decision: OutputSafetyDecisionV1;
    rawContentBlocks?: ReadonlyArray<Record<string, unknown>>;
    contentText?: string;
    requestId?: string | null;
  }) {
    super(
      `bedrock output blocked by validator: reasons=` +
        `${pyReprList(args.decision.reasons)}; detail=${pyReprStr(args.decision.detail)}`,
    );
    this.name = "LlmOutputUnsafeError";
    this.decision = args.decision;
    this.rawContentBlocks = args.rawContentBlocks ?? [];
    this.contentText = args.contentText ?? "";
    this.requestId = args.requestId ?? null;
  }
}

/** Python `repr()` of a str: single-quoted, `\`→`\\`, `'`→`\'`. ASCII reasons/detail only here. */
function pyReprStr(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Python `list(...)` repr of string reasons: `['a', 'b']`. */
function pyReprList(values: ReadonlyArray<string>): string {
  return `[${values.map(pyReprStr).join(", ")}]`;
}
