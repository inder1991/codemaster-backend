// Unit tests for the Stage-5 policy post-filter helpers (SYSTEM_INVARIANTS severity floor + the per-chunk
// bundle merge) + the arbitration footer renderer. These are the pure, sandbox-safe building blocks the
// orchestrator's Step 7.2 (applyPolicyPostFilter) and posting's footer fold compose.

import { describe, it, expect } from "vitest";

import {
  postFilterFindingsWithMetadata,
  postFilterFindings,
} from "#backend/policy/trust_filter.js";
import {
  SYSTEM_INVARIANTS,
  EmptyInvariantsRegistryError,
} from "#backend/policy/system_invariants.js";
import { mergePerChunkBundles } from "#backend/policy/citation_context_builder.js";
import { renderArbitrationFooterMd } from "#backend/review/arbitration/arbitration_footer.js";

import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { ResolvedGuidanceBundleV1, DedupedRuleV1 } from "#contracts/resolved_guidance.v1.js";
import { ExtractedRuleV1 } from "#contracts/extracted_rules.v1.js";
import { ToolStatusV1 } from "#contracts/tool_status.v1.js";
import type { ArbitrationResultV1 } from "#contracts/arbitration_result.v1.js";

function finding(args: { category: string; severity: string }): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: "src/x.ts",
    start_line: 1,
    end_line: 1,
    severity: args.severity,
    category: args.category,
    title: "t",
    body: "b",
    confidence: 0.9,
  });
}

const EMPTY_BUNDLE = ResolvedGuidanceBundleV1.parse({ changed_path: "*" });

function extractedRule(ruleId: string): ExtractedRuleV1 {
  return ExtractedRuleV1.parse({
    rule_id: ruleId,
    normalized_hash: "a".repeat(64),
    source_file: "CLAUDE.md",
    source_file_sha256: "b".repeat(64),
    scope_dir: "",
    rule_index: 0,
    title: ruleId,
    body: "do the thing",
    category: "security",
    intent: "require",
    priority: 100,
  });
}

function dedupedRule(ruleId: string): DedupedRuleV1 {
  const r = extractedRule(ruleId);
  return DedupedRuleV1.parse({ rule: r, sources: [r] });
}

function bundle(changedPath: string, ruleIds: ReadonlyArray<string>): ResolvedGuidanceBundleV1 {
  return ResolvedGuidanceBundleV1.parse({
    changed_path: changedPath,
    applicable_rules: ruleIds.map(dedupedRule),
    resolution_explanation: ruleIds.map((id) => `${id} applied`),
  });
}

describe("SYSTEM_INVARIANTS registry", () => {
  it("carries the 2 active invariants (SI-001 + SI-005)", () => {
    const ids = SYSTEM_INVARIANTS.map((i) => i.invariant_id);
    expect(ids).toEqual([
      "SI-001-security-finding-non-suppressible",
      "SI-005-severity-grading-platform-owned",
    ]);
  });
});

describe("postFilterFindingsWithMetadata — SI-001 / SI-005 severity floor", () => {
  it("floors a below-floor SECURITY finding to 'issue' and records the fired invariant", () => {
    const [out, meta] = postFilterFindingsWithMetadata(
      [finding({ category: "security", severity: "nit" })],
      EMPTY_BUNDLE,
    );
    expect(out[0]!.severity).toBe("issue");
    expect(meta[0]!.invariant_violation_attempted).toBe(true);
    // both SI-001 + SI-005 enforce the floor; SI-001 fires first, SI-005 is then a no-op on the already-
    // floored finding → only SI-001 recorded as fired.
    expect(meta[0]!.invariants_fired).toEqual(["SI-001-security-finding-non-suppressible"]);
  });

  it("leaves an at-or-above-floor SECURITY finding unchanged (same object reference)", () => {
    const f = finding({ category: "security", severity: "blocker" });
    const [out, meta] = postFilterFindingsWithMetadata([f], EMPTY_BUNDLE);
    expect(out[0]).toBe(f); // reference identity preserved (no-op path)
    expect(meta[0]!.invariant_violation_attempted).toBe(false);
    expect(meta[0]!.invariants_fired).toEqual([]);
  });

  it("leaves a non-security finding untouched regardless of severity", () => {
    const f = finding({ category: "bug", severity: "nit" });
    const [out, meta] = postFilterFindingsWithMetadata([f], EMPTY_BUNDLE);
    expect(out[0]).toBe(f);
    expect(meta[0]!.invariants_fired).toEqual([]);
  });

  it("postFilterFindings (no-metadata wrapper) returns the floored findings", () => {
    const out = postFilterFindings([finding({ category: "security", severity: "suggestion" })], EMPTY_BUNDLE);
    expect(out[0]!.severity).toBe("issue");
  });
});

describe("mergePerChunkBundles — per-chunk bundle union", () => {
  it("yields an empty-rules review-level bundle for empty input", () => {
    const merged = mergePerChunkBundles(new Map());
    expect(merged.changed_path).toBe("*");
    expect(merged.applicable_rules).toEqual([]);
    expect(merged.resolution_explanation).toEqual([]);
  });

  it("dedups by rule_id across chunks + sorts deterministically by rule_id", () => {
    const map = new Map<string, ResolvedGuidanceBundleV1>([
      ["src/b.ts", bundle("src/b.ts", ["R-2", "R-1"])],
      ["src/a.ts", bundle("src/a.ts", ["R-1", "R-3"])], // R-1 duplicate → deduped
    ]);
    const merged = mergePerChunkBundles(map);
    expect(merged.applicable_rules.map((r) => r.rule.rule_id)).toEqual(["R-1", "R-2", "R-3"]);
    // explanations stay index-aligned with the (sorted, deduped) rules.
    expect(merged.applicable_rules.length).toBe(merged.resolution_explanation.length);
  });
});

describe("renderArbitrationFooterMd", () => {
  const emptyResult: ArbitrationResultV1 = { decisions: [], rejected_intents: [] };

  it("returns '' when there are no suppressed findings and all tools completed", () => {
    expect(renderArbitrationFooterMd({ result: emptyResult, toolStatuses: [] })).toBe("");
  });

  it("renders the suppressed section with per-state counts (sorted by state)", () => {
    const result: ArbitrationResultV1 = {
      decisions: [
        decision("SUPPRESSED_BY_LLM"),
        decision("SUPPRESSED_BY_LLM"),
        decision("SUPPRESSED_BY_POLICY"),
        decision("NONE"),
      ],
      rejected_intents: [],
    };
    const out = renderArbitrationFooterMd({ result, toolStatuses: [] });
    expect(out.startsWith("\n\n---\n\n")).toBe(true);
    expect(out).toContain("- SUPPRESSED_BY_LLM x 2");
    expect(out).toContain("- SUPPRESSED_BY_POLICY x 1");
    // NONE decisions are excluded from the count.
    expect(out).not.toContain("NONE x");
  });

  it("renders the tool-degradation section for non-completed tools (sorted by tool_name)", () => {
    const degraded = ToolStatusV1.parse({
      tool_name: "eslint",
      status: "timed_out",
      files_scanned: 87,
      files_total: 100,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: null,
      duration_ms: 5000,
      error_class: "TimeoutError",
    });
    const completed = ToolStatusV1.parse({
      tool_name: "trivy",
      status: "completed",
      files_scanned: 100,
      files_total: 100,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      duration_ms: 1000,
    });
    const out = renderArbitrationFooterMd({ result: emptyResult, toolStatuses: [degraded, completed] });
    expect(out).toContain("Tool degradation");
    expect(out).toContain("- eslint: timed_out (87/100 files, TimeoutError)");
    // the completed tool is omitted.
    expect(out).not.toContain("trivy");
  });
});

function decision(state: "NONE" | "SUPPRESSED_BY_LLM" | "SUPPRESSED_BY_POLICY") {
  if (state === "NONE") {
    return {
      schema_version: 1 as const,
      finding_id: "00000000-0000-4000-8000-000000000001",
      suppression_state: state,
      suppression_reason: null,
      suppression_confidence: null,
      suppression_model: null,
      suppression_prompt_version: null,
      suppressed_at: null,
      suppressed_by_finding_id: null,
    };
  }
  return {
    schema_version: 1 as const,
    finding_id: "00000000-0000-4000-8000-000000000001",
    suppression_state: state,
    suppression_reason: "r",
    suppression_confidence: "0.9",
    suppression_model: "m",
    suppression_prompt_version: "v1",
    suppressed_at: "2026-01-01T00:00:00.000Z",
    suppressed_by_finding_id: null,
  };
}

describe("EmptyInvariantsRegistryError shape", () => {
  it("is an Error subclass with the registry name", () => {
    const e = new EmptyInvariantsRegistryError("boom");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("EmptyInvariantsRegistryError");
  });
});
