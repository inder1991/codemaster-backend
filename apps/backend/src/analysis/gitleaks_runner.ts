/**
 * GitleaksInWorkerRunner — 1:1 port of `vendor/codemaster-py/codemaster/analysis/gitleaks_runner.py`
 * (Sprint 9 / S9.1.5).
 *
 * Runs Gitleaks via the in-worker subprocess sandbox and parses its JSON-array output into
 * {@link AnalysisFindingV1}s.
 *
 * ALWAYS-PROMOTE rule: every gitleaks finding lands at `severity_raw="blocker"` regardless of the
 * tool's own classification. The curator (S9.2.2) bypasses gitleaks findings — they translate 1:1 to
 * a blocker/security ReviewFindingV1 with no LLM intervention. A leaked credential is high-cost to
 * miss and low-cost to flag spuriously.
 *
 * SECRET REDACTION: the raw `Secret` value is NEVER stored in the finding — only the rule_id + line
 * range + a redacted message (first/last 4 chars, middle masked) reach the envelope. (The redact
 * activity later re-runs the content through the PII/secret redactor, so Bedrock never sees the raw
 * key either.)
 *
 * Gitleaks JSON shape (per `gitleaks detect --report-format=json`):
 *   [{ "Description": "...", "StartLine": 14, "EndLine": 14, "Match": "...", "Secret": "...",
 *      "File": "/abs/path", "RuleID": "aws-access-token", "Fingerprint": "..." }, ...]
 *
 * Conventions match the other runners: empty file list → []; exit 0/1 → success; exit ≥ 2 →
 * {@link RunnerToolError}; malformed JSON / null body / non-array → log WARN + return [].
 */

import { RunnerToolError } from "./eslint_runner.js";
import { InWorkerRunner, type SpawnFn, type SubprocessResultV1 } from "./in_worker_runner.js";
import type { AnalysisRunner, RunnerRunInput } from "./runner_port.js";
import { relativeToWorkspace } from "./_relative_to_workspace.js";
import { uuid4 } from "./uuid4.js";
import { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { type Clock } from "#platform/clock.js";

/** Per the always-promote rule — every gitleaks finding gets blocker so the curator translates 1:1. */
const GITLEAKS_SEVERITY = "blocker";

/**
 * Show first/last 4 chars; mask the middle. Mirrors the PatternSecretDetector redaction style so
 * reviewers can recognize WHICH credential leaked without seeing the full value. 1:1 with the Python
 * `_redact_secret` (uses the U+2026 HORIZONTAL ELLIPSIS, "…", exactly as the Python `"…"` literal).
 */
export function redactSecret(secret: string): string {
  // Python `len(secret) <= 8` counts CODE POINTS; `[...secret]` does the same in JS (`String.length`
  // counts UTF-16 units, which would diverge on astral-plane chars). Secrets are ASCII in practice,
  // but we match Python's code-point semantics exactly.
  const cps = [...secret];
  if (cps.length <= 8) return "…".repeat(cps.length);
  return `${cps.slice(0, 4).join("")}…${cps.slice(-4).join("")}`;
}

type GitleaksInWorkerRunnerOptions = {
  readonly gitleaksPath?: string;
  readonly timeoutSeconds?: number;
  readonly spawnFn?: SpawnFn;
  readonly clock?: Clock;
};

export class GitleaksInWorkerRunner implements AnalysisRunner {
  public readonly name = "gitleaks";
  private readonly gitleaksPath: string;
  private readonly timeoutSeconds: number | undefined;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly clock: Clock | undefined;

  public constructor({
    gitleaksPath = "gitleaks",
    timeoutSeconds,
    spawnFn,
    clock,
  }: GitleaksInWorkerRunnerOptions = {}) {
    this.gitleaksPath = gitleaksPath;
    this.timeoutSeconds = timeoutSeconds;
    this.spawnFn = spawnFn;
    this.clock = clock;
  }

  public async run({ workspace, files, signal }: RunnerRunInput): Promise<ReadonlyArray<AnalysisFindingV1>> {
    if (files.length === 0) return [];
    const runner = new InWorkerRunner({
      command: this.buildCommand(workspace),
      workspace,
      ...(this.timeoutSeconds !== undefined ? { timeoutSeconds: this.timeoutSeconds } : {}),
      ...(this.spawnFn !== undefined ? { spawnFn: this.spawnFn } : {}),
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    const result = await runner.runSubprocess();
    return parseGitleaksOutput(result, workspace);
  }

  private buildCommand(workspace: string): ReadonlyArray<string> {
    // gitleaks `detect` scans the whole working tree; the per-file filter is applied post-hoc in the
    // changed-line filter. --no-banner + report-format json + --no-git so we don't need a .git dir.
    return [
      this.gitleaksPath,
      "detect",
      "--no-banner",
      "--report-format=json",
      "--report-path=/dev/stdout",
      "--no-git",
      `--source=${workspace}`,
    ];
  }
}

/** Parse a captured Gitleaks subprocess result into findings. Exported for the parser parity test. */
export function parseGitleaksOutput(
  result: SubprocessResultV1,
  workspace: string,
): ReadonlyArray<AnalysisFindingV1> {
  if (result.exit_code !== 0 && result.exit_code !== 1) {
    throw new RunnerToolError({
      tool: "gitleaks",
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
  // gitleaks emits `null` when the report path is set + no findings exist on some versions.
  if (payload === null) return [];
  if (!Array.isArray(payload)) return [];

  const findings: Array<AnalysisFindingV1> = [];
  for (const entry of payload) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const ruleId = e["RuleID"] != null && e["RuleID"] !== "" ? String(e["RuleID"]) : "unknown";
    const filePath = String(e["File"] ?? "");
    const relative = relativeToWorkspace(filePath, workspace);

    // Mirror the frozen Python try-block: int(StartLine, 1) → start_line, then int(EndLine,
    // start_line) → end_line; ANY non-coercible value collapses to (1, 1).
    let startLine: number;
    let endLine: number;
    const startRaw = toInt(e["StartLine"], 1);
    if (startRaw === null) {
      startLine = 1;
      endLine = 1;
    } else {
      startLine = startRaw || 1;
      const endRaw = toInt(e["EndLine"], startLine);
      if (endRaw === null) {
        startLine = 1;
        endLine = 1;
      } else {
        endLine = endRaw || startLine;
      }
    }
    if (endLine < startLine) endLine = startLine;

    const description = String(e["Description"] ?? "").trim();
    const secret = String(e["Secret"] ?? "");
    const redactedSnippet = secret ? redactSecret(secret) : "";

    let message: string;
    if (description && redactedSnippet) {
      message = `${description} (redacted: ${redactedSnippet})`;
    } else if (description) {
      message = description;
    } else if (ruleId !== "unknown") {
      message = `${ruleId} matched`;
    } else {
      message = "secret detected";
    }

    findings.push(
      AnalysisFindingV1.parse({
        finding_id: uuid4(),
        tool: "gitleaks",
        rule_id: ruleId,
        file: relative,
        start_line: startLine,
        end_line: endLine,
        severity_raw: GITLEAKS_SEVERITY,
        message: message.slice(0, 2000),
        fix_suggestion: null,
      }),
    );
  }
  return findings;
}

/** Mirror Python `int(x)` with a default; null on a non-coercible value (Python's `except` → (1,1)). */
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
