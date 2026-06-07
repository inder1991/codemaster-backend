/**
 * Unit tests for the TS unified-diff hunk-range parser — the 1:1 port of
 * `codemaster/integrations/github/unified_diff_parser.py::parse_unified_diff_ranges`.
 *
 * Each case mirrors the frozen Python's
 * `tests/unit/integrations/github/test_unified_diff_parser.py` 1:1 (same patches, same expected
 * post-image ranges). The byte-significant behaviour: parse ONLY the `@@ -A[,B] +C[,D] @@` hunk
 * headers; `+C` (no comma) ⇒ count 1; `+C,0` (pure deletion) ⇒ dropped; output sorted by start.
 */

import { describe, it, expect } from "vitest";

import { parseUnifiedDiffRanges } from "#backend/integrations/github/unified_diff_parser.js";

describe("parseUnifiedDiffRanges — 1:1 with parse_unified_diff_ranges", () => {
  it("empty patch returns an empty array", () => {
    expect(parseUnifiedDiffRanges("")).toEqual([]);
  });

  it("single hunk added lines → one post-image range", () => {
    const patch = "@@ -9,0 +10,3 @@\n+new1\n+new2\n+new3\n";
    expect(parseUnifiedDiffRanges(patch)).toEqual([[10, 12]]);
  });

  it("single hunk modified lines → post-image span", () => {
    const patch =
      "@@ -20,5 +20,5 @@\n-old1\n-old2\n-old3\n-old4\n-old5\n+new1\n+new2\n+new3\n+new4\n+new5\n";
    expect(parseUnifiedDiffRanges(patch)).toEqual([[20, 24]]);
  });

  it("multiple hunks → multiple ranges in order", () => {
    const patch = "@@ -4,0 +5,3 @@\n+a\n+b\n+c\n@@ -29,0 +30,3 @@\n+d\n+e\n+f\n";
    expect(parseUnifiedDiffRanges(patch)).toEqual([
      [5, 7],
      [30, 32],
    ]);
  });

  it("context lines count toward the post-image span verbatim", () => {
    const patch =
      "@@ -50,3 +50,5 @@\n context1\n-removed\n context2\n+added1\n+added2\n context3\n";
    expect(parseUnifiedDiffRanges(patch)).toEqual([[50, 54]]);
  });

  it("pure-deletion hunk (+K,0) is omitted", () => {
    const patch = "@@ -100,3 +99,0 @@\n-x\n-y\n-z\n";
    expect(parseUnifiedDiffRanges(patch)).toEqual([]);
  });

  it("implicit count of one (+10 ≡ +10,1)", () => {
    const patch = "@@ -9,1 +10 @@\n-old\n+new\n";
    expect(parseUnifiedDiffRanges(patch)).toEqual([[10, 10]]);
  });

  it("malformed hunk header raises", () => {
    const patch = "@@ this is not a hunk header @@\n+x\n";
    expect(() => parseUnifiedDiffRanges(patch)).toThrow(/malformed hunk header/);
  });

  it("ranges are sorted by start line ascending", () => {
    const patch = "@@ -29,0 +30,3 @@\n+a\n+b\n+c\n@@ -4,0 +5,3 @@\n+d\n+e\n+f\n";
    expect(parseUnifiedDiffRanges(patch)).toEqual([
      [5, 7],
      [30, 32],
    ]);
  });

  it("no off-by-one on a single-line addition (+10,1 → [10, 10])", () => {
    const patch = "@@ -9,0 +10,1 @@\n+single\n";
    expect(parseUnifiedDiffRanges(patch)).toEqual([[10, 10]]);
  });
});
