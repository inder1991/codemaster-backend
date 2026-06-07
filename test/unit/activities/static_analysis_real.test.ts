// REAL end-to-end test of the `StaticAnalysisActivity` body with the ACTUAL ruff/eslint/gitleaks
// binaries wired into the soft-barrier orchestrator. Proves the whole in-worker subsystem composes:
// envelope → language routing → REAL subprocess runners → orchestrator (soft barrier + per-tool
// ToolStatusV1) → MAX_RAW_PER_TOOL cap → changed-line filter → curator input → StaticAnalysisResultV1.
//
// The CURATOR is a fake (the real curator needs a live LLM, tested separately in curator.test.ts /
// curate.parity.test.ts). Everything UPSTREAM of the curator is REAL: the actual tool binaries run as
// real subprocesses against a seeded multi-language workspace. This is the closest the unit tier can
// get to the production activity without a Bedrock call.
//
// Binaries: eslint is the project's node_modules/.bin; ruff/gitleaks resolve via PATH or ~/.local/bin
// (uv tool install). When a binary is unavailable (CI without it) that runner's assertions are skipped
// — the orchestrator's fail-open keeps the activity green regardless. The worker-image binaries are
// owner-provided infra.

import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SLACK_BAIT_TOKEN } from "../../support/slack_bait.js";

import { FakeClock } from "#platform/clock.js";
import { StaticAnalysisActivity } from "#backend/activities/static_analysis.activity.js";
import type { CuratorPort } from "#backend/activities/static_analysis.activity.js";
import { RuffInWorkerRunner } from "#backend/analysis/ruff_runner.js";
import { EslintInWorkerRunner } from "#backend/analysis/eslint_runner.js";
import { GitleaksInWorkerRunner } from "#backend/analysis/gitleaks_runner.js";
import { ESLINT_CONFIG_PATH, RUFF_CONFIG_PATH } from "#backend/analysis/config_assets.js";

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { StaticAnalysisInputV1 } from "#contracts/static_analysis_input.v1.js";
import { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";
import type { PrMetaV1 } from "#contracts/walkthrough.v1.js";

// ─── binary probes (mirror runners.test.ts) ─────────────────────────────────────────────────────

function binaryAvailable(bin: string, versionArgs: ReadonlyArray<string>): string | null {
  for (const candidate of [bin, path.join(os.homedir(), ".local", "bin", bin)]) {
    const r = spawnSync(candidate, [...versionArgs], { encoding: "utf8" });
    if (r.status === 0 || (r.stdout ?? "").length > 0) return candidate;
  }
  return null;
}

const ESLINT_BIN = path.join(process.cwd(), "node_modules", ".bin", "eslint");
const RUFF_BIN = binaryAvailable("ruff", ["--version"]);
const GITLEAKS_BIN = binaryAvailable("gitleaks", ["version"]);

function gitleaksSupportsDevStdout(bin: string | null): boolean {
  if (bin === null) return false;
  const dir = mkdtempSync(path.join(os.tmpdir(), "gl-probe-e2e-"));
  try {
    writeFileSync(
      path.join(dir, "secrets.env"),
      `slack_token=${SLACK_BAIT_TOKEN}\n`,
    );
    const r = spawnSync(
      bin,
      ["detect", "--no-banner", "--report-format=json", "--report-path=/dev/stdout", "--no-git", `--source=${dir}`],
      { encoding: "utf8" },
    );
    return (r.stdout ?? "").trim().startsWith("[");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GITLEAKS_OK = GITLEAKS_BIN !== null && gitleaksSupportsDevStdout(GITLEAKS_BIN);

// ─── a curator double that just echoes its input as promoted findings ────────────────────────────

const PR_META: PrMetaV1 = {
  pr_id: "0123abcd-4567-89ab-cdef-0123456789ab",
  installation_id: "0123abcd-4567-89ab-cdef-0123456789ac",
  repo: "octo/widgets",
  pr_title: "Add the thing",
  pr_description: "A change that adds the thing.",
} as PrMetaV1;

/** Records the findings it was handed; promotes none (we assert on the INPUT it received, which is the
 *  capped + changed-line-filtered set the real runners produced). */
class RecordingCurator implements CuratorPort {
  public saw: ReadonlyArray<AnalysisFindingV1> | undefined;
  public async curate(
    findings: ReadonlyArray<AnalysisFindingV1>,
  ): Promise<{ findings: ReadonlyArray<ReviewFindingV1>; curator_skipped: boolean }> {
    this.saw = findings;
    return { findings: [], curator_skipped: true };
  }
}

function buildRealHolder(curator: CuratorPort): StaticAnalysisActivity {
  return new StaticAnalysisActivity({
    runners: {
      ruff: new RuffInWorkerRunner({ ...(RUFF_BIN ? { ruffPath: RUFF_BIN } : {}), configPath: RUFF_CONFIG_PATH, timeoutSeconds: 30 }),
      eslint: new EslintInWorkerRunner({ eslintPath: ESLINT_BIN, configPath: ESLINT_CONFIG_PATH, timeoutSeconds: 30 }),
      gitleaks: new GitleaksInWorkerRunner({ ...(GITLEAKS_BIN ? { gitleaksPath: GITLEAKS_BIN } : {}), timeoutSeconds: 30 }),
    },
    curator,
    deadlineSeconds: 30,
    clock: new FakeClock(),
  });
}

// ─── tests ─────────────────────────────────────────────────────────────────────────────────────

describe("StaticAnalysisActivity (REAL subprocess end-to-end)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sa-act-")));
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("composes routing → REAL ruff+eslint+gitleaks → orchestrator → cap → filter → curator input", async () => {
    // Seed one bait per tool. The eslint bait is always present (eslint binary always available);
    // ruff/gitleaks baits exercise those runners when their binaries are available.
    await fs.writeFile(path.join(ws, "bad.py"), "import os\n\n\ndef f(x=[]):\n    eval(x)\n");
    await fs.writeFile(path.join(ws, "bad.js"), 'var x = 1;\nfunction f() {\n  eval("1");\n}\n');
    await fs.writeFile(
      path.join(ws, "secrets.env"),
      `slack_token=${SLACK_BAIT_TOKEN}\n`,
    );

    const curator = new RecordingCurator();
    const holder = buildRealHolder(curator);

    const files = ["bad.py", "bad.js", "secrets.env"];
    const input = StaticAnalysisInputV1.parse({
      workspace_path: ws,
      sandbox_files: files,
      // every line of every file is "changed" → the changed-line filter keeps the real findings.
      changed_line_ranges: Object.fromEntries(files.map((f) => [f, [[1, 1000]]])),
      pr_meta: PR_META,
    });

    const result = await holder.staticAnalysis(input);

    // the envelope round-trips through the strict output contract.
    expect(() => StaticAnalysisResultV1.parse(result)).not.toThrow();

    // one status per registered runner, in registration order.
    expect(result.tool_statuses.map((s) => s.tool_name)).toEqual(["ruff", "eslint", "gitleaks"]);

    // eslint is always available → its real findings flow through to tier1_findings + the curator input.
    const tier1Tools = new Set(result.tier1_findings.map((f) => f.tool));
    expect(tier1Tools.has("eslint")).toBe(true);
    const eslintStatus = result.tool_statuses.find((s) => s.tool_name === "eslint")!;
    expect(eslintStatus.status).toBe("completed");
    expect(eslintStatus.findings_produced).toBeGreaterThan(0);
    // the curator got the changed-line-filtered set (all lines changed → eslint findings survive).
    expect(curator.saw?.some((f) => f.tool === "eslint")).toBe(true);

    // ruff (when available) finds the unused-import bait.
    if (RUFF_BIN) {
      expect(tier1Tools.has("ruff")).toBe(true);
      const ruffStatus = result.tool_statuses.find((s) => s.tool_name === "ruff")!;
      expect(ruffStatus.status).toBe("completed");
      expect(result.tier1_findings.some((f) => f.tool === "ruff" && f.rule_id === "F401")).toBe(true);
    }

    // gitleaks (when the local build supports /dev/stdout) finds the seeded secret + redacts it.
    if (GITLEAKS_OK) {
      expect(tier1Tools.has("gitleaks")).toBe(true);
      const gl = result.tier1_findings.filter((f) => f.tool === "gitleaks");
      expect(gl.length).toBeGreaterThan(0);
      for (const f of gl) {
        expect(f.severity_raw).toBe("blocker");
        expect(f.message).not.toContain(SLACK_BAIT_TOKEN);
      }
    }
  }, 60_000);

  it("fail-open: a missing binary DEGRADES (failed_startup) without failing the activity (review survives)", async () => {
    // Point ruff at a non-existent binary → ENOENT → SubprocessLaunchError → failed_startup. eslint
    // still runs for real, so the activity returns a valid envelope with the surviving tool's findings.
    const curator = new RecordingCurator();
    const holder = new StaticAnalysisActivity({
      runners: {
        ruff: new RuffInWorkerRunner({ ruffPath: "/nonexistent/ruff-binary", configPath: RUFF_CONFIG_PATH, timeoutSeconds: 30 }),
        eslint: new EslintInWorkerRunner({ eslintPath: ESLINT_BIN, configPath: ESLINT_CONFIG_PATH, timeoutSeconds: 30 }),
        gitleaks: new GitleaksInWorkerRunner({ gitleaksPath: "/nonexistent/gitleaks-binary", timeoutSeconds: 30 }),
      },
      curator,
      deadlineSeconds: 30,
      clock: new FakeClock(),
    });

    await fs.writeFile(path.join(ws, "bad.js"), 'var x = 1;\nfunction f() {\n  eval("1");\n}\n');
    await fs.writeFile(path.join(ws, "a.py"), "import os\n");

    const files = ["a.py", "bad.js"];
    const result = await holder.staticAnalysis(
      StaticAnalysisInputV1.parse({
        workspace_path: ws,
        sandbox_files: files,
        changed_line_ranges: Object.fromEntries(files.map((f) => [f, [[1, 1000]]])),
        pr_meta: PR_META,
      }),
    );

    // the activity did NOT throw; it returned a valid envelope.
    expect(() => StaticAnalysisResultV1.parse(result)).not.toThrow();
    // the missing-binary tools degraded to failed_startup + are surfaced in per_tool_errors.
    const byName = new Map(result.tool_statuses.map((s) => [s.tool_name, s]));
    expect(byName.get("ruff")?.status).toBe("failed_startup");
    expect(byName.get("gitleaks")?.status).toBe("failed_startup");
    expect(result.per_tool_errors["ruff"]).toBeTruthy();
    expect(result.per_tool_errors["gitleaks"]).toBeTruthy();
    // eslint still ran for real → its findings came through.
    expect(byName.get("eslint")?.status).toBe("completed");
    expect(result.tier1_findings.some((f) => f.tool === "eslint")).toBe(true);
  }, 60_000);
});
