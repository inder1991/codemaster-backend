// Production TemporalClientPort adapter wrapping the real `@temporalio/client` Client (1:1 in intent with
// the Python adapters/temporal_sdk.py::TemporalSdkClient). Used by the outbox `temporal_workflow_start`
// sink to start workflows + by ensureOutboxDispatcherSingleton. The in-memory RecordingTemporalClient in
// temporal_port.ts stays the test double; THIS is the thing that talks to a real Temporal cluster.

import { type Client, ServiceError, WorkflowExecutionAlreadyStartedError, isGrpcServiceError } from "@temporalio/client";

import {
  type StartWorkflowCall,
  type TemporalClientPort,
  TemporalConnectivityError,
  WorkflowAlreadyStarted,
} from "./temporal_port.js";

/** gRPC status code NOT_FOUND — a cancel of an already-gone workflow is benign. */
const GRPC_NOT_FOUND = 5;

export class RealTemporalClient implements TemporalClientPort {
  readonly #client: Client;

  public constructor(client: Client) {
    this.#client = client;
  }

  public async startWorkflow(call: StartWorkflowCall): Promise<string> {
    try {
      const handle = await this.#client.workflow.start(call.workflowType, {
        taskQueue: call.taskQueue,
        workflowId: call.workflowId,
        args: [...call.args],
        // The SDK's Duration accepts a bare number as MILLISECONDS, so seconds × 1000.
        workflowExecutionTimeout: call.executionTimeoutSeconds * 1000,
        workflowRunTimeout: call.runTimeoutSeconds * 1000,
        // Identity mapping — StartWorkflowCall's policy strings ARE the SDK's WorkflowIdReusePolicy /
        // WorkflowIdConflictPolicy values (verified against @temporalio/common workflow-options.d.ts).
        workflowIdReusePolicy: call.idReusePolicy,
        workflowIdConflictPolicy: call.idConflictPolicy,
        // searchAttributes intentionally NOT forwarded — the raw form is deprecated in this SDK and the
        // outbox path never sets it (the payload default is {}). Wire typedSearchAttributes here if needed.
      });
      return handle.firstExecutionRunId;
    } catch (e) {
      throw this.#mapError(e, call.workflowId);
    }
  }

  public async cancelWorkflow(args: { workflowId: string }): Promise<void> {
    try {
      await this.#client.workflow.getHandle(args.workflowId).cancel();
    } catch (e) {
      // NOT_FOUND on cancel is benign (the workflow already finished / never existed).
      if (isGrpcServiceError(e) && (e as { code?: number }).code === GRPC_NOT_FOUND) {
        return;
      }
      throw this.#mapError(e, args.workflowId);
    }
  }

  public async signalWorkflow(args: {
    workflowId: string;
    signalName: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.#client.workflow.getHandle(args.workflowId).signal(args.signalName, args.payload);
    } catch (e) {
      throw this.#mapError(e, args.workflowId);
    }
  }

  /** Map SDK failures onto the port taxonomy: already-started → permanent; any gRPC/service error →
   *  retryable connectivity; everything else passes through unchanged. */
  #mapError(e: unknown, workflowId: string): Error {
    if (e instanceof WorkflowExecutionAlreadyStartedError) {
      return new WorkflowAlreadyStarted(workflowId);
    }
    if (e instanceof ServiceError || isGrpcServiceError(e)) {
      return new TemporalConnectivityError(e instanceof Error ? e.message : String(e));
    }
    return e instanceof Error ? e : new Error(String(e));
  }
}
