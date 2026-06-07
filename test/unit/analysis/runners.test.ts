/**
 * Unit tests for the three static-analysis runners (Ruff / ESLint / Gitleaks).
 *
 * Three layers:
 *   1. PARSER edge cases — exit-code semantics (≥2 → RunnerToolError), malformed JSON / non-array /
 *      null body → degrade to [], empty stdout → [], severity mapping, secret redaction. (The happy-
 *      path parser parity vs the frozen Python lives in
 *      `test/parity/static_analysis_parsers.parity.test.ts`.)
 *   2. RUNNER fail-open — a missing binary (ENOENT) surfaces as SubprocessLaunchError up the runner
 *      (the orchestrator turns it into a degraded ToolStatusV1; tested in the orchestrator suite).
 *   3. REAL subprocess parity — run the ACTUAL tool binary via `.run()` against a temp workspace and
 *      assert real findings come back. The binaries are installed locally (ruff via uv, gitleaks via
 *      brew, eslint via the project's node_modules); when a binary is unavailable the real test is
 *      skipped (the parser layer + ENOENT layer still cover the contract). The runtime worker-image
 *      binaries are owner-provided infra.
 */

import { spawnSync } from "node:child_process";
import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SLACK_BAIT_TOKEN } from "../../support/slack_bait.js";

import {
  EslintInWorkerRunner,
  RunnerToolError,
  parseEslintOutput,
} from "#backend/analysis/eslint_runner.js";
import {
  GitleaksInWorkerRunner,
  parseGitleaksOutput,
  redactSecret,
} from "#backend/analysis/gitleaks_runner.js";
import {
  RuffInWorkerRunner,
  parseRuffOutput,
  severityForCode,
} from "#backend/analysis/ruff_runner.js";
import { SubprocessLaunchError, type SubprocessResultV1 } from "#backend/analysis/in_worker_runner.js";
import { ESLINT_CONFIG_PATH, RUFF_CONFIG_PATH } from "#backend/analysis/config_assets.js";

function result(exitCode: number, stdout: string, stderr = ""): SubprocessResultV1 {
  return {
    exit_code: exitCode,
    stdout: new Uint8Array(Buffer.from(stdout)),
    stderr: new Uint8Array(Buffer.from(stderr)),
    wall_ms: 1,
  };
}

const WS = "/ws";

// ─── parser edge cases ─────────────────────────────────────────────────────────────────────────

describe("parseRuffOutput edge cases", () => {
  it("exit ≥ 2 raises RunnerToolError carrying stderr", () => {
    expect(() => parseRuffOutput(result(2, "", "fatal config error"), WS)).toThrow(RunnerToolError);
  });
  it("empty stdout → []", () => {
    expect(parseRuffOutput(result(0, ""), WS)).toEqual([]);
  });
  it("malformed JSON → [] (degrade, not crash)", () => {
    expect(parseRuffOutput(result(1, "{not json"), WS)).toEqual([]);
  });
  it("non-array JSON → []", () => {
    expect(parseRuffOutput(result(1, '{"code":"F401"}'), WS)).toEqual([]);
  });
  it("a finding with no message falls back to `<code> matched`", () => {
    const json = JSON.stringify([
      { code: "F401", filename: "/ws/a.py", location: { row: 3 }, end_location: { row: 3 }, message: "" },
    ]);
    const out = parseRuffOutput(result(1, json), WS);
    expect(out[0]!.message).toBe("F401 matched");
    expect(out[0]!.file).toBe("a.py");
    expect(out[0]!.start_line).toBe(3);
  });
  it("end_line < start_line is clamped up to start_line", () => {
    const json = JSON.stringify([
      { code: "E501", filename: "/ws/a.py", location: { row: 9 }, end_location: { row: 2 }, message: "x" },
    ]);
    const out = parseRuffOutput(result(1, json), WS);
    expect(out[0]!.start_line).toBe(9);
    expect(out[0]!.end_line).toBe(9);
  });
});

describe("severityForCode (Ruff prefix → severity_raw)", () => {
  it("maps by longest prefix", () => {
    expect(severityForCode("S307")).toBe("error"); // bandit security
    expect(severityForCode("B006")).toBe("error"); // bugbear
    expect(severityForCode("F401")).toBe("warning"); // pyflakes
    expect(severityForCode("E501")).toBe("warning");
    expect(severityForCode("PLR2004")).toBe("warning"); // 2-char prefix PL
    expect(severityForCode("RUF001")).toBe("warning"); // 3-char prefix RUF
    expect(severityForCode("D100")).toBe("info"); // pydocstyle
    expect(severityForCode("ZZZ999")).toBe("warning"); // unknown → default
  });
});

describe("parseEslintOutput edge cases", () => {
  it("exit ≥ 2 raises RunnerToolError", () => {
    expect(() => parseEslintOutput(result(2, "", "fatal"), WS)).toThrow(RunnerToolError);
  });
  it("severity 1 → warning, 2 → error", () => {
    const json = JSON.stringify([
      {
        filePath: "/ws/a.ts",
        messages: [
          { ruleId: "no-var", severity: 2, line: 1, endLine: 1, message: "no var" },
          { ruleId: "prefer-const", severity: 1, line: 2, endLine: 2, message: "use const" },
        ],
      },
    ]);
    const out = parseEslintOutput(result(1, json), WS);
    expect(out.map((f) => f.severity_raw)).toEqual(["error", "warning"]);
    expect(out[0]!.fix_suggestion).toBeNull();
  });
  it("a null ruleId becomes `unknown`", () => {
    const json = JSON.stringify([
      { filePath: "/ws/a.ts", messages: [{ ruleId: null, severity: 1, line: 1, message: "parse" }] },
    ]);
    const out = parseEslintOutput(result(1, json), WS);
    expect(out[0]!.rule_id).toBe("unknown");
  });
  it("carries a fix.text suggestion", () => {
    const json = JSON.stringify([
      {
        filePath: "/ws/a.ts",
        messages: [{ ruleId: "no-var", severity: 2, line: 1, message: "x", fix: { range: [0, 3], text: "let" } }],
      },
    ]);
    const out = parseEslintOutput(result(1, json), WS);
    expect(out[0]!.fix_suggestion).toBe("let");
  });
});

describe("parseGitleaksOutput edge cases", () => {
  it("exit ≥ 2 raises RunnerToolError", () => {
    expect(() => parseGitleaksOutput(result(2, "", "fatal"), WS)).toThrow(RunnerToolError);
  });
  it("null JSON body → [] (some versions emit null on no findings)", () => {
    expect(parseGitleaksOutput(result(0, "null"), WS)).toEqual([]);
  });
  it("every finding is blocker severity (always-promote)", () => {
    const json = JSON.stringify([
      { RuleID: "aws-key", File: "/ws/s.env", StartLine: 4, EndLine: 4, Description: "AWS", Secret: "AKIA0123456789ABCDEF" },
    ]);
    const out = parseGitleaksOutput(result(1, json), WS);
    expect(out[0]!.severity_raw).toBe("blocker");
    expect(out[0]!.tool).toBe("gitleaks");
    expect(out[0]!.fix_suggestion).toBeNull();
    // redaction: secret not present; masked form is
    expect(out[0]!.message).toContain("AKIA");
    expect(out[0]!.message).toContain("…");
    expect(out[0]!.message).not.toContain("AKIA0123456789ABCDEF");
  });
  it("message fallbacks: rule-only, then `secret detected`", () => {
    const ruleOnly = parseGitleaksOutput(
      result(1, JSON.stringify([{ RuleID: "x", File: "/ws/s", StartLine: 1, EndLine: 1 }])),
      WS,
    );
    expect(ruleOnly[0]!.message).toBe("x matched");
    const bare = parseGitleaksOutput(
      result(1, JSON.stringify([{ File: "/ws/s", StartLine: 1, EndLine: 1 }])),
      WS,
    );
    expect(bare[0]!.message).toBe("secret detected");
  });
});

describe("redactSecret", () => {
  it("masks ≤8-char secrets fully and shows first/last-4 otherwise", () => {
    expect(redactSecret("12345678")).toBe("…".repeat(8)); // 8 chars → 8 ellipses
    expect(redactSecret("AKIA0123456789ABCDEF")).toBe("AKIA…CDEF");
    expect(redactSecret("")).toBe("");
  });
});

// ─── runner fail-open (ENOENT) ───────────────────────────────────────────────────────────────────

describe("runner fail-open on a missing binary", () => {
  it("Ruff: a missing binary surfaces as SubprocessLaunchError", async () => {
    const runner = new RuffInWorkerRunner({ ruffPath: "definitely-not-a-real-binary-xyz", timeoutSeconds: 5 });
    await expect(
      runner.run({ workspace: os.tmpdir(), files: ["a.py"], changedLineRanges: {} }),
    ).rejects.toBeInstanceOf(SubprocessLaunchError);
  });
  it("empty file list → no subprocess, returns []", async () => {
    const runner = new RuffInWorkerRunner({ ruffPath: "definitely-not-a-real-binary-xyz" });
    await expect(runner.run({ workspace: os.tmpdir(), files: [], changedLineRanges: {} })).resolves.toEqual([]);
  });
});

// ─── REAL subprocess parity (binaries installed locally) ─────────────────────────────────────────

function binaryAvailable(bin: string, versionArgs: ReadonlyArray<string>): string | null {
  // Resolve a runnable path: try PATH, then ~/.local/bin (uv tool install location).
  for (const candidate of [bin, path.join(os.homedir(), ".local", "bin", bin)]) {
    const r = spawnSync(candidate, [...versionArgs], { encoding: "utf8" });
    if (r.status === 0 || (r.stdout ?? "").length > 0) return candidate;
  }
  return null;
}

const ESLINT_BIN = path.join(process.cwd(), "node_modules", ".bin", "eslint");
const RUFF_BIN = binaryAvailable("ruff", ["--version"]);
const GITLEAKS_BIN = binaryAvailable("gitleaks", ["version"]);

/**
 * Probe whether THIS gitleaks build can write its report to `/dev/stdout` (the production command
 * shape, matching the frozen Python). Gitleaks 8.30.x on macOS opens `/dev/stdout` directly and
 * fails ("permission denied") when stdout is a pipe; the OpenShift worker-image build supports it.
 * When the local build can't, the REAL gitleaks run is skipped — the parser parity (over the
 * recorded real fixture) + the ENOENT fail-open already cover the runner contract. This is purely a
 * local-binary-version gate, NOT a production concern (the worker-image binary is owner-provided).
 */
function gitleaksSupportsDevStdout(bin: string | null): boolean {
  if (bin === null) return false;
  const dir = mkdtempSync(path.join(os.tmpdir(), "gl-probe-"));
  try {
    writeFileSync(path.join(dir, "secrets.env"), `slack_token=${SLACK_BAIT_TOKEN}\n`);
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

const GITLEAKS_DEV_STDOUT_OK = gitleaksSupportsDevStdout(GITLEAKS_BIN);

describe("REAL subprocess: runners against actual tool binaries", () => {
  let ws: string;
  beforeEach(async () => {
    // realpath so the workspace matches the absolute paths the tools emit (macOS symlinks
    // /tmp → /private/tmp; the Linux worker image has no such symlink, and the production cwd is the
    // already-realpath'd cloned workspace). Without this, `relativeToWorkspace` would (correctly)
    // fall back to its not-under-workspace passthrough on this dev host.
    ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sa-real-")));
  });
  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it.runIf(RUFF_BIN)("Ruff finds the seeded bait with the bundled config", async () => {
    await fs.writeFile(path.join(ws, "bad.py"), "import os\n\n\ndef f(x=[]):\n    eval(x)\n");
    const runner = new RuffInWorkerRunner({ ruffPath: RUFF_BIN!, configPath: RUFF_CONFIG_PATH, timeoutSeconds: 30 });
    const findings = await runner.run({ workspace: ws, files: ["bad.py"], changedLineRanges: {} });
    expect(findings.length).toBeGreaterThan(0);
    const codes = findings.map((f) => f.rule_id);
    expect(codes).toContain("F401"); // unused import os
    expect(findings.every((f) => f.tool === "ruff")).toBe(true);
    expect(findings.every((f) => f.file === "bad.py")).toBe(true);
  }, 30_000);

  it("ESLint finds the seeded bait with the bundled config", async () => {
    await fs.writeFile(path.join(ws, "bad.js"), 'var x = 1;\nfunction f() {\n  eval("1");\n}\n');
    const runner = new EslintInWorkerRunner({ eslintPath: ESLINT_BIN, configPath: ESLINT_CONFIG_PATH, timeoutSeconds: 30 });
    const findings = await runner.run({ workspace: ws, files: ["bad.js"], changedLineRanges: {} });
    expect(findings.length).toBeGreaterThan(0);
    const rules = findings.map((f) => f.rule_id);
    expect(rules).toContain("no-var");
    expect(rules).toContain("no-eval");
    expect(findings.every((f) => f.tool === "eslint")).toBe(true);
  }, 30_000);

  it.runIf(GITLEAKS_BIN && GITLEAKS_DEV_STDOUT_OK)("Gitleaks finds the seeded secret + redacts it", async () => {
    await fs.writeFile(
      path.join(ws, "secrets.env"),
      `slack_token=${SLACK_BAIT_TOKEN}\n`,
    );
    const runner = new GitleaksInWorkerRunner({ gitleaksPath: GITLEAKS_BIN!, timeoutSeconds: 30 });
    const findings = await runner.run({ workspace: ws, files: ["secrets.env"], changedLineRanges: {} });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.severity_raw === "blocker")).toBe(true);
    for (const f of findings) {
      expect(f.message).not.toContain(SLACK_BAIT_TOKEN);
      expect(f.message).toContain("…");
    }
  }, 30_000);
});
