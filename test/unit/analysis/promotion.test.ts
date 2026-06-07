/**
 * Unit tests for `filterToChangedLines` — 1:1 with the frozen-Python `filter_to_changed_lines`
 * (`promotion.py`). The happy-path parity vs Python (over real ruff findings) lives in
 * `test/parity/static_analysis_parsers.parity.test.ts`; this suite pins the interval-overlap boundary
 * conditions + the drop rules directly in TS.
 */

import { describe, expect, it } from "vitest";

import { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { filterToChangedLines } from "#backend/analysis/promotion.js";
import type { ChangedLineRanges } from "#backend/analysis/runner_port.js";

function f(file: string, start: number, end: number, rule = "X"): AnalysisFindingV1 {
  return AnalysisFindingV1.parse({
    finding_id: "00000000-0000-4000-8000-000000000000",
    tool: "ruff",
    rule_id: rule,
    file,
    start_line: start,
    end_line: end,
    severity_raw: "warning",
    message: `${rule} at ${file}:${start}-${end}`,
    fix_suggestion: null,
  });
}

describe("filterToChangedLines", () => {
  it("empty findings → []", () => {
    expect(filterToChangedLines([], { "a.py": [[1, 10]] })).toEqual([]);
  });

  it("empty changed-line ranges → [] (drops everything)", () => {
    expect(filterToChangedLines([f("a.py", 5, 5)], {})).toEqual([]);
  });

  it("file absent from the ranges map → dropped", () => {
    expect(filterToChangedLines([f("a.py", 5, 5)], { "b.py": [[1, 10]] })).toEqual([]);
  });

  it("file present but its range list is empty → dropped", () => {
    expect(filterToChangedLines([f("a.py", 5, 5)], { "a.py": [] })).toEqual([]);
  });

  it("keeps a finding overlapping a changed range", () => {
    const out = filterToChangedLines([f("a.py", 5, 7)], { "a.py": [[6, 9]] });
    expect(out).toHaveLength(1);
  });

  it("boundary: a finding touching the range edge (single-line overlap) is kept", () => {
    // finding [10,10] vs range [10,12] — inclusive overlap.
    expect(filterToChangedLines([f("a.py", 10, 10)], { "a.py": [[10, 12]] })).toHaveLength(1);
    // finding [12,15] vs range [10,12] — touches at 12.
    expect(filterToChangedLines([f("a.py", 12, 15)], { "a.py": [[10, 12]] })).toHaveLength(1);
  });

  it("boundary: a finding one line off the range edge is dropped", () => {
    // finding [13,15] vs range [10,12] — no overlap.
    expect(filterToChangedLines([f("a.py", 13, 15)], { "a.py": [[10, 12]] })).toEqual([]);
    // finding [7,9] vs range [10,12] — no overlap.
    expect(filterToChangedLines([f("a.py", 7, 9)], { "a.py": [[10, 12]] })).toEqual([]);
  });

  it("a finding overlapping ANY of multiple ranges is kept (and counted once)", () => {
    const ranges: ChangedLineRanges = { "a.py": [[1, 2], [50, 60], [100, 110]] };
    const out = filterToChangedLines([f("a.py", 55, 55)], ranges);
    expect(out).toHaveLength(1);
  });

  it("preserves input order of survivors (stable)", () => {
    const ranges: ChangedLineRanges = { "a.py": [[1, 100]] };
    const out = filterToChangedLines(
      [f("a.py", 30, 30, "C"), f("a.py", 10, 10, "A"), f("a.py", 20, 20, "B")],
      ranges,
    );
    expect(out.map((x) => x.rule_id)).toEqual(["C", "A", "B"]);
  });
});
