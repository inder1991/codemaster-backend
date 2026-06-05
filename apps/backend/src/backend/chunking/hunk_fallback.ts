// HunkFallbackChunker — port of the frozen Python fallback chunker
// (vendor/codemaster-py/codemaster/chunking/hunk_fallback.py).
//
// ── NON-PARITY (best-effort) ────────────────────────────────────────────────────────────────────────
// This chunker is the routing FALLBACK for languages we have no tree-sitter grammar for (Go, Rust,
// YAML, Dockerfile, …). It is line-window-anchored, NOT AST-anchored, so it carries no AST-shape
// parity obligation against the Python reference the way the tree-sitter chunkers do. Its OUTPUT SHAPE
// (DiffChunkV1 fields, chunk_kind="hunk", the expand/merge/clamp arithmetic, the extension→language
// table) is nonetheless ported 1:1 so it composes identically with the post-passes (token budget /
// batcher) and the selector. The behavioral tests are marked NON-PARITY sanity checks.
//
// Emits one chunk per hunk range, expanded by `lineWindow` (default 20) on BOTH sides, clamped to the
// file boundaries; ranges whose expanded windows touch or overlap (`start <= prev_end + 1`) merge into
// one chunk. `chunk_kind` is always "hunk"; `language` comes from the small extension→label table
// (unknown extension → null). LINE-BASED (ADR-0067 cond 5): slices the body BY LINES, no byte offsets.

import { computeChunkId, DiffChunkV1 } from "#contracts/diff_chunking.v1.js";

import { DiffTooLargeError, type HunkRange, MAX_DIFF_LINES } from "./treesitter_python.js";

/** Port of hunk_fallback.py::_LANG_BY_EXT — extension → language label. */
const LANG_BY_EXT: Readonly<Record<string, string>> = {
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".md": "markdown",
  ".json": "json",
};

const NEWLINE_BYTE = 0x0a;

/** Port of chunker_port.py::_assert_diff_size. Counts newline BYTES (avoids decoding on the reject
 *  path); a body not ending in a newline still counts its final partial line. Local copy (the Python
 *  hunk_fallback imports this from chunker_port; the TS chunkers each keep their own copy). */
function assertDiffSize(body: Uint8Array): void {
  if (body.length === 0) {
    return;
  }
  let lineCount = 0;
  for (const b of body) {
    if (b === NEWLINE_BYTE) {
      lineCount += 1;
    }
  }
  if (body[body.length - 1] !== NEWLINE_BYTE) {
    lineCount += 1;
  }
  if (lineCount > MAX_DIFF_LINES) {
    throw new DiffTooLargeError({ line_count: lineCount });
  }
}

// ── Python str.splitlines(keepends=True) — identical copy to the chunkers (see token_budget.ts note).
const LINE_BOUNDARY_CODEPOINTS: ReadonlySet<number> = new Set([
  0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
]);

function splitlinesKeepends(text: string): Array<string> {
  const out: Array<string> = [];
  const chars = [...text];
  let lineStart = 0;
  let i = 0;
  while (i < chars.length) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded numeric loop index into a local array, not user input
    const cp = chars[i]!.codePointAt(0)!;
    if (LINE_BOUNDARY_CODEPOINTS.has(cp)) {
      let end = i + 1;
      // eslint-disable-next-line security/detect-object-injection -- `end` is a bounded numeric loop index into a local array
      if (cp === 0x0d && end < chars.length && chars[end]!.codePointAt(0) === 0x0a) {
        end += 1;
      }
      out.push(chars.slice(lineStart, end).join(""));
      lineStart = end;
      i = end;
      continue;
    }
    i += 1;
  }
  if (lineStart < chars.length) {
    out.push(chars.slice(lineStart).join(""));
  }
  return out;
}

/** Port of hunk_fallback.py::_estimate_tokens — `max(1, len(body) // 4)` (INTEGER floor division,
 *  NO non-ASCII factor; this is the simpler estimate the hunk fallback uses, matching the frozen
 *  Python). `len(body)` is the CODE-POINT length. */
function estimateTokens(body: string): number {
  return Math.max(1, Math.trunc([...body].length / 4));
}

/** Lowercased final extension including the dot, or "" — port of `Path(path).suffix.lower()`
 *  (leading-dot names and trailing-dot names have no suffix). */
function lowerSuffix(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot).toLowerCase();
}

/** Lowercased final path segment — port of `Path(path).name.lower()`. */
function lowerName(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  return name.toLowerCase();
}

/** Port of hunk_fallback.py::_language_for — Dockerfile by NAME, else the extension table (else null). */
function languageFor(path: string): string | null {
  const name = lowerName(path);
  if (name === "dockerfile" || name.startsWith("dockerfile.")) {
    return "dockerfile";
  }
  const ext = lowerSuffix(path);
  // eslint-disable-next-line security/detect-object-injection -- `ext` indexes a frozen const map; absence → undefined → null
  return LANG_BY_EXT[ext] ?? null;
}

/**
 * Port of HunkFallbackChunker. NON-PARITY best-effort fallback (see module header). Construct once at
 * worker boot (selector singleton); reuse across files.
 */
export class HunkFallbackChunker {
  private readonly lineWindow: number;

  constructor(opts: { lineWindow?: number } = {}) {
    const lineWindow = opts.lineWindow ?? 20;
    if (lineWindow < 0) {
      throw new RangeError("line_window must be non-negative");
    }
    this.lineWindow = lineWindow;
  }

  /**
   * Port of `chunk`. Emit one chunk per merged hunk range, line-window-expanded + clamped.
   *
   * @param path workspace-relative path; copied onto every chunk + drives the language label.
   * @param body raw file bytes; decoded UTF-8 with replacement (matches Python `decode(errors=replace)`).
   * @param hunkRanges inclusive 1-based (start, end) pairs of changed lines; EMPTY → no chunks (`()`).
   */
  async chunk(args: {
    path: string;
    body: Uint8Array;
    hunkRanges: ReadonlyArray<HunkRange>;
  }): Promise<Array<DiffChunkV1>> {
    const { path, body, hunkRanges } = args;
    assertDiffSize(body);
    if (hunkRanges.length === 0) {
      return [];
    }
    const decoded = new TextDecoder("utf-8").decode(body);
    const lines = splitlinesKeepends(decoded);
    const total = lines.length;
    if (total === 0) {
      return [];
    }

    // Validate + expand each hunk range, then sort (tuple sort: by start, then end).
    const expanded: Array<[number, number]> = [];
    for (const [hs, he] of hunkRanges) {
      if (hs > he) {
        throw new RangeError(`invalid hunk range: start ${hs} > end ${he}`);
      }
      const start = Math.max(1, hs - this.lineWindow);
      const end = Math.min(total, he + this.lineWindow);
      expanded.push([start, end]);
    }
    expanded.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));

    // Merge adjacent / overlapping expanded ranges (distance ≤ 0 → touch/overlap; `start <= prev+1`).
    const merged: Array<[number, number]> = [];
    for (const [start, end] of expanded) {
      const last = merged[merged.length - 1];
      if (last !== undefined && start <= last[1] + 1) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
    }

    const language = languageFor(path);
    const out: Array<DiffChunkV1> = [];
    for (const [start, end] of merged) {
      const sliceBody = lines.slice(start - 1, end).join("");
      out.push(
        DiffChunkV1.parse({
          chunk_id: computeChunkId({ path, start_line: start, end_line: end, body: sliceBody }),
          path,
          language,
          start_line: start,
          end_line: end,
          body: sliceBody,
          chunk_kind: "hunk",
          token_estimate: estimateTokens(sliceBody),
        }),
      );
    }
    return out;
  }
}
