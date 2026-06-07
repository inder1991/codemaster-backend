import { describe, expect, it } from "vitest";

import {
  LOCKOUT_DURATION_MS,
  LOCKOUT_THRESHOLD,
  type LockoutState,
  applyAttempt,
  isLocked,
} from "#backend/api/auth/credential_lockout.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const FRESH: LockoutState = { failed_attempts: 0, locked_until: null, last_login_at: null };

describe("credential_lockout (parity with credential_lockout.py)", () => {
  it("anchors the documented numerics (5 failures / 15min)", () => {
    expect(LOCKOUT_THRESHOLD).toBe(5);
    expect(LOCKOUT_DURATION_MS).toBe(15 * 60 * 1000);
  });

  it("success resets attempts, clears lockout, sets last_login_at", () => {
    const locked: LockoutState = {
      failed_attempts: 9,
      locked_until: new Date("2030-01-01T00:00:00Z"),
      last_login_at: null,
    };
    const next = applyAttempt(locked, { success: true, now: NOW });
    expect(next).toEqual({ failed_attempts: 0, locked_until: null, last_login_at: NOW });
  });

  it("failure below threshold increments and preserves locked_until", () => {
    let s = FRESH;
    for (let i = 1; i < LOCKOUT_THRESHOLD; i++) {
      s = applyAttempt(s, { success: false, now: NOW });
      expect(s.failed_attempts).toBe(i);
      expect(s.locked_until).toBeNull();
    }
  });

  it("sets the lockout window ONLY on the exact threshold transition", () => {
    let s = FRESH;
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
      s = applyAttempt(s, { success: false, now: NOW });
    }
    expect(s.failed_attempts).toBe(LOCKOUT_THRESHOLD - 1);
    const atThreshold = applyAttempt(s, { success: false, now: NOW });
    expect(atThreshold.failed_attempts).toBe(LOCKOUT_THRESHOLD);
    expect(atThreshold.locked_until?.getTime()).toBe(NOW.getTime() + LOCKOUT_DURATION_MS);
  });

  it("does NOT re-extend locked_until on failures past threshold (anti-DoS bug fix)", () => {
    const lockedAt = new Date(NOW.getTime() + LOCKOUT_DURATION_MS);
    const atThreshold: LockoutState = {
      failed_attempts: LOCKOUT_THRESHOLD,
      locked_until: lockedAt,
      last_login_at: null,
    };
    const later = new Date(NOW.getTime() + 60_000);
    const next = applyAttempt(atThreshold, { success: false, now: later });
    expect(next.failed_attempts).toBe(LOCKOUT_THRESHOLD + 1);
    expect(next.locked_until?.getTime()).toBe(lockedAt.getTime()); // unchanged, NOT later + duration
  });

  it("isLocked uses strict-greater-than (boundary == now is expired)", () => {
    expect(isLocked(null, NOW)).toBe(false);
    expect(isLocked(new Date(NOW.getTime() + 1), NOW)).toBe(true);
    expect(isLocked(NOW, NOW)).toBe(false);
    expect(isLocked(new Date(NOW.getTime() - 1), NOW)).toBe(false);
  });
});
