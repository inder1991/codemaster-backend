// Idempotent bootstrap for the OutboxDispatcherWorkflow singleton (1:1 with the Python
// OUTBOX_DISPATCHER_WORKFLOW_ID + the start-idempotent helper). Lives OUTSIDE the workflow sandbox file —
// it uses `@temporalio/client` (not sandbox-safe) — so it can be called from the worker boot path.

import { type Client, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";

/** The fixed workflowId the singleton runs under — referenced by boot, ops scripts, and the smoke. */
export const OUTBOX_DISPATCHER_WORKFLOW_ID = "outbox-dispatcher-singleton";

/** The registered workflow TYPE — the exported function name in outbox_dispatcher.workflow.ts. */
export const OUTBOX_DISPATCHER_WORKFLOW_TYPE = "OutboxDispatcherWorkflow";

/**
 * Start the dispatcher singleton if it isn't already running. `USE_EXISTING` makes a concurrent boot a
 * no-op against the already-running execution (no throw); the explicit `WorkflowExecutionAlreadyStartedError`
 * catch covers the closed-then-reused race. Mirrors the Python fail-fast-on-unexpected, no-throw-on-running
 * semantics — callers wrap this in their own boot fail-open if they want the worker to come up regardless.
 */
export async function ensureOutboxDispatcherSingleton(
  client: Client,
  opts: { taskQueue: string },
): Promise<void> {
  try {
    await client.workflow.start(OUTBOX_DISPATCHER_WORKFLOW_TYPE, {
      workflowId: OUTBOX_DISPATCHER_WORKFLOW_ID,
      taskQueue: opts.taskQueue,
      workflowIdConflictPolicy: "USE_EXISTING",
      args: [],
    });
  } catch (e) {
    if (e instanceof WorkflowExecutionAlreadyStartedError) {
      return; // already running — the singleton is healthy
    }
    throw e;
  }
}
