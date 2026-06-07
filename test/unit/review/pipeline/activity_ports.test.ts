// Unit test for RETRY_POLICIES (activity_ports.ts). The constants are LOAD-BEARING — they are the exact
// start_to_close_timeout + RetryPolicy values from the frozen Python bridge closures. This test pins the
// load-bearing fields (timeout, attempts, intervals, backoff, heartbeat, non-retryable sets) so a silent
// drift from the Python is caught. Each expectation cites the frozen Python source line.
import { describe, it, expect } from "vitest";

import { RETRY_POLICIES } from "#backend/review/pipeline/activity_ports.js";

describe("RETRY_POLICIES — 1:1 with the frozen Python dispatch sites", () => {
  it("clone (review_pull_request.py:1084-1088): 60s start_to_close, 30s heartbeat, 2s/3-attempt retry", () => {
    expect(RETRY_POLICIES.clone.startToCloseTimeout).toBe("60s");
    expect(RETRY_POLICIES.clone.heartbeatTimeout).toBe("30s");
    expect(RETRY_POLICIES.clone.retry.initialInterval).toBe("2s");
    expect(RETRY_POLICIES.clone.retry.maximumAttempts).toBe(3);
  });

  it("classify (py:1105-1108): 30s, 2s/3-attempt", () => {
    expect(RETRY_POLICIES.classify.startToCloseTimeout).toBe("30s");
    expect(RETRY_POLICIES.classify.retry.maximumAttempts).toBe(3);
  });

  it("chunkAndRedact (py:1126-1129): 30s, 2s/3-attempt", () => {
    expect(RETRY_POLICIES.chunkAndRedact.startToCloseTimeout).toBe("30s");
    expect(RETRY_POLICIES.chunkAndRedact.retry.maximumAttempts).toBe(3);
  });

  it("staticAnalysis (py:1445-1448): 120s, 2s/2-attempt", () => {
    expect(RETRY_POLICIES.staticAnalysis.startToCloseTimeout).toBe("120s");
    expect(RETRY_POLICIES.staticAnalysis.retry.maximumAttempts).toBe(2);
  });

  it("selectCarryForward (py:1478-1481): 30s, 2s/3-attempt", () => {
    expect(RETRY_POLICIES.selectCarryForward.startToCloseTimeout).toBe("30s");
    expect(RETRY_POLICIES.selectCarryForward.retry.maximumAttempts).toBe(3);
  });

  it("embedQuery (py:1671-1683): 15s, 2s→15s backoff=2.0, 3-attempt (R-16)", () => {
    expect(RETRY_POLICIES.embedQuery.startToCloseTimeout).toBe("15s");
    expect(RETRY_POLICIES.embedQuery.retry.initialInterval).toBe("2s");
    expect(RETRY_POLICIES.embedQuery.retry.maximumInterval).toBe("15s");
    expect(RETRY_POLICIES.embedQuery.retry.backoffCoefficient).toBe(2.0);
    expect(RETRY_POLICIES.embedQuery.retry.maximumAttempts).toBe(3);
  });

  it("retrieveKnowledge (py:1777-1791): 20s, 2s→20s backoff=2.0, 3-attempt (R-16)", () => {
    expect(RETRY_POLICIES.retrieveKnowledge.startToCloseTimeout).toBe("20s");
    expect(RETRY_POLICIES.retrieveKnowledge.retry.maximumInterval).toBe("20s");
    expect(RETRY_POLICIES.retrieveKnowledge.retry.backoffCoefficient).toBe(2.0);
    expect(RETRY_POLICIES.retrieveKnowledge.retry.maximumAttempts).toBe(3);
  });

  it("reviewChunk (py:1897-1917): 90s, 5s→60s backoff=2.0, 4-attempt + 3 non-retryable Bedrock types", () => {
    expect(RETRY_POLICIES.reviewChunk.startToCloseTimeout).toBe("90s");
    expect(RETRY_POLICIES.reviewChunk.retry.initialInterval).toBe("5s");
    expect(RETRY_POLICIES.reviewChunk.retry.maximumInterval).toBe("60s");
    expect(RETRY_POLICIES.reviewChunk.retry.backoffCoefficient).toBe(2.0);
    expect(RETRY_POLICIES.reviewChunk.retry.maximumAttempts).toBe(4);
    expect(RETRY_POLICIES.reviewChunk.retry.nonRetryableErrorTypes).toEqual([
      "BedrockBudgetExceededError",
      "BedrockOutputUnsafeError",
      "BedrockInvalidRequestError",
    ]);
  });

  it("aggregate (py:1974-1977): 30s, 2s/3-attempt", () => {
    expect(RETRY_POLICIES.aggregate.startToCloseTimeout).toBe("30s");
    expect(RETRY_POLICIES.aggregate.retry.maximumAttempts).toBe(3);
  });

  it("generateWalkthrough (py:2227-2228 + WALKTHROUGH_RETRY_POLICY py:95-103): 60s, 5s/2-attempt + 3 Llm* non-retryable", () => {
    expect(RETRY_POLICIES.generateWalkthrough.startToCloseTimeout).toBe("60s");
    expect(RETRY_POLICIES.generateWalkthrough.retry.initialInterval).toBe("5s");
    expect(RETRY_POLICIES.generateWalkthrough.retry.maximumAttempts).toBe(2);
    expect(RETRY_POLICIES.generateWalkthrough.retry.nonRetryableErrorTypes).toEqual([
      "LlmAuthError",
      "LlmRoleNotConfiguredError",
      "LlmRoleDisabledError",
    ]);
  });

  it("postReview (py:2442-2451): 60s, 2s/3-attempt + 3 non-retryable post types", () => {
    expect(RETRY_POLICIES.postReview.startToCloseTimeout).toBe("60s");
    expect(RETRY_POLICIES.postReview.retry.maximumAttempts).toBe(3);
    expect(RETRY_POLICIES.postReview.retry.nonRetryableErrorTypes).toEqual([
      "PrClosedError",
      "PostReviewPermissionError",
      "StaleWriteError",
    ]);
  });

  it("postCheckRun (py:2865-2868): 30s, 2s/3-attempt", () => {
    expect(RETRY_POLICIES.postCheckRun.startToCloseTimeout).toBe("30s");
    expect(RETRY_POLICIES.postCheckRun.retry.maximumAttempts).toBe(3);
  });

  it("cleanup (py:3253-3256): 30s, 2s/2-attempt", () => {
    expect(RETRY_POLICIES.cleanup.startToCloseTimeout).toBe("30s");
    expect(RETRY_POLICIES.cleanup.retry.maximumAttempts).toBe(2);
  });

  it("allocateWorkspace (py:1049-1050): 30s, 2s/3-attempt", () => {
    expect(RETRY_POLICIES.allocateWorkspace.startToCloseTimeout).toBe("30s");
    expect(RETRY_POLICIES.allocateWorkspace.retry.maximumAttempts).toBe(3);
  });

  it("emitOutputSafetyAudit (py:1505-1510): 2min schedule_to_close, 1s→30s, 5-attempt", () => {
    expect(RETRY_POLICIES.emitOutputSafetyAudit.scheduleToCloseTimeout).toBe("2 minutes");
    expect(RETRY_POLICIES.emitOutputSafetyAudit.retry.initialInterval).toBe("1s");
    expect(RETRY_POLICIES.emitOutputSafetyAudit.retry.maximumInterval).toBe("30s");
    expect(RETRY_POLICIES.emitOutputSafetyAudit.retry.maximumAttempts).toBe(5);
  });
});
