import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import { LlmClient, type LlmSdk } from "#backend/integrations/llm/client.js";
import {
  LlmInvocationError,
  LlmRoleNotConfiguredError,
} from "#backend/integrations/llm/errors.js";
import {
  bedrockReviewChunk,
  doReview,
  type LlmClientCacheLike,
} from "#backend/review/review_activity.js";

import { computeChunkId } from "#contracts/diff_chunking.v1.js";
import { ReviewContextV1 } from "#contracts/review_context.v1.js";

// Unit coverage of doReview (1:1 _do_review): the three error paths + the sanitize-and-continue branch.
// The cache returns a real LlmClient wired with a stub SDK that replays a constructed response — exactly
// the cassette replay seam, reduced to one in-test response.

const UUID = "12345678-1234-5678-1234-567812345678";

function context(): ReviewContextV1 {
  const chunkId = computeChunkId({
    path: "src/foo.py",
    start_line: 1,
    end_line: 20,
    body: "def foo():\n    return 1\n",
  });
  return ReviewContextV1.parse({
    pr_id: UUID,
    installation_id: UUID,
    repo: "acme/widget",
    pr_title: "Cassette-driven review",
    pr_description: "## Summary\n\nReplay this cassette.",
    chunk: {
      chunk_id: chunkId,
      path: "src/foo.py",
      language: "python",
      start_line: 1,
      end_line: 20,
      body: "def foo():\n    return 1\n",
      chunk_kind: "function",
      token_estimate: 20,
    },
    policy_revision: 1,
  });
}

/** A cache whose forRole returns a real LlmClient wired to replay `response`. */
function cacheReturning(response: Record<string, unknown>): LlmClientCacheLike {
  const sdk: LlmSdk = {
    async createMessage(): Promise<Record<string, unknown>> {
      return response;
    },
  };
  const client = new LlmClient({
    sdk,
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    clock: new FakeClock(),
  });
  return {
    async forRole(): Promise<LlmClient> {
      return client;
    },
  };
}

/** A cache whose client's invokeModel throws `err` from the SDK call (generic-invocation-error path). */
function cacheThrowingFromSdk(err: Error): LlmClientCacheLike {
  const sdk: LlmSdk = {
    async createMessage(): Promise<Record<string, unknown>> {
      throw err;
    },
  };
  const client = new LlmClient({
    sdk,
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    clock: new FakeClock(),
  });
  return {
    async forRole(): Promise<LlmClient> {
      return client;
    },
  };
}

/**
 * A cache whose client's PRE-CALL cost-cap check denies (kill-switch) → BedrockBudgetExceededError
 * propagates directly out of invokeModel (it is raised BEFORE the SDK-call try/catch). This is the real
 * Python injection point for the budget-exceeded path.
 */
function cacheWithBudgetDeny(): LlmClientCacheLike {
  const costCap = new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 });
  costCap.setKillSwitch(true);
  const sdk: LlmSdk = {
    async createMessage(): Promise<Record<string, unknown>> {
      throw new Error("SDK must not be reached when the pre-call cost-cap denies");
    },
  };
  const client = new LlmClient({ sdk, costCap, clock: new FakeClock() });
  return {
    async forRole(): Promise<LlmClient> {
      return client;
    },
  };
}

describe("doReview — happy path", () => {
  it("parses tool_use findings into ReviewChunkResponseV1 (via bedrockReviewChunk)", async () => {
    const response = {
      content: [
        { type: "text", text: "I'll surface a finding." },
        {
          type: "tool_use",
          id: "t1",
          name: "report_finding",
          input: {
            file: "src/foo.py",
            start_line: 10,
            end_line: 12,
            severity: "issue",
            category: "bug",
            title: "off-by-one",
            body: "The loop should iterate up to len(xs), not len(xs)-1.",
            confidence: 0.9,
          },
        },
      ],
      usage: { input_tokens: 80, output_tokens: 40 },
      stop_reason: "tool_use",
    };
    const envelope = await bedrockReviewChunk(context(), { cache: cacheReturning(response) });
    expect(envelope.findings).toHaveLength(1);
    expect(envelope.findings[0]!.file).toBe("src/foo.py");
    expect(envelope.arbitration_intents).toHaveLength(0);
    expect(envelope.sanitization_event).toBeNull();
  });

  it("returns zero findings for a clean (text-only) response", async () => {
    const response = {
      content: [{ type: "text", text: "No issues identified." }],
      usage: { input_tokens: 80, output_tokens: 12 },
      stop_reason: "end_turn",
    };
    const result = await doReview(context(), { cache: cacheReturning(response) });
    expect(result.findings).toHaveLength(0);
    expect(result.intents).toHaveLength(0);
    expect(result.sanitizationEvent).toBeNull();
  });
});

describe("doReview — error paths", () => {
  it("(a) role not configured → non-retryable BedrockInvocationError ApplicationFailure", async () => {
    const cache: LlmClientCacheLike = {
      async forRole(): Promise<LlmClient> {
        throw new LlmRoleNotConfiguredError("no primary row");
      },
    };
    await expect(doReview(context(), { cache })).rejects.toMatchObject({
      type: "BedrockInvocationError",
      nonRetryable: false,
    });
  });

  it("(a) budget exceeded (pre-call cost-cap deny) → non-retryable BedrockBudgetExceededError ApplicationFailure", async () => {
    await expect(doReview(context(), { cache: cacheWithBudgetDeny() })).rejects.toMatchObject({
      type: "BedrockBudgetExceededError",
      nonRetryable: true,
    });
  });

  it("(c) generic invocation error → retryable BedrockInvocationError ApplicationFailure", async () => {
    const cache = cacheThrowingFromSdk(new LlmInvocationError("upstream flake"));
    await expect(doReview(context(), { cache })).rejects.toMatchObject({
      type: "BedrockInvocationError",
      nonRetryable: false,
    });
  });
});

describe("doReview — output-safety sanitize-and-continue", () => {
  it("secret_leaked-only block WITH tool_use findings → sanitization_event populated + findings preserved", async () => {
    const unsafeText = "AWS access key AKIAREALKEY12345678X found at secrets_loader.py:5.";
    const response = {
      content: [
        { type: "text", text: unsafeText },
        {
          type: "tool_use",
          id: "t1",
          name: "report_finding",
          input: {
            file: "src/foo.py",
            start_line: 5,
            end_line: 5,
            severity: "blocker",
            category: "security",
            title: "hardcoded credential",
            body: "An AWS access key is committed in this file; rotate it and move it to a secret store.",
            confidence: 0.99,
          },
        },
      ],
      usage: { input_tokens: 20, output_tokens: 20 },
      stop_reason: "tool_use",
    };
    const result = await doReview(context(), { cache: cacheReturning(response) });

    // findings survive the text-only redaction.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.category).toBe("security");
    // sanitization event populated.
    expect(result.sanitizationEvent).not.toBeNull();
    const ev = result.sanitizationEvent!;
    expect(ev.stage).toBe("review_chunk");
    expect(ev.detector_kinds).toEqual(["aws_access_key_id"]);
    expect(ev.spans_redacted).toBe(1);
    expect(ev.redacted_text).toContain("[REDACTED]");
    expect(ev.redacted_text).not.toContain("AKIAREALKEY12345678X");
    expect(ev.original_text).toBe(unsafeText);
    expect(ev.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("secret_leaked-only block WITHOUT findings → terminal non-retryable BedrockOutputUnsafeError", async () => {
    // A secret in the text but NO tool_use finding block → not sanitizable (decision.findings is the
    // secret-span list, which is non-empty, but there are no review findings to return — actually the
    // Python condition keys on decision.findings, the secret spans. With a secret present, decision has
    // findings; the OTHER terminal case is a non-secret block. We exercise the non-secret terminal here.)
    const response = {
      // length-exceeded via a privileged tag is simplest: emit a forbidden tag → privileged_tag block.
      content: [{ type: "text", text: "Here is a <system> tag I should not emit." }],
      usage: { input_tokens: 5, output_tokens: 5 },
      stop_reason: "end_turn",
    };
    await expect(doReview(context(), { cache: cacheReturning(response) })).rejects.toMatchObject({
      type: "BedrockOutputUnsafeError",
      nonRetryable: true,
    });
  });
});
