import { describe, expect, it } from "vitest";

import { HunkFallbackChunker } from "#backend/chunking/hunk_fallback.js";
import { DiffTooLargeError, MAX_DIFF_LINES } from "#backend/chunking/treesitter_python.js";

// NON-PARITY sanity tests for the hunk fallback chunker. The fallback is line-window-anchored (NOT
// AST-anchored), so it carries no chunk-shape parity obligation against the Python tree-sitter
// reference — these assert the OUTPUT-SHAPE invariants (expand/merge/clamp arithmetic, the
// extension→language table, chunk_kind="hunk", empty-hunks → no chunks) that the post-passes + the
// composite activity rely on. The ported arithmetic mirrors the frozen hunk_fallback.py 1:1; if a
// future port introduces a parity oracle for this chunker, these become the seed cases.

const enc = new TextEncoder();

/** A file of `n` lines: "line 1\nline 2\n...\nline n\n". */
function lines(n: number): Uint8Array {
  return enc.encode(Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
}

describe("HunkFallbackChunker — NON-PARITY sanity", () => {
  it("returns no chunks for empty hunk ranges", async () => {
    const ch = new HunkFallbackChunker();
    expect(await ch.chunk({ path: "x.go", body: lines(30), hunkRanges: [] })).toEqual([]);
  });

  it("returns no chunks for an empty body", async () => {
    const ch = new HunkFallbackChunker();
    expect(await ch.chunk({ path: "x.go", body: enc.encode(""), hunkRanges: [[1, 1]] })).toEqual([]);
  });

  it("expands a single hunk by lineWindow on both sides, clamped to file bounds", async () => {
    const ch = new HunkFallbackChunker({ lineWindow: 2 });
    const out = await ch.chunk({ path: "x.go", body: lines(30), hunkRanges: [[10, 10]] });
    expect(out.length).toBe(1);
    expect([out[0]!.start_line, out[0]!.end_line]).toEqual([8, 12]);
    expect(out[0]!.chunk_kind).toBe("hunk");
    expect(out[0]!.language).toBe("go");
    // body is the sliced lines 8..12 (inclusive), keepends.
    expect(out[0]!.body).toBe("line 8\nline 9\nline 10\nline 11\nline 12\n");
  });

  it("clamps the expansion to line 1 / file end", async () => {
    const ch = new HunkFallbackChunker({ lineWindow: 20 });
    const out = await ch.chunk({ path: "x.go", body: lines(10), hunkRanges: [[5, 5]] });
    expect([out[0]!.start_line, out[0]!.end_line]).toEqual([1, 10]);
  });

  it("merges adjacent / overlapping expanded windows into one chunk", async () => {
    const ch = new HunkFallbackChunker({ lineWindow: 2 });
    // (5,5)→(3,7) and (8,8)→(6,10): 6 <= 7+1 → merge → (3,10); (20,20)→(18,22) stays separate.
    const out = await ch.chunk({
      path: "x.go",
      body: lines(30),
      hunkRanges: [[5, 5], [8, 8], [20, 20]],
    });
    expect(out.map((c) => [c.start_line, c.end_line])).toEqual([
      [3, 10],
      [18, 22],
    ]);
  });

  it("maps unknown extensions to language=null", async () => {
    const ch = new HunkFallbackChunker({ lineWindow: 1 });
    const out = await ch.chunk({ path: "weird.xyz", body: lines(5), hunkRanges: [[3, 3]] });
    expect(out[0]!.language).toBeNull();
  });

  it("recognizes Dockerfile by name (not extension)", async () => {
    const ch = new HunkFallbackChunker({ lineWindow: 1 });
    const out = await ch.chunk({ path: "Dockerfile", body: lines(5), hunkRanges: [[3, 3]] });
    expect(out[0]!.language).toBe("dockerfile");
    const out2 = await ch.chunk({ path: "Dockerfile.dev", body: lines(5), hunkRanges: [[3, 3]] });
    expect(out2[0]!.language).toBe("dockerfile");
  });

  it("maps known extensions case-insensitively (.GO → go, .YAML → yaml)", async () => {
    const ch = new HunkFallbackChunker({ lineWindow: 1 });
    expect((await ch.chunk({ path: "x.GO", body: lines(5), hunkRanges: [[3, 3]] }))[0]!.language).toBe(
      "go",
    );
    expect(
      (await ch.chunk({ path: "x.YAML", body: lines(5), hunkRanges: [[3, 3]] }))[0]!.language,
    ).toBe("yaml");
  });

  it("rejects an inverted hunk range (start > end)", async () => {
    const ch = new HunkFallbackChunker();
    await expect(
      ch.chunk({ path: "x.go", body: lines(10), hunkRanges: [[5, 3]] }),
    ).rejects.toThrow(/invalid hunk range/);
  });

  it("rejects a negative lineWindow at construction", () => {
    expect(() => new HunkFallbackChunker({ lineWindow: -1 })).toThrow();
  });

  it("raises DiffTooLargeError on an oversized body", async () => {
    const ch = new HunkFallbackChunker();
    const big = enc.encode("x\n".repeat(MAX_DIFF_LINES + 1));
    await expect(ch.chunk({ path: "x.go", body: big, hunkRanges: [[1, 1]] })).rejects.toBeInstanceOf(
      DiffTooLargeError,
    );
  });
});
