import { describe, it, expect } from "vitest";

import { canonicalize } from "./canonical.js";

describe("canonicalize", () => {
  it("sorts object keys recursively and stringifies stably", () => {
    const a = canonicalize({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalize({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves Decimal-as-string (Pydantic emits Decimal as a string, not a number)", () => {
    expect(canonicalize({ cost: "1.50" })).toBe('{"cost":"1.50"}');
  });

  it("normalizes datetime instants to .ffffff+00:00 via string ops (mirrors the Python ref runner)", () => {
    // string-based (not JS Date), so microseconds survive; Z and +00:00 unify
    expect(canonicalize({ t: "2026-06-03T10:00:00Z" })).toBe('{"t":"2026-06-03T10:00:00.000000+00:00"}');
    expect(canonicalize({ t: "2026-06-03T10:00:00.123456Z" })).toBe('{"t":"2026-06-03T10:00:00.123456+00:00"}');
    expect(canonicalize({ t: "2026-06-03T10:00:00.5+00:00" })).toBe('{"t":"2026-06-03T10:00:00.500000+00:00"}');
  });

  it("throws on a bare float (contracts must emit Decimal-as-string or int)", () => {
    expect(() => canonicalize({ x: 1.5 })).toThrow(/bare float/);
  });

  it("allows integers", () => {
    expect(canonicalize({ n: 42 })).toBe('{"n":42}');
  });
});
