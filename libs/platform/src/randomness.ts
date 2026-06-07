/**
 * Randomness seam — 1:1 port of `codemaster/infra/randomness.py` (frozen Python, Sprint 0).
 *
 * Production code MUST NOT use `Math.random()` or call `node:crypto` random functions directly.
 * Use the injected {@link Random} seam instead. The CI gate `scripts/gates/check_clock_random.ts`
 * enforces this and allowlists THIS file as the one place `node:crypto` randomness is sanctioned
 * (mirroring the Python gate `scripts/no_wall_clock.py`).
 *
 * Why: deterministic, replayable tests. Jitter, eviction order, debounce, sample selection — all
 * need to be reproducible from a seed.
 *
 * Method-name mapping vs the Python `Random` Protocol (camelCase per TS style; everything else 1:1):
 *   Python `random`       -> `random`
 *   Python `uniform`      -> `uniform`
 *   Python `randint`      -> `randint`
 *   Python `choice`       -> `choice`
 *   Python `shuffle`      -> `shuffle`
 *   Python `token_bytes`  -> `tokenBytes`
 */

/* eslint-disable security/detect-object-injection --
 * The only computed index access here is the length-bounded Fisher-Yates swap in
 * `SystemRandom.shuffle`; indices are numeric loop/`randomInt` values into a local array, never
 * attacker-controlled object keys, so the rule's prototype-pollution threat model does not apply.
 */

import * as crypto from "node:crypto";

import { type Clock, WallClock } from "./clock.js";
import { Mt19937 } from "./_mt19937.js";

/** A randomness interface. Mirrors the Python `Random` Protocol (token_bytes -> tokenBytes). */
export type Random = {
  /** Uniform float in [0.0, 1.0). */
  random(): number;
  /** Uniform float in [a, b]. */
  uniform(a: number, b: number): number;
  /** Uniform integer in [a, b], inclusive. */
  randint(a: number, b: number): number;
  /** Pick one element. */
  choice<T>(seq: ReadonlyArray<T>): T;
  /** Shuffle in place. */
  shuffle<T>(seq: Array<T>): void;
  /** Cryptographically-random bytes (e.g., for nonces). */
  tokenBytes(n: number): Uint8Array;
};

// 2^53, the divisor that turns 53 random bits into a double in [0, 1) (matches genrand_res53).
const TWO_POW_53 = 9007199254740992.0;
const TWO_POW_26 = 67108864.0;

/**
 * Production implementation. Uses cryptographically-secure entropy (mirrors Python `SystemRandom` /
 * `secrets`). NOT seedable and NOT value-parity-checked — only range/structural behavior is defined,
 * because the entropy source is the OS CSPRNG. This is the ONLY class permitted to call
 * `node:crypto` random functions (the CI gate allowlists this file for exactly this reason).
 */
export class SystemRandom implements Random {
  public random(): number {
    // Build a 53-bit double the same way as genrand_res53, but from crypto words (top 27 + top 26).
    const a = crypto.randomBytes(4).readUInt32BE(0) >>> 5;
    const b = crypto.randomBytes(4).readUInt32BE(0) >>> 6;
    return (a * TWO_POW_26 + b) * (1.0 / TWO_POW_53);
  }

  public uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }

  public randint(a: number, b: number): number {
    // `crypto.randomInt(min, max)` is [min, max) — add 1 to make the upper bound inclusive.
    return crypto.randomInt(a, b + 1);
  }

  public choice<T>(seq: ReadonlyArray<T>): T {
    return seq[crypto.randomInt(0, seq.length)]!;
  }

  public shuffle<T>(seq: Array<T>): void {
    for (let i = seq.length - 1; i >= 1; i--) {
      const j = crypto.randomInt(0, i + 1);
      const tmp = seq[i]!;
      seq[i] = seq[j]!;
      seq[j] = tmp;
    }
  }

  public tokenBytes(n: number): Uint8Array {
    return new Uint8Array(crypto.randomBytes(n));
  }
}

/**
 * Test implementation with a deterministic seed. Bit-for-bit identical to CPython's
 * `random.Random(seed)` because it delegates to the {@link Mt19937} engine. Proven against the
 * live frozen Python by `test/parity/randomness.parity.test.ts`.
 *
 * @example
 * ```ts
 * const rand = new SeededRandom({ seed: 42 });
 * // ... deterministic, replayable outputs ...
 * ```
 */
export class SeededRandom implements Random {
  private readonly engine: Mt19937;

  public constructor({ seed }: { seed: number }) {
    this.engine = new Mt19937();
    this.engine.seed(seed);
  }

  public random(): number {
    return this.engine.randomDouble();
  }

  public uniform(a: number, b: number): number {
    return this.engine.uniform(a, b);
  }

  public randint(a: number, b: number): number {
    return this.engine.randint(a, b);
  }

  public choice<T>(seq: ReadonlyArray<T>): T {
    return this.engine.choice(seq);
  }

  public shuffle<T>(seq: Array<T>): void {
    this.engine.shuffle(seq);
  }

  public tokenBytes(n: number): Uint8Array {
    return this.engine.tokenBytes(n);
  }
}

// UUIDv7 minter -----------------------------------------------------------
//
// Phase 2 of the run_id execution-causality refactor. UUIDv7 is the encoding for `run_id`: a
// 48-bit Unix-ms timestamp prefix followed by the version nibble (0x7), 12 random bits, the
// variant bits (0b10), and 62 random bits. The timestamp prefix gives lexicographic time-ordering
// at ms resolution; the 74 random bits keep collisions astronomically unlikely.
//
// Reference: RFC 9562 §5.7.

const VERSION_7 = 0x7;
const VARIANT_RFC9562 = 0b10n;

/**
 * Return a UUIDv7 (RFC 9562 §5.7) as a canonical lowercase hyphenated string — timestamp-prefixed,
 * monotonically sortable.
 *
 * Layout:
 *   unix_ts_ms (48 bits) | ver (4 bits = 0x7) | rand_a (12 bits) |
 *   var (2 bits = 0b10)  | rand_b (62 bits)
 *
 * The 74 random bits use `node:crypto` (NOT the seeded engine), so two `uuid7()` values — even at
 * the same instant, even across the TS/Python impls — always differ BY DESIGN. `run_id` is
 * ephemeral execution identity and is parity-excluded by value; only the 48-bit timestamp prefix,
 * the version nibble, and the variant bits are deterministic/parity-checkable.
 *
 * Returns a lowercase hyphenated UUID string to match Python's `str(uuid.UUID(...))`.
 */
export function uuid7({ clock }: { clock?: Clock } = {}): string {
  const c = clock ?? new WallClock();
  const ms = Math.trunc(c.now().getTime()); // 48-bit Unix-ms timestamp prefix
  const tsHex = ms.toString(16).padStart(12, "0").slice(-12);

  // 16 bits = ver(4) + rand_a(12). Version nibble = 0x7.
  const randA = crypto.randomInt(0, 1 << 12);
  const verAndRandA = (VERSION_7 << 12) | randA;

  // 64 bits = var(2) + rand_b(62). Variant bits = 0b10. Use a BigInt so the width is exact.
  const randB = BigInt("0x" + crypto.randomBytes(8).toString("hex")) & ((1n << 62n) - 1n);
  const varAndRandB = (VARIANT_RFC9562 << 62n) | randB;

  const hex =
    tsHex +
    verAndRandA.toString(16).padStart(4, "0") +
    varAndRandB.toString(16).padStart(16, "0");

  // Format as canonical 8-4-4-4-12 (hyphenated, already lowercase).
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Return a UUIDv4 (RFC-4122) as a canonical lowercase hyphenated string. The 122 random bits come from the
 * injected {@link Random} seam (default {@link SystemRandom}) so callers stay off raw `node:crypto` /
 * `Math.random` per the clock/random gate. This is the canonical home for v4 minting (the inlined copies in
 * outbox_repo.ts / _workflow_events_repository.ts predate it; consolidate opportunistically).
 */
export function uuid4(rng: Pick<Random, "tokenBytes"> = new SystemRandom()): string {
  const b = Buffer.from(rng.tokenBytes(16));
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC-4122 variant (10xx)
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Return a UUIDv5 (RFC-4122 — SHA-1 of namespace-bytes ++ name-bytes) as a canonical lowercase hyphenated
 * string. DETERMINISTIC (no randomness — `node:crypto` hashing only), so the same `(namespace, name)`
 * always maps to the same UUID across replays and across the TS/Python impls (byte-for-byte parity). 1:1
 * with Python's `uuid.uuid5`.
 */
export function uuid5(namespaceHex: string, name: string): string {
  const nsBytes = Buffer.from(namespaceHex.replace(/-/g, ""), "hex"); // 16 namespace bytes
  const digest = crypto
    .createHash("sha1")
    .update(nsBytes)
    .update(Buffer.from(name, "utf-8"))
    .digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x50, 6); // version 5
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8); // RFC-4122 variant (10xx)
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
