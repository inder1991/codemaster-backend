import { describe, expect, it } from "vitest";

import { GenerateWalkthroughInputV1 } from "#contracts/generate_walkthrough_input.v1.js";

// GenerateWalkthroughInputV1 — the NEW typed envelope introduced during the port (CLAUDE.md
// invariant 11 / ADR-0047 closure of the Python 4-positional generate_walkthrough dispatch). There is
// NO Python counterpart to byte-diff, so this covers round-trip + validation only. The constituent
// shapes (PrMetaV1, AggregatedFindingsV1, LinkedIssueV1) are byte-parity-validated against frozen
// Python in their own suites (walkthrough.v1.parity.test.ts / aggregated_findings.v1.parity.test.ts).

const PR_ID = "11111111-1111-4111-8111-111111111111";
const INST_ID = "22222222-2222-4222-8222-222222222222";

function prMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pr_id: PR_ID,
    installation_id: INST_ID,
    repo: "acme/widgets",
    pr_title: "Add a feature",
    pr_description: "Body.",
    ...overrides,
  };
}

function aggregated(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    findings: [],
    dedupe_stats: {
      input_count: 0,
      exact_dropped: 0,
      semantic_merged: 0,
      capped: 0,
    },
    policy_revision: 0,
    ...overrides,
  };
}

describe("GenerateWalkthroughInputV1 envelope (no Python counterpart — validation only)", () => {
  it("accepts a minimal {pr_meta, aggregated} and applies the schema_version + tuple defaults", () => {
    const parsed = GenerateWalkthroughInputV1.parse({
      pr_meta: prMeta(),
      aggregated: aggregated(),
    });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.linked_issues).toEqual([]);
    expect(parsed.suggested_reviewers).toEqual([]);
    // Nested shapes got their own defaults.
    expect(parsed.pr_meta.draft).toBe(false);
    expect(parsed.aggregated.dedupe_stats.semantic_skipped).toBe(false);
  });

  it("accepts populated linked_issues + suggested_reviewers", () => {
    const parsed = GenerateWalkthroughInputV1.parse({
      pr_meta: prMeta(),
      aggregated: aggregated(),
      linked_issues: [{ issue_number: 42, linkage_kind: "closes" }],
      suggested_reviewers: ["@alice", "@bob"],
    });
    expect(parsed.linked_issues).toHaveLength(1);
    expect(parsed.linked_issues[0]!.issue_number).toBe(42);
    expect(parsed.linked_issues[0]!.title).toBeNull();
    expect(parsed.suggested_reviewers).toEqual(["@alice", "@bob"]);
  });

  it("rejects unknown top-level keys (.strict())", () => {
    expect(() =>
      GenerateWalkthroughInputV1.parse({ pr_meta: prMeta(), aggregated: aggregated(), bogus: true }),
    ).toThrow();
  });

  it("rejects more than 10 suggested_reviewers (WalkthroughV1.suggested_reviewers max bound)", () => {
    expect(() =>
      GenerateWalkthroughInputV1.parse({
        pr_meta: prMeta(),
        aggregated: aggregated(),
        suggested_reviewers: Array.from({ length: 11 }, (_, i) => `@r${i}`),
      }),
    ).toThrow();
  });

  it("rejects a pr_meta that violates the PrMetaV1 contract (empty repo)", () => {
    expect(() =>
      GenerateWalkthroughInputV1.parse({
        pr_meta: prMeta({ repo: "" }),
        aggregated: aggregated(),
      }),
    ).toThrow();
  });

  it("rejects an aggregated that violates AggregatedFindingsV1 (missing dedupe_stats)", () => {
    expect(() =>
      GenerateWalkthroughInputV1.parse({
        pr_meta: prMeta(),
        aggregated: { findings: [], policy_revision: 0 },
      }),
    ).toThrow();
  });
});
