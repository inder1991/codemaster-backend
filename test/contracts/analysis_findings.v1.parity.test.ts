import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { AnalysisFindingV1 } from "../../libs/contracts/src/analysis_findings.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (via the oracle —
// `<Model>(**payload).model_dump(mode="json")`) and through Zod (`<Model>.parse(payload)`), then diff
// canonical JSON. Accept/reject must also agree. Follows the markdown_chunk.v1 / review_findings.v1
// template.
const PY = "contracts.analysis_findings.v1";

// Pydantic lowercases UUIDs on dump; keep payloads canonical-lowercase so Zod (which does not
// lowercase) and Pydantic agree byte-for-byte.
const FINDING_ID = "11111111-2222-4333-8444-555555555555";

describe("AnalysisFindingV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a full payload identically", async () => {
    const payload = {
      finding_id: FINDING_ID,
      tool: "ruff",
      rule_id: "E501",
      file: "src/app.py",
      start_line: 10,
      end_line: 20,
      severity_raw: "warning",
      message: "Line too long.",
      fix_suggestion: "Wrap the line.",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AnalysisFindingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(AnalysisFindingV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies all the same defaults when optional fields omitted", async () => {
    const payload = {
      finding_id: FINDING_ID,
      tool: "eslint",
      rule_id: "no-unused-vars",
      file: "src/a.ts",
      start_line: 1,
      end_line: 1,
      severity_raw: "error",
      message: "Unused variable.",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AnalysisFindingV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    const zodCanon = canonicalize(AnalysisFindingV1.parse(payload));
    expect(zodCanon).toBe(r.out);
    // Defaults: schema_version=1, fix_suggestion=null.
    const z = JSON.parse(zodCanon) as Record<string, unknown>;
    expect(z.schema_version).toBe(1);
    expect(z.fix_suggestion).toBeNull();
  }, 30_000);

  it("accepts every Tool enum value identically", async () => {
    const tools = [
      "eslint",
      "ruff",
      "gitleaks",
      "semgrep",
      "trivy",
      "checkov",
      "kube-linter",
      "golangci-lint",
      "clippy",
      "rubocop",
      "shellcheck",
      "hadolint",
    ];
    for (const tool of tools) {
      const payload = {
        finding_id: FINDING_ID,
        tool,
        rule_id: "r",
        file: "f",
        start_line: 1,
        end_line: 1,
        severity_raw: "info",
        message: "m",
      };
      const r = await pyRef({ pyModule: PY, pyCallable: "AnalysisFindingV1", kwargs: payload });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(AnalysisFindingV1.parse(payload))).toBe(r.out);
    }
  }, 60_000);

  it("both REJECT an out-of-range value (start_line < 1)", async () => {
    const bad = {
      finding_id: FINDING_ID,
      tool: "ruff",
      rule_id: "E501",
      file: "a.py",
      start_line: 0,
      end_line: 1,
      severity_raw: "warning",
      message: "m",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AnalysisFindingV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => AnalysisFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a rule_id that exceeds max_length (200)", async () => {
    const bad = {
      finding_id: FINDING_ID,
      tool: "ruff",
      rule_id: "x".repeat(201),
      file: "a.py",
      start_line: 1,
      end_line: 1,
      severity_raw: "warning",
      message: "m",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AnalysisFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AnalysisFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty message (min_length=1)", async () => {
    const bad = {
      finding_id: FINDING_ID,
      tool: "ruff",
      rule_id: "E501",
      file: "a.py",
      start_line: 1,
      end_line: 1,
      severity_raw: "warning",
      message: "",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AnalysisFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AnalysisFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an invalid Tool enum value (out of vocabulary)", async () => {
    const bad = {
      finding_id: FINDING_ID,
      tool: "not_a_tool",
      rule_id: "E501",
      file: "a.py",
      start_line: 1,
      end_line: 1,
      severity_raw: "warning",
      message: "m",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AnalysisFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AnalysisFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed finding_id (not a UUID)", async () => {
    const bad = {
      finding_id: "not-a-uuid",
      tool: "ruff",
      rule_id: "E501",
      file: "a.py",
      start_line: 1,
      end_line: 1,
      severity_raw: "warning",
      message: "m",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AnalysisFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AnalysisFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required finding_id", async () => {
    const bad = {
      tool: "ruff",
      rule_id: "E501",
      file: "a.py",
      start_line: 1,
      end_line: 1,
      severity_raw: "warning",
      message: "m",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AnalysisFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AnalysisFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT the line-range validator (_check_line_range: end_line < start_line)", async () => {
    const bad = {
      finding_id: FINDING_ID,
      tool: "ruff",
      rule_id: "E501",
      file: "a.py",
      start_line: 20,
      end_line: 10,
      severity_raw: "warning",
      message: "m",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AnalysisFindingV1", kwargs: bad });
    expect(r.ok).toBe(false); // ValueError from @model_validator
    expect(() => AnalysisFindingV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      finding_id: FINDING_ID,
      tool: "ruff",
      rule_id: "E501",
      file: "a.py",
      start_line: 1,
      end_line: 1,
      severity_raw: "warning",
      message: "m",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "AnalysisFindingV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => AnalysisFindingV1.parse(bad)).toThrow();
  }, 30_000);
});
