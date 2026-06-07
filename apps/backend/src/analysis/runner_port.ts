/**
 * AnalysisRunner — the seam every static-analysis runner implements.
 *
 * 1:1 port of `vendor/codemaster-py/codemaster/analysis/runner_port.py` (the Sprint-9 S9.1.1
 * Protocol) UNIFIED with the NEWER orchestrator's `AnalysisRunner` Protocol
 * (`static_analysis_orchestrator.py`), which additionally threads `changed_line_ranges`.
 *
 * Two implementation strategies in the frozen codebase:
 *   - subprocess `InWorkerRunner` (Ruff / ESLint / Gitleaks) — fast, low-memory tools run inside the
 *     worker pod. THIS port builds those three.
 *   - `JobRunner` (Semgrep / Trivy / Checkov / Kube-linter) — heavy tools run as one-shot K8s Jobs.
 *     Out of scope here.
 *
 * Either way the orchestrator only sees `run(...) -> ReadonlyArray<AnalysisFindingV1>`; the sandbox
 * choice is invisible to it.
 *
 * On `changedLineRanges`: Sprint-9 subprocess runners ACCEPT but IGNORE this argument — filtering is
 * centralized (the orchestrator applies `filterToChangedLines` post-fan-out). It is part of the
 * Protocol so future source-level-optimizing runners can consume it. The frozen Python comment notes
 * Python keyword binding is strict, so every implementation must honor the contract; in TS the
 * parameter is part of the single options object every runner accepts.
 */

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";

/** Per-file inclusive `[start_line, end_line]` tuples of changed lines. Mirrors the Sprint-8
 *  carry-forward `changed_line_ranges` shape: `dict[str, tuple[tuple[int, int], ...]]`. */
export type ChangedLineRanges = Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>;

/** Options passed to every runner's `run`. The single-object shape is the TS analogue of the frozen
 *  Python keyword-only signature `run(*, workspace, files, changed_line_ranges)`. */
export type RunnerRunInput = {
  /** Absolute workspace path the tool scans (subprocess `cwd`). */
  readonly workspace: string;
  /** The files (workspace-relative) routed to this tool. Empty ⇒ no subprocess; return `[]`. */
  readonly files: ReadonlyArray<string>;
  /** Accepted but currently unused by subprocess runners (central filtering). */
  readonly changedLineRanges: ChangedLineRanges;
  /**
   * Soft-barrier cancellation signal. The orchestrator owns the authoritative Tier-1 deadline and
   * arms ONE shared signal; when it fires (deadline hit) a runner should abandon its in-flight work.
   * This is the TS analogue of the Python orchestrator's `task.cancel()` — JS promises aren't
   * cancellable, so cooperative cancellation flows through this signal (the subprocess `InWorkerRunner`
   * tears down the process group when it sees the abort). Optional: a runner MAY ignore it (the
   * orchestrator stops awaiting it at the deadline regardless and records `timed_out`).
   */
  readonly signal?: AbortSignal;
};

/** Run a static-analysis tool against a workspace. */
export type AnalysisRunner = {
  /** Stable tool identifier; matches `AnalysisFindingV1.tool` and `ToolStatusV1.tool_name`. */
  readonly name: string;
  run(input: RunnerRunInput): Promise<ReadonlyArray<AnalysisFindingV1>>;
};
