// Unit tests for RealTemporalClient — the @temporalio/client adapter implementing TemporalClientPort.
// A fake Client captures the workflow.start options; the SDK error types drive the taxonomy mapping.

import { ServiceError, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";

import { RealTemporalClient } from "#backend/adapters/real_temporal_client.js";
import {
  type StartWorkflowCall,
  TemporalConnectivityError,
  WorkflowAlreadyStarted,
} from "#backend/adapters/temporal_port.js";

import type { Client } from "@temporalio/client";

const CALL: StartWorkflowCall = {
  workflowType: "reviewPullRequest",
  workflowId: "review/1/2/3",
  taskQueue: "review-q",
  args: [{ pr: 1 }],
  executionTimeoutSeconds: 900,
  runTimeoutSeconds: 600,
  searchAttributes: {},
  idReusePolicy: "ALLOW_DUPLICATE",
  idConflictPolicy: "TERMINATE_EXISTING",
};

function clientWithStart(start: (...a: Array<unknown>) => unknown): Client {
  return { workflow: { start, getHandle: vi.fn() } } as unknown as Client;
}

describe("RealTemporalClient.startWorkflow", () => {
  it("maps the call to workflow.start options (timeouts ×1000, identity policies) and returns firstExecutionRunId", async () => {
    const start = vi.fn(async () => ({ firstExecutionRunId: "run-xyz" }));
    const port = new RealTemporalClient(clientWithStart(start));

    const runId = await port.startWorkflow(CALL);
    expect(runId).toBe("run-xyz");
    expect(start).toHaveBeenCalledWith(
      "reviewPullRequest",
      expect.objectContaining({
        taskQueue: "review-q",
        workflowId: "review/1/2/3",
        args: [{ pr: 1 }],
        workflowExecutionTimeout: 900_000,
        workflowRunTimeout: 600_000,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        workflowIdConflictPolicy: "TERMINATE_EXISTING",
      }),
    );
    // searchAttributes (empty) is intentionally NOT forwarded (deprecated raw form).
    expect((start.mock.calls[0] as Array<unknown>)[1]).not.toHaveProperty("searchAttributes");
  });

  it("maps WorkflowExecutionAlreadyStartedError → WorkflowAlreadyStarted (permanent)", async () => {
    const start = vi.fn(async () => {
      throw new WorkflowExecutionAlreadyStartedError("dup", "review/1/2/3", "reviewPullRequest");
    });
    const port = new RealTemporalClient(clientWithStart(start));
    await expect(port.startWorkflow(CALL)).rejects.toBeInstanceOf(WorkflowAlreadyStarted);
  });

  it("maps a ServiceError → TemporalConnectivityError (retryable)", async () => {
    const start = vi.fn(async () => {
      throw new ServiceError("temporal unreachable");
    });
    const port = new RealTemporalClient(clientWithStart(start));
    await expect(port.startWorkflow(CALL)).rejects.toBeInstanceOf(TemporalConnectivityError);
  });
});
