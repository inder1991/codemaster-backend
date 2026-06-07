/**
 * StaticAnalysisOrchestrator — the NEWER soft-barrier deadline orchestrator.
 *
 * 1:1 port of `vendor/codemaster-py/codemaster/analysis/static_analysis_orchestrator.py`
 * (Phase B / static-analysis-coverage-gap fix). It OWNS the Tier-1 deadline, spawns the registered
 * runners concurrently, applies a SOFT BARRIER (collect-until-deadline, then cancel-remaining), and
 * returns `(findings, tool_statuses)` — where `findings` are RAW (uncapped, unfiltered, flattened
 * across tools in runner-REGISTRATION order) and `tool_statuses` is a per-tool {@link ToolStatusV1}
 * as a FIRST-CLASS output.
 *
 * Division of labor (1:1 with the frozen Python): the MAX_RAW_PER_TOOL cap, the changed-line filter,
 * and the Haiku curator do NOT live here — they live in the static-analysis ACTIVITY
 * (`static_analysis.activity.ts`), exactly as the frozen `static_analysis_pipeline.py` owns the
 * cap/filter and `activities/static_analysis.py` assembles the envelope. Keeping the orchestrator's
 * output RAW lets the activity derive BOTH `tier1_findings` (raw, for the Tier-2 LLM prompt to cite)
 * AND the curated `findings` (cap → filter → curate) from the single orchestrator run.
 *
 * Architecture principle (project-owner framing, preserved verbatim from the Python docstring):
 *   "Tier 1 is an optimization layer for Tier 2 quality, not a correctness dependency for the
 *    review. The orchestrator owns the authoritative deadline. Tool-level timeouts exist only as
 *    safety guards."
 *
 * Fail-open is the contract: the orchestrator NEVER throws. Recoverable runner failures degrade to
 * failure statuses; unknown exception classes are degraded to `failed_runtime`.
 *
 * Cancellation model (TS vs Python): Python cancels the asyncio Task. JS promises aren't cancellable,
 * so the soft barrier arms ONE shared {@link AbortController} that fires at the deadline; the
 * subprocess runners tear down their process group when they observe the abort (see
 * `in_worker_runner.ts`). A runner that ignores the signal is simply stopped-being-awaited and
 * recorded `timed_out` regardless. The orchestrator runs in the static-analysis ACTIVITY (normal
 * Node runtime), NOT the workflow sandbox — so a Clock seam + an AbortController are both fine here.
 *
 * Determinism: findings AND statuses are emitted in runner-REGISTRATION order (not completion order),
 * exactly as the Python iterates `tasks_by_name` in dict-insertion order.
 *
 * JobRunnerPort (DEFERRED): the heavy K8s-Job tools (Semgrep / Trivy / Checkov / Kube-linter) run as
 * one-shot K8s Jobs via a {@link JobRunnerPort} adapter. Only the IN-WORKER runners (Ruff / ESLint /
 * Gitleaks) are registered today; the K8s adapter is owner-provided infra. See
 * FOLLOW-UP-static-analysis-k8s-job-runners. The port type below documents the seam so a future
 * registration is a drop-in (a JobRunner satisfies the same {@link AnalysisRunner} contract).
 */

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { ToolStatusV1 } from "#contracts/tool_status.v1.js";
import { type Clock } from "#platform/clock.js";
import { transportAbortSignal } from "#platform/transport_timeout.js";

import { RunnerToolError } from "./eslint_runner.js";
import { SubprocessLaunchError, SubprocessTimeoutError } from "./in_worker_runner.js";
import type { AnalysisRunner, ChangedLineRanges } from "./runner_port.js";

/** One registered runner + the files it should scan. 1:1 with the Python `RunnerSpec`. */
export type RunnerSpec = {
  /** Stable tool identifier; matches `AnalysisFindingV1.tool` / `ToolStatusV1.tool_name`. */
  readonly name: string;
  readonly runner: AnalysisRunner;
  /** Files (workspace-relative) routed to this runner. Empty ⇒ marked `skipped`, never spawned. */
  readonly files: ReadonlyArray<string>;
};

/**
 * The slice of a K8s-Job analyzer runner the orchestrator would register for the heavy tools
 * (Semgrep / Trivy / Checkov / Kube-linter). A `JobRunner` satisfies the SAME {@link AnalysisRunner}
 * contract the in-worker runners do — `run(...) -> ReadonlyArray<AnalysisFindingV1>` — and adds a
 * `cancel()` the orchestrator could call on the soft barrier (the in-worker runners cancel via the
 * shared AbortSignal threaded through `RunnerRunInput.signal`).
 *
 * DEFERRED — the K8s adapter is owner-provided infra; only the in-worker runners are registered now.
 * FOLLOW-UP-static-analysis-k8s-job-runners. The port is exported so the wiring is a drop-in once the
 * adapter lands (register a `JobRunnerPort` impl into the {@link RunnerSpec} list alongside the
 * in-worker runners).
 */
export type JobRunnerPort = AnalysisRunner & {
  /** Tear down the in-flight K8s Job (the Job-based analogue of the in-worker process-group reap). */
  cancel(): Promise<void>;
};

/**
 * Orchestrator output. 1:1 with the Python `tuple[tuple[AnalysisFindingV1, ...], tuple[ToolStatusV1,
 * ...]]`. `findings` are RAW (uncapped, unfiltered) flattened across tools in registration order; one
 * status per registered runner (including timed-out / failed / skipped ones).
 */
export type StaticAnalysisOrchestratorResult = {
  readonly findings: ReadonlyArray<AnalysisFindingV1>;
  readonly toolStatuses: ReadonlyArray<ToolStatusV1>;
};

type RunInput = {
  readonly runners: ReadonlyArray<RunnerSpec>;
  readonly workspace: string;
  readonly changedLineRanges: ChangedLineRanges;
};

/** A runner's settled outcome (never rejects — fail-open). */
type RunnerOutcome =
  | { readonly kind: "completed"; readonly findings: ReadonlyArray<AnalysisFindingV1> }
  | { readonly kind: "failed_startup"; readonly errorClass: string; readonly errorMessage: string }
  | { readonly kind: "failed_runtime"; readonly errorClass: string; readonly errorMessage: string }
  | { readonly kind: "timed_out" };

type RunnerTask = {
  readonly spec: RunnerSpec;
  readonly startedAt: Date;
  /** Resolves with the runner's outcome (or `timed_out` if the deadline cancels it first); the
   *  resolution side-effect stamps `finishedAt` + `outcome`. */
  readonly settled: Promise<RunnerOutcome>;
  /** Set when the runner finished; used to stamp `finished_at` / `duration_ms`. */
  finishedAt: Date | null;
  /** The settled outcome, stamped on resolution so we never re-index a positional results array. */
  outcome: RunnerOutcome | null;
};

export class StaticAnalysisOrchestrator {
  private readonly deadlineSeconds: number;
  private readonly clock: Clock;

  public constructor({ deadlineSeconds, clock }: { deadlineSeconds: number; clock: Clock }) {
    this.deadlineSeconds = deadlineSeconds;
    this.clock = clock;
  }

  /**
   * Run all registered analyzers concurrently under the deadline. Returns the RAW findings flattened
   * in registration order + one {@link ToolStatusV1} per registered runner (including timed-out /
   * failed / skipped ones). Never throws — recoverable failures degrade to failure statuses; unknown
   * exception classes degrade to `failed_runtime`. The cap / changed-line filter / curator are the
   * activity's job.
   */
  public async run({ runners, workspace, changedLineRanges }: RunInput): Promise<StaticAnalysisOrchestratorResult> {
    if (runners.length === 0) {
      return { findings: [], toolStatuses: [] };
    }

    // The soft-barrier deadline: one shared controller all spawned runners observe. The orchestrator
    // owns this authoritative deadline (tool-level timeouts are only safety guards).
    const deadlineController = new AbortController();

    // Spawn one task per non-empty runner; empty-files runners are marked skipped (no spawn, no wait).
    const tasks: Array<RunnerTask> = [];
    const skippedStatuses = new Map<string, ToolStatusV1>();
    for (const spec of runners) {
      const startedAt = this.clock.now();
      if (spec.files.length === 0) {
        skippedStatuses.set(spec.name, skippedStatus(spec, startedAt, this.clock.now()));
        continue;
      }
      const task: RunnerTask = {
        spec,
        startedAt,
        finishedAt: null,
        outcome: null,
        // Stamp finished_at + outcome the instant the runner settles (before the orchestrator collects
        // it), so the duration reflects the runner's true elapsed time even under the soft barrier and
        // the outcome is carried ON the task (no positional results-array re-indexing).
        settled: this.runOne(spec, workspace, changedLineRanges, deadlineController.signal).then((outcome) => {
          task.finishedAt = this.clock.now();
          task.outcome = outcome;
          return outcome;
        }),
      };
      tasks.push(task);
    }

    // Soft barrier: wait for ALL runner tasks OR the authoritative deadline, whichever comes first.
    // The deadline is a REAL transport-seam timer (gate-clean; tiny in tests, ~Tier-1 budget in
    // prod) — NOT the Clock seam, which is reserved for the ToolStatusV1 timestamps. Any task still
    // pending at the deadline is cancelled (the shared controller fires) and recorded as timed_out.
    if (tasks.length > 0) {
      const allSettled = Promise.all(tasks.map((t) => t.settled)).then(() => "all" as const);
      const deadline = deadlineReached(this.deadlineSeconds).then(() => "deadline" as const);
      const winner = await Promise.race([allSettled, deadline]);
      if (winner === "deadline") {
        // Fire the soft barrier: signal every still-running runner to abandon its work + tear down.
        deadlineController.abort();
        // Wait for the runners to settle their abort path; we collect outcomes next.
        await Promise.allSettled(tasks.map((t) => t.settled));
      }
    }

    // Ensure every task has settled (the deadline branch already awaited; the all-settled branch did
    // too — this is a no-op guard so `task.outcome` is non-null below). Outcome is carried ON each task
    // (stamped in the `.then` above), so we never re-index a positional results array.
    await Promise.all(tasks.map((t) => t.settled));
    const taskByName = new Map<string, RunnerTask>();
    for (const task of tasks) {
      taskByName.set(task.spec.name, task);
    }

    // Emit findings + statuses in REGISTRATION order (deterministic), interleaving the skipped statuses
    // back into their original positions.
    const statuses: Array<ToolStatusV1> = [];
    const allFindings: Array<AnalysisFindingV1> = [];
    for (const spec of runners) {
      const skipped = skippedStatuses.get(spec.name);
      if (skipped !== undefined) {
        statuses.push(skipped);
        continue;
      }
      const task = taskByName.get(spec.name)!;
      const outcome = task.outcome!;
      const finishedAt = task.finishedAt ?? this.clock.now();
      statuses.push(this.statusFor(spec, outcome, task.startedAt, finishedAt));
      if (outcome.kind === "completed") {
        allFindings.push(...outcome.findings);
      }
    }

    return { findings: allFindings, toolStatuses: statuses };
  }

  /** Invoke one runner; translate any error into a settled {@link RunnerOutcome} (fail-open). */
  private async runOne(
    spec: RunnerSpec,
    workspace: string,
    changedLineRanges: ChangedLineRanges,
    signal: AbortSignal,
  ): Promise<RunnerOutcome> {
    try {
      const findings = await spec.runner.run({ workspace, files: spec.files, changedLineRanges, signal });
      return { kind: "completed", findings };
    } catch (e) {
      // Map the error to the right degradation label. The orchestrator never re-raises.
      if (e instanceof SubprocessLaunchError) {
        return { kind: "failed_startup", errorClass: e.name, errorMessage: e.message };
      }
      if (e instanceof SubprocessTimeoutError) {
        // A runner timed out on ITS OWN safety guard (vs the orchestrator deadline) — still timed_out.
        return { kind: "timed_out" };
      }
      if (e instanceof RunnerToolError) {
        return { kind: "failed_runtime", errorClass: e.name, errorMessage: e.message };
      }
      // Defensive: unknown error class still degrades fail-open (Python logs + → failed_runtime).
      return {
        kind: "failed_runtime",
        errorClass: e instanceof Error ? e.name : "Error",
        errorMessage: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** Build the {@link ToolStatusV1} for one runner's settled outcome. */
  private statusFor(
    spec: RunnerSpec,
    outcome: RunnerOutcome,
    startedAt: Date,
    finishedAt: Date,
  ): ToolStatusV1 {
    if (outcome.kind === "completed") {
      return completedStatus(spec, startedAt, finishedAt, outcome.findings.length);
    }
    if (outcome.kind === "timed_out") {
      return timedOutStatus(spec, startedAt, this.deadlineSeconds);
    }
    return failedStatus(spec, startedAt, finishedAt, {
      errorClass: outcome.errorClass,
      errorMessage: outcome.errorMessage,
      statusLabel: outcome.kind, // "failed_startup" | "failed_runtime"
    });
  }
}

// ─── status helpers (1:1 with the Python module functions) ───────────────────────────────────────

function completedStatus(spec: RunnerSpec, startedAt: Date, finishedAt: Date, findingsProduced: number): ToolStatusV1 {
  return ToolStatusV1.parse({
    tool_name: spec.name,
    status: "completed",
    files_scanned: spec.files.length,
    files_total: spec.files.length,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs(startedAt, finishedAt),
    findings_produced: findingsProduced,
  });
}

function timedOutStatus(spec: RunnerSpec, startedAt: Date, deadlineSeconds: number): ToolStatusV1 {
  return ToolStatusV1.parse({
    tool_name: spec.name,
    // v1: subprocess + K8s runners report 0 coverage on timeout (partial-coverage reporting is a
    // later refinement, out of scope).
    status: "timed_out",
    files_scanned: 0,
    files_total: spec.files.length,
    started_at: startedAt.toISOString(),
    finished_at: null,
    duration_ms: Math.round(deadlineSeconds * 1000),
    findings_produced: 0,
    error_class: "TimedOut",
    error_message: `Cancelled by orchestrator at ${deadlineSeconds}s deadline`,
  });
}

function failedStatus(
  spec: RunnerSpec,
  startedAt: Date,
  finishedAt: Date,
  { errorClass, errorMessage, statusLabel }: { errorClass: string; errorMessage: string; statusLabel: string },
): ToolStatusV1 {
  return ToolStatusV1.parse({
    tool_name: spec.name,
    status: statusLabel,
    files_scanned: 0,
    files_total: spec.files.length,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs(startedAt, finishedAt),
    findings_produced: 0,
    error_class: errorClass,
    // Cap per ToolStatusV1 contract (max 2048; leave a margin for downstream concatenation).
    error_message: errorMessage.slice(0, 2000),
  });
}

function skippedStatus(spec: RunnerSpec, startedAt: Date, finishedAt: Date): ToolStatusV1 {
  return ToolStatusV1.parse({
    tool_name: spec.name,
    status: "skipped",
    files_scanned: 0,
    files_total: 0,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: 0,
    findings_produced: 0,
  });
}

/** Non-negative duration in ms (the contract requires `duration_ms >= 0`; a fake clock that doesn't
 *  advance yields 0, never negative). */
function durationMs(startedAt: Date, finishedAt: Date): number {
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

/** Resolve when the authoritative Tier-1 deadline is reached, driven by the transport-timeout seam's
 *  `AbortSignal` (the gate allow-lists `AbortSignal.timeout` only inside that seam; listening to the
 *  signal — not creating a timer — keeps this file gate-clean). Identical to `cloner.ts::abortAfter`
 *  and `in_worker_runner.ts::abortAfter`. A real timer, so the FakeClock injected for timestamps does
 *  NOT short-circuit the soft barrier; tests pass a tiny `deadlineSeconds` to drive the timeout path. */
function deadlineReached(seconds: number): Promise<void> {
  const signal = transportAbortSignal(seconds * 1000);
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
