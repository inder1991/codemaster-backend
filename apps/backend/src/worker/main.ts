/**
 * Worker bootstrap — the Temporal-TS review-pipeline SPINE worker. Brings up a single Temporal Worker that
 * registers the full review-pipeline activity surface ({@link buildActivities}) and serves the THIN spine
 * workflow (`review_pull_request.workflow`, which REPLACES the Phase-2.0 walking skeleton), wired with the
 * custom payload converter (`data_converter`).
 *
 * This is the foundational worker pattern the review pipeline reuses: NativeConnection → Worker.create
 * (with workflowsPath + activities + dataConverter) → worker.run.
 *
 * ## Isolation defaults (keep the spine OFF the real cluster's path)
 *
 * The defaults deliberately isolate this worker from production review workflows:
 *   - namespace  `dualrun`                      (env `TEMPORAL_NAMESPACE`)
 *   - taskQueue  `review-pull-request-dualrun`  (env `TEMPORAL_TASK_QUEUE`)
 *   - address    `localhost:7233`               (env `TEMPORAL_ADDRESS`)
 *   - tls        off unless `TEMPORAL_TLS=1`
 *
 * A dedicated namespace + dedicated task queue means a real worker never polls this queue and this worker
 * never polls a real queue — the spine worker cannot pick up (or be picked up by) live cluster traffic.
 * These defaults apply ONLY on a loopback address; against a real cluster (a non-loopback `TEMPORAL_ADDRESS`
 * or `NODE_ENV=production`) {@link resolveWorkerTemporalConfig} REQUIRES `TEMPORAL_NAMESPACE` +
 * `TEMPORAL_TASK_QUEUE` and fails boot otherwise (finding H) — a misconfigured prod deploy can't silently
 * poll the dualrun queue and process zero reviews.
 *
 * ## ESM ↔ CJS interop for `require.resolve`
 *
 * The package is `"type": "module"`, so there is NO ambient CommonJS `require` in this module — calling a
 * bare `require.resolve(...)` would be a `ReferenceError`. Temporal's `workflowsPath` and
 * `dataConverter.payloadConverterPath` both want a RESOLVED absolute module path (Temporal loads those
 * files itself — `workflowsPath` is webpack-bundled into the sandbox; `payloadConverterPath` is imported
 * into both threads). We therefore reconstruct `require.resolve` from the ESM entrypoint URL via
 * `createRequire(import.meta.url)` — the canonical Node ESM→CJS bridge — and resolve the two sibling
 * modules relative to THIS file. `createRequire` is bound to this module's URL, so the relative specifiers
 * resolve correctly whether the worker runs from `.ts` (tsx) or compiled `.js` (the resolver honours the
 * package `exports` / extension at runtime).
 */

import { createRequire } from "node:module";

import { NativeConnection, Worker } from "@temporalio/worker";

import { startupSelfCheck } from "../chunking/treesitter_loader.js";
import { buildActivities } from "./registry.js";
import { resolveWorkerTemporalConfig } from "./temporal_config.js";

/** ESM→CJS bridge: a `require` bound to THIS module's URL, so `require.resolve` works under ESM. */
const require_ = createRequire(import.meta.url);

/**
 * Bring up the spine worker and run it until shutdown. Connects a {@link NativeConnection}, creates a
 * {@link Worker} bound to the isolated namespace / task queue with the spine workflow + the full activity
 * surface + the custom payload converter, then blocks in `worker.run()` (resolves on graceful shutdown /
 * SIGINT-SIGTERM, which the SDK wires by default).
 *
 * `tls` is included in the connection options ONLY when `TEMPORAL_TLS=1` — under `exactOptionalPropertyTypes`
 * an explicit `tls: undefined` is a type error against the optional field, so we build the options object
 * conditionally rather than passing `undefined`.
 */
export async function runWorker(): Promise<void> {
  // Fail LOUD at worker boot if the vendored tree-sitter grammars are missing/corrupt (ADR-0067 cond 3,
  // SHA-256-verified). Without this, a missing .wasm would surface as a degraded review mid-flight (the
  // chunker falling back to hunk-mode) instead of a clear startup failure.
  await startupSelfCheck();

  // Production-misconfiguration guard (finding H): a real-cluster TEMPORAL_ADDRESS (or NODE_ENV=production)
  // without TEMPORAL_NAMESPACE + TEMPORAL_TASK_QUEUE fails boot LOUDLY here, rather than silently falling
  // back to the dualrun-isolated defaults and polling the wrong queue (processing zero reviews).
  const temporal = resolveWorkerTemporalConfig(process.env);
  const connection = await NativeConnection.connect(
    temporal.tls ? { address: temporal.address, tls: {} } : { address: temporal.address },
  );

  // Build the full review-pipeline activity surface via the composition root (real collaborators, every
  // activity curried/bound to a 1-arg Temporal activity, the ADR-0068 ledger wired into the LlmClientCache).
  // Constructed HERE (not at module load) so the env reads `buildActivities()` performs happen with the
  // worker's populated environment.
  const activities = buildActivities();

  const worker = await Worker.create({
    connection,
    namespace: temporal.namespace,
    taskQueue: temporal.taskQueue,
    // Stage 1 — the spine worker now serves the THIN review-pipeline workflow
    // (review_pull_request.workflow), which REPLACES the Phase-2.0 walking skeleton as the spine. The
    // skeleton workflow file stays importable for any test that still references it, but the worker no
    // longer registers it (a workflow bundle has one workflowsPath; the new spine is the live one).
    workflowsPath: require_.resolve("../workflows/review_pull_request.workflow"),
    activities,
    dataConverter: { payloadConverterPath: require_.resolve("./data_converter") },
  });

  await worker.run();
}

// Main-module entrypoint guard: when this file is executed directly (not imported), run the worker and
// fail loudly on any startup error. `process.argv[1]` is the entrypoint path; comparing the file:// URL
// of THIS module to it is the ESM analogue of `if __name__ == "__main__":`.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runWorker().catch((err: unknown) => {
    process.stderr.write(`[ERROR] review-pull-request worker failed: ${String(err)}\n`);
    process.exit(1);
  });
}
