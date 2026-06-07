/**
 * Unit tests for the TS `StaticAnalysisOrchestrator` — the NEWER soft-barrier deadline orchestrator
 * (1:1 port of `vendor/codemaster-py/codemaster/analysis/static_analysis_orchestrator.py`).
 *
 * Division of labor (1:1 with the frozen Python): the orchestrator OWNS the Tier-1 deadline, spawns
 * the runners concurrently, applies the SOFT BARRIER (collect-until-deadline then cancel-remaining),
 * and returns `(findings, tool_statuses)` where `findings` are RAW + uncapped + unfiltered (flattened
 * across tools in registration order) and `tool_statuses` is one {@link ToolStatusV1} per registered
 * runner. The MAX_RAW_PER_TOOL cap + the changed-line filter + the curator live in the static-analysis
 * ACTIVITY (`static_analysis.activity.ts`), exactly as the frozen Python's `static_analysis_pipeline`
 * owns the cap/filter and `static_analysis.py` activity assembles the envelope — NOT in the orchestrator.
 *
 * Surface under test (every behavior the owner pinned as exact):
 *   - empty runner list → ([], []) default;
 *   - runners run INDEPENDENTLY + concurrently; one tool's RECOVERABLE failure DEGRADES (a failure
 *     ToolStatusV1) without failing the others;
 *   - empty-files runner → `skipped` status, never spawned;
 *   - per-tool ToolStatusV1 is a FIRST-CLASS output (completed / failed_startup / failed_runtime /
 *     timed_out / skipped), one per registered runner;
 *   - soft barrier: a runner that overruns the deadline is cancelled + recorded `timed_out`;
 *   - deterministic ordering (findings + statuses follow runner registration order);
 *   - findings are RAW (no cap, no changed-line filter applied by the orchestrator).
 */

import { describe, expect, it } from "vitest";

import { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { FakeClock } from "#platform/clock.js";
import { RunnerToolError } from "#backend/analysis/eslint_runner.js";
import {
  SubprocessLaunchError,
  SubprocessTimeoutError,
} from "#backend/analysis/in_worker_runner.js";
import {
  StaticAnalysisOrchestrator,
  type RunnerSpec,
} from "#backend/analysis/static_analysis_orchestrator.js";
import type { AnalysisRunner, RunnerRunInput } from "#backend/analysis/runner_port.js";

// ─── fakes ───────────────────────────────────────────────────────────────────────────────────────

function finding(tool: "ruff" | "eslint" | "gitleaks", file: string, line: number): AnalysisFindingV1 {
  return AnalysisFindingV1.parse({
    finding_id: "00000000-0000-4000-8000-000000000000",
    tool,
    rule_id: `${tool}-rule`,
    file,
    start_line: line,
    end_line: line,
    severity_raw: "warning",
    message: `${tool} finding at ${file}:${line}`,
    fix_suggestion: null,
  });
}

type FakeBehavior =
  | { kind: "ok"; findings: ReadonlyArray<AnalysisFindingV1> }
  | { kind: "throw"; error: Error }
  | { kind: "hang" };

class FakeRunner implements AnalysisRunner {
  public ranWith: RunnerRunInput | undefined;
  public constructor(
    public readonly name: string,
    private readonly behavior: FakeBehavior,
    private readonly clock?: FakeClock,
    private readonly advanceOnRunSeconds?: number,
  ) {}

  public async run(input: RunnerRunInput): Promise<ReadonlyArray<AnalysisFindingV1>> {
    this.ranWith = input;
    if (this.behavior.kind === "throw") throw this.behavior.error;
    if (this.behavior.kind === "hang") {
      // Never resolve until the deadline cancels via the abort signal.
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new SubprocessTimeoutError({ command: [this.name], wallMs: 1 });
    }
    // ok: optionally advance the clock to model elapsed time, then return.
    if (this.clock && this.advanceOnRunSeconds) this.clock.advance({ seconds: this.advanceOnRunSeconds });
    return this.behavior.findings;
  }
}

const ALL_CHANGED: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>> = {
  "a.py": [[1, 1000]],
  "b.ts": [[1, 1000]],
  "secrets.env": [[1, 1000]],
};

function spec(runner: AnalysisRunner, files: ReadonlyArray<string>): RunnerSpec {
  return { name: runner.name, runner, files };
}

// ─── tests ───────────────────────────────────────────────────────────────────────────────────────

describe("StaticAnalysisOrchestrator", () => {
  it("empty runner list → empty findings / statuses", async () => {
    const orch = new StaticAnalysisOrchestrator({ deadlineSeconds: 30, clock: new FakeClock() });
    const out = await orch.run({ runners: [], workspace: "/ws", changedLineRanges: {} });
    expect(out.findings).toEqual([]);
    expect(out.toolStatuses).toEqual([]);
  });

  it("runs runners independently + concurrently; collects all findings in registration order", async () => {
    const clock = new FakeClock();
    const ruff = new FakeRunner("ruff", { kind: "ok", findings: [finding("ruff", "a.py", 5)] }, clock);
    const eslint = new FakeRunner("eslint", { kind: "ok", findings: [finding("eslint", "b.ts", 10)] }, clock);
    const orch = new StaticAnalysisOrchestrator({ deadlineSeconds: 30, clock });
    const out = await orch.run({
      runners: [spec(ruff, ["a.py"]), spec(eslint, ["b.ts"])],
      workspace: "/ws",
      changedLineRanges: ALL_CHANGED,
    });
    expect(out.findings.map((f) => f.tool)).toEqual(["ruff", "eslint"]);
    expect(out.toolStatuses.map((s) => s.tool_name)).toEqual(["ruff", "eslint"]);
    expect(out.toolStatuses.map((s) => s.status)).toEqual(["completed", "completed"]);
    // both actually ran with the files routed to them
    expect(ruff.ranWith?.files).toEqual(["a.py"]);
    expect(eslint.ranWith?.files).toEqual(["b.ts"]);
  });

  it("a recoverable tool failure DEGRADES (failure status) without failing the others", async () => {
    const clock = new FakeClock();
    const okRunner = new FakeRunner("eslint", { kind: "ok", findings: [finding("eslint", "b.ts", 10)] }, clock);
    const launchFail = new FakeRunner("ruff", {
      kind: "throw",
      error: new SubprocessLaunchError({ command: ["ruff"], reason: "spawn ruff ENOENT" }),
    });
    const runtimeFail = new FakeRunner("gitleaks", {
      kind: "throw",
      error: new RunnerToolError({ tool: "gitleaks", exitCode: 3, stderr: "boom" }),
    });
    const orch = new StaticAnalysisOrchestrator({ deadlineSeconds: 30, clock });
    const out = await orch.run({
      runners: [spec(launchFail, ["a.py"]), spec(okRunner, ["b.ts"]), spec(runtimeFail, ["secrets.env"])],
      workspace: "/ws",
      changedLineRanges: ALL_CHANGED,
    });
    // findings from the surviving tool only
    expect(out.findings.map((f) => f.tool)).toEqual(["eslint"]);
    // statuses: one per runner, in order, with the right degradation labels
    const byName = new Map(out.toolStatuses.map((s) => [s.tool_name, s]));
    expect(byName.get("ruff")?.status).toBe("failed_startup");
    expect(byName.get("ruff")?.error_class).toBe("SubprocessLaunchError");
    expect(byName.get("eslint")?.status).toBe("completed");
    expect(byName.get("gitleaks")?.status).toBe("failed_runtime");
    expect(byName.get("gitleaks")?.error_class).toBe("RunnerToolError");
  });

  it("empty-files runner is marked `skipped` and never spawned", async () => {
    const clock = new FakeClock();
    const skipped = new FakeRunner("gitleaks", { kind: "throw", error: new Error("should not run") });
    const orch = new StaticAnalysisOrchestrator({ deadlineSeconds: 30, clock });
    const out = await orch.run({
      runners: [spec(skipped, [])],
      workspace: "/ws",
      changedLineRanges: ALL_CHANGED,
    });
    expect(out.toolStatuses).toHaveLength(1);
    expect(out.toolStatuses[0]!.status).toBe("skipped");
    expect(out.toolStatuses[0]!.files_total).toBe(0);
    expect(skipped.ranWith).toBeUndefined();
  });

  it("soft barrier: a runner that overruns the deadline is cancelled + recorded `timed_out`", async () => {
    const clock = new FakeClock();
    const hanger = new FakeRunner("ruff", { kind: "hang" });
    const quick = new FakeRunner("eslint", { kind: "ok", findings: [finding("eslint", "b.ts", 3)] }, clock);
    const orch = new StaticAnalysisOrchestrator({ deadlineSeconds: 0.05, clock });
    const out = await orch.run({
      runners: [spec(hanger, ["a.py"]), spec(quick, ["b.ts"])],
      workspace: "/ws",
      changedLineRanges: ALL_CHANGED,
    });
    const byName = new Map(out.toolStatuses.map((s) => [s.tool_name, s]));
    expect(byName.get("ruff")?.status).toBe("timed_out");
    expect(byName.get("ruff")?.error_class).toBe("TimedOut");
    expect(byName.get("eslint")?.status).toBe("completed");
    // only the quick runner's findings survived
    expect(out.findings.map((f) => f.tool)).toEqual(["eslint"]);
  });

  it("returns RAW findings (no MAX_RAW_PER_TOOL cap, no changed-line filter — those live in the activity)", async () => {
    const clock = new FakeClock();
    // 600 ruff findings, half of them outside any changed range — the orchestrator returns ALL of them
    // raw. Capping (to 500) + the changed-line filter happen in the activity, not here.
    const many = Array.from({ length: 600 }, (_unused, i) => finding("ruff", "a.py", i + 1));
    const ruff = new FakeRunner("ruff", { kind: "ok", findings: many }, clock);
    const orch = new StaticAnalysisOrchestrator({ deadlineSeconds: 30, clock });
    const out = await orch.run({
      runners: [spec(ruff, ["a.py"])],
      workspace: "/ws",
      // a tight range that would drop most findings IF the orchestrator filtered — it must NOT.
      changedLineRanges: { "a.py": [[1, 3]] },
    });
    expect(out.findings).toHaveLength(600);
    // the ToolStatusV1 reports the finding count the tool produced.
    expect(out.toolStatuses[0]!.findings_produced).toBe(600);
  });

  it("threads changedLineRanges + workspace into the runner input (runners accept-but-ignore the ranges)", async () => {
    const clock = new FakeClock();
    const ruff = new FakeRunner("ruff", { kind: "ok", findings: [] }, clock);
    const orch = new StaticAnalysisOrchestrator({ deadlineSeconds: 30, clock });
    await orch.run({
      runners: [spec(ruff, ["a.py"])],
      workspace: "/ws",
      changedLineRanges: ALL_CHANGED,
    });
    expect(ruff.ranWith?.changedLineRanges).toBe(ALL_CHANGED);
    expect(ruff.ranWith?.workspace).toBe("/ws");
  });
});
