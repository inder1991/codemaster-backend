/**
 * `selectCarryForward` activity — port of the frozen Python
 * vendor/codemaster-py/codemaster/review/carry_forward.py (`CarryForwardActivity.select_carry_forward`
 * + `_do_select`, Sprint 8 / S8.4.1b).
 *
 * Decides which parent-review findings carry forward unchanged into the current review and which chunks
 * need fresh LLM analysis. The selector is PURE deterministic line-range-overlap selection over its
 * inputs — no clock, no random, no DB, no LLM — so it is replay-safe by construction and a byte-for-byte
 * parity target against the frozen Python (proven in test/parity/carry_forward.parity.test.ts).
 *
 * ## Rule (1:1 with the frozen Python)
 *
 *   - A finding `(file, start_line, end_line)` carries forward IFF its line range does NOT intersect any
 *     change in `changed_line_ranges[file]`.
 *   - A chunk goes to `to_review` IFF its line range intersects any change in
 *     `changed_line_ranges[chunk.path]`. A chunk whose file is ABSENT from `changed_line_ranges` is
 *     treated as fully changed (renamed / new-path case) → reviewed.
 *   - A file PRESENT in `changed_line_ranges` with an EMPTY range array is treated as no-change for that
 *     file (chunks skipped, findings carried).
 *
 * Intersection is INCLUSIVE on both ends (`a_start <= b_end && a_end >= b_start`), so an exact-boundary
 * touch (e.g. finding [10,20] vs change [20,30]) counts as overlap — matching the frozen Python.
 *
 * Input/output ORDER is preserved: `carried` follows `parent_findings` order; `to_review` follows
 * `current_chunks` order (the Python builds both lists by a single forward pass).
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The frozen Python activity dispatches with FOUR positional arguments
 * (`select_carry_forward(parent_findings, current_chunks, changed_line_ranges, parent_review_id)`),
 * which violates invariant 11 ("every Temporal activity takes EXACTLY ONE positional argument typed as a
 * Pydantic v2 BaseModel"). This port CLOSES that violation: the single positional input is the
 * {@link SelectCarryForwardInputV1} envelope (libs/contracts/src/select_carry_forward_input.v1.ts).
 * There is no Python Pydantic counterpart for the envelope — it is introduced during the port.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. The selector is
 * nonetheless PURE + DETERMINISTIC, which is why this activity touches no Postgres and registers no
 * clock/random seam. S22.DM.18 (consulting `core.review_findings` for prior matches) stays DEFERRED to
 * Sprint 23+ per the frozen Python's docstring rationale — the in-memory parent-review-state path is the
 * only behavior ported here.
 */

import type { CarryForwardSelectionV1 } from "#contracts/carry_forward.v1.js";
import type { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import type { SelectCarryForwardInputV1 } from "#contracts/select_carry_forward_input.v1.js";

/** The wire shape of `changed_line_ranges`: path → array of [start, end] inclusive line-range pairs. */
type ChangedLineRanges = Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>;

/**
 * Port of `_intersects` — inclusive overlap of two closed line ranges [aStart, aEnd] and [bStart, bEnd].
 * `aStart <= bEnd && aEnd >= bStart` → true when the ranges share at least one line (including an
 * exact-boundary touch).
 */
function intersects(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

/**
 * Port of `_any_change_overlaps` — true iff ANY change range for `file` overlaps [startLine, endLine].
 * A file absent from the change map returns false (no recorded change → no overlap); the caller decides
 * what that means (carry the finding; review the chunk as renamed/new-path).
 */
function anyChangeOverlaps(args: {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly changed: ChangedLineRanges;
}): boolean {
  const ranges = args.changed[args.file];
  if (ranges === undefined) {
    return false;
  }
  for (const [cs, ce] of ranges) {
    if (intersects(args.startLine, args.endLine, cs, ce)) {
      return true;
    }
  }
  return false;
}

/**
 * Port of `_do_select` — the pure carried-vs-to_review partition. Exported so the Tier-1 parity oracle
 * can drive the exact selection the activity runs (mirrors the frozen Python exporting `_do_select`).
 *
 * Returns the {@link CarryForwardSelectionV1} envelope. PURE + SYNCHRONOUS (the Python `_do_select` is
 * likewise sync) — no clock, random, DB, or LLM.
 */
export function doSelectCarryForward(input: SelectCarryForwardInputV1): CarryForwardSelectionV1 {
  const changed = input.changed_line_ranges as ChangedLineRanges;

  const carried: Array<ReviewFindingV1> = [];
  for (const f of input.parent_findings) {
    if (
      anyChangeOverlaps({
        file: f.file,
        startLine: f.start_line,
        endLine: f.end_line,
        changed,
      })
    ) {
      // Finding's range intersects a change in this push → it may be stale; do NOT carry it forward.
      continue;
    }
    carried.push(f);
  }

  const toReview: Array<DiffChunkV1> = [];
  for (const c of input.current_chunks) {
    if (!(c.path in changed)) {
      // File absent from the change map → treat as fully changed (renamed / new path); review every
      // chunk. `in` (not `=== undefined`) so a present-but-empty range array does NOT take this branch —
      // it falls through to the no-overlap path below and is correctly SKIPPED (the no-change case).
      toReview.push(c);
      continue;
    }
    if (
      anyChangeOverlaps({
        file: c.path,
        startLine: c.start_line,
        endLine: c.end_line,
        changed,
      })
    ) {
      toReview.push(c);
    }
  }

  return {
    schema_version: 1,
    carried,
    to_review: toReview,
    parent_review_id: input.parent_review_id,
  };
}

/**
 * The registered Temporal activity (`select_carry_forward`). Takes the single typed
 * {@link SelectCarryForwardInputV1} envelope (invariant 11) and returns the carried-vs-to_review
 * partition. Async to match the Temporal activity contract (the frozen Python activity method is
 * `async def`); the selection itself is pure + synchronous via {@link doSelectCarryForward}.
 */
export async function selectCarryForward(
  input: SelectCarryForwardInputV1,
): Promise<CarryForwardSelectionV1> {
  return doSelectCarryForward(input);
}
