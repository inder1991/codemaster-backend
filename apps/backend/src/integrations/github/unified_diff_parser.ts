/**
 * Unified-diff range parser — 1:1 TypeScript port of the frozen Python
 * `vendor/codemaster-py/codemaster/integrations/github/unified_diff_parser.py` (F2 of the pr_files
 * wiring fix).
 *
 * Extracts post-image {@link HunkRange} tuples (1-based inclusive) from a GitHub PR file's `patch`
 * field. Pure function; no I/O. Consumed by `enrich_pr_files_activity` to assemble the
 * `changed_line_ranges` record the orchestrator passes to the chunker.
 *
 * We parse only the hunk headers (`@@ -A,B +C,D @@`) — line content is irrelevant for our purpose
 * (the chunker line-window-expands, so a narrow-to-changed-lines optimisation is wasted effort).
 *
 * Per unified-diff semantics (verbatim from the frozen source):
 *
 *   - `+C,D` declares the post-image hunk: starting at line C, spanning D lines.
 *   - `+C` (no comma) is equivalent to `+C,1`.
 *   - `+C,0` (pure deletion) contributes no post-image line and is dropped from the output.
 *
 * Output is sorted by start line ascending.
 *
 * Port fidelity notes vs the Python:
 *   - Python's `parse_unified_diff_ranges` raises `TypeError` when handed `None` (its callers guard
 *     `patch: str | None` at the boundary). In the TS port the field is statically typed `string`,
 *     so the `None`/`TypeError` branch is structurally unreachable and is intentionally omitted —
 *     callers thread `env.patch` only after a `patch !== null` guard (mirroring the Python activity's
 *     `if env.patch is None: continue`).
 *   - A malformed hunk header throws an `Error` whose message begins `malformed hunk header:` so the
 *     caller's fail-open guard at the activity boundary can convert it to "no ranges for this file".
 *     (Python raises `ValueError`; TS has no `ValueError` — `Error` is the faithful analogue and the
 *     activity catches it by message-prefix-free instanceof Error, exactly as Python catches it by
 *     `except ValueError`.)
 */

import { type HunkRange } from "#contracts/pr_files_enrichment.v1.js";

/**
 * Match `@@ -A[,B] +C[,D] @@` with capturing groups on the post-image start and (optional) count.
 * Byte-identical to the frozen Python `_HUNK_HEADER_RE` pattern.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- 1:1 port of the frozen `_HUNK_HEADER_RE`; anchored at `^`, every quantified group (`\d+`, `(?:,\d+)?`, the named `\d+` groups) is a single non-overlapping digit class that consumes ≥1 char per iteration, so there is no ambiguous/nested backtracking (heuristic false positive)
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(?<start>\d+)(?:,(?<count>\d+))? @@/;

/**
 * Error thrown for a hunk line that starts with `@@` but does not match the unified-diff hunk-header
 * grammar. The activity boundary catches it (any `instanceof Error`) and degrades to "no ranges for
 * this file". 1:1 with the Python `raise ValueError(f"malformed hunk header: {raw_line!r}")` — JS has
 * no `ValueError`, so a plain `Error` with the same message prefix is the faithful port.
 */
export class MalformedHunkHeaderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MalformedHunkHeaderError";
  }
}

/**
 * Return the post-image {@link HunkRange} tuples (sorted) for one file's unified-diff `patch` string.
 *
 * Empty string returns an empty array. Pure-deletion hunks (count = 0) are dropped. A malformed hunk
 * header throws {@link MalformedHunkHeaderError} so the caller's fail-open guard at the activity
 * boundary can convert it to "no ranges for this file". 1:1 with `parse_unified_diff_ranges`.
 */
export function parseUnifiedDiffRanges(patch: string): Array<HunkRange> {
  if (patch === "") {
    return [];
  }

  const ranges: Array<HunkRange> = [];
  // Python `str.splitlines()` splits on \n (and other Unicode line boundaries) WITHOUT a trailing
  // empty element. JS `split("\n")` yields a trailing "" for a trailing newline, but those empty /
  // non-"@@" lines are skipped by the `startsWith("@@")` guard below — so the behaviour matches for
  // the hunk-header lines we actually parse.
  for (const rawLine of patch.split("\n")) {
    if (!rawLine.startsWith("@@")) {
      continue;
    }
    const match = HUNK_HEADER_RE.exec(rawLine);
    if (match === null || match.groups === undefined) {
      // Mirror Python `f"malformed hunk header: {raw_line!r}"` — the repr quotes the line.
      throw new MalformedHunkHeaderError(`malformed hunk header: ${JSON.stringify(rawLine)}`);
    }
    const start = Number.parseInt(match.groups["start"]!, 10);
    const countRaw = match.groups["count"];
    const count = countRaw !== undefined ? Number.parseInt(countRaw, 10) : 1;
    if (count === 0) {
      continue;
    }
    const end = start + count - 1;
    ranges.push([start, end]);
  }

  // Sort by start ascending (tuple comparison in Python sorts by first then second element; the start
  // line is unique per hunk in a well-formed diff, so sorting by start alone is faithful — but we
  // compare the full tuple to match Python's `ranges.sort()` total order exactly).
  ranges.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  return ranges;
}
