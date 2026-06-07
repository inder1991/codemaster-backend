// Entrypoint for the outbox-dispatcher worker — a SEPARATE worker/bundle from the review-pipeline worker
// (main.ts). It bundles ONLY the OutboxDispatcherWorkflow on its own task queue, registers the 4 outbox
// activities, wires the (previously inert) temporal_workflow_start sink to a real client, and ensures the
// dispatcher singleton is running. Mirrors main.ts's NativeConnection → Worker.create → worker.run shape.
//
// Why a separate worker: a Temporal worker bundles ONE workflowsPath. The review worker bundles
// review_pull_request.workflow; the dispatcher needs its own bundle (outbox_dispatcher.workflow) on a
// distinct queue so review pollers never receive OutboxDispatcherWorkflow tasks they can't run.

import { createRequire } from "node:module";

import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

import { RealTemporalClient } from "#backend/adapters/real_temporal_client.js";
import { registerTemporalWorkflowStartSink } from "#backend/outbox/sinks/temporal_workflow_start.js";

import { buildOutboxActivities } from "./build_outbox_activities.js";
import { ensureOutboxDispatcherSingleton } from "./outbox_dispatcher_singleton.js";
import { resolveWorkerTemporalConfig } from "./temporal_config.js";

// createRequire bound to THIS module's URL so the relative specifiers resolve whether the worker runs from
// .ts (tsx) or compiled .js. Temporal loads workflowsPath/payloadConverterPath itself (absolute paths).
const require_ = createRequire(import.meta.url);

/** The dispatcher's own task queue (distinct from the review queue); env-overridable. */
function dispatcherTaskQueue(): string {
  const q = process.env["CODEMASTER_OUTBOX_TASK_QUEUE"];
  return q !== undefined && q !== "" ? q : "outbox-dispatcher";
}

/** Bring up the outbox-dispatcher worker + singleton and run until shutdown. */
export async function runOutboxDispatcherWorker(): Promise<void> {
  const temporal = resolveWorkerTemporalConfig(process.env);
  const taskQueue = dispatcherTaskQueue();
  const connectOpts = temporal.tls ? { address: temporal.address, tls: {} } : { address: temporal.address };

  // Worker connection (NativeConnection) — polls the dispatcher queue + runs the bundled workflow.
  const connection = await NativeConnection.connect(connectOpts);
  const activities = buildOutboxActivities();
  const worker = await Worker.create({
    connection,
    namespace: temporal.namespace,
    taskQueue,
    workflowsPath: require_.resolve("../workflows/outbox_dispatcher.workflow"),
    activities,
    dataConverter: { payloadConverterPath: require_.resolve("./data_converter") },
  });

  // Client connection (Connection — a distinct type from NativeConnection). The data converter MUST match
  // the worker's for wire byte-parity. Used for the sink's start_workflow calls + the singleton bootstrap.
  const clientConnection = await Connection.connect(connectOpts);
  const client = new Client({
    connection: clientConnection,
    namespace: temporal.namespace,
    dataConverter: { payloadConverterPath: require_.resolve("./data_converter") },
  });

  // Wire the previously-inert temporal_workflow_start sink to a REAL client (dispatched review rows now
  // actually start workflows), then ensure the singleton is running (self-heals across pod rolls).
  registerTemporalWorkflowStartSink(new RealTemporalClient(client));
  await ensureOutboxDispatcherSingleton(client, { taskQueue });

  await worker.run();
}

// Main-module entrypoint guard — run the worker and fail LOUD on any startup error (same idiom as main.ts).
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runOutboxDispatcherWorker().catch((err: unknown) => {
    process.stderr.write(
      `outbox-dispatcher worker FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
