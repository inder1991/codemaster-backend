// Token-budget enforcement — 1:1 port of the frozen Python post-pass
// (vendor/codemaster-py/codemaster/chunking/token_budget.py).
//
// Post-pass over a chunker's output that splits any chunk whose `token_estimate` exceeds
// MAX_CHUNK_TOKENS at the line midpoint (approximate halving) until every output chunk fits the
// budget. Splits are DETERMINISTIC: same input → identical output across runs; output preserves the
// original chunk ordering; sub-chunks of a split source carry the same `chunk_kind` + `language` as
// the source, and their `chunk_id` is re-minted from the new (path, start, end, body) via the shared
// `computeChunkId` so chunk_id parity is preserved.
//
// LINE-BASED (ADR-0067 cond 5): the split slices the body BY LINES using the same Python
// `str.splitlines(keepends=True)` semantics the chunkers use — NO byte offsets. The midpoint is
// computed from the chunk's `end_line - start_line + 1` line span (NOT the rendered line array), so
// the (left_end, right_start) line numbers match the frozen Python byte-for-byte.

import { computeChunkId, DiffChunkV1 } from "#contracts/diff_chunking.v1.js";

/** Port of token_budget.py::MAX_CHUNK_TOKENS. */
export const MAX_CHUNK_TOKENS = 6_000;

// ── Python str.splitlines(keepends=True) ──────────────────────────────────────────────────────────
// Parity-critical: `_split_once` slices the body BY LINES, so the line array MUST be split exactly as
// the frozen Python `str.splitlines(keepends=True)`. Identical to the copy in treesitter_python.ts /
// treesitter_tsjs.ts (kept local so this post-pass module owns its own slicing; the production corpus
// is LF-only, but porting the full Unicode boundary set keeps arbitrary input byte-identical).
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
 *  \r\n treated as a single terminator. A trailing terminator does NOT yield an empty final element. */
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
      // eslint-disable-next-line security/detect-object-injection -- `end` is a bounded numeric loop index into a local array
      if (cp === 0x0d && end < chars.length && chars[end]!.codePointAt(0) === 0x0a) {
        end += 1; // \r\n is a single boundary
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

/** Port of token_budget.py::_ASCII_MAX — chars with codepoint > this are non-ASCII (R-18). */
const ASCII_MAX = 127;
/** Port of token_budget.py::_NON_ASCII_FACTOR_THRESHOLD — non-ASCII share above which the 2.5x
 *  tokenizer safety factor applies (R-18). */
const NON_ASCII_FACTOR_THRESHOLD = 0.1;
/** Port of the R-18 safety factor multiplier. */
const NON_ASCII_FACTOR = 2.5;

/**
 * Port of token_budget.py::estimate_tokens — 4-chars-per-token proxy with the R-18 non-ASCII safety
 * factor. Parity-critical arithmetic:
 *   - empty body → 1 (the Python `if not body: return 1`).
 *   - `non_ascii_share = (# codepoints with ord(c) > 127) / len(body)` over CODE POINTS (Python str
 *     length, NOT UTF-16 units) — `[...body]` iterates codepoints.
 *   - `factor = 2.5 if share > 0.1 else 1.0` (STRICT `>` — exactly 0.1 keeps factor 1.0).
 *   - `max(1, int(len/4 * factor))` — FLOAT division then FLOAT multiply then TRUNCATE toward zero
 *     (`int()` in Python ≡ `Math.trunc` on a non-negative). NOTE: this is NOT integer division;
 *     `int(25 * 2.5) = int(62.5) = 62`, so the order of operations matters for parity.
 */
export function estimateTokens(body: string): number {
  if (body === "") {
    return 1;
  }
  const codepoints = [...body];
  let nonAscii = 0;
  for (const ch of codepoints) {
    if (ch.codePointAt(0)! > ASCII_MAX) {
      nonAscii += 1;
    }
  }
  const share = nonAscii / codepoints.length;
  const factor = share > NON_ASCII_FACTOR_THRESHOLD ? NON_ASCII_FACTOR : 1.0;
  return Math.max(1, Math.trunc((codepoints.length / 4) * factor));
}

/**
 * Port of token_budget.py::_split_once — halve a chunk at the line midpoint.
 *
 * Returns `[chunk, chunk]` (the SAME object twice) as the can't-split sentinel when the chunk spans
 * fewer than 2 lines OR its rendered body has fewer than 2 lines — matching the Python `return chunk,
 * chunk`. Otherwise returns the two re-minted halves.
 *
 *   mid         = n_lines // 2                  (floor; Math.trunc on a non-negative)
 *   left_end    = start_line + mid - 1
 *   right_start = left_end + 1
 *   left_body   = "".join(lines[:mid])
 *   right_body  = "".join(lines[mid:])
 */
function splitOnce(chunk: DiffChunkV1): readonly [DiffChunkV1, DiffChunkV1] {
  const lines = splitlinesKeepends(chunk.body);
  const nLines = chunk.end_line - chunk.start_line + 1;
  if (nLines < 2 || lines.length < 2) {
    // Cannot split a single-line chunk — caller (enforceTokenBudget) handles this by no-oping.
    return [chunk, chunk];
  }

  const mid = Math.trunc(nLines / 2);
  const leftEnd = chunk.start_line + mid - 1;
  const rightStart = leftEnd + 1;
  const leftBody = lines.slice(0, mid).join("");
  const rightBody = lines.slice(mid).join("");

  const left = DiffChunkV1.parse({
    chunk_id: computeChunkId({
      path: chunk.path,
      start_line: chunk.start_line,
      end_line: leftEnd,
      body: leftBody,
    }),
    path: chunk.path,
    language: chunk.language,
    start_line: chunk.start_line,
    end_line: leftEnd,
    body: leftBody,
    chunk_kind: chunk.chunk_kind,
    token_estimate: estimateTokens(leftBody),
  });
  const right = DiffChunkV1.parse({
    chunk_id: computeChunkId({
      path: chunk.path,
      start_line: rightStart,
      end_line: chunk.end_line,
      body: rightBody,
    }),
    path: chunk.path,
    language: chunk.language,
    start_line: rightStart,
    end_line: chunk.end_line,
    body: rightBody,
    chunk_kind: chunk.chunk_kind,
    token_estimate: estimateTokens(rightBody),
  });
  return [left, right];
}

/**
 * Port of token_budget.py::enforce_token_budget — split oversized chunks at the line midpoint until
 * every chunk fits the budget. Returns a NEW array with the same ordering; chunks already within the
 * budget pass through unchanged (object identity preserved). Sub-chunks are processed in original
 * order (left before right) via a worklist that mirrors the Python `pending.insert(0, ...)` LIFO
 * front-insertion.
 *
 * @throws RangeError when `maxTokens <= 0` (mirrors the Python `ValueError`).
 */
export function enforceTokenBudget(
  chunks: ReadonlyArray<DiffChunkV1>,
  opts: { maxTokens?: number } = {},
): Array<DiffChunkV1> {
  const maxTokens = opts.maxTokens ?? MAX_CHUNK_TOKENS;
  if (maxTokens <= 0) {
    throw new RangeError("max_tokens must be positive");
  }

  const out: Array<DiffChunkV1> = [];
  const pending: Array<DiffChunkV1> = [...chunks];
  while (pending.length > 0) {
    const head = pending.shift()!;
    if (head.token_estimate <= maxTokens) {
      out.push(head);
      continue;
    }
    const [left, right] = splitOnce(head);
    if (left === head && right === head) {
      // Couldn't split further (single-line oversized chunk) — emit as-is, don't loop forever.
      out.push(head);
      continue;
    }
    // Process halves in original order: left first, then right (front-insert right, then left).
    pending.unshift(right);
    pending.unshift(left);
  }
  return out;
}
