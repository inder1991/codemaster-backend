/**
 * RuffInWorkerRunner — 1:1 port of `vendor/codemaster-py/codemaster/analysis/ruff_runner.py`
 * (Sprint 9 / S9.1.4).
 *
 * Runs Ruff via the in-worker subprocess sandbox and parses its `--output-format=json` output into
 * {@link AnalysisFindingV1}s.
 *
 * Ruff JSON shape (per `ruff check --output-format=json`):
 *   [{ "code": "F401", "filename": "/abs/path.py",
 *      "location": {"row": 1, "column": 8}, "end_location": {"row": 1, "column": 10},
 *      "message": "...", "fix": {"edits": [{"content": "..."}]} | null }, ...]
 *
 * Ruff emits no per-finding severity (each rule's severity is fixed by its prefix). We map the rule
 * prefix to a coarse `severity_raw`; the curator does the precise ReviewFindingV1 severity later.
 *
 * Conventions:
 *   - Empty file list → no subprocess; return [].
 *   - Exit 0 (no findings) / 1 (findings exist) → success, parse output.
 *   - Exit ≥ 2 → typed {@link RunnerToolError}.
 *   - Malformed JSON / non-array → log WARN + return [] (degrade, never crash the review).
 */

import { RunnerToolError } from "./eslint_runner.js";
import { InWorkerRunner, type SpawnFn, type SubprocessResultV1 } from "./in_worker_runner.js";
import type { AnalysisRunner, RunnerRunInput } from "./runner_port.js";
import { RUFF_CONFIG_PATH } from "./config_assets.js";
import { relativeToWorkspace } from "./_relative_to_workspace.js";
import { uuid4 } from "./uuid4.js";
import { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { type Clock } from "#platform/clock.js";

/** Coarse rule-prefix → severity_raw map (1:1 with the Python `_SEVERITY_BY_PREFIX`). The curator
 *  (S9.2.2) handles the precise ReviewFindingV1 severity; this is the tool's-own-string layer. */
const SEVERITY_BY_PREFIX: ReadonlyMap<string, string> = new Map([
  ["S", "error"],
  ["B", "error"],
  ["F", "warning"],
  ["E", "warning"],
  ["W", "warning"],
  ["I", "warning"],
  ["PL", "warning"],
  ["RUF", "warning"],
  ["SIM", "warning"],
  ["C", "warning"],
  ["D", "info"],
]);

/** Match the longest prefix in {@link SEVERITY_BY_PREFIX} (3 → 2 → 1 chars), defaulting to "warning". */
export function severityForCode(code: string): string {
  for (const length of [3, 2, 1]) {
    const prefix = code.slice(0, length);
    const hit = SEVERITY_BY_PREFIX.get(prefix);
    if (hit !== undefined) return hit;
  }
  return "warning";
}

type RuffInWorkerRunnerOptions = {
  readonly ruffPath?: string;
  readonly configPath?: string;
  readonly timeoutSeconds?: number;
  readonly spawnFn?: SpawnFn;
  readonly clock?: Clock;
};

export class RuffInWorkerRunner implements AnalysisRunner {
  public readonly name = "ruff";
  private readonly ruffPath: string;
  private readonly configPath: string;
  private readonly timeoutSeconds: number | undefined;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly clock: Clock | undefined;

  public constructor({
    ruffPath = "ruff",
    configPath = RUFF_CONFIG_PATH,
    timeoutSeconds,
    spawnFn,
    clock,
  }: RuffInWorkerRunnerOptions = {}) {
    this.ruffPath = ruffPath;
    this.configPath = configPath;
    this.timeoutSeconds = timeoutSeconds;
    this.spawnFn = spawnFn;
    this.clock = clock;
  }

  public async run({ workspace, files, signal }: RunnerRunInput): Promise<ReadonlyArray<AnalysisFindingV1>> {
    // changedLineRanges accepted but ignored — central filtering at the orchestrator (see runner_port).
    if (files.length === 0) return [];
    const runner = new InWorkerRunner({
      command: this.buildCommand(files),
      workspace,
      ...(this.timeoutSeconds !== undefined ? { timeoutSeconds: this.timeoutSeconds } : {}),
      ...(this.spawnFn !== undefined ? { spawnFn: this.spawnFn } : {}),
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    const result = await runner.runSubprocess();
    return parseRuffOutput(result, workspace);
  }

  private buildCommand(files: ReadonlyArray<string>): ReadonlyArray<string> {
    return [
      this.ruffPath,
      "check",
      "--output-format=json",
      // --exit-zero stops Ruff from short-circuiting our parse on exit 1 in some edge cases (we
      // inspect the JSON ourselves).
      "--exit-zero",
      "--no-cache", // the workspace is ephemeral
      "--config",
      this.configPath,
      ...files,
    ];
  }
}

/** Parse a captured Ruff subprocess result into findings. Exported for the parser parity test. */
export function parseRuffOutput(
  result: SubprocessResultV1,
  workspace: string,
): ReadonlyArray<AnalysisFindingV1> {
  if (result.exit_code !== 0 && result.exit_code !== 1) {
    throw new RunnerToolError({
      tool: "ruff",
      exitCode: result.exit_code,
      stderr: Buffer.from(result.stderr).toString("utf8"),
    });
  }
  const stdout = Buffer.from(result.stdout).toString("utf8");
  if (!stdout) return [];

  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    // Degrade to no findings rather than crash the review (matches Python WARN + return ()).
    return [];
  }
  if (!Array.isArray(payload)) return [];

  const findings: Array<AnalysisFindingV1> = [];
  for (const entry of payload) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const code = String(e["code"] ?? "unknown") || "unknown";
    const filePath = String(e["filename"] ?? "");
    const relative = relativeToWorkspace(filePath, workspace);
    const location = isRecord(e["location"]) ? e["location"] : {};
    const endLocation = isRecord(e["end_location"]) ? e["end_location"] : location;

    // Mirror the frozen Python's single try-block: int(location["row"], 1) → start_line, then
    // int(end_location["row"], start_line) → end_line; ANY non-coercible value collapses to (1, 1).
    let startLine: number;
    let endLine: number;
    const startRaw = toInt(location["row"], 1);
    if (startRaw === null) {
      startLine = 1;
      endLine = 1;
    } else {
      startLine = startRaw || 1;
      const endRaw = toInt(endLocation["row"], startLine);
      if (endRaw === null) {
        startLine = 1;
        endLine = 1;
      } else {
        endLine = endRaw || startLine;
      }
    }
    if (endLine < startLine) endLine = startLine;

    let message = String(e["message"] ?? "").trim();
    if (!message) message = `${code} matched`;

    let fixSuggestion: string | null = null;
    const fix = e["fix"];
    if (isRecord(fix)) {
      const edits = fix["edits"];
      if (Array.isArray(edits) && edits.length > 0) {
        const first = edits[0];
        if (isRecord(first) && "content" in first) {
          fixSuggestion = String(first["content"]);
        }
      }
    }

    findings.push(
      AnalysisFindingV1.parse({
        finding_id: uuid4(),
        tool: "ruff",
        rule_id: code,
        file: relative,
        start_line: startLine,
        end_line: endLine,
        severity_raw: severityForCode(code),
        message: message.slice(0, 2000),
        fix_suggestion: fixSuggestion,
      }),
    );
  }
  return findings;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Mirror Python `int(x)` coercion with a default; returns null on a non-coercible value (→ Python's
 *  `except (TypeError, ValueError)` fallback to (1, 1)). */
function toInt(v: unknown, fallback: number): number | null {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}
