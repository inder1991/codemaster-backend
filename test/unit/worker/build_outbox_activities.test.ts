// Coverage test for buildOutboxActivities() — mirrors build_activities.test.ts: every name the
// OutboxDispatcherWorkflow's proxyActivities() expects MUST be registered (else ActivityNotRegistered at
// runtime), and every value is a single-arg activity function (invariant 11). Construction is cheap — the
// Kysely pool is lazy (no connection until a query), so a fake DSN suffices.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildOutboxActivities } from "#backend/worker/build_outbox_activities.js";

// The names the workflow's proxyActivities() bind to (outbox_dispatcher.workflow.ts).
const EXPECTED = ["claimPendingRows", "dispatchRow", "markDispatched", "markAttemptFailed"];
const PRIOR_DSN = process.env["CODEMASTER_PG_CORE_DSN"];

describe("buildOutboxActivities() composition root", () => {
  beforeAll(() => {
    process.env["CODEMASTER_PG_CORE_DSN"] =
      "postgresql://codemaster:codemaster@localhost:5433/codemaster_test";
  });
  afterAll(() => {
    if (PRIOR_DSN === undefined) {
      delete process.env["CODEMASTER_PG_CORE_DSN"];
    } else {
      process.env["CODEMASTER_PG_CORE_DSN"] = PRIOR_DSN;
    }
  });

  it("registers exactly the 4 dispatcher activities, each a single-arg function", () => {
    const acts = buildOutboxActivities();
    expect(Object.keys(acts).sort()).toEqual([...EXPECTED].sort());
    for (const [name, fn] of Object.entries(acts)) {
      expect(typeof fn, name).toBe("function");
      expect(fn.length, name).toBeLessThanOrEqual(1);
    }
  });

  it("throws a clear error when CODEMASTER_PG_CORE_DSN is unset", () => {
    const saved = process.env["CODEMASTER_PG_CORE_DSN"];
    delete process.env["CODEMASTER_PG_CORE_DSN"];
    try {
      expect(() => buildOutboxActivities()).toThrow(/CODEMASTER_PG_CORE_DSN/);
    } finally {
      process.env["CODEMASTER_PG_CORE_DSN"] = saved;
    }
  });
});
