// TreeSitterPythonChunker — 1:1 port of the frozen Python chunker
// (vendor/codemaster-py/codemaster/chunking/treesitter_python.py).
//
// AST-aware chunker for Python. Emits one DiffChunkV1 per top-level def / async def / class /
// @decorated def. Methods live inside their class chunk. Files with no AST candidates fall back to a
// single module-level chunk; parse errors fall back to the same single chunk + WARN log. The chunker
// itself NEVER raises on unparseable input.
//
// LINE-BASED / encoding-agnostic (ADR-0067 cond 5): chunk spans derive from tree-sitter
// startPosition.row / endPosition.row (= Python node.start_point[0] / .end_point[0]) plus the
// endPosition.column===0 backup, and the body is sliced BY LINES (splitlines keepends). NO byte
// offsets, NO UTF-16↔UTF-8 mapping — rows + column-0 match the Python reference byte-for-byte.

import {
  computeChunkId,
  DiffChunkV1,
  type ChunkKind as DiffChunkKind,
} from "#contracts/diff_chunking.v1.js";

import { getParser } from "./treesitter_loader.js";

/** Inclusive 1-based (start_line, end_line) pair. Port of Python `HunkRange = tuple[int, int]`. */
export type HunkRange = readonly [number, number];

/** Port of chunker_port.py::MAX_DIFF_LINES. */
export const MAX_DIFF_LINES = 50_000;

/** Port of chunker_port.py::DiffTooLargeError. Carries the actual line count so callers can
 *  log / metric without re-counting. */
export class DiffTooLargeError extends Error {
  readonly line_count: number;
  constructor(args: { line_count: number }) {
    super(`diff exceeds MAX_DIFF_LINES=${MAX_DIFF_LINES}: got ${args.line_count} lines`);
    this.name = "DiffTooLargeError";
    this.line_count = args.line_count;
  }
}

const FUNCTION_NODE_TYPES: ReadonlySet<string> = new Set([
  "function_definition",
  "async_function_definition",
]);
const CLASS_NODE_TYPES: ReadonlySet<string> = new Set(["class_definition"]);

// Newline byte (0x0A). _assert_diff_size counts these to reject oversize diffs without decoding.
const NEWLINE_BYTE = 0x0a;

/** Port of chunker_port.py::_assert_diff_size. Counts newline BYTES (avoids decoding on the reject
 *  path); a body not ending in a newline still counts its final partial line. */
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

/** Port of treesitter_python.py::_overlaps. */
function overlaps(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA <= endB && endA >= startB;
}

/** Port of treesitter_python.py::_estimate_tokens — `max(1, len(body) // 4)`. `len(body)` is the
 *  CODE-POINT length (Python str length); `//` is floor division → Math.trunc on a non-negative. */
function estimateTokens(body: string): number {
  const codePointLen = [...body].length;
  return Math.max(1, Math.trunc(codePointLen / 4));
}

// ── Python str.splitlines(keepends=True) ──────────────────────────────────────────────────────────
// Parity-critical: the chunker slices lines[start-1:end] where start/end are tree-sitter rows, so the
// line array MUST be split exactly as the frozen Python str.splitlines(keepends=True). Python's line
// boundaries are the full Unicode set; \r\n is ONE boundary. We replicate that set verbatim. (The
// production corpus is LF-only, but porting the quirk keeps arbitrary input byte-identical.)
const LINE_BOUNDARY_CODEPOINTS: ReadonlySet<number> = new Set([
  0x0a, // \n  line feed
  0x0d, // \r  carriage return
  0x0b, // \v  line tabulation
  0x0c, // \f  form feed
  0x1c, // file separator
  0x1d, // group separator
  0x1e, // record separator
  0x85, // next line (NEL)
  0x2028, // line separator
  0x2029, // paragraph separator
]);

/** Port of Python `str.splitlines(keepends=True)`: split into lines INCLUDING their terminators, with
 *  \r\n treated as a single terminator. A trailing terminator does NOT yield an empty final element
 *  (matching Python). */
function splitlinesKeepends(text: string): Array<string> {
  const out: Array<string> = [];
  const chars = [...text]; // code-point iteration (matches Python str semantics)
  let lineStart = 0;
  let i = 0;
  while (i < chars.length) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded numeric loop index into a local array, not user input
    const cp = chars[i]!.codePointAt(0)!;
    if (LINE_BOUNDARY_CODEPOINTS.has(cp)) {
      let end = i + 1;
      // \r\n is a single boundary.
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

/** Minimal structural shape of the tree-sitter nodes this chunker reads (subset of the
 *  web-tree-sitter Node API; lets the candidate extractor be unit-tested without a live parser). */
type TsNode = {
  readonly type: string;
  readonly startPosition: { readonly row: number; readonly column: number };
  readonly endPosition: { readonly row: number; readonly column: number };
  readonly children: ReadonlyArray<TsNode | null>;
};

/**
 * Port of TreeSitterPythonChunker. The frozen class lazily caches a parser at class level; here the
 * loader (treesitter_loader.ts) owns the process-wide parser cache, so this chunker is a thin,
 * stateless adapter — construct once at worker boot, reuse across files (selector.py rationale).
 */
export class TreeSitterPythonChunker {
  /**
   * Port of `chunk`. Carve `body` into review-sized chunks anchored on changed lines.
   *
   * @param path workspace-relative path, copied verbatim onto every chunk for citation.
   * @param body raw file bytes; decoded UTF-8 with replacement (matches Python
   *   `body.decode("utf-8", errors="replace")`) for parsing + line-slicing.
   * @param hunkRanges inclusive 1-based (start, end) pairs of changed lines; empty → whole file.
   */
  async chunk(args: {
    path: string;
    body: Uint8Array;
    hunkRanges: ReadonlyArray<HunkRange>;
  }): Promise<Array<DiffChunkV1>> {
    const { path, body, hunkRanges } = args;
    assertDiffSize(body);
    // errors="replace": one U+FFFD per invalid byte, identical to Python bytes.decode(errors=replace).
    const decoded = new TextDecoder("utf-8").decode(body);
    if (decoded === "") {
      return [];
    }

    let root: TsNode;
    try {
      const parser = await getParser("python");
      const tree = parser.parse(decoded);
      if (tree === null) {
        return this.fallbackModule({ path, body: decoded, hunkRanges });
      }
      root = tree.rootNode as unknown as TsNode;
    } catch {
      // Defensive: tree-sitter parse failed → module fallback (the chunker never raises on input).
      return this.fallbackModule({ path, body: decoded, hunkRanges });
    }

    const candidates = this.extractCandidates({ root, body: decoded, path });

    if (candidates.length === 0) {
      return this.fallbackModule({ path, body: decoded, hunkRanges });
    }

    if (hunkRanges.length === 0) {
      return candidates;
    }

    const intersecting = candidates.filter((c) =>
      hunkRanges.some(([hs, he]) => overlaps(c.start_line, c.end_line, hs, he)),
    );
    if (intersecting.length === 0) {
      return this.fallbackModule({ path, body: decoded, hunkRanges });
    }
    return intersecting;
  }

  // ── candidate extraction ────────────────────────────────────────────────────────────────────
  /** Port of `_extract_candidates`. Walk `root.children`; emit one chunk per top-level def/class/
   *  decorated-def. The decorated unit's span includes the decorator line(s) (anchor = the
   *  decorated_definition node). */
  private extractCandidates(args: { root: TsNode; body: string; path: string }): Array<DiffChunkV1> {
    const { root, body, path } = args;
    const lines = splitlinesKeepends(body);
    const out: Array<DiffChunkV1> = [];
    for (const child of root.children) {
      if (child === null) {
        continue;
      }
      const node = child;
      let chunkKind: DiffChunkKind | null = null;
      let anchor: TsNode = node;

      if (node.type === "decorated_definition") {
        // The decorated unit's kind comes from its inner def/class node.
        const inner = node.children.find(
          (c): c is TsNode =>
            c !== null && (FUNCTION_NODE_TYPES.has(c.type) || CLASS_NODE_TYPES.has(c.type)),
        );
        if (inner === undefined) {
          continue;
        }
        chunkKind = CLASS_NODE_TYPES.has(inner.type) ? "class" : "function";
        anchor = node; // span includes the decorator line(s)
      } else if (FUNCTION_NODE_TYPES.has(node.type)) {
        chunkKind = "function";
      } else if (CLASS_NODE_TYPES.has(node.type)) {
        chunkKind = "class";
      }

      if (chunkKind === null) {
        continue;
      }

      const startLine = anchor.startPosition.row + 1;
      let endLine = anchor.endPosition.row + 1;
      // col-0 backup: a node ending at column 0 of a later row spans through the PRIOR line's
      // terminator; pull end_line back so the slice doesn't capture the next line.
      if (anchor.endPosition.column === 0 && endLine > startLine) {
        endLine -= 1;
      }
      const sliceBody = lines.slice(startLine - 1, endLine).join("");
      out.push(
        DiffChunkV1.parse({
          chunk_id: computeChunkId({
            path,
            start_line: startLine,
            end_line: endLine,
            body: sliceBody,
          }),
          path,
          language: "python",
          start_line: startLine,
          end_line: endLine,
          body: sliceBody,
          chunk_kind: chunkKind,
          token_estimate: estimateTokens(sliceBody),
        }),
      );
    }
    return out;
  }

  /** Port of `_fallback_module`: a single module-level chunk spanning the whole file, or — when hunk
   *  ranges are present — the clamped union window of the changed lines. */
  private fallbackModule(args: {
    path: string;
    body: string;
    hunkRanges: ReadonlyArray<HunkRange>;
  }): Array<DiffChunkV1> {
    const { path, body, hunkRanges } = args;
    if (body === "") {
      return [];
    }
    const lines = splitlinesKeepends(body);
    const total = lines.length;
    let start: number;
    let end: number;
    if (hunkRanges.length > 0) {
      start = Math.max(1, Math.min(...hunkRanges.map(([hs]) => hs)));
      end = Math.min(total, Math.max(...hunkRanges.map(([, he]) => he)));
      if (end < start) {
        end = start;
      }
    } else {
      start = 1;
      end = total;
    }
    const sliceBody = lines.slice(start - 1, end).join("");
    return [
      DiffChunkV1.parse({
        chunk_id: computeChunkId({ path, start_line: start, end_line: end, body: sliceBody }),
        path,
        language: "python",
        start_line: start,
        end_line: end,
        body: sliceBody,
        chunk_kind: "module",
        token_estimate: estimateTokens(sliceBody),
      }),
    ];
  }
}
