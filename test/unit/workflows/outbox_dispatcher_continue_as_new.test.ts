// Source-inspection guard for OutboxDispatcherWorkflow (mirrors the frozen Python
// test_outbox_dispatcher_continue_as_new.py): the continue-as-new check MUST sit at the TOP of the while
// loop — before claimPendingRows and OUTSIDE the per-row for loop — so the workflow never
// continues-as-new mid-drain (BF-12: a half-processed batch must not be abandoned with in-flight leases).
// Plus a determinism guard (no setTimeout/Date/random in the sandbox body). The behavioral
// TestWorkflowEnvironment proof lives in test/integration/workflows/outbox_dispatcher.test.ts (gated).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  fileURLToPath(new URL("../../../apps/backend/src/workflows/outbox_dispatcher.workflow.ts", import.meta.url)),
  "utf-8",
);

describe("OutboxDispatcherWorkflow continue-as-new placement", () => {
  it("checks continueAsNewSuggested and calls continueAsNew() exactly once", () => {
    expect(SRC).toContain("continueAsNewSuggested");
    expect(SRC.split("continueAsNew()").length - 1).toBe(1);
  });

  it("calls continueAsNew BEFORE claimPendingRows and OUTSIDE the per-row for loop", () => {
    const canIdx = SRC.indexOf("continueAsNew()");
    const claimIdx = SRC.indexOf("claimPendingRows({");
    const forIdx = SRC.indexOf("for (const row");
    expect(canIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(-1);
    expect(forIdx).toBeGreaterThan(-1);
    // Continue-as-new is the FIRST thing in the loop body: before the claim, before the per-row loop.
    expect(canIdx).toBeLessThan(claimIdx);
    expect(canIdx).toBeLessThan(forIdx);
  });

  it("uses the durable workflow API only (no setTimeout / Date.now / Math.random / crypto)", () => {
    expect(SRC).toContain('from "@temporalio/workflow"');
    expect(SRC).not.toContain("setTimeout");
    expect(SRC).not.toMatch(/Date\.now|Math\.random|crypto\./);
  });
});
