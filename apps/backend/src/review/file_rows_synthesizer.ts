// Client-side file_rows synthesizer — 1:1 port of the frozen Python
//   vendor/codemaster-py/codemaster/review/file_rows_synthesizer.py (R-W3 / R-WR1 / R-WR8).
//
// Builds a per-file FileRowV1 tuple from aggregated findings, used when the LLM's walkthrough output
// came back with empty (or missing) file_rows OR when the walkthrough activity fell into its
// fallback path (cost cap, output-safety block, parse error). The synthesizer is PURE:
//   * No I/O (no DB, no LLM, no Bedrock), no clock/random, no global-state mutation.
//   * Deterministic — output is stably sorted (severity-desc, then path-asc) so a Temporal replay
//     produces byte-identical output. No reliance on object key-iteration order.
//
// Properties guaranteed (mirrored from the Python docstring):
//   * Severity floor preserved — each row's severity_max is the MAX severity across that file's
//     findings, ranked by SEVERITY_RANK (NOT lexicographic max, which would mis-order the literals).
//   * Bounded fan-out — caps at 49 real rows + 1 overflow row aggregating the elided tail; the
//     overflow row's severity_max is the MAX across elided files (preserves "there is a blocker hiding
//     in the tail"); finding_count is the SUM across elided files.
//   * Returns [] when findings is empty (the defensive early-return keeps the helper a total function).

import { type FileRowV1, type Severity } from "#contracts/walkthrough.v1.js";

/**
 * The minimal finding shape the synthesizer reads: a file path + a severity literal. `ReviewFindingV1`
 * (the aggregated finding) satisfies this structurally — the synthesizer only touches `.file` and
 * `.severity` (mirroring the frozen Python `f.file` / `f.severity` attribute reads).
 */
export type SynthesizableFinding = {
  readonly file: string;
  readonly severity: string;
};

// Severity rank for the per-file rollup. The walkthrough contract uses
// Severity = "nit" | "suggestion" | "issue" | "blocker"; a lexicographic max() produces the WRONG
// order (alphabetical: blocker < issue < nit < suggestion). The explicit rank mirrors the renderer's
// "blocker > issue > suggestion > nit" semantics. A ReadonlyMap (not an object index) keeps the lookup
// off a dynamic-property sink. Mirrors Python `_SEVERITY_RANK`.
const SEVERITY_RANK: ReadonlyMap<string, number> = new Map<string, number>([
  ["nit", 0],
  ["suggestion", 1],
  ["issue", 2],
  ["blocker", 3],
]);

// Inverse map for synthesizer rank → severity literal. Mirrors Python `_RANK_TO_SEVERITY`.
const RANK_TO_SEVERITY: ReadonlyMap<number, Severity> = new Map<number, Severity>([
  [0, "nit"],
  [1, "suggestion"],
  [2, "issue"],
  [3, "blocker"],
]);

// R-WR1: the WalkthroughV1.file_rows contract caps file_rows. The synthesizer caps at 49 real rows + 1
// overflow row aggregating the remainder. The overflow row's path token is intentionally
// non-filesystem so the renderer's per-file linking doesn't resolve it as a real file. Mirrors the
// frozen Python module-level Finals.
export const FILE_ROWS_HARD_CAP = 50;
export const FILE_ROWS_REAL_CAP = FILE_ROWS_HARD_CAP - 1; // 49 real + 1 overflow
export const OVERFLOW_ROW_PATH = "…(additional files)"; // "…(additional files)"

/**
 * R-W3 / R-WR1 — build a per-file FileRowV1 tuple from aggregated findings. 1:1 with the frozen
 * Python `synthesize_file_rows_from_aggregated`.
 *
 * Returns [] when `findings` is empty. The `change_summary` placeholder text is fixed-format (byte-for
 * -byte with Python) so a future operator dashboard can grep for "synthesized from" occurrences as the
 * runtime signal that synthesis fired.
 */
export function synthesizeFileRowsFromAggregated(
  findings: ReadonlyArray<SynthesizableFinding>,
): Array<FileRowV1> {
  if (findings.length === 0) {
    return [];
  }

  // Group by file path; track (max_rank, count). A Map preserves first-seen insertion order (matching
  // Python dict semantics) — though the subsequent sort makes the final order independent of it.
  const byFile = new Map<string, { maxRank: number; count: number }>();
  for (const f of findings) {
    const path = f.file;
    // Mirror Python `_SEVERITY_RANK.get(f.severity, 0)` — an out-of-vocab severity ranks as nit (0).
    const rank = SEVERITY_RANK.get(f.severity) ?? 0;
    const prior = byFile.get(path);
    if (prior === undefined) {
      byFile.set(path, { maxRank: rank, count: 1 });
    } else {
      byFile.set(path, { maxRank: Math.max(prior.maxRank, rank), count: prior.count + 1 });
    }
  }

  // Severity-desc, then path-asc — mirrors Python `sorted(by_file, key=lambda p: (-rank, p))`. Total
  // order → Temporal replay byte-identical. Surfaces blockers first (matching the real LLM walkthrough).
  const sortedPaths = [...byFile.keys()].sort((a, b) => {
    const rankA = byFile.get(a)!.maxRank;
    const rankB = byFile.get(b)!.maxRank;
    if (rankA !== rankB) {
      return rankB - rankA; // -rank ascending == rank descending
    }
    // path-asc by Unicode code point — JS string `<` compares UTF-16 code units, which matches Python
    // str comparison for the BMP path strings repos use (and for astral chars both compare by code
    // unit / code point consistently for sort stability here).
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const totalFiles = sortedPaths.length;

  // R-WR1 — cap at FILE_ROWS_REAL_CAP (49) real rows + 1 overflow row aggregating the remainder.
  let realPaths: Array<string>;
  let overflowPaths: Array<string>;
  if (totalFiles > FILE_ROWS_HARD_CAP) {
    realPaths = sortedPaths.slice(0, FILE_ROWS_REAL_CAP);
    overflowPaths = sortedPaths.slice(FILE_ROWS_REAL_CAP);
  } else {
    realPaths = sortedPaths;
    overflowPaths = [];
  }

  const rows: Array<FileRowV1> = [];
  for (const path of realPaths) {
    const { maxRank, count } = byFile.get(path)!;
    // change_summary is required (min_length=1, max_length=300). Use the singular/plural that scans
    // cleanly at any count — byte-identical to the frozen Python f-string.
    const findingWord = count === 1 ? "finding" : "findings";
    rows.push({
      path,
      change_summary:
        `(${count} ${findingWord} synthesized from aggregated ` +
        "findings; LLM walkthrough was truncated — see inline " +
        "comments for details)",
      severity_max: RANK_TO_SEVERITY.get(maxRank)!,
      finding_count: count,
    });
  }

  if (overflowPaths.length > 0) {
    // Aggregate the elided tail.
    const overflowMaxRank = Math.max(...overflowPaths.map((p) => byFile.get(p)!.maxRank));
    const overflowCount = overflowPaths.reduce((acc, p) => acc + byFile.get(p)!.count, 0);
    const overflowFileCount = overflowPaths.length;
    rows.push({
      path: OVERFLOW_ROW_PATH,
      change_summary:
        `+${overflowFileCount} additional files with ` +
        `${overflowCount} synthesized findings ` +
        "(table capped at 50 rows; see footer for total)",
      severity_max: RANK_TO_SEVERITY.get(overflowMaxRank)!,
      finding_count: overflowCount,
    });
  }

  return rows;
}

// R-WR8 — degradation note used when the walkthrough fallback path fires because the LLM activity
// raised (cost cap, output safety block, parse error, etc.) and the per-file table was synthesized
// from data already in hand. Byte-identical to the frozen Python `LLM_FALLBACK_SYNTHESIS_NOTE`.
export const LLM_FALLBACK_SYNTHESIS_NOTE =
  "walkthrough generation failed; per-file table synthesized from aggregated findings";
