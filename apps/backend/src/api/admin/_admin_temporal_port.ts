// Thin admin-facing wrapper over the existing TemporalClientPort. Admin write endpoints
// (knowledge proposal approve/reject; the 8 embedder reembed endpoints) dispatch/signal workflows
// synchronously from the HTTP handler. Bridges the small admin API onto the richer StartWorkflowCall.

import { type StartWorkflowCall, type TemporalClientPort } from "#backend/adapters/temporal_port.js";
import { type IdReusePolicy } from "#contracts/outbox_payloads.v1.js";

export interface AdminTemporalPort {
  dispatchWorkflow(a: {
    workflowType: string;
    workflowId: string;
    taskQueue: string;
    input: unknown;
    idReusePolicy?: IdReusePolicy;
  }): Promise<void>;
  signalWorkflow(a: {
    workflowId: string;
    signalName: string;
    input?: unknown;
  }): Promise<void>;
}

const NO_TIMEOUT_SECONDS = 0;

export function makeAdminTemporalPort(inner: TemporalClientPort): AdminTemporalPort {
  return {
    async dispatchWorkflow(a): Promise<void> {
      const call: StartWorkflowCall = {
        workflowType: a.workflowType,
        workflowId: a.workflowId,
        taskQueue: a.taskQueue,
        args: [a.input],
        executionTimeoutSeconds: NO_TIMEOUT_SECONDS,
        runTimeoutSeconds: NO_TIMEOUT_SECONDS,
        searchAttributes: {},
        idReusePolicy: a.idReusePolicy ?? "ALLOW_DUPLICATE",
        idConflictPolicy: "FAIL",
      };
      await inner.startWorkflow(call);
    },
    async signalWorkflow(a): Promise<void> {
      await inner.signalWorkflow({
        workflowId: a.workflowId,
        signalName: a.signalName,
        payload: (a.input ?? {}) as Record<string, unknown>,
      });
    },
  };
}
