// Unit tests for ensureOutboxDispatcherSingleton — idempotent bootstrap of the dispatcher singleton.

import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";

import {
  OUTBOX_DISPATCHER_WORKFLOW_ID,
  OUTBOX_DISPATCHER_WORKFLOW_TYPE,
  ensureOutboxDispatcherSingleton,
} from "#backend/worker/outbox_dispatcher_singleton.js";

import type { Client } from "@temporalio/client";

function clientWithStart(start: (...a: Array<unknown>) => unknown): Client {
  return { workflow: { start } } as unknown as Client;
}

describe("ensureOutboxDispatcherSingleton", () => {
  it("starts the singleton under the fixed id + USE_EXISTING conflict policy", async () => {
    const start = vi.fn(async () => ({ firstExecutionRunId: "r" }));
    await ensureOutboxDispatcherSingleton(clientWithStart(start), { taskQueue: "outbox-dispatcher" });
    expect(start).toHaveBeenCalledWith(
      OUTBOX_DISPATCHER_WORKFLOW_TYPE,
      expect.objectContaining({
        workflowId: OUTBOX_DISPATCHER_WORKFLOW_ID,
        taskQueue: "outbox-dispatcher",
        workflowIdConflictPolicy: "USE_EXISTING",
        args: [],
      }),
    );
  });

  it("swallows WorkflowExecutionAlreadyStartedError (already running → no-op)", async () => {
    const start = vi.fn(async () => {
      throw new WorkflowExecutionAlreadyStartedError(
        "dup",
        OUTBOX_DISPATCHER_WORKFLOW_ID,
        OUTBOX_DISPATCHER_WORKFLOW_TYPE,
      );
    });
    await expect(
      ensureOutboxDispatcherSingleton(clientWithStart(start), { taskQueue: "q" }),
    ).resolves.toBeUndefined();
  });

  it("propagates any other error (fail-loud at boot)", async () => {
    const start = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(ensureOutboxDispatcherSingleton(clientWithStart(start), { taskQueue: "q" })).rejects.toThrow(
      "boom",
    );
  });
});
