// Unit tests for the worker Temporal-config resolver + its production-misconfiguration guard (finding H).
// The worker defaults to the dualrun-isolated namespace/queue (safe for dev / the dual-run), but those
// defaults must NEVER apply against a real cluster — there they would silently poll the wrong queue and
// process zero reviews. The guard fails boot loudly instead.

import { describe, expect, it } from "vitest";

import { resolveWorkerTemporalConfig } from "#backend/worker/temporal_config.js";

describe("resolveWorkerTemporalConfig", () => {
  it("loopback address + no overrides → the dualrun-isolated defaults (dev / dual-run)", () => {
    const cfg = resolveWorkerTemporalConfig({});
    expect(cfg.address).toBe("localhost:7233");
    expect(cfg.namespace).toBe("dualrun");
    expect(cfg.taskQueue).toBe("review-pull-request-dualrun");
    expect(cfg.tls).toBe(false);
  });

  it("explicit localhost address still allows the defaults", () => {
    const cfg = resolveWorkerTemporalConfig({ TEMPORAL_ADDRESS: "127.0.0.1:7233" });
    expect(cfg.namespace).toBe("dualrun");
  });

  it("REAL (non-loopback) cluster address WITHOUT namespace/queue → throws (no silent dualrun poll)", () => {
    expect(() =>
      resolveWorkerTemporalConfig({ TEMPORAL_ADDRESS: "temporal.prod.svc:7233" }),
    ).toThrow(/TEMPORAL_NAMESPACE.*TEMPORAL_TASK_QUEUE|real cluster/);
  });

  it("REAL cluster address WITH both namespace + queue → returns them (TLS honored)", () => {
    const cfg = resolveWorkerTemporalConfig({
      TEMPORAL_ADDRESS: "temporal.prod.svc:7233",
      TEMPORAL_NAMESPACE: "codemaster",
      TEMPORAL_TASK_QUEUE: "review-pull-request",
      TEMPORAL_TLS: "1",
    });
    expect(cfg.address).toBe("temporal.prod.svc:7233");
    expect(cfg.namespace).toBe("codemaster");
    expect(cfg.taskQueue).toBe("review-pull-request");
    expect(cfg.tls).toBe(true);
  });

  it("NODE_ENV=production also triggers the guard even on a loopback address", () => {
    expect(() =>
      resolveWorkerTemporalConfig({ NODE_ENV: "production" }),
    ).toThrow(/real cluster|TEMPORAL_NAMESPACE/);
  });

  it("an empty-string namespace counts as unset (not a valid explicit value)", () => {
    expect(() =>
      resolveWorkerTemporalConfig({
        TEMPORAL_ADDRESS: "temporal.prod.svc:7233",
        TEMPORAL_NAMESPACE: "",
        TEMPORAL_TASK_QUEUE: "review-pull-request",
      }),
    ).toThrow();
  });
});
