// `temporal_workflow_start` outbox sink — 1:1 port of
// vendor/codemaster-py/codemaster/activities/outbox_sinks/temporal_workflow_start.py (Sprint 0 / S0.3c).
//
// Triggered when ingest persists a webhook and needs to start a Temporal workflow. Wrapping the start in
// the outbox makes Temporal unavailability non-fatal: the row is durable, the dispatcher retries until
// Temporal recovers.
//
// Idempotency: the workflow ID is deterministic (e.g. `review/{installationId}/{repoId}/{prNumber}`); the
// default ALLOW_DUPLICATE reuse + TERMINATE_EXISTING conflict policy coalesces re-dispatch under retry to
// the same workflow (matches the per-PR mutex spec).
//
// Failure modes: Temporal unreachable → RetryableSinkError; WorkflowAlreadyStarted (only fires under
// REJECT_DUPLICATE) → PermanentSinkError; payload schema violation → PermanentSinkError.

import { TemporalWorkflowStartPayloadV1 } from "#contracts/outbox_payloads.v1.js";

import { OUTBOX_SINK_TEMPORAL_WORKFLOW_START } from "#backend/domain/repos/outbox_repo.js";
import {
  PermanentSinkError,
  RetryableSinkError,
  registerSink,
  type SinkHandler,
} from "#backend/outbox/sink_registry.js";

import {
  type StartWorkflowCall,
  type TemporalClientPort,
  TemporalConnectivityError,
  WorkflowAlreadyStarted,
} from "#backend/adapters/temporal_port.js";

/** The canonical sink name — the same string {@link OUTBOX_SINK_TEMPORAL_WORKFLOW_START} the repo writes. */
export const SINK_NAME = OUTBOX_SINK_TEMPORAL_WORKFLOW_START;

/** Build the sink handler bound to a {@link TemporalClientPort} (Python `make_handler`). */
export function makeTemporalWorkflowStartHandler(port: TemporalClientPort): SinkHandler {
  return async ({ payload }) => {
    let req: TemporalWorkflowStartPayloadV1;
    try {
      req = TemporalWorkflowStartPayloadV1.parse(payload);
    } catch (e) {
      throw new PermanentSinkError(`invalid payload: ${e instanceof Error ? e.message : String(e)}`);
    }

    const call: StartWorkflowCall = {
      workflowType: req.workflow_type,
      workflowId: req.workflow_id,
      taskQueue: req.task_queue,
      args: req.args,
      executionTimeoutSeconds: req.execution_timeout_seconds,
      runTimeoutSeconds: req.run_timeout_seconds,
      searchAttributes: req.search_attributes,
      idReusePolicy: req.id_reuse_policy,
      idConflictPolicy: req.id_conflict_policy,
    };

    try {
      await port.startWorkflow(call);
    } catch (e) {
      if (e instanceof WorkflowAlreadyStarted) {
        throw new PermanentSinkError(`workflow already started: ${e.message}`);
      }
      if (e instanceof TemporalConnectivityError) {
        throw new RetryableSinkError(`Temporal unreachable: ${e.message}`);
      }
      throw e;
    }
  };
}

/** Register the handler into the sink registry (called at worker boot — Python `register`). */
export function registerTemporalWorkflowStartSink(port: TemporalClientPort): void {
  registerSink(SINK_NAME, makeTemporalWorkflowStartHandler(port));
}
