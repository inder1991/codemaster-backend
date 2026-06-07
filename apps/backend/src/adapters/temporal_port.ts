// Temporal client adapter port — 1:1 port of vendor/codemaster-py/codemaster/adapters/temporal_port.py
// (Sprint 0 / S0.3c).
//
// Production code drives Temporal directly inside workflow definitions, but cross-cutting code that
// *triggers* workflows (ingest, the outbox `temporal_workflow_start` sink) goes through TemporalClientPort
// so unit tests can verify start-workflow calls without a real Temporal cluster. The real-SDK adapter
// (wrapping `@temporalio/client`) lands with the dispatcher worker-boot wiring; this module carries the
// port contract, the error taxonomy, and the in-memory RecordingTemporalClient used across tests.

import { type IdConflictPolicy, type IdReusePolicy } from "#contracts/outbox_payloads.v1.js";

/** A start-workflow invocation (Python `StartWorkflowCall`). camelCase — this is an internal adapter DTO,
 *  not a wire contract (the wire shape is TemporalWorkflowStartPayloadV1, which stays snake_case). */
export type StartWorkflowCall = {
  workflowType: string;
  workflowId: string;
  taskQueue: string;
  args: ReadonlyArray<unknown>;
  executionTimeoutSeconds: number;
  runTimeoutSeconds: number;
  searchAttributes: Record<string, unknown>;
  idReusePolicy: IdReusePolicy;
  idConflictPolicy: IdConflictPolicy;
};

/** The triggering surface cross-cutting code depends on (Python `TemporalClientPort` Protocol). */
export type TemporalClientPort = {
  /** Start a workflow. Returns the run_id. Idempotent w.r.t. `workflowId`. */
  startWorkflow(call: StartWorkflowCall): Promise<string>;
  /** Cancel a running workflow by ID. No-op if already finished / missing. */
  cancelWorkflow(args: { workflowId: string }): Promise<void>;
  /** Send a signal to a running workflow. */
  signalWorkflow(args: {
    workflowId: string;
    signalName: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
};

/** Base class for Temporal client failures (Python `TemporalError`). */
export class TemporalError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TemporalError";
  }
}

/** Temporal Server unreachable. The caller (dispatcher) treats this as retryable. */
export class TemporalConnectivityError extends TemporalError {
  public constructor(message: string) {
    super(message);
    this.name = "TemporalConnectivityError";
  }
}

/** Policy=REJECT_DUPLICATE and the workflow ID is already running. */
export class WorkflowAlreadyStarted extends TemporalError {
  public constructor(message: string) {
    super(message);
    this.name = "WorkflowAlreadyStarted";
  }
}

// === Recording implementation for tests (Python `RecordingTemporalClient`) ===

/** In-memory TemporalClientPort that records every call. Tests assert against `.calls` after the code
 *  under test runs; idempotency under ALLOW_DUPLICATE / REJECT_DUPLICATE is emulated. */
export class RecordingTemporalClient implements TemporalClientPort {
  public readonly calls: Array<StartWorkflowCall> = [];
  public readonly cancellations: Array<string> = [];
  public readonly signals: Array<[string, string, Record<string, unknown>]> = [];
  readonly #cancelledIds = new Set<string>();
  #unreachable = false;
  #runIdCounter = 0;

  public async startWorkflow(call: StartWorkflowCall): Promise<string> {
    if (this.#unreachable) {
      throw new TemporalConnectivityError("simulated connectivity failure");
    }
    // Idempotency emulation: a prior call with the same workflowId under REJECT_DUPLICATE is a conflict.
    const existing = this.calls.find((c) => c.workflowId === call.workflowId);
    if (existing !== undefined && call.idReusePolicy === "REJECT_DUPLICATE") {
      throw new WorkflowAlreadyStarted(call.workflowId);
    }
    this.calls.push(call);
    this.#runIdCounter += 1;
    return `run-${this.#runIdCounter}`;
  }

  public async cancelWorkflow(args: { workflowId: string }): Promise<void> {
    if (this.#unreachable) {
      throw new TemporalConnectivityError("simulated connectivity failure");
    }
    this.cancellations.push(args.workflowId);
    this.#cancelledIds.add(args.workflowId);
  }

  public async signalWorkflow(args: {
    workflowId: string;
    signalName: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (this.#unreachable) {
      throw new TemporalConnectivityError("simulated connectivity failure");
    }
    this.signals.push([args.workflowId, args.signalName, args.payload]);
  }

  // --- test-only API ---

  public simulateUnreachable(value = true): void {
    this.#unreachable = value;
  }

  public workflowCount(workflowId: string): number {
    return this.calls.filter((c) => c.workflowId === workflowId).length;
  }
}
