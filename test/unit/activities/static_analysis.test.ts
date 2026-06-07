// Unit tests for the REAL `staticAnalysis` activity (StaticAnalysisActivity holder) — 1:1 port of the
// frozen Python `StaticAnalysisActivity` (vendor/codemaster-py/codemaster/activities/static_analysis.py)
// + the production `_ProductionPipeline` wiring (vendor/.../worker/main.py:2275-2327).
//
// The holder owns: the in-worker runners (ruff/eslint/gitleaks), the soft-barrier orchestrator
// (StaticAnalysisOrchestrator — deadline + clock), and the AnalysisCurator. The bound activity method:
//   1. empty sandbox_files → default StaticAnalysisResultV1 (no runner fires);
//   2. else routes files by language → RunnerSpec list → orchestrator → raw findings + tool_statuses;
//   3. tier1_findings = the RAW orchestrator findings;
//   4. MAX_RAW_PER_TOOL cap per-tool (records truncated_per_tool), THEN changed-line filter;
//   5. curator promotes filtered → ReviewFindingV1 findings + curator_skipped;
//   6. per_tool_errors derived from the failed/timed-out tool statuses;
//   7. assembles StaticAnalysisResultV1.{findings, tier1_findings, tool_statuses, per_tool_errors,
//      truncated_per_tool, curator_skipped}.
//
// These tests inject FAKE runners (in-memory AnalysisFindingV1 producers / throwers) + a FAKE curator
// (records its input, returns canned ReviewFindingV1s) — the real runners + curator are tested in
// test/unit/analysis/. NO subprocess, NO LLM, NO DB.

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { StaticAnalysisActivity, MAX_RAW_PER_TOOL } from "#backend/activities/static_analysis.activity.js";
import type { CuratorPort } from "#backend/activities/static_analysis.activity.js";
import type { AnalysisRunner, RunnerRunInput } from "#backend/analysis/runner_port.js";

import { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { StaticAnalysisInputV1 } from "#contracts/static_analysis_input.v1.js";
import { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";
import type { PrMetaV1 } from "#contracts/walkthrough.v1.js";

// ─── fixtures ──────────────────────────────────────────────────────────────────────────────────

const PR_META = {
  pr_id: "0123abcd-4567-89ab-cdef-0123456789ab",
  installation_id: "0123abcd-4567-89ab-cdef-0123456789ac",
  repo: "octo/widgets",
  pr_title: "Add the thing",
  pr_description: "A change that adds the thing.",
};

let seq = 0;
function finding(
  tool: "ruff" | "eslint" | "gitleaks",
  file: string,
  line: number,
  rule = `${tool}-rule`,
): AnalysisFindingV1 {
  seq += 1;
  const hex = seq.toString(16).padStart(12, "0");
  return AnalysisFindingV1.parse({
    finding_id: `00000000-0000-4000-8000-${hex}`,
    tool,
    rule_id: rule,
    file,
    start_line: line,
    end_line: line,
    severity_raw: tool === "gitleaks" ? "blocker" : "warning",
    message: `${tool} finding`,
    fix_suggestion: null,
  });
}

class FakeRunner implements AnalysisRunner {
  public ranWith: RunnerRunInput | undefined;
  public constructor(
    public readonly name: string,
    private readonly behavior: { kind: "ok"; findings: ReadonlyArray<AnalysisFindingV1> } | { kind: "throw"; error: Error },
  ) {}

  public async run(input: RunnerRunInput): Promise<ReadonlyArray<AnalysisFindingV1>> {
    this.ranWith = input;
    if (this.behavior.kind === "throw") throw this.behavior.error;
    return this.behavior.findings;
  }
}

/** A curator double: records the (findings, prMeta) it received, returns a canned CuratedResult. */
class FakeCurator implements CuratorPort {
  public sawFindings: ReadonlyArray<AnalysisFindingV1> | undefined;
  public sawPrMeta: PrMetaV1 | undefined;
  public constructor(
    private readonly result: { findings: ReadonlyArray<ReviewFindingV1>; curator_skipped: boolean },
  ) {}

  public async curate(
    findings: ReadonlyArray<AnalysisFindingV1>,
    args: { prMeta: PrMetaV1 },
  ): Promise<{ findings: ReadonlyArray<ReviewFindingV1>; curator_skipped: boolean }> {
    this.sawFindings = findings;
    this.sawPrMeta = args.prMeta;
    return this.result;
  }
}

function reviewFinding(file: string, line: number): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file,
    start_line: line,
    end_line: line,
    severity: "issue",
    category: "bug",
    title: "promoted",
    body: "a promoted finding",
    suggestion: null,
    confidence: 0.8,
  });
}

function buildHolder(args: {
  runners: { ruff: AnalysisRunner; eslint: AnalysisRunner; gitleaks: AnalysisRunner };
  curator: CuratorPort;
  deadlineSeconds?: number;
}): StaticAnalysisActivity {
  return new StaticAnalysisActivity({
    runners: args.runners,
    curator: args.curator,
    deadlineSeconds: args.deadlineSeconds ?? 30,
    clock: new FakeClock(),
  });
}

function input(overrides: Partial<Record<string, unknown>> = {}): StaticAnalysisInputV1 {
  return StaticAnalysisInputV1.parse({
    workspace_path: "/tmp/ws",
    sandbox_files: ["a.py", "b.ts"],
    changed_line_ranges: { "a.py": [[1, 100]], "b.ts": [[1, 100]] },
    pr_meta: PR_META,
    ...overrides,
  });
}

// ─── tests ─────────────────────────────────────────────────────────────────────────────────────

describe("StaticAnalysisActivity (real runner orchestration)", () => {
  it("empty sandbox_files → default StaticAnalysisResultV1 (no runner fires)", async () => {
    const ruff = new FakeRunner("ruff", { kind: "ok", findings: [] });
    const eslint = new FakeRunner("eslint", { kind: "ok", findings: [] });
    const gitleaks = new FakeRunner("gitleaks", { kind: "ok", findings: [] });
    const curator = new FakeCurator({ findings: [], curator_skipped: true });
    const holder = buildHolder({ runners: { ruff, eslint, gitleaks }, curator });

    const result = await holder.staticAnalysis(input({ sandbox_files: [], changed_line_ranges: {} }));

    expect(() => StaticAnalysisResultV1.parse(result)).not.toThrow();
    expect(result.findings).toEqual([]);
    expect(result.tier1_findings).toEqual([]);
    expect(result.tool_statuses).toEqual([]);
    expect(result.curator_skipped).toBe(true);
    // no runner was ever invoked
    expect(ruff.ranWith).toBeUndefined();
    expect(eslint.ranWith).toBeUndefined();
    expect(gitleaks.ranWith).toBeUndefined();
  });

  it("routes files by language: .py→ruff, .ts/.tsx/.js/.jsx→eslint, ALL files→gitleaks", async () => {
    const ruff = new FakeRunner("ruff", { kind: "ok", findings: [] });
    const eslint = new FakeRunner("eslint", { kind: "ok", findings: [] });
    const gitleaks = new FakeRunner("gitleaks", { kind: "ok", findings: [] });
    const curator = new FakeCurator({ findings: [], curator_skipped: true });
    const holder = buildHolder({ runners: { ruff, eslint, gitleaks }, curator });

    const files = ["a.py", "b.ts", "c.tsx", "d.js", "e.jsx", "f.go", "secrets.env"];
    await holder.staticAnalysis(
      input({ sandbox_files: files, changed_line_ranges: Object.fromEntries(files.map((f) => [f, [[1, 100]]])) }),
    );

    expect(ruff.ranWith?.files).toEqual(["a.py"]);
    expect(eslint.ranWith?.files).toEqual(["b.ts", "c.tsx", "d.js", "e.jsx"]);
    // gitleaks scans the WHOLE file set (secret scanner; file-language irrelevant)
    expect(gitleaks.ranWith?.files).toEqual(files);
  });

  it("tier1_findings = the RAW orchestrator findings (pre-cap, pre-filter, pre-curator)", async () => {
    // ruff emits a finding OUTSIDE the changed range; it survives in tier1_findings (raw) but is
    // dropped from the curated `findings` path by the changed-line filter.
    const ruff = new FakeRunner("ruff", { kind: "ok", findings: [finding("ruff", "a.py", 999)] });
    const eslint = new FakeRunner("eslint", { kind: "ok", findings: [] });
    const gitleaks = new FakeRunner("gitleaks", { kind: "ok", findings: [] });
    const curator = new FakeCurator({ findings: [], curator_skipped: true });
    const holder = buildHolder({ runners: { ruff, eslint, gitleaks }, curator });

    const result = await holder.staticAnalysis(
      input({ sandbox_files: ["a.py"], changed_line_ranges: { "a.py": [[1, 10]] } }),
    );

    expect(result.tier1_findings).toHaveLength(1);
    expect(result.tier1_findings[0]!.start_line).toBe(999);
    // the curator got the CHANGED-LINE-FILTERED set: the 999 finding was dropped before curation
    expect(curator.sawFindings).toEqual([]);
  });

  it("caps raw findings at MAX_RAW_PER_TOOL per tool BEFORE the changed-line filter; records truncated_per_tool", async () => {
    const overflow = MAX_RAW_PER_TOOL + 7;
    const many = Array.from({ length: overflow }, (_u, i) => finding("ruff", "a.py", i + 1));
    const ruff = new FakeRunner("ruff", { kind: "ok", findings: many });
    const eslint = new FakeRunner("eslint", { kind: "ok", findings: [] });
    const gitleaks = new FakeRunner("gitleaks", { kind: "ok", findings: [] });
    const curator = new FakeCurator({ findings: [], curator_skipped: true });
    const holder = buildHolder({ runners: { ruff, eslint, gitleaks }, curator });

    const result = await holder.staticAnalysis(
      input({ sandbox_files: ["a.py"], changed_line_ranges: { "a.py": [[1, 100_000]] } }),
    );

    // tier1_findings keeps ALL raw findings (cap is for the curator budget, not the Tier-2 prompt)
    expect(result.tier1_findings).toHaveLength(overflow);
    expect(result.truncated_per_tool).toEqual({ ruff: 7 });
    // the curator saw the capped (then filtered) set: exactly MAX_RAW_PER_TOOL
    expect(curator.sawFindings).toHaveLength(MAX_RAW_PER_TOOL);
  });

  it("passes the changed-line-filtered findings to the curator; returns its findings + curator_skipped", async () => {
    const ruff = new FakeRunner("ruff", {
      kind: "ok",
      findings: [finding("ruff", "a.py", 5), finding("ruff", "a.py", 50)],
    });
    const eslint = new FakeRunner("eslint", { kind: "ok", findings: [] });
    const gitleaks = new FakeRunner("gitleaks", { kind: "ok", findings: [] });
    const promoted = reviewFinding("a.py", 5);
    const curator = new FakeCurator({ findings: [promoted], curator_skipped: false });
    const holder = buildHolder({ runners: { ruff, eslint, gitleaks }, curator });

    const result = await holder.staticAnalysis(
      input({ sandbox_files: ["a.py"], changed_line_ranges: { "a.py": [[1, 10]] } }),
    );

    // only the line-5 finding is in the changed range [1,10]; line-50 is dropped before curation
    expect(curator.sawFindings?.map((f) => f.start_line)).toEqual([5]);
    expect(curator.sawPrMeta?.repo).toBe("octo/widgets");
    expect(result.findings).toEqual([promoted]);
    expect(result.curator_skipped).toBe(false);
  });

  it("a recoverable runner failure DEGRADES (per_tool_errors + failed status); the review survives", async () => {
    const ruff = new FakeRunner("ruff", {
      kind: "throw",
      // a launch failure (binary missing) — the orchestrator records failed_startup
      error: new (await import("#backend/analysis/in_worker_runner.js")).SubprocessLaunchError({
        command: ["ruff"],
        reason: "spawn ruff ENOENT",
      }),
    });
    const eslint = new FakeRunner("eslint", { kind: "ok", findings: [finding("eslint", "b.ts", 3)] });
    const gitleaks = new FakeRunner("gitleaks", { kind: "ok", findings: [] });
    const promoted = reviewFinding("b.ts", 3);
    const curator = new FakeCurator({ findings: [promoted], curator_skipped: false });
    const holder = buildHolder({ runners: { ruff, eslint, gitleaks }, curator });

    const result = await holder.staticAnalysis(
      input({ sandbox_files: ["a.py", "b.ts"], changed_line_ranges: { "a.py": [[1, 100]], "b.ts": [[1, 100]] } }),
    );

    // the review did NOT fail; the surviving tool's curated finding came through
    expect(result.findings).toEqual([promoted]);
    // per_tool_errors carries the degraded tool with its error message
    expect(result.per_tool_errors["ruff"]).toContain("ruff");
    expect(result.per_tool_errors["eslint"]).toBeUndefined();
    // the failed tool's status is first-class in tool_statuses
    const byName = new Map(result.tool_statuses.map((s) => [s.tool_name, s]));
    expect(byName.get("ruff")?.status).toBe("failed_startup");
    expect(byName.get("eslint")?.status).toBe("completed");
  });

  it("gitleaks findings flow through the orchestrator → curator (always-promoted there); statuses are first-class", async () => {
    // The curator does the gitleaks always-promote; the activity just routes + assembles. Here the fake
    // curator stands in for that promotion. We assert the activity hands gitleaks findings to the curator
    // and surfaces the gitleaks status.
    const ruff = new FakeRunner("ruff", { kind: "ok", findings: [] });
    const eslint = new FakeRunner("eslint", { kind: "ok", findings: [] });
    const gitleaks = new FakeRunner("gitleaks", {
      kind: "ok",
      findings: [finding("gitleaks", "secrets.env", 14, "aws-access-token")],
    });
    const promotedSecret = ReviewFindingV1.parse({
      file: "secrets.env",
      start_line: 14,
      end_line: 14,
      severity: "blocker",
      category: "security",
      title: "gitleaks: aws-access-token",
      body: "secret",
      suggestion: null,
      confidence: 0.99,
    });
    const curator = new FakeCurator({ findings: [promotedSecret], curator_skipped: true });
    const holder = buildHolder({ runners: { ruff, eslint, gitleaks }, curator });

    const result = await holder.staticAnalysis(
      input({ sandbox_files: ["secrets.env"], changed_line_ranges: { "secrets.env": [[1, 100]] } }),
    );

    expect(curator.sawFindings?.map((f) => f.tool)).toEqual(["gitleaks"]);
    expect(result.findings).toEqual([promotedSecret]);
    const byName = new Map(result.tool_statuses.map((s) => [s.tool_name, s]));
    expect(byName.get("gitleaks")?.status).toBe("completed");
  });

  it("returns a strictly-valid StaticAnalysisResultV1 the orchestrator's Step-3b round-trip accepts", async () => {
    const ruff = new FakeRunner("ruff", { kind: "ok", findings: [finding("ruff", "a.py", 5)] });
    const eslint = new FakeRunner("eslint", { kind: "ok", findings: [] });
    const gitleaks = new FakeRunner("gitleaks", { kind: "ok", findings: [] });
    const curator = new FakeCurator({ findings: [reviewFinding("a.py", 5)], curator_skipped: false });
    const holder = buildHolder({ runners: { ruff, eslint, gitleaks }, curator });

    const result = await holder.staticAnalysis(
      input({ sandbox_files: ["a.py"], changed_line_ranges: { "a.py": [[1, 10]] } }),
    );

    expect(() => StaticAnalysisResultV1.parse(result)).not.toThrow();
    expect(result.schema_version).toBe(1);
  });
});
