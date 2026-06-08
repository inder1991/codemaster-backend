// Unit tests for makeAdminTemporalPort — thin admin-facing wrapper over TemporalClientPort.
// RecordingTemporalClient stores startWorkflow calls in `.calls` and signals in `.signals`
// as [workflowId, signalName, payload] tuples.

import { describe, expect, it } from "vitest";
import { makeAdminTemporalPort } from "#backend/api/admin/_admin_temporal_port.js";
import { RecordingTemporalClient } from "#backend/adapters/temporal_port.js";

describe("makeAdminTemporalPort", () => {
  it("dispatchWorkflow maps to startWorkflow with [input] args + defaulted timeouts/policies", async () => {
    const inner = new RecordingTemporalClient();
    const port = makeAdminTemporalPort(inner);
    await port.dispatchWorkflow({
      workflowType: "reembedGeneration",
      workflowId: "reembed-generation-7",
      taskQueue: "embedder-maintenance",
      input: { schema_version: 1, generation_id: 7 },
      idReusePolicy: "REJECT_DUPLICATE",
    });
    expect(inner.calls).toHaveLength(1);
    const call = inner.calls[0]!;
    expect(call.workflowType).toBe("reembedGeneration");
    expect(call.workflowId).toBe("reembed-generation-7");
    expect(call.taskQueue).toBe("embedder-maintenance");
    expect(call.args).toEqual([{ schema_version: 1, generation_id: 7 }]);
    expect(call.idReusePolicy).toBe("REJECT_DUPLICATE");
    expect(call.searchAttributes).toEqual({});
  });

  it("signalWorkflow delegates to inner.signalWorkflow with payload=input", async () => {
    const inner = new RecordingTemporalClient();
    const port = makeAdminTemporalPort(inner);
    await port.signalWorkflow({
      workflowId: "wf-1",
      signalName: "approve",
      input: { approver: "u1" },
    });
    expect(inner.signals).toEqual([["wf-1", "approve", { approver: "u1" }]]);
  });
});
