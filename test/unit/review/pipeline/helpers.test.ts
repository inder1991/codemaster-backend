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
} from "#backend/review/pipeline/helpers.js";
import { makePostReviewCapture } from "#backend/review/pipeline/state.js";
import { ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";
import { PublicationOutcome } from "#contracts/posted_review.v1.js";

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
