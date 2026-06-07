// In-process behavioral proof for OutboxDispatcherWorkflow: a `@temporalio/testing`
// TestWorkflowEnvironment (time-skipping, no external server) runs a real Worker that BUNDLES the
// workflow (this is also the sandbox-purity proof — a forbidden import would fail the bundle) + STUB
// activities. The singleton never returns, so we `start` it (not `execute`), wait until the first row is
// dispatched + marked, then `cancel` and assert the workflow ends cancelled.
//
// Gated behind CODEMASTER_TEST_TEMPORAL=1 (the env boots an ephemeral test server — heavier than a unit
// test), mirroring review_pipeline_composition.test.ts; validate-fast runs WITHOUT the flag → skipped.

import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OutboxRow } from "#backend/domain/repos/outbox_repo.js";

const RUN_TEMPORAL = process.env["CODEMASTER_TEST_TEMPORAL"] === "1";
const describeTemporal = RUN_TEMPORAL ? describe : describe.skip;

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await testEnv?.teardown();
});

/** One bootstrap-sink row (installation_id null → orphan_reason bootstrap_sink, no guard). */
function oneRow(): OutboxRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    sink: "sync_code_owners",
    payload: { a: 1 },
    schemaVersion: 2,
    attempts: 0,
    traceContext: {},
    runId: null,
    reviewId: null,
    provider: null,
    installationId: null,
  };
}

describeTemporal("OutboxDispatcherWorkflow (in-process TestWorkflowEnvironment)", () => {
  it("claims a batch, dispatches + marks each row in order, then is cancellable", async () => {
    const calls: Array<string> = [];
    let claimCount = 0;
    let resolveDrained!: () => void;
    const drained = new Promise<void>((r) => {
      resolveDrained = r;
    });

    const activities = {
      claimPendingRows: async (): Promise<Array<OutboxRow>> => {
        claimCount += 1;
        calls.push("claim");
        return claimCount === 1 ? [oneRow()] : []; // one batch, then idle
      },
      dispatchRow: async (): Promise<void> => {
        calls.push("dispatch");
      },
      markDispatched: async (): Promise<void> => {
        calls.push("markDispatched");
        resolveDrained();
      },
      markAttemptFailed: async (): Promise<void> => {
        calls.push("markAttemptFailed");
      },
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.namespace ?? "default",
      taskQueue: "outbox-dispatcher-test",
      workflowsPath: fileURLToPath(
        new URL("../../../apps/backend/src/workflows/outbox_dispatcher.workflow.ts", import.meta.url),
      ),
      dataConverter: {
        payloadConverterPath: fileURLToPath(
          new URL("../../../apps/backend/src/worker/data_converter.ts", import.meta.url),
        ),
      },
      activities,
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start("OutboxDispatcherWorkflow", {
        taskQueue: "outbox-dispatcher-test",
        workflowId: "outbox-dispatcher-test-singleton",
        args: [],
      });
      await drained; // the first row reached markDispatched
      await handle.cancel();
      // The singleton never returns on its own; result() rejects because we cancelled it.
      await expect(handle.result()).rejects.toThrow();
    });

    // The first batch drove claim → dispatch → markDispatched in order; the failure path never fired.
    expect(calls.slice(0, 3)).toEqual(["claim", "dispatch", "markDispatched"]);
    expect(calls).not.toContain("markAttemptFailed");
  }, 60_000);
});
