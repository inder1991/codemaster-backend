import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { LoginRateLimiter } from "#backend/api/auth/rate_limit.js";

function makeLimiter(clock: FakeClock): LoginRateLimiter {
  // Production wiring: 10 attempts / 5-minute window / 5-minute cooldown.
  return new LoginRateLimiter({
    maxAttempts: 10,
    windowMs: 5 * 60 * 1000,
    lockoutMs: 5 * 60 * 1000,
    clock,
  });
}

describe("LoginRateLimiter (parity with rate_limit.py)", () => {
  it("validates constructor numerics", () => {
    const clock = new FakeClock();
    expect(() => new LoginRateLimiter({ maxAttempts: 0, windowMs: 1, lockoutMs: 1, clock })).toThrow();
    expect(() => new LoginRateLimiter({ maxAttempts: 1, windowMs: 0, lockoutMs: 1, clock })).toThrow();
    expect(() => new LoginRateLimiter({ maxAttempts: 1, windowMs: 1, lockoutMs: 0, clock })).toThrow();
  });

  it("allows up to max_attempts failures, then blocks", () => {
    const clock = new FakeClock({ now: new Date("2026-06-07T12:00:00Z") });
    const rl = makeLimiter(clock);
    for (let i = 0; i < 10; i++) {
      expect(rl.checkAllowed("1.2.3.4")).toBe(true);
      rl.recordFailure("1.2.3.4");
    }
    expect(rl.checkAllowed("1.2.3.4")).toBe(false);
  });

  it("isolates keys", () => {
    const clock = new FakeClock({ now: new Date("2026-06-07T12:00:00Z") });
    const rl = makeLimiter(clock);
    for (let i = 0; i < 10; i++) {
      rl.recordFailure("1.2.3.4");
    }
    expect(rl.checkAllowed("1.2.3.4")).toBe(false);
    expect(rl.checkAllowed("5.6.7.8")).toBe(true);
  });

  it("record_success clears the failure history", () => {
    const clock = new FakeClock({ now: new Date("2026-06-07T12:00:00Z") });
    const rl = makeLimiter(clock);
    for (let i = 0; i < 10; i++) {
      rl.recordFailure("1.2.3.4");
    }
    expect(rl.checkAllowed("1.2.3.4")).toBe(false);
    rl.recordSuccess("1.2.3.4");
    expect(rl.checkAllowed("1.2.3.4")).toBe(true);
  });

  it("ages failures out of the sliding window", () => {
    const clock = new FakeClock({ now: new Date("2026-06-07T12:00:00Z") });
    const rl = makeLimiter(clock);
    for (let i = 0; i < 10; i++) {
      rl.recordFailure("1.2.3.4");
    }
    expect(rl.checkAllowed("1.2.3.4")).toBe(false);
    // advance past the horizon (max(window, lockout) = 5min); failures age out.
    clock.advance({ seconds: 5 * 60 + 1 });
    expect(rl.checkAllowed("1.2.3.4")).toBe(true);
  });
});
