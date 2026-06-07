import { afterAll, describe, expect, it } from "vitest";

import { pyIsSuppressible, pyLoadPolicy, shutdownArbitrateRef } from "./arbitrate_oracle.js";

import {
  BUNDLED_SUPPRESSION_POLICY,
  isSuppressible,
  KNOWN_TOOLS,
  loadBundledPolicy,
  loadPolicyFromYaml,
  SuppressionPolicy,
} from "#backend/review/arbitration/suppression_policy.js";

afterAll(() => shutdownArbitrateRef());

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Parity: prove the TS embedded BUNDLED policy + isSuppressible are byte/value-equal to the frozen Python
// suppression_policy.py (load_policy() + is_suppressible()). The policy's min_confidence values are bare
// floats, so the policy-dump compare uses deep-equal (NOT the bare-float-rejecting canonicalize); the
// is_suppressible compare is a structural value diff.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("BUNDLED suppression policy parity (TS literal ↔ frozen YAML)", () => {
  it("the embedded TS policy equals the frozen Python load_policy() dump", async () => {
    const py = await pyLoadPolicy();
    // The TS bundled policy is the SuppressionPolicy.parse of the embedded literal; model_dump shape matches.
    expect(BUNDLED_SUPPRESSION_POLICY).toEqual(py);
    expect(loadBundledPolicy()).toEqual(py);
  }, 30_000);
});

describe("is_suppressible parity (TS ↔ Python) across the policy surface", () => {
  // (tool, rule_id, confidence) tuples spanning: per-rule override hit, per-tool default, the
  // non-suppressible secret/CVE tools, the confidence boundary (>= vs <), and the unknown-tool fail-closed.
  const cases: ReadonlyArray<{ tool: string; ruleId: string; confidence: number }> = [
    { tool: "ruff", ruleId: "F401", confidence: 0.9 }, // per-rule override; conf == min → suppress
    { tool: "ruff", ruleId: "F401", confidence: 0.89 }, // just below min → no
    { tool: "ruff", ruleId: "E501", confidence: 0.8 }, // E501 min 0.80 boundary
    { tool: "ruff", ruleId: "UNKNOWN", confidence: 0.86 }, // falls to tool default (min 0.85)
    { tool: "ruff", ruleId: "UNKNOWN", confidence: 0.84 }, // below tool default
    { tool: "gitleaks", ruleId: "aws", confidence: 1.0 }, // structurally non-suppressible
    { tool: "trivy", ruleId: "CVE-x", confidence: 1.0 }, // structurally non-suppressible
    { tool: "semgrep", ruleId: "rule.x", confidence: 0.9 }, // default min 0.90
    { tool: "eslint", ruleId: "no-unused-vars", confidence: 0.9 }, // per-rule override
    { tool: "eslint", ruleId: "other", confidence: 0.85 }, // tool default
    { tool: "llm", ruleId: "x", confidence: 0.85 }, // forward-compat branch
    { tool: "made-up-tool", ruleId: "x", confidence: 1.0 }, // unknown → fail-closed
  ];

  for (const c of cases) {
    it(`${c.tool}/${c.ruleId}@${c.confidence} matches Python`, async () => {
      const py = await pyIsSuppressible({ tool: c.tool, ruleId: c.ruleId, confidence: c.confidence });
      const ts = isSuppressible({
        policy: loadBundledPolicy(),
        tool: c.tool,
        rule_id: c.ruleId,
        confidence: c.confidence,
      });
      expect(ts.suppressible).toBe(py.suppressible);
      expect(ts.min_confidence).toBe(py.min_confidence);
    }, 30_000);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Unit coverage (no Python diff) — fail-closed sentinel, YAML loader, contract rejection.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("suppression_policy unit behavior", () => {
  it("unknown tool returns the fail-closed sentinel (suppressible=false, min_confidence=1.0)", () => {
    const d = isSuppressible({ policy: loadBundledPolicy(), tool: "nope", rule_id: "x", confidence: 1.0 });
    expect(d).toEqual({ suppressible: false, min_confidence: 1.0 });
  });

  it("KNOWN_TOOLS is exactly the six policy branches", () => {
    expect([...KNOWN_TOOLS].sort()).toEqual(["eslint", "gitleaks", "llm", "ruff", "semgrep", "trivy"]);
  });

  it("loadPolicyFromYaml parses + validates a well-formed YAML policy", () => {
    const yaml = `
schema_version: 1
ruff: { default: { suppressible: true, min_confidence: 0.5 }, rules: {} }
gitleaks: { default: { suppressible: false, min_confidence: 1.0 }, rules: {} }
semgrep: { default: { suppressible: true, min_confidence: 0.9 }, rules: {} }
trivy: { default: { suppressible: false, min_confidence: 1.0 }, rules: {} }
eslint: { default: { suppressible: true, min_confidence: 0.85 }, rules: {} }
llm: { default: { suppressible: true, min_confidence: 0.85 }, rules: {} }
`;
    const policy = loadPolicyFromYaml(yaml);
    expect(policy.ruff.default.min_confidence).toBe(0.5);
    // A finding at conf 0.6 is suppressible under this override (ruff default min 0.5).
    expect(isSuppressible({ policy, tool: "ruff", rule_id: "X", confidence: 0.6 }).suppressible).toBe(true);
  });

  it("loadPolicyFromYaml rejects a policy missing a required tool branch (.strict / sealing)", () => {
    const yaml = `
schema_version: 1
ruff: { default: { suppressible: true, min_confidence: 0.5 }, rules: {} }
`;
    expect(() => loadPolicyFromYaml(yaml)).toThrow();
  });

  it("SuppressionPolicy rejects min_confidence out of [0,1]", () => {
    expect(() =>
      SuppressionPolicy.parse({
        schema_version: 1,
        ruff: { default: { suppressible: true, min_confidence: 1.5 }, rules: {} },
        gitleaks: { default: { suppressible: false, min_confidence: 1.0 }, rules: {} },
        semgrep: { default: { suppressible: true, min_confidence: 0.9 }, rules: {} },
        trivy: { default: { suppressible: false, min_confidence: 1.0 }, rules: {} },
        eslint: { default: { suppressible: true, min_confidence: 0.85 }, rules: {} },
        llm: { default: { suppressible: true, min_confidence: 0.85 }, rules: {} },
      }),
    ).toThrow();
  });
});
