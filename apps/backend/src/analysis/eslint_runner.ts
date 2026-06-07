/**
 * EslintInWorkerRunner — 1:1 port of `vendor/codemaster-py/codemaster/analysis/eslint_runner.py`
 * (Sprint 9 / S9.1.3).
 *
 * Runs ESLint via the in-worker subprocess sandbox and parses its `--format=json` output into
 * {@link AnalysisFindingV1}s.
 *
 * Conventions:
 *   - Empty file list → no subprocess; return [].
 *   - Exit 0 (no problems) / 1 (problems found) → success, parse output. (ESLint uses exit-1 to
 *     signal "lint findings exist," not failure.)
 *   - Exit ≥ 2 (true tool failure) → typed {@link RunnerToolError} carrying stderr.
 *   - Malformed JSON / non-array → log WARN + return [] (degrade, never crash the review).
 *
 * ESLint severity → severity_raw: 1 → "warning", 2 → "error"; anything else passes through as the
 * string form of the integer.
 *
 * This module also OWNS {@link RunnerToolError} — in the frozen Python it is defined here and
 * imported by `ruff_runner.py` / `gitleaks_runner.py`; the TS port preserves that ownership so the
 * import graph matches.
 */

import { InWorkerRunner, type SpawnFn, type SubprocessResultV1 } from "./in_worker_runner.js";
import type { AnalysisRunner, RunnerRunInput } from "./runner_port.js";
import { ESLINT_CONFIG_PATH } from "./config_assets.js";
import { relativeToWorkspace } from "./_relative_to_workspace.js";
import { uuid4 } from "./uuid4.js";
import { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { type Clock } from "#platform/clock.js";

/** ESLint integer severity → severity_raw string (1:1 with the Python `_ESLINT_SEVERITY_MAP`). */
const ESLINT_SEVERITY_MAP: ReadonlyMap<number, string> = new Map([
  [1, "warning"],
  [2, "error"],
]);

/**
 * Raised when an analysis tool exits with a true failure code (≥ 2 for ESLint / Ruff / Gitleaks).
 * Carries stderr for diagnostics. 1:1 with the Python `RunnerToolError`.
 */
export class RunnerToolError extends Error {
  public readonly tool: string;
  public readonly exitCode: number;
  public readonly stderr: string;

  public constructor({ tool, exitCode, stderr }: { tool: string; exitCode: number; stderr: string }) {
    super(`${tool} exited ${exitCode}; stderr (first 500 chars): ${JSON.stringify(stderr.slice(0, 500))}`);
    this.name = "RunnerToolError";
    this.tool = tool;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

type EslintInWorkerRunnerOptions = {
  readonly eslintPath?: string;
  readonly configPath?: string;
  readonly timeoutSeconds?: number;
  readonly spawnFn?: SpawnFn;
  readonly clock?: Clock;
};

export class EslintInWorkerRunner implements AnalysisRunner {
  public readonly name = "eslint";
  private readonly eslintPath: string;
  private readonly configPath: string;
  private readonly timeoutSeconds: number | undefined;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly clock: Clock | undefined;

  public constructor({
    eslintPath = "eslint",
    configPath = ESLINT_CONFIG_PATH,
    timeoutSeconds,
    spawnFn,
    clock,
  }: EslintInWorkerRunnerOptions = {}) {
    this.eslintPath = eslintPath;
    this.configPath = configPath;
    this.timeoutSeconds = timeoutSeconds;
    this.spawnFn = spawnFn;
    this.clock = clock;
  }

  public async run({ workspace, files, signal }: RunnerRunInput): Promise<ReadonlyArray<AnalysisFindingV1>> {
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
    return parseEslintOutput(result, workspace);
  }

  private buildCommand(files: ReadonlyArray<string>): ReadonlyArray<string> {
    return [
      this.eslintPath,
      "--format=json",
      "--no-error-on-unmatched-pattern",
      "--config",
      this.configPath,
      ...files,
    ];
  }
}

/** Parse a captured ESLint subprocess result into findings. Exported for the parser parity test. */
export function parseEslintOutput(
  result: SubprocessResultV1,
  workspace: string,
): ReadonlyArray<AnalysisFindingV1> {
  if (result.exit_code !== 0 && result.exit_code !== 1) {
    throw new RunnerToolError({
      tool: "eslint",
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
    return [];
  }
  if (!Array.isArray(payload)) return [];

  const findings: Array<AnalysisFindingV1> = [];
  for (const fileBlock of payload) {
    if (fileBlock === null || typeof fileBlock !== "object") continue;
    const fb = fileBlock as Record<string, unknown>;
    const filePath = String(fb["filePath"] ?? "");
    const relative = relativeToWorkspace(filePath, workspace);
    const messages = fb["messages"];
    if (!Array.isArray(messages)) continue;
    for (const msg of messages) {
      if (msg === null || typeof msg !== "object") continue;
      const m = msg as Record<string, unknown>;
      const ruleId = m["ruleId"] != null && m["ruleId"] !== "" ? String(m["ruleId"]) : "unknown";

      const startLine = toIntOr(m["line"], 1) || 1;
      let endLine = toIntOr(m["endLine"], startLine) || startLine;
      if (endLine < startLine) endLine = startLine;

      const rawSeverity = toIntOr(m["severity"], 1);
      const severityRaw =
        ESLINT_SEVERITY_MAP.get(rawSeverity) ?? String(m["severity"] ?? "warning");

      let message = String(m["message"] ?? "").trim();
      if (!message) message = `${ruleId} matched`;

      let fixSuggestion: string | null = null;
      const fix = m["fix"];
      if (fix !== null && typeof fix === "object" && "text" in (fix as Record<string, unknown>)) {
        fixSuggestion = String((fix as Record<string, unknown>)["text"]);
      }

      findings.push(
        AnalysisFindingV1.parse({
          finding_id: uuid4(),
          tool: "eslint",
          rule_id: ruleId,
          file: relative,
          start_line: startLine,
          end_line: endLine,
          severity_raw: severityRaw,
          message: message.slice(0, 2000),
          fix_suggestion: fixSuggestion,
        }),
      );
    }
  }
  return findings;
}

/** Mirror Python `int(x, default)` for the ESLint integer fields, which Python coerces eagerly via
 *  `int(msg.get("line", 1))`. A non-numeric value would raise in Python (the producer always emits
 *  ints); we fall back to the default for robustness without diverging on the real-tool path. */
function toIntOr(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}
