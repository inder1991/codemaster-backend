/**
 * Tier-A parser parity: the TS runner parsers (`parseRuffOutput` / `parseEslintOutput` /
 * `parseGitleaksOutput`) MUST produce byte-identical {@link AnalysisFindingV1}s to the frozen Python
 * `*_runner._parse_output` static methods over the SAME recorded real-tool JSON.
 *
 * Recorded fixtures (`test/fixtures/static_analysis/{ruff,eslint,gitleaks}_output.json`) are the
 * REAL stdout of Ruff 0.15.x / ESLint v10 / Gitleaks 8.30.x run against the seeded-bait fixture files
 * with codemaster's bundled configs. The Python ref (`tools/parity/run_static_analysis_parser_ref.py`)
 * runs each frozen parser against the same bytes; we strip the non-deterministic `finding_id` + the
 * constant `schema_version` from BOTH sides and assert structural equality.
 *
 * Workspace note: the fixtures' absolute paths are under `/private/tmp/sapclean` (the macOS realpath
 * of `/tmp/sapclean` where they were generated). Passing that exact workspace to BOTH sides yields
 * clean workspace-relative `file` fields AND exercises `_relative_to_workspace`'s under-workspace
 * branch identically.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { parseEslintOutput } from "#backend/analysis/eslint_runner.js";
import { parseGitleaksOutput } from "#backend/analysis/gitleaks_runner.js";
import { parseRuffOutput } from "#backend/analysis/ruff_runner.js";
import { filterToChangedLines } from "#backend/analysis/promotion.js";
import type { SubprocessResultV1 } from "#backend/analysis/in_worker_runner.js";

import { SLACK_BAIT_PLACEHOLDER, SLACK_BAIT_TOKEN } from "../support/slack_bait.js";
import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";

import { shutdownRef } from "./oracle.js";

afterAll(() => shutdownRef());

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/test/parity
const REPO_ROOT = join(HERE, "..", "..");
const SUBMODULE = join(REPO_ROOT, "vendor", "codemaster-py");
const VENV_PY = join(SUBMODULE, ".venv", "bin", "python");
const REF_SCRIPT = join(REPO_ROOT, "tools", "parity", "run_static_analysis_parser_ref.py");
const FIXTURES = join(REPO_ROOT, "test", "fixtures", "static_analysis");

// The workspace the fixtures' absolute paths are under (macOS realpath of /tmp/sapclean).
const WORKSPACE = "/private/tmp/sapclean";

type StrippedFinding = Record<string, unknown>;

/** Run the frozen Python parser ref for one tool; return its findings (finding_id/schema stripped). */
function pythonParse(tool: "ruff" | "eslint" | "gitleaks", exitCode = 1): Array<Record<string, unknown>> {
  const fixture = join(FIXTURES, `${tool}_output.json`);
  const r = spawnSync(VENV_PY, [REF_SCRIPT, "parse", tool, fixture, WORKSPACE, String(exitCode)], {
    cwd: SUBMODULE,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`python ref failed (${tool}): ${r.stderr}`);
  return JSON.parse(r.stdout) as Array<Record<string, unknown>>;
}

/** Run the frozen Python parse-THEN-filter ref for one tool against a changed-line ranges map. */
function pythonFilter(
  tool: "ruff" | "eslint" | "gitleaks",
  ranges: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>,
  exitCode = 1,
): Array<Record<string, unknown>> {
  const fixture = join(FIXTURES, `${tool}_output.json`);
  const r = spawnSync(
    VENV_PY,
    [REF_SCRIPT, "filter", tool, fixture, WORKSPACE, String(exitCode), JSON.stringify(ranges)],
    { cwd: SUBMODULE, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`python ref failed (filter ${tool}): ${r.stderr}`);
  return JSON.parse(r.stdout) as Array<Record<string, unknown>>;
}

/** Build a fake SubprocessResultV1 from a recorded stdout fixture. */
function resultFromFixture(tool: "ruff" | "eslint" | "gitleaks", exitCode: number): SubprocessResultV1 {
  // Substitute the committed-source-safe placeholder back to the real Slack-token bait (the literal is
  // never stored in the fixture so push-protection stays satisfied; the Python ref does the same substitution).
  const raw = readFileSync(join(FIXTURES, `${tool}_output.json`), "utf8").replaceAll(
    SLACK_BAIT_PLACEHOLDER,
    SLACK_BAIT_TOKEN,
  );
  const stdout = new TextEncoder().encode(raw);
  return { exit_code: exitCode, stdout, stderr: new Uint8Array(), wall_ms: 1 };
}

/** Strip the non-parity fields (non-deterministic finding_id + constant schema_version) so the
 *  comparison is value-stable, exactly matching the Python ref's `_strip`. */
function strip(f: AnalysisFindingV1): StrippedFinding {
  const copy: Record<string, unknown> = { ...f };
  delete copy["finding_id"];
  delete copy["schema_version"];
  return copy;
}

describe("static-analysis parser parity (TS ↔ frozen Python over recorded real-tool output)", () => {
  for (const tool of ["ruff", "eslint", "gitleaks"] as const) {
    it(`${tool}: TS parser matches the frozen Python parser`, () => {
      const py = pythonParse(tool, 1);
      const tsParser =
        tool === "ruff" ? parseRuffOutput : tool === "eslint" ? parseEslintOutput : parseGitleaksOutput;
      const ts = tsParser(resultFromFixture(tool, 1), WORKSPACE).map(strip);
      expect(ts).toEqual(py);
      expect(ts.length).toBeGreaterThan(0); // the fixtures carry real findings
    });
  }

  it("gitleaks special-cases blocker severity + redacts the secret in the message", () => {
    // Cross-check the gitleaks-specific behavior the owner pinned: blocker severity + redaction.
    const ts = parseGitleaksOutput(resultFromFixture("gitleaks", 1), WORKSPACE);
    expect(ts.length).toBeGreaterThan(0);
    for (const f of ts) {
      expect(f.severity_raw).toBe("blocker");
      // the raw 56-char slack token must NOT appear; a redacted "xoxb…VwX"-style mask must.
      expect(f.message).not.toContain(SLACK_BAIT_TOKEN);
      expect(f.message).toContain("…");
    }
  });

  // ─── changed-line filter parity (parse THEN filterToChangedLines) ──────────────────────────────
  // The ruff fixture's findings sit at bad.py lines 1, 2, 5, 6. We exercise: a window that keeps a
  // subset, a window that keeps none, an empty ranges map, and an unknown-file map.
  const RUFF_FILTER_CASES: ReadonlyArray<{
    label: string;
    ranges: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>;
  }> = [
    { label: "keep lines 5-6 only", ranges: { "bad.py": [[5, 6]] } },
    { label: "keep line 1 only", ranges: { "bad.py": [[1, 1]] } },
    { label: "keep all (1-100)", ranges: { "bad.py": [[1, 100]] } },
    { label: "keep none (window outside)", ranges: { "bad.py": [[50, 60]] } },
    { label: "empty ranges → drop all", ranges: {} },
    { label: "unknown file → drop all", ranges: { "other.py": [[1, 100]] } },
    { label: "present-but-empty range list → drop all", ranges: { "bad.py": [] } },
  ];

  for (const { label, ranges } of RUFF_FILTER_CASES) {
    it(`filter parity (ruff): ${label}`, () => {
      const py = pythonFilter("ruff", ranges, 1);
      const parsed = parseRuffOutput(resultFromFixture("ruff", 1), WORKSPACE);
      const ts = filterToChangedLines(parsed, ranges).map(strip);
      expect(ts).toEqual(py);
    });
  }
});
