// Unit test for `isTimeoutError` — the telemetry status classifier that decides whether an LLM
// invocation failure is recorded as status="timeout" vs status="failed".
//
// 1:1 with the Python client.py except-arm split: `except TimeoutError` (builtin) -> status="timeout";
// `except Exception` -> status="failed". The Python `LlmTimeoutError` subclasses `LlmInvocationError`
// (which subclasses `Exception`), NOT the builtin `TimeoutError`, and the SDK adapter maps every provider
// timeout to `LlmTimeoutError`. So an SDK-mapped timeout falls through to `except Exception` and is
// recorded status="failed" — only a RAW (unmapped) timeout reaches the `except TimeoutError` arm.

import { describe, expect, it } from "vitest";

import { isTimeoutError } from "#backend/integrations/llm/client.js";
import { LlmInvocationError, LlmTimeoutError } from "#backend/integrations/llm/errors.js";

describe("isTimeoutError (LLM telemetry status classification)", () => {
  it("classifies a RAW timeout (an Error whose name is TimeoutError) as a timeout", () => {
    const e = new Error("transport aborted");
    e.name = "TimeoutError";
    expect(isTimeoutError(e)).toBe(true);
  });

  it("does NOT classify an SDK-mapped LlmTimeoutError as a timeout", () => {
    // Python: LlmTimeoutError(LlmInvocationError(Exception)) is caught by `except Exception` -> "failed",
    // NOT by `except TimeoutError`. The TS must mirror that, so a mapped timeout records status="failed".
    expect(isTimeoutError(new LlmTimeoutError("provider timed out"))).toBe(false);
  });

  it("does NOT classify a generic LlmInvocationError as a timeout", () => {
    expect(isTimeoutError(new LlmInvocationError("400 bad request"))).toBe(false);
  });

  it("does NOT classify a plain Error as a timeout", () => {
    expect(isTimeoutError(new Error("boom"))).toBe(false);
  });
});
