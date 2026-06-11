// test/unit/runner/loop_health.test.ts
//
// CS3.1 (cutover-safety plan, finding CS3 — audit C5/H7/XH11/RT2): the LoopHealthRegistry the
// supervised runtime loops feed, so a DEAD REQUIRED LOOP becomes a queryable readiness signal.
// Pre-CS3.1 a crashed loop's only trace was the codemaster_runner_loop_crashed_total counter —
// a no-op meter when no MeterProvider is wired — and /readyz is hardcoded ready, so a pod whose
// runner/scheduler/outbox/review loop had died kept reporting ready forever (self-healing could
// structurally never trigger). Proves the registry contract the composition root threads into
// runSupervisedLoops:
//
//   (1) register() declares a REQUIRED loop, initially "up": 3 registered loops →
//       allRequiredUp() true; snapshot() shows each up with its registration instant;
//   (2) markDown() flips the aggregate: allRequiredUp() false + snapshot names the down loop
//       with the REASON and the transition instant (clock seam); the siblings stay up;
//   (3) an Error reason is normalized to `name: message` (the supervisor's crash path passes
//       the caught Error straight through);
//   (4) markUp() restores: allRequiredUp() true again, since = the recovery instant;
//   (5) FAIL-LOUD wiring: duplicate register() throws; markDown()/markUp() on an unregistered
//       loop throws (a typo'd name must not silently mint a health entry);
//   (6) an EMPTY registry is vacuously allRequiredUp() === true (required-ness is DECLARED by
//       register(), never assumed);
//   (7) snapshot() is a defensive copy — mutating the returned record never perturbs the
//       registry's own state.
//
// Pure unit — no DB, no timers; FakeClock pins every `since` instant exactly.

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { LoopHealthRegistry } from "#backend/runner/loop_health.js";

const T0 = new Date("2026-06-11T00:00:00.000Z");

function registryWithLoops(loops: ReadonlyArray<string>, clock: FakeClock): LoopHealthRegistry {
  const health = new LoopHealthRegistry({ clock });
  for (const loop of loops) {
    health.register(loop);
  }
  return health;
}

describe("LoopHealthRegistry — queryable loop liveness (CS3.1)", () => {
  it("(1) registered loops start 'up': allRequiredUp() true; snapshot carries the registration instant", () => {
    const clock = new FakeClock({ now: T0 });
    const health = registryWithLoops(["runner", "scheduler", "outbox"], clock);

    expect(health.allRequiredUp()).toBe(true);
    expect(health.snapshot()).toEqual({
      runner: { status: "up", since: T0 },
      scheduler: { status: "up", since: T0 },
      outbox: { status: "up", since: T0 },
    });
  });

  it("(2) markDown flips allRequiredUp() false; snapshot names the down loop + reason + transition instant; siblings stay up", () => {
    const clock = new FakeClock({ now: T0 });
    const health = registryWithLoops(["runner", "scheduler", "outbox"], clock);

    clock.advance({ seconds: 90 }); // the transition instant must come from the CLOCK SEAM, not wall time
    health.markDown("scheduler", "rigged: scheduler pass-level failure");

    expect(health.allRequiredUp()).toBe(false);
    expect(health.snapshot()).toEqual({
      runner: { status: "up", since: T0 },
      scheduler: {
        status: "down",
        reason: "rigged: scheduler pass-level failure",
        since: new Date("2026-06-11T00:01:30.000Z"),
      },
      outbox: { status: "up", since: T0 },
    });
  });

  it("(3) an Error reason is normalized to 'name: message' (the supervisor passes the caught Error)", () => {
    const clock = new FakeClock({ now: T0 });
    const health = registryWithLoops(["review"], clock);

    health.markDown("review", new TypeError("pool is not a function"));

    expect(health.snapshot()["review"]).toEqual({
      status: "down",
      reason: "TypeError: pool is not a function",
      since: T0,
    });
    expect(health.allRequiredUp()).toBe(false);
  });

  it("(4) markUp restores the loop: allRequiredUp() true again with the recovery instant", () => {
    const clock = new FakeClock({ now: T0 });
    const health = registryWithLoops(["runner", "outbox"], clock);

    health.markDown("outbox", "transient claim fault");
    expect(health.allRequiredUp()).toBe(false);

    clock.advance({ seconds: 30 });
    health.markUp("outbox");

    expect(health.allRequiredUp()).toBe(true);
    expect(health.snapshot()["outbox"]).toEqual({
      status: "up",
      since: new Date("2026-06-11T00:00:30.000Z"),
    });
  });

  it("(5a) duplicate register() throws naming the loop — double-wiring fails loud", () => {
    const clock = new FakeClock({ now: T0 });
    const health = registryWithLoops(["runner"], clock);

    expect(() => health.register("runner")).toThrowError(/runner.*already registered/);
  });

  it("(5b) markDown/markUp on an UNREGISTERED loop throws naming it — a typo'd name must not mint a health entry", () => {
    const clock = new FakeClock({ now: T0 });
    const health = registryWithLoops(["runner"], clock);

    expect(() => health.markDown("schedulr", "boom")).toThrowError(/schedulr.*not registered/);
    expect(() => health.markUp("schedulr")).toThrowError(/schedulr.*not registered/);
    expect(health.snapshot()).toEqual({ runner: { status: "up", since: T0 } });
  });

  it("(6) an empty registry is vacuously allRequiredUp() === true", () => {
    const health = new LoopHealthRegistry({ clock: new FakeClock({ now: T0 }) });
    expect(health.allRequiredUp()).toBe(true);
    expect(health.snapshot()).toEqual({});
  });

  it("(7) snapshot() is a defensive copy — mutating the returned record never perturbs the registry", () => {
    const clock = new FakeClock({ now: T0 });
    const health = registryWithLoops(["runner", "scheduler"], clock);

    const snap = health.snapshot();
    delete snap["runner"];
    snap["scheduler"] = { status: "down", reason: "mutated from outside", since: T0 };

    expect(health.allRequiredUp()).toBe(true);
    expect(health.snapshot()).toEqual({
      runner: { status: "up", since: T0 },
      scheduler: { status: "up", since: T0 },
    });
  });
});
