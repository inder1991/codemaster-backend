// Per-IP login rate limiter — 1:1 port of codemaster/api/auth/rate_limit.py (Sprint Y.2, 2026-05-11).
//
// Defends against credential spraying (many usernames from one source) — account-level lockout misses this
// because each username only sees one failure. In-process `Map<key, Date[]>` sliding window; single-pod
// admin-api needs no cross-pod coordination (lifts cleanly to Postgres if we go multi-replica).
//
// Faithful divergence from the Python: no `threading.Lock`. Node's event loop runs each synchronous method
// to completion without preemption, so the Map mutations are already atomic (mirrors the FakeClock note —
// the lock guarded a concern that doesn't exist on a single-threaded runtime).

import type { Clock } from "#platform/clock.js";

export type LoginRateLimiterOptions = {
  maxAttempts: number;
  /** Sliding-window width in ms. */
  windowMs: number;
  /** Cooldown horizon in ms (kept for prune-horizon parity with the Python's `lockout` arg). */
  lockoutMs: number;
  clock: Clock;
}

/** Per-key sliding-window failure counter with cooldown. */
export class LoginRateLimiter {
  readonly #maxAttempts: number;
  readonly #windowMs: number;
  readonly #lockoutMs: number;
  readonly #clock: Clock;
  readonly #failures = new Map<string, Array<Date>>();

  public constructor(opts: LoginRateLimiterOptions) {
    if (opts.maxAttempts < 1) {
      throw new Error("max_attempts must be >= 1");
    }
    if (opts.windowMs <= 0) {
      throw new Error("window must be positive");
    }
    if (opts.lockoutMs <= 0) {
      throw new Error("lockout must be positive");
    }
    this.#maxAttempts = opts.maxAttempts;
    this.#windowMs = opts.windowMs;
    this.#lockoutMs = opts.lockoutMs;
    this.#clock = opts.clock;
  }

  /** True if a fresh attempt from `key` may proceed. */
  public checkAllowed(key: string): boolean {
    this.#prune(key);
    const count = this.#failures.get(key)?.length ?? 0;
    return count < this.#maxAttempts;
  }

  /** Record a failed authentication attempt for `key`. */
  public recordFailure(key: string): void {
    const bucket = this.#failures.get(key) ?? [];
    bucket.push(this.#clock.now());
    this.#failures.set(key, bucket);
    this.#prune(key);
  }

  /** Clear all failure history for `key` (legitimate auth). */
  public recordSuccess(key: string): void {
    this.#failures.delete(key);
  }

  /** Drop failures outside the relevant horizon (= max(window, lockout)); a failure ages out only when it
   *  can no longer count toward either the sliding-window threshold or an active cooldown. */
  #prune(key: string): void {
    const bucket = this.#failures.get(key);
    if (bucket === undefined || bucket.length === 0) {
      return;
    }
    const horizon = Math.max(this.#windowMs, this.#lockoutMs);
    const cutoff = this.#clock.now().getTime() - horizon;
    const kept = bucket.filter((ts) => ts.getTime() > cutoff);
    if (kept.length > 0) {
      this.#failures.set(key, kept);
    } else {
      this.#failures.delete(key);
    }
  }
}
