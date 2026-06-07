import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import { LlmClient, type LlmSdk } from "#backend/integrations/llm/client.js";
import { LlmInvocationError, LlmRoleNotConfiguredError } from "#backend/integrations/llm/errors.js";
import {
  FixPromptActivities,
  type FixPromptIssueCommentClient,
} from "#backend/activities/generate_fix_prompt.activity.js";
import {
  FIX_PROMPT_THEME_TOOL_NAME,
  type LlmClientCacheLike,
  buildFixPrompt,
  extractThemes,
  renderFixPromptComment,
} from "#backend/review/fix_prompt/fix_prompt_theme_activity.js";
import { buildFixPromptDeterministic, severityTruncate } from "#backend/review/fix_prompt/fix_prompt_builder.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { FixPromptRepo } from "#backend/domain/repos/fix_prompt_repo.js";
import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import type { AggregatedFindingsV1 as AggregatedFindingsV1Type } from "#contracts/aggregated_findings.v1.js";
import { type FixPromptV1 } from "#contracts/fix_prompt.v1.js";
import { GenerateFixPromptInputV1 } from "#contracts/generate_fix_prompt.v1.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Unit coverage of the fix-prompt feature's BEHAVIOUR (the deterministic builder's byte-exactness is
// proven separately by the Tier-1 parity test). Here we assert the ADDITIVE-LLM-themes contract:
//   * the deterministic section ALWAYS ships — on LLM success, on no-themes, on SDK error, on forRole error;
//   * mode="llm" iff the LLM call succeeded AND returned a themes block;
//   * the activity short-circuits on empty findings, persists the record, and posts the comment best-effort.
// The cache returns a real LlmClient wired with a stub SDK that replays a constructed Anthropic response —
// the cassette replay seam reduced to one in-test response. NO live LLM.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const REVIEW_ID = "2b9d4e7a-1c3f-4a8b-9e0d-5f6a7b8c9d0e";
const INSTALLATION_ID = "12345678-1234-5678-1234-567812345678";

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

function aggregated(findings: ReadonlyArray<Record<string, unknown>>): AggregatedFindingsV1Type {
  return AggregatedFindingsV1.parse({
    findings,
    dedupe_stats: {
      input_count: findings.length,
      exact_dropped: 0,
      semantic_merged: 0,
      capped: 0,
      semantic_skipped: false,
    },
    policy_revision: 0,
  });
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

/** A cache whose client's invokeModel throws `err` from the SDK call (the generic-invocation-error path). */
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

/** A cache whose forRole itself throws (operator hasn't seeded the role — DB/Vault read failure surface). */
function cacheForRoleThrows(err: Error): LlmClientCacheLike {
  return {
    async forRole(): Promise<LlmClient> {
      throw err;
    },
  };
}

/** Build an Anthropic-shaped response carrying an emit_fix_prompt_themes tool_use block with `themes`. */
function themesResponse(themes: string): Record<string, unknown> {
  return {
    content: [{ type: "tool_use", id: "t1", name: FIX_PROMPT_THEME_TOOL_NAME, input: { themes } }],
    usage: { input_tokens: 50, output_tokens: 30 },
    stop_reason: "tool_use",
  };
}

/** An Anthropic-shaped response with NO tool_use themes block (only a text block). */
function noThemesResponse(): Record<string, unknown> {
  return {
    content: [{ type: "text", text: "no structured themes here" }],
    usage: { input_tokens: 50, output_tokens: 5 },
    stop_reason: "end_turn",
  };
}

const FIXED_CLOCK = new FakeClock({ now: new Date("2026-06-03T10:00:00.000Z") });

// ─── extractThemes (defensive parser) ────────────────────────────────────────────────────────────

describe("extractThemes", () => {
  it("returns the first matching tool_use block's themes string", () => {
    const blocks = [
      { type: "text", text: "ignored" },
      { type: "tool_use", name: FIX_PROMPT_THEME_TOOL_NAME, input: { themes: "## Cross-cutting patterns\nA" } },
    ];
    expect(extractThemes(blocks)).toBe("## Cross-cutting patterns\nA");
  });

  it("returns null when no block names the tool", () => {
    expect(extractThemes([{ type: "tool_use", name: "other_tool", input: { themes: "x" } }])).toBeNull();
  });

  it("returns null for a non-string / empty / whitespace-only themes value (skipped, never throws)", () => {
    expect(extractThemes([{ type: "tool_use", name: FIX_PROMPT_THEME_TOOL_NAME, input: { themes: 42 } }])).toBeNull();
    expect(extractThemes([{ type: "tool_use", name: FIX_PROMPT_THEME_TOOL_NAME, input: { themes: "" } }])).toBeNull();
    expect(extractThemes([{ type: "tool_use", name: FIX_PROMPT_THEME_TOOL_NAME, input: { themes: "   " } }])).toBeNull();
  });

  it("never throws on malformed blocks (non-object, missing input, wrong types)", () => {
    expect(extractThemes([null, 7, "str", { type: "tool_use" }, { type: "tool_use", name: FIX_PROMPT_THEME_TOOL_NAME }])).toBeNull();
    expect(
      extractThemes([{ type: "tool_use", name: FIX_PROMPT_THEME_TOOL_NAME, input: "not-a-dict" }]),
    ).toBeNull();
  });
});

// ─── renderFixPromptComment (pure, byte-exact) ───────────────────────────────────────────────────

describe("renderFixPromptComment", () => {
  it("folds the prompt inside a collapsed <details> fenced text block (byte-exact)", () => {
    const out = renderFixPromptComment("PROMPT-BODY");
    expect(out).toBe(
      "🔧 **Fix-it prompt for Claude Code** — paste into Claude Code to address these findings.\n\n" +
        "<details><summary>Copy fix-prompt</summary>\n\n" +
        "```text\n" +
        "PROMPT-BODY\n" +
        "```\n\n" +
        "</details>",
    );
  });
});

// ─── buildFixPrompt (deterministic primary + additive LLM themes) ────────────────────────────────

describe("buildFixPrompt — additive LLM theme synthesis", () => {
  const agg = aggregated([finding({ title: "alpha" }), finding({ file: "src/b.ts", severity: "blocker", title: "beta" })]);

  /** The exact deterministic base (themes-free) the builder produces for `agg` — the always-ships floor. */
  function deterministicBase(): string {
    const [included, truncated] = severityTruncate(agg.findings, { maxFindings: 40, maxChars: 60000 });
    return buildFixPromptDeterministic(included, null, {
      prNumber: 77,
      truncated,
      total: agg.findings.length,
    });
  }

  it("mode='llm' and the themes section is embedded when the LLM returns a themes block", async () => {
    const themes = "## Cross-cutting patterns\nBoth findings share a missing-guard root cause.";
    const record = await buildFixPrompt({
      reviewId: REVIEW_ID,
      aggregated: agg,
      prNumber: 77,
      installationId: INSTALLATION_ID,
      cache: cacheReturning(themesResponse(themes)),
      clock: FIXED_CLOCK,
    });
    expect(record.generation_mode).toBe("llm");
    // The deterministic findings still ship (the additive contract): the base's <finding> content is a
    // substring of the enriched prompt, and the synthesized summary is prepended.
    expect(record.prompt).toContain("Both findings share a missing-guard root cause.");
    expect(record.prompt).toContain("_AI-synthesized cross-cutting summary follows.");
    expect(record.prompt).toContain("## Findings");
    expect(record.finding_count).toBe(2);
    expect(record.review_id).toBe(REVIEW_ID);
    expect(record.generated_at).toBe("2026-06-03T10:00:00.000Z");
  });

  it("mode='deterministic_fallback' and ships the base verbatim when the LLM returns NO themes block", async () => {
    const record = await buildFixPrompt({
      reviewId: REVIEW_ID,
      aggregated: agg,
      prNumber: 77,
      installationId: INSTALLATION_ID,
      cache: cacheReturning(noThemesResponse()),
      clock: FIXED_CLOCK,
    });
    expect(record.generation_mode).toBe("deterministic_fallback");
    // No themes block → the prompt is EXACTLY the themes-free deterministic base.
    expect(record.prompt).toBe(deterministicBase());
  });

  it("DETERMINISTIC-STILL-SHIPS: an SDK invocation error degrades to the base (mode=deterministic_fallback)", async () => {
    const record = await buildFixPrompt({
      reviewId: REVIEW_ID,
      aggregated: agg,
      prNumber: 77,
      installationId: INSTALLATION_ID,
      cache: cacheThrowingFromSdk(new LlmInvocationError("bedrock exploded")),
      clock: FIXED_CLOCK,
    });
    expect(record.generation_mode).toBe("deterministic_fallback");
    expect(record.prompt).toBe(deterministicBase());
  });

  it("DETERMINISTIC-STILL-SHIPS: a forRole failure (role not configured) degrades to the base", async () => {
    const record = await buildFixPrompt({
      reviewId: REVIEW_ID,
      aggregated: agg,
      prNumber: 77,
      installationId: INSTALLATION_ID,
      cache: cacheForRoleThrows(new LlmRoleNotConfiguredError("no primary row")),
      clock: FIXED_CLOCK,
    });
    expect(record.generation_mode).toBe("deterministic_fallback");
    expect(record.prompt).toBe(deterministicBase());
  });

  it("DETERMINISTIC-STILL-SHIPS: even a non-LLM error inside forRole degrades silently (bare catch)", async () => {
    const record = await buildFixPrompt({
      reviewId: REVIEW_ID,
      aggregated: agg,
      prNumber: 77,
      installationId: INSTALLATION_ID,
      cache: cacheForRoleThrows(new Error("vault decrypt timeout")),
      clock: FIXED_CLOCK,
    });
    expect(record.generation_mode).toBe("deterministic_fallback");
    expect(record.prompt).toBe(deterministicBase());
  });
});

// ─── FixPromptActivities.generateFixPrompt (persist + post + result) ─────────────────────────────

/** A fake FixPromptRepo capturing the persisted record + tenancy scope. */
class FakeRepo {
  public persisted: Array<{ record: FixPromptV1; installationId: string }> = [];
  async persist(record: FixPromptV1, scope: { installationId: string }): Promise<void> {
    this.persisted.push({ record, installationId: scope.installationId });
  }
}

/** A fake issue-comment client recording every posted comment. */
class FakeGh implements FixPromptIssueCommentClient {
  public posted: Array<{ owner: string; repo: string; prNumber: number; body: string }> = [];
  public throwOnPost = false;
  async createIssueComment(args: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<number> {
    if (this.throwOnPost) {
      throw new Error("422 from GitHub");
    }
    this.posted.push(args);
    return 999;
  }
}

function input(findings: ReadonlyArray<Record<string, unknown>>): GenerateFixPromptInputV1 {
  return GenerateFixPromptInputV1.parse({
    review_id: REVIEW_ID,
    installation_id: INSTALLATION_ID,
    pr_number: 77,
    owner: "acme",
    repo: "widget",
    aggregated: aggregated(findings),
  });
}

describe("FixPromptActivities.generateFixPrompt", () => {
  it("short-circuits on empty findings: not generated, empty mode, no persist, no post", async () => {
    const repo = new FakeRepo();
    const gh = new FakeGh();
    const acts = new FixPromptActivities({
      cache: cacheReturning(noThemesResponse()),
      repo: repo as unknown as FixPromptRepo,
      gh,
      clock: FIXED_CLOCK,
    });
    const result = await acts.generateFixPrompt(input([]));
    expect(result).toEqual({ schema_version: 1, generated: false, generation_mode: "", comment_posted: false });
    expect(repo.persisted).toHaveLength(0);
    expect(gh.posted).toHaveLength(0);
  });

  it("persists the record, posts the comment, and returns the llm-mode result on the happy path", async () => {
    const repo = new FakeRepo();
    const gh = new FakeGh();
    const acts = new FixPromptActivities({
      cache: cacheReturning(themesResponse("## Cross-cutting patterns\nshared guard")),
      repo: repo as unknown as FixPromptRepo,
      gh,
      clock: FIXED_CLOCK,
    });
    const result = await acts.generateFixPrompt(input([finding({ title: "x" })]));

    expect(result.generated).toBe(true);
    expect(result.generation_mode).toBe("llm");
    expect(result.comment_posted).toBe(true);

    // Persisted exactly once, tenancy-scoped, with the built prompt.
    expect(repo.persisted).toHaveLength(1);
    expect(repo.persisted[0]!.installationId).toBe(INSTALLATION_ID);
    expect(repo.persisted[0]!.record.review_id).toBe(REVIEW_ID);
    expect(repo.persisted[0]!.record.generation_mode).toBe("llm");

    // Posted exactly once to the right PR, with the rendered <details> comment wrapping the prompt.
    expect(gh.posted).toHaveLength(1);
    expect(gh.posted[0]!.owner).toBe("acme");
    expect(gh.posted[0]!.repo).toBe("widget");
    expect(gh.posted[0]!.prNumber).toBe(77);
    expect(gh.posted[0]!.body).toBe(renderFixPromptComment(repo.persisted[0]!.record.prompt));
  });

  it("comment_posted=false (NOT thrown) when the PR comment POST fails — but the record still persisted", async () => {
    const repo = new FakeRepo();
    const gh = new FakeGh();
    gh.throwOnPost = true;
    const acts = new FixPromptActivities({
      cache: cacheReturning(noThemesResponse()),
      repo: repo as unknown as FixPromptRepo,
      gh,
      clock: FIXED_CLOCK,
    });
    const result = await acts.generateFixPrompt(input([finding({ title: "y" })]));

    expect(result.generated).toBe(true);
    expect(result.generation_mode).toBe("deterministic_fallback");
    expect(result.comment_posted).toBe(false);
    // The advisory post failed, but the durable record is still there (serves the API/UI).
    expect(repo.persisted).toHaveLength(1);
  });

  it("still generates (deterministic_fallback) + persists + posts when the LLM enrichment fails", async () => {
    const repo = new FakeRepo();
    const gh = new FakeGh();
    const acts = new FixPromptActivities({
      cache: cacheThrowingFromSdk(new LlmInvocationError("boom")),
      repo: repo as unknown as FixPromptRepo,
      gh,
      clock: FIXED_CLOCK,
    });
    const result = await acts.generateFixPrompt(input([finding({ title: "z" })]));
    expect(result).toEqual({
      schema_version: 1,
      generated: true,
      generation_mode: "deterministic_fallback",
      comment_posted: true,
    });
    expect(repo.persisted).toHaveLength(1);
    expect(gh.posted).toHaveLength(1);
  });
});
