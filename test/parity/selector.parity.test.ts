import { afterAll, describe, expect, it } from "vitest";

import { pySelectForName, shutdownPostPassRef } from "./post_pass_oracle.js";
import {
  ChunkerRegistry,
  extractExtension,
} from "#backend/chunking/selector.js";
import { HunkFallbackChunker } from "#backend/chunking/hunk_fallback.js";
import { TreeSitterPythonChunker } from "#backend/chunking/treesitter_python.js";
import { TreeSitterTsJsChunker } from "#backend/chunking/treesitter_tsjs.js";

// Selector dispatch + extension-extraction parity against the frozen Python
// (selector.ChunkerRegistry.select_for → which chunker class) via run_post_pass_ref.py. The Python ref
// returns the chosen chunker's CLASS NAME; the TS side maps the returned instance to the same logical
// name, so a match proves both impls route every path to the SAME chunker (the load-bearing behavior).
// Extension-extraction edge cases (dotfiles, compound ext, case-insensitivity) are asserted directly
// against the frozen Python's routing through these same probe paths.

afterAll(() => shutdownPostPassRef());

const registry = ChunkerRegistry.build();

/** Map a selected TS chunker instance to the frozen Python class name. */
function tsSelectName(path: string): string {
  const chunker = registry.selectFor(path);
  if (chunker instanceof TreeSitterPythonChunker) return "TreeSitterPythonChunker";
  if (chunker instanceof TreeSitterTsJsChunker) return "TreeSitterTsJsChunker";
  if (chunker instanceof HunkFallbackChunker) return "HunkFallbackChunker";
  throw new Error("unknown chunker instance");
}

describe("ChunkerRegistry.selectFor parity — dispatch by extension", () => {
  // Spans every routing branch + the default-deny typos + dotfiles + compound-ext + casing + dirs.
  const PATHS = [
    // python
    "a.py",
    "pkg/mod.py",
    "a.b.PY", // case-insensitive, last-extension-only
    // ts/js
    "a.ts",
    "a.tsx",
    "a.js",
    "a.jsx",
    "a.mjs",
    "a.cjs",
    "src/deep/x.TS", // casing
    // fallback (default-deny on typos / unknown / extensionless / dotfiles)
    "a.py3",
    "a.coffee",
    "Makefile",
    "Dockerfile",
    ".gitignore", // dotfile → "" ext → fallback
    "x.tar.gz", // compound → ".gz" → fallback
    "noext",
    "a.go",
    "config.yaml",
    "weird.",
    "dir.py/notpython", // extensionless basename despite a dotted dir
  ];
  for (const path of PATHS) {
    it(`routes identically: ${path}`, async () => {
      expect(tsSelectName(path)).toBe(await pySelectForName(path));
    }, 30_000);
  }
});

describe("extractExtension — _extract_extension edge cases", () => {
  // Directly assert the TS extractor on the parity-significant edge cases. (The dispatch test above
  // already proves the routing these extensions drive matches the frozen Python.)
  const CASES: Array<[string, string]> = [
    ["a.py", ".py"],
    ["a.b.py", ".py"], // last extension only
    ["A.PY", ".py"], // lowercased
    [".gitignore", ""], // dotfile → no extension
    [".env.local", ".local"], // leading dot then a real extension
    ["Makefile", ""],
    ["x.tar.gz", ".gz"],
    ["noext", ""],
    ["weird.", "."], // trailing dot → "." (last_dot at len-1, but > 0)
    ["dir.d/file", ""], // slash after the dot → basename has no dot
    ["a\\b.TS", ".ts"], // backslash separator handled (Windows-style)
  ];
  for (const [path, expected] of CASES) {
    it(`extractExtension(${JSON.stringify(path)}) === ${JSON.stringify(expected)}`, () => {
      expect(extractExtension(path)).toBe(expected);
    });
  }
});

describe("ChunkerRegistry.build — singletons", () => {
  it("returns the SAME instance per selection (pre-constructed singletons)", () => {
    expect(registry.selectFor("a.py")).toBe(registry.selectFor("b.py"));
    expect(registry.selectFor("a.ts")).toBe(registry.selectFor("b.tsx"));
    expect(registry.selectFor("x.go")).toBe(registry.selectFor("y.rs"));
    expect(registry.python).toBeInstanceOf(TreeSitterPythonChunker);
    expect(registry.tsjs).toBeInstanceOf(TreeSitterTsJsChunker);
    expect(registry.fallback).toBeInstanceOf(HunkFallbackChunker);
  });
});
