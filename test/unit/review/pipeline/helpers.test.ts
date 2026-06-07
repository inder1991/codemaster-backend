// Unit tests for the two Stage-3 pure helpers that landed alongside the lifecycle wiring:
//   * buildAnalyzedPayload          — parity-covered in test/parity/pipeline_helpers.parity.test.ts; here
//     we assert only the structural invariant (the two degradation lists are SEPARATE keys, never merged)
//     so a refactor that accidentally folds them is caught even without the Python ref running.
//   * buildPolicyCitationContext    — the union+dedup+sort over per-changed-path policy bundles. The
//     Python original (codemaster/policy/citation_context_builder.py::build_policy_citation_context) is a
//     trivial union+sort, so it is unit-tested here (the produced PolicyCitationContextV1 contract itself
//     is parity-tested in policy_citation.v1.parity.test.ts).

import { describe, it, expect } from "vitest";

import {
  buildAnalyzedPayload,
  buildPolicyCitationContext,
  configChangeNoticeFinding,
  maybeAppendConfigNotice,
} from "#backend/review/pipeline/helpers.js";
import { makePostReviewCapture } from "#backend/review/pipeline/state.js";
import { ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";
import { PublicationOutcome } from "#contracts/posted_review.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";

// ─── helpers to build a minimal valid policy bundle keyed by a set of rule_ids ───────────────────────

function ruleFor(ruleId: string): Record<string, unknown> {
  return {
    rule_id: ruleId,
    normalized_hash: "0".repeat(64),
    source_file: "CLAUDE.md",
    source_file_sha256: "1".repeat(64),
    scope_dir: "",
    rule_index: 0,
    title: ruleId,
    body: `body for ${ruleId}`,
    category: "architecture",
    intent: "require",
    priority: 10,
  };
}

function bundleFor(changedPath: string, ruleIds: ReadonlyArray<string>): ResolvedGuidanceBundleV1 {
  return ResolvedGuidanceBundleV1.parse({
    changed_path: changedPath,
    applicable_rules: ruleIds.map((rid) => ({ rule: ruleFor(rid), sources: [ruleFor(rid)] })),
  });
}

describe("buildPolicyCitationContext — union + dedup + sort", () => {
  it("returns an empty-rule_ids observe-mode context for an empty bundle map", () => {
    const ctx = buildPolicyCitationContext(new Map());
    expect(ctx.valid_rule_ids).toEqual([]);
    expect(ctx.enforcement).toBe("observe");
    expect(ctx.schema_version).toBe(1);
  });

  it("unions rule_ids across all bundles, sorted ascending", () => {
    const bundles = new Map<string, ResolvedGuidanceBundleV1>([
      ["src/b.ts", bundleFor("src/b.ts", ["rule-z", "rule-a"])],
      ["src/a.ts", bundleFor("src/a.ts", ["rule-m"])],
    ]);
    const ctx = buildPolicyCitationContext(bundles);
    expect(ctx.valid_rule_ids).toEqual(["rule-a", "rule-m", "rule-z"]);
  });

  it("deduplicates a rule_id that appears across multiple changed-path bundles", () => {
    // A repo-root CLAUDE.md rule the scope resolver surfaced in every bundle → must appear ONCE.
    const bundles = new Map<string, ResolvedGuidanceBundleV1>([
      ["src/a.ts", bundleFor("src/a.ts", ["root-rule", "a-only"])],
      ["src/b.ts", bundleFor("src/b.ts", ["root-rule", "b-only"])],
    ]);
    const ctx = buildPolicyCitationContext(bundles);
    expect(ctx.valid_rule_ids).toEqual(["a-only", "b-only", "root-rule"]);
  });

  it("honours an explicit enforcement override", () => {
    const ctx = buildPolicyCitationContext(new Map(), "enforce");
    expect(ctx.enforcement).toBe("enforce");
  });
});

// ─── maybeAppendConfigNotice — the spec §7 config-change notice mutator ───────────────────────────────

function ordinaryFinding(idx: number): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: `src/file_${idx}.ts`,
    start_line: 1,
    end_line: 1,
    severity: "issue",
    category: "bug",
    title: `finding-${idx}`,
    body: `body ${idx}`,
    confidence: 0.9,
  });
}

function aggregatedOf(findings: ReadonlyArray<ReviewFindingV1>): AggregatedFindingsV1 {
  return AggregatedFindingsV1.parse({
    findings: [...findings],
    dedupe_stats: { input_count: findings.length, exact_dropped: 0, semantic_merged: 0, capped: 0 },
    policy_revision: 3,
  });
}

describe("maybeAppendConfigNotice — spec §7 (.codemaster.yaml) config-change notice", () => {
  it("appends the notice when .codemaster.yaml is in the changed set", () => {
    const before = aggregatedOf([ordinaryFinding(1)]);
    const after = maybeAppendConfigNotice(before, ["src/file_1.ts", ".codemaster.yaml"]);
    expect(after.findings.length).toBe(2);
    const notice = after.findings[after.findings.length - 1]!;
    expect(notice.file).toBe(".codemaster.yaml");
    expect(notice.category).toBe("config");
    expect(notice.title).toBe("codemaster: this PR modifies .codemaster.yaml");
    expect(notice.severity).toBe("suggestion");
    // The notice the helper appends is the canonical configChangeNoticeFinding leaf.
    expect(notice).toEqual(configChangeNoticeFinding());
    // dedupe_stats + policy_revision + schema_version are preserved on the rebuild.
    expect(after.dedupe_stats).toEqual(before.dedupe_stats);
    expect(after.policy_revision).toBe(before.policy_revision);
    expect(after.schema_version).toBe(before.schema_version);
  });

  it("does NOT append the notice when .codemaster.yaml is absent from the changed set", () => {
    const before = aggregatedOf([ordinaryFinding(1), ordinaryFinding(2)]);
    const after = maybeAppendConfigNotice(before, ["src/file_1.ts", "src/file_2.ts"]);
    // Identity-by-value: no notice added.
    expect(after.findings.length).toBe(2);
    expect(after.findings.some((f) => f.file === ".codemaster.yaml")).toBe(false);
    // No-op path returns the SAME object reference (the Python `return aggregated`).
    expect(after).toBe(before);
  });

  it("is idempotent — a second call over an already-noticed result does not double-append", () => {
    const before = aggregatedOf([ordinaryFinding(1)]);
    const once = maybeAppendConfigNotice(before, [".codemaster.yaml"]);
    expect(once.findings.length).toBe(2);
    const twice = maybeAppendConfigNotice(once, [".codemaster.yaml"]);
    // No duplicate: still exactly one notice. The idempotency guard returns the same object reference.
    expect(twice.findings.length).toBe(2);
    expect(twice.findings.filter((f) => f.file === ".codemaster.yaml").length).toBe(1);
    expect(twice).toBe(once);
  });

  it("appends to an empty findings set when .codemaster.yaml is the only changed file", () => {
    const before = aggregatedOf([]);
    const after = maybeAppendConfigNotice(before, [".codemaster.yaml"]);
    expect(after.findings.length).toBe(1);
    expect(after.findings[0]!.file).toBe(".codemaster.yaml");
  });
});

describe("buildAnalyzedPayload — provenance separation invariant", () => {
  it("keeps publication_degradation_notes and pipeline_degradation_notes as SEPARATE keys (never merged)", () => {
    const capture = {
      ...makePostReviewCapture(),
      publicationOutcome: PublicationOutcome.enum.body_only_posted,
      degradationNotes: ["github_422_on_inline_post"] as ReadonlyArray<string>,
    };
    const payload = buildAnalyzedPayload({
      findingsCount: 5,
      headSha: "a".repeat(40),
      postedReviewCapture: capture,
      pipelineResult: null,
    });
    expect(payload).toEqual({
      findings_count: 5,
      head_sha: "a".repeat(40),
      publication_outcome: "body_only_posted",
      publication_degradation_notes: ["github_422_on_inline_post"],
      pipeline_degradation_notes: [],
    });
  });

  it("emits publication_outcome=null when no publication happened", () => {
    const payload = buildAnalyzedPayload({
      findingsCount: 0,
      headSha: "b".repeat(40),
      postedReviewCapture: makePostReviewCapture(),
      pipelineResult: null,
    });
    expect(payload["publication_outcome"]).toBeNull();
  });
});
