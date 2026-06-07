// Tests for the uuid4 + uuid5 minters added to the randomness seam (the clock/random gate's allowlisted
// home for UUID minting, alongside uuid7). uuid5 parity is proven via derivePrId's golden vector
// (_pr_id.test.ts); here we cover uuid4's shape/determinism + uuid5's RFC test vector.

import { describe, expect, it } from "vitest";

import { type Random, uuid4, uuid5 } from "#platform/randomness.js";

/** A deterministic RNG returning fixed bytes — lets us assert uuid4 is a pure function of its RNG. */
function fixedRandom(fill: number): Pick<Random, "tokenBytes"> {
  return { tokenBytes: (n: number) => new Uint8Array(n).fill(fill) };
}

describe("uuid4", () => {
  it("mints an RFC-4122 v4 UUID (version nibble 4, variant 10xx)", () => {
    expect(uuid4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("is a pure function of its injected Random (same bytes → same UUID; sets version+variant bits)", () => {
    const a = uuid4(fixedRandom(0xab));
    const b = uuid4(fixedRandom(0xab));
    expect(a).toBe(b);
    // 0xab: byte[6] → (0x0b | 0x40)=0x4b (version 4); byte[8] → (0x2b | 0x80)=0xab (variant 10xx).
    expect(a).toBe("abababab-abab-4bab-abab-abababababab");
  });
});

describe("uuid5", () => {
  it("matches the canonical RFC-4122 v5 vector (DNS namespace, 'example.com')", () => {
    // uuid5(NAMESPACE_DNS, "example.com") — a widely-published v5 test vector.
    expect(uuid5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "example.com")).toBe(
      "cfbff0d1-9375-5685-968c-48ce8b15ae17",
    );
  });
});
