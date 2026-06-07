/**
 * Linter-finding promotion primitives — 1:1 port of
 * `vendor/codemaster-py/codemaster/analysis/promotion.py` (Sprint 9 / S9.2.x).
 *
 * Stage 1: {@link filterToChangedLines} (S9.2.1) — drop findings that fall outside the current PR's
 * changed line ranges. Reviewers don't want to be lectured about pre-existing code.
 *
 * (Stages 2/3 — the Haiku curator + linter↔LLM dedup — live in their own modules and are out of
 * scope for this runner/filter port.)
 */

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import type { ChangedLineRanges } from "./runner_port.js";

/** Inclusive interval overlap test (1:1 with the Python `_intersects`). */
function intersects(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

/**
 * Return only the findings that overlap a changed line range.
 *
 * Rules (1:1 with the Python `filter_to_changed_lines`):
 *   - A finding's `(file, start_line, end_line)` must overlap at least one range in
 *     `changedLineRanges[file]`.
 *   - If `file` is absent from `changedLineRanges` → drop (never lecture about files not in this PR).
 *   - If `file` is present but its range list is empty → drop (same reasoning).
 *   - Order is stable (preserves input ordering of survivors).
 *   - Empty `findings` or empty `changedLineRanges` → `[]`.
 */
export function filterToChangedLines(
  findings: ReadonlyArray<AnalysisFindingV1>,
  changedLineRanges: ChangedLineRanges,
): ReadonlyArray<AnalysisFindingV1> {
  if (findings.length === 0) return [];
  if (Object.keys(changedLineRanges).length === 0) return [];

  const out: Array<AnalysisFindingV1> = [];
  for (const f of findings) {
    // `f.file` is contract-validated finding data keyed against an in-process per-PR ranges map (not
    // an attacker-controlled object path); the `hasOwnProperty` guard mirrors Python `dict.get`.
    const ranges = Object.prototype.hasOwnProperty.call(changedLineRanges, f.file)
      ? changedLineRanges[f.file]
      : undefined;
    if (ranges === undefined || ranges.length === 0) continue;
    for (const [cs, ce] of ranges) {
      if (intersects(f.start_line, f.end_line, cs, ce)) {
        out.push(f);
        break;
      }
    }
  }
  return out;
}
