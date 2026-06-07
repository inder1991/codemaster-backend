// Unit tests for the `temporal_workflow_start` outbox sink — 1:1 with
// vendor/codemaster-py/codemaster/activities/outbox_sinks/temporal_workflow_start.py.
//
// The sink validates the row payload against TemporalWorkflowStartPayloadV1, maps it to a
// StartWorkflowCall, and starts the workflow via the injected TemporalClientPort. Error mapping is the
// behaviour under test: invalid payload → PermanentSinkError; Temporal unreachable → RetryableSinkError;
// WorkflowAlreadyStarted (REJECT_DUPLICATE) → PermanentSinkError.

import { afterEach, describe, expect, it } from "vitest";

import {
  PermanentSinkError,
  RetryableSinkError,
  registeredSinks,
  resetRegistryForTesting,
  type SinkContext,
} from "#backend/outbox/sink_registry.js";
import {
  SINK_NAME,
  makeTemporalWorkflowStartHandler,
  registerTemporalWorkflowStartSink,
} from "#backend/outbox/sinks/temporal_workflow_start.js";

import { RecordingTemporalClient } from "#backend/adapters/temporal_port.js";

const ctx: SinkContext = { deliveryId: null, installationId: null, runId: null };

afterEach(() => {
  resetRegistryForTesting();
});

describe("temporal_workflow_start sink handler", () => {
  it("valid payload → maps to a StartWorkflowCall and starts the workflow (contract defaults applied)", async () => {
    const port = new RecordingTemporalClient();
    const handler = makeTemporalWorkflowStartHandler(port);

    await handler({
      payload: {
        workflow_type: "reviewPullRequest",
        workflow_id: "review/1/2/3",
        task_queue: "review-pull-request-dualrun",
        args: [{ pr: 1 }],
      },
      context: ctx,
    });

    expect(port.calls).toHaveLength(1);
    const call = port.calls[0]!;
    expect(call.workflowType).toBe("reviewPullRequest");
    expect(call.workflowId).toBe("review/1/2/3");
    expect(call.taskQueue).toBe("review-pull-request-dualrun");
    expect(call.args).toEqual([{ pr: 1 }]);
    // Defaults filled by TemporalWorkflowStartPayloadV1:
    expect(call.idReusePolicy).toBe("ALLOW_DUPLICATE");
    expect(call.idConflictPolicy).toBe("TERMINATE_EXISTING");
    expect(call.executionTimeoutSeconds).toBe(900);
    expect(call.runTimeoutSeconds).toBe(900);
  });

  it("invalid payload (missing workflow_id) → PermanentSinkError, no workflow started", async () => {
    const port = new RecordingTemporalClient();
    const handler = makeTemporalWorkflowStartHandler(port);

    await expect(
      handler({ payload: { workflow_type: "x", task_queue: "q" }, context: ctx }),
    ).rejects.toBeInstanceOf(PermanentSinkError);
    expect(port.calls).toHaveLength(0);
  });

  it("Temporal unreachable → RetryableSinkError (the dispatcher re-leases the row)", async () => {
    const port = new RecordingTemporalClient();
    port.simulateUnreachable();
    const handler = makeTemporalWorkflowStartHandler(port);

    await expect(
      handler({
        payload: { workflow_type: "x", workflow_id: "y", task_queue: "q" },
        context: ctx,
      }),
    ).rejects.toBeInstanceOf(RetryableSinkError);
  });

  it("WorkflowAlreadyStarted under REJECT_DUPLICATE re-dispatch → PermanentSinkError", async () => {
    const port = new RecordingTemporalClient();
    const handler = makeTemporalWorkflowStartHandler(port);
    const payload = {
      workflow_type: "x",
      workflow_id: "dup",
      task_queue: "q",
      id_reuse_policy: "REJECT_DUPLICATE",
    };

    await handler({ payload, context: ctx }); // first start succeeds
    await expect(handler({ payload, context: ctx })).rejects.toBeInstanceOf(PermanentSinkError);
    expect(port.calls).toHaveLength(1); // the second never recorded
  });

  it("registerTemporalWorkflowStartSink wires the handler under the canonical sink name", () => {
    const port = new RecordingTemporalClient();
    registerTemporalWorkflowStartSink(port);
    expect(registeredSinks()).toContain(SINK_NAME);
    expect(SINK_NAME).toBe("temporal_workflow_start");
  });
});
