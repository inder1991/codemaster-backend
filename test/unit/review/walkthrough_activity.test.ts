import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import {
  InMemoryCostCapEnforcer,
} from "#backend/cost/enforcer.js";
import { LlmClient, type LlmSdk } from "#backend/integrations/llm/client.js";
import { LlmInvocationError, LlmRoleNotConfiguredError } from "#backend/integrations/llm/errors.js";
import { LLM_FALLBACK_SYNTHESIS_NOTE } from "#backend/review/file_rows_synthesizer.js";
import {
  WalkthroughActivities,
  doGenerateWalkthrough,
  type LlmClientCacheLike,
} from "#backend/review/walkthrough_activity.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { GenerateWalkthroughInputV1 } from "#contracts/generate_walkthrough_input.v1.js";
import { AggregatedFindingsV1 as AggregatedFindingsV1Schema } from "#contracts/aggregated_findings.v1.js";
import { PrMetaV1 } from "#contracts/walkthrough.v1.js";
import type { PrMetaV1 as PrMetaV1Type } from "#contracts/walkthrough.v1.js";

// Unit coverage of the generate_walkthrough DETERMINISTIC transform: the happy-path prompt build →
// emit_walkthrough parse → WalkthroughV1, the aggregation-signal propagators, the linked-issues /
// suggested-reviewers embedding, the secret-leaked sanitize-and-continue branch, and the synthesis
// fallback across every LLM-path error. The cache returns a real LlmClient wired with a stub SDK that
// replays a constructed response — the cassette replay seam reduced to one in-test response. NO live LLM.

const UUID = "12345678-1234-5678-1234-567812345678";

function prMeta(overrides: Record<string, unknown> = {}): PrMetaV1Type {
  return PrMetaV1.parse({
    pr_id: UUID,
    installation_id: UUID,
    repo: "acme/widget",
    pr_title: "Add a feature",
    pr_description: "## Summary\n\nDoes a thing.",
    ...overrides,
  });
}

function aggregated(
  findings: ReadonlyArray<Record<string, unknown>> = [],
  stats: Partial<Record<string, number | boolean>> = {},
  policyRevision = 0,
): AggregatedFindingsV1 {
  return AggregatedFindingsV1Schema.parse({
    findings,
    dedupe_stats: {
      input_count: 0,
      exact_dropped: 0,
      semantic_merged: 0,
      capped: 0,
      semantic_skipped: false,
      ...stats,
    },
    policy_revision: policyRevision,
  });
}

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: "src/app.ts",
    start_line: 10,
    end_line: 12,
    severity: "issue",
    category: "bug",
    title: "A finding",
    body: "Body text describing the issue.",
    confidence: 0.8,
    ...overrides,
  };
}

/** A cache whose forRole returns a real LlmClient wired to replay `response`. */
function cacheReturning(response: Record<string, unknown>): LlmClientCacheLike {
  const sdk: LlmSdk = {
    async createMessage(): Promise<Record<string, unknown>> {
      return response;
    },
  };
  const client = new LlmClient({
    sdk,
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    blobStore: new InMemoryBlobStoreAdapter(),
    clock: new FakeClock(),
  });
  return {
    async forRole(): Promise<LlmClient> {
      return client;
    },
  };
}

/** A cache whose client's invokeModel throws `err` from the SDK call (generic-invocation-error path). */
function cacheThrowingFromSdk(err: Error): LlmClientCacheLike {
  const sdk: LlmSdk = {
    async createMessage(): Promise<Record<string, unknown>> {
      throw err;
    },
  };
  const client = new LlmClient({
    sdk,
    costCap: new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 }),
    blobStore: new InMemoryBlobStoreAdapter(),
    clock: new FakeClock(),
  });
  return {
    async forRole(): Promise<LlmClient> {
      return client;
    },
  };
}

/** A cache whose client's PRE-CALL cost-cap check denies (kill-switch) → BedrockBudgetExceededError. */
function cacheWithBudgetDeny(): LlmClientCacheLike {
  const costCap = new InMemoryCostCapEnforcer({ globalCapCents: 500_000, perOrgCapCents: 100_000 });
  costCap.setKillSwitch(true);
  const sdk: LlmSdk = {
    async createMessage(): Promise<Record<string, unknown>> {
      throw new Error("SDK must not be reached when the pre-call cost-cap denies");
    },
  };
  const client = new LlmClient({
    sdk,
    costCap,
    blobStore: new InMemoryBlobStoreAdapter(),
    clock: new FakeClock(),
  });
  return {
    async forRole(): Promise<LlmClient> {
      return client;
    },
  };
}

function walkthroughBlock(input: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: "tool_use", id: "w1", name: "emit_walkthrough", input }],
    usage: { input_tokens: 80, output_tokens: 40 },
    stop_reason: "tool_use",
  };
}

const BASE_ARGS = {
  linkedIssues: [],
  suggestedReviewers: [],
} as const;

describe("doGenerateWalkthrough — happy path", () => {
  it("parses the emit_walkthrough tool_use into WalkthroughV1", async () => {
    const cache = cacheReturning(
      walkthroughBlock({
        tldr: "This PR adds a request handler.",
        file_rows: [
          { path: "src/app.ts", change_summary: "New handler.", severity_max: "issue", finding_count: 1 },
        ],
        configuration_section_md: "## config\nnone",
      }),
    );
    const result = await doGenerateWalkthrough(
      { ...BASE_ARGS, prMeta: prMeta(), aggregated: aggregated([finding()]) },
      { cache },
    );
    expect(result.tldr).toBe("This PR adds a request handler.");
    expect(result.file_rows).toHaveLength(1);
    expect(result.file_rows[0]!.path).toBe("src/app.ts");
    expect(result.degradation_note).toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.sanitization_event).toBeNull();
  });

  it("forces truncated=true when aggregation capped>0 (model cannot lie about it)", async () => {
    const cache = cacheReturning(walkthroughBlock({ tldr: "Big PR.", truncated: false }));
    const result = await doGenerateWalkthrough(
      { ...BASE_ARGS, prMeta: prMeta(), aggregated: aggregated([finding()], { capped: 3 }) },
      { cache },
    );
    expect(result.truncated).toBe(true);
  });

  it("injects the semantic-skip degradation note when the embedder was unavailable", async () => {
    const cache = cacheReturning(walkthroughBlock({ tldr: "Done." }));
    const result = await doGenerateWalkthrough(
      { ...BASE_ARGS, prMeta: prMeta(), aggregated: aggregated([finding()], { semantic_skipped: true }) },
      { cache },
    );
    expect(result.degradation_note).toBe("semantic-merge stage skipped (embedder unavailable)");
  });

  it("embeds pre-resolved linked_issues + suggested_reviewers", async () => {
    const cache = cacheReturning(walkthroughBlock({ tldr: "Done." }));
    const result = await doGenerateWalkthrough(
      {
        prMeta: prMeta(),
        aggregated: aggregated([finding()]),
        linkedIssues: [{ issue_number: 7, linkage_kind: "closes", title: "An issue", state: "open" }],
        suggestedReviewers: ["@alice", "@bob"],
      },
      { cache },
    );
    expect(result.linked_issues).toHaveLength(1);
    expect(result.linked_issues[0]!.issue_number).toBe(7);
    expect(result.suggested_reviewers).toEqual(["@alice", "@bob"]);
  });
});

describe("doGenerateWalkthrough — synthesis fallback (collapsed-on) across LLM-path errors", () => {
  // Every LLM-path error returns the synthesized fallback walkthrough directly (the activity folds in
  // the workflow-body fallback; the walkthrough-cost-cap-synthesis gate is collapsed-on).

  function expectSynthesizedFallback(
    result: { tldr: string; file_rows: ReadonlyArray<unknown>; degradation_note: string | null; truncated: boolean },
    nFindings: number,
  ): void {
    expect(result.tldr).toBe(
      `Walkthrough generation temporarily unavailable. ${nFindings} finding(s) detected; see inline comments below.`,
    );
    expect(result.degradation_note).toBe(LLM_FALLBACK_SYNTHESIS_NOTE);
    expect(result.truncated).toBe(false);
    // file_rows ALWAYS synthesized from the aggregated findings (one row per file here).
    expect(result.file_rows.length).toBeGreaterThan(0);
  }

  it("role-not-configured → synthesized fallback", async () => {
    const cache: LlmClientCacheLike = {
      async forRole() {
        throw new LlmRoleNotConfiguredError("no primary row");
      },
    };
    const result = await doGenerateWalkthrough(
      { ...BASE_ARGS, prMeta: prMeta(), aggregated: aggregated([finding()]) },
      { cache },
    );
    expectSynthesizedFallback(result, 1);
  });

  it("budget exceeded (pre-call cost-cap deny) → synthesized fallback", async () => {
    const result = await doGenerateWalkthrough(
      { ...BASE_ARGS, prMeta: prMeta(), aggregated: aggregated([finding({ file: "src/a.ts" }), finding({ file: "src/b.ts" })]) },
      { cache: cacheWithBudgetDeny() },
    );
    expectSynthesizedFallback(result, 2);
    expect(result.file_rows).toHaveLength(2);
  });

  it("generic invocation error → synthesized fallback", async () => {
    const cache = cacheThrowingFromSdk(new LlmInvocationError("upstream flake"));
    const result = await doGenerateWalkthrough(
      { ...BASE_ARGS, prMeta: prMeta(), aggregated: aggregated([finding()]) },
      { cache },
    );
    expectSynthesizedFallback(result, 1);
  });

  it("parse error (no emit_walkthrough block) → synthesized fallback", async () => {
    // A text-only response carries no emit_walkthrough block → WalkthroughParseError → fallback.
    const cache = cacheReturning({
      content: [{ type: "text", text: "I forgot to call the tool." }],
      usage: { input_tokens: 10, output_tokens: 10 },
      stop_reason: "end_turn",
    });
    const result = await doGenerateWalkthrough(
      { ...BASE_ARGS, prMeta: prMeta(), aggregated: aggregated([finding()]) },
      { cache },
    );
    expectSynthesizedFallback(result, 1);
  });

  it("terminal output-unsafe (non-secret block) → synthesized fallback", async () => {
    // A privileged <system> tag in the preamble → non-secret output-safety block → terminal → fallback.
    const cache = cacheReturning({
      content: [
        { type: "text", text: "Here is a <system> tag I should not emit." },
        { type: "tool_use", id: "w1", name: "emit_walkthrough", input: { tldr: "x" } },
      ],
      usage: { input_tokens: 5, output_tokens: 5 },
      stop_reason: "tool_use",
    });
    const result = await doGenerateWalkthrough(
      { ...BASE_ARGS, prMeta: prMeta(), aggregated: aggregated([finding()]) },
      { cache },
    );
    expectSynthesizedFallback(result, 1);
  });

  it("fallback with ZERO findings still synthesizes (empty file_rows, n=0 in tldr)", async () => {
    const cache = cacheThrowingFromSdk(new LlmInvocationError("flake"));
    const result = await doGenerateWalkthrough(
      { ...BASE_ARGS, prMeta: prMeta(), aggregated: aggregated([]) },
      { cache },
    );
    expect(result.tldr).toBe(
      "Walkthrough generation temporarily unavailable. 0 finding(s) detected; see inline comments below.",
    );
    expect(result.degradation_note).toBe(LLM_FALLBACK_SYNTHESIS_NOTE);
    expect(result.file_rows).toHaveLength(0);
  });
});

describe("doGenerateWalkthrough — secret-leaked sanitize-and-continue", () => {
  it("populates sanitization_event + preserves the walkthrough tool_use payload", async () => {
    const unsafeText = "AWS access key AKIAREALKEY12345678X found at secrets_loader.py:5.";
    const cache = cacheReturning({
      content: [
        { type: "text", text: unsafeText },
        {
          type: "tool_use",
          id: "w1",
          name: "emit_walkthrough",
          input: { tldr: "Found a leaked credential; rotate it." },
        },
      ],
      usage: { input_tokens: 20, output_tokens: 20 },
      stop_reason: "tool_use",
    });
    const result = await doGenerateWalkthrough(
      { ...BASE_ARGS, prMeta: prMeta(), aggregated: aggregated([finding({ severity: "blocker", category: "security" })]) },
      { cache },
    );
    // The walkthrough tool_use payload survives the text-only redaction.
    expect(result.tldr).toBe("Found a leaked credential; rotate it.");
    // sanitization_event populated.
    expect(result.sanitization_event).not.toBeNull();
    const ev = result.sanitization_event!;
    expect(ev.stage).toBe("walkthrough");
    expect(ev.detector_kinds).toEqual(["aws_access_key_id"]);
    expect(ev.spans_redacted).toBe(1);
    expect(ev.redacted_text).toContain("[REDACTED]");
    expect(ev.redacted_text).not.toContain("AKIAREALKEY12345678X");
    expect(ev.original_text).toBe(unsafeText);
    expect(ev.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("WalkthroughActivities — bound-method holder (typed-input envelope)", () => {
  it("drives generateWalkthrough from the GenerateWalkthroughInputV1 envelope", async () => {
    const cache = cacheReturning(
      walkthroughBlock({ tldr: "Envelope-driven walkthrough." }),
    );
    const activities = new WalkthroughActivities({ cache });
    const input = GenerateWalkthroughInputV1.parse({
      pr_meta: {
        pr_id: UUID,
        installation_id: UUID,
        repo: "acme/widget",
        pr_title: "Feature",
        pr_description: "Body.",
      },
      aggregated: {
        findings: [finding()],
        dedupe_stats: { input_count: 1, exact_dropped: 0, semantic_merged: 0, capped: 0 },
        policy_revision: 0,
      },
      linked_issues: [{ issue_number: 5, linkage_kind: "fixes" }],
      suggested_reviewers: ["@carol"],
    });
    const result = await activities.generateWalkthrough(input);
    expect(result.tldr).toBe("Envelope-driven walkthrough.");
    expect(result.linked_issues[0]!.issue_number).toBe(5);
    expect(result.suggested_reviewers).toEqual(["@carol"]);
  });

  it("stays bound when destructured into an activities map (arrow property)", async () => {
    const cache = cacheReturning(walkthroughBlock({ tldr: "Bound." }));
    const activities = new WalkthroughActivities({ cache });
    const { generateWalkthrough } = activities; // destructured — `this` would be lost on a plain method
    const input = GenerateWalkthroughInputV1.parse({
      pr_meta: {
        pr_id: UUID,
        installation_id: UUID,
        repo: "acme/widget",
        pr_title: "Feature",
        pr_description: "Body.",
      },
      aggregated: {
        findings: [],
        dedupe_stats: { input_count: 0, exact_dropped: 0, semantic_merged: 0, capped: 0 },
        policy_revision: 0,
      },
    });
    const result = await generateWalkthrough(input);
    expect(result.tldr).toBe("Bound.");
  });
});
