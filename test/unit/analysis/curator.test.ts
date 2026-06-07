import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { AnalysisCurator } from "#backend/analysis/curator.js";
import { CURATE_TOOL_NAME } from "#backend/analysis/curator_schema.js";
import { BedrockBudgetExceededError, InMemoryCostCapEnforcer } from "#backend/cost/enforcer.js";
import { LlmClient, type LlmSdk } from "#backend/integrations/llm/client.js";
import { LlmInvocationError, LlmRoleNotConfiguredError } from "#backend/integrations/llm/errors.js";
import type { LlmClientCacheLike } from "#backend/analysis/curator.js";

import { InMemoryBlobStoreAdapter } from "../../support/llm/cassette_sdk.js";

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import { AnalysisFindingV1 as AnalysisFindingV1Schema } from "#contracts/analysis_findings.v1.js";
import { PrMetaV1 } from "#contracts/walkthrough.v1.js";
import type { PrMetaV1 as PrMetaV1Type } from "#contracts/walkthrough.v1.js";

// Unit coverage of the AnalysisCurator DETERMINISTIC paths — the ones that need NO live LLM:
//   * empty findings → curator_skipped, no LLM call
//   * gitleaks / trivy ALWAYS-promote 1:1 (no LLM call)
//   * only always-promote tools present → skip the Haiku call entirely (curator_skipped)
//   * fail-open on an unexpected LLM error → always-promote-only + curator_skipped
//   * the Haiku happy path (stub SDK replays a curate_finding tool_use response)
//   * typed-error re-raise (budget / invocation) — NOT swallowed by the fail-open path
//
// The cache returns a real LlmClient wired to a stub SDK that replays a constructed response — the
// same in-test replay seam the walkthrough activity test uses. NO live LLM.

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

let findingSeq = 0;
function finding(overrides: Record<string, unknown> = {}): AnalysisFindingV1 {
  findingSeq += 1;
  const hex = findingSeq.toString(16).padStart(12, "0");
  return AnalysisFindingV1Schema.parse({
    finding_id: `00000000-0000-4000-8000-${hex}`,
    tool: "eslint",
    rule_id: "no-unused-vars",
    file: "src/app.ts",
    start_line: 10,
    end_line: 12,
    severity_raw: "warning",
    message: "Unused variable.",
    ...overrides,
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

/** A cache whose client's invokeModel throws `err` from the SDK call. */
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

/** A cache whose PRE-CALL cost-cap denies (kill switch) → BedrockBudgetExceededError. */
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

/** A cache that throws when a client is requested — proves NO LLM resolution on the skip paths. */
function cacheThatMustNotBeCalled(): LlmClientCacheLike {
  return {
    async forRole(): Promise<LlmClient> {
      throw new Error("forRole must not be called on a deterministic-skip path");
    },
  };
}

function curateResponse(inputs: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  return {
    content: inputs.map((input, i) => ({
      type: "tool_use",
      id: `c${i}`,
      name: CURATE_TOOL_NAME,
      input,
    })),
    usage: { input_tokens: 50, output_tokens: 30 },
    stop_reason: "tool_use",
  };
}

const CURATE_INPUT = {
  file: "src/app.ts",
  start_line: 10,
  end_line: 12,
  severity: "issue",
  category: "bug",
  title: "Promoted finding",
  body: "Worth surfacing.",
  confidence: 0.7,
};

describe("AnalysisCurator — empty input", () => {
  it("zero findings → curator_skipped, empty result, NO LLM call", async () => {
    const curator = new AnalysisCurator({ cache: cacheThatMustNotBeCalled() });
    const result = await curator.curate([], { prMeta: prMeta() });
    expect(result.findings).toHaveLength(0);
    expect(result.curator_skipped).toBe(true);
  });
});

describe("AnalysisCurator — always-promote tools (no LLM)", () => {
  it("promotes a gitleaks finding 1:1 at severity=blocker / category=security, NO LLM call", async () => {
    const curator = new AnalysisCurator({ cache: cacheThatMustNotBeCalled() });
    const result = await curator.curate(
      [
        finding({
          tool: "gitleaks",
          rule_id: "aws-access-key",
          severity_raw: "blocker",
          message: "AWS key leaked.",
        }),
      ],
      { prMeta: prMeta() },
    );
    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(f.severity).toBe("blocker");
    expect(f.category).toBe("security");
    expect(f.title).toBe("gitleaks: aws-access-key");
    expect(f.body).toBe("AWS key leaked.");
    expect(f.confidence).toBe(0.99);
    // Only always-promote tools present → the Haiku call is skipped entirely.
    expect(result.curator_skipped).toBe(true);
  });

  it("promotes a trivy finding 1:1 (trivy is in the always-promote set)", async () => {
    const curator = new AnalysisCurator({ cache: cacheThatMustNotBeCalled() });
    const result = await curator.curate(
      [finding({ tool: "trivy", rule_id: "CVE-2024-0001", message: "Vulnerable dep." })],
      { prMeta: prMeta() },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe("trivy: CVE-2024-0001");
    expect(result.curator_skipped).toBe(true);
  });

  it("carries the fix_suggestion into the promoted finding's suggestion", async () => {
    const curator = new AnalysisCurator({ cache: cacheThatMustNotBeCalled() });
    const result = await curator.curate(
      [finding({ tool: "gitleaks", fix_suggestion: "Rotate the key." })],
      { prMeta: prMeta() },
    );
    expect(result.findings[0]!.suggestion).toBe("Rotate the key.");
  });
});

describe("AnalysisCurator — Haiku-curated tools (stub LLM)", () => {
  it("promotes the curate_finding tool_use blocks the model emits", async () => {
    const cache = cacheReturning(curateResponse([CURATE_INPUT]));
    const curator = new AnalysisCurator({ cache });
    const result = await curator.curate([finding()], { prMeta: prMeta() });
    expect(result.curator_skipped).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe("Promoted finding");
  });

  it("drops curatable findings the model does NOT emit (zero tool calls → empty curated set)", async () => {
    const cache = cacheReturning(curateResponse([]));
    const curator = new AnalysisCurator({ cache });
    const result = await curator.curate([finding(), finding()], { prMeta: prMeta() });
    expect(result.curator_skipped).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it("combines always-promote findings with Haiku-promoted ones", async () => {
    const cache = cacheReturning(curateResponse([CURATE_INPUT]));
    const curator = new AnalysisCurator({ cache });
    const result = await curator.curate(
      [finding({ tool: "gitleaks", rule_id: "key" }), finding({ tool: "eslint" })],
      { prMeta: prMeta() },
    );
    // always-promote first (per Python `tuple(always_promote) + curated`), then the curated one.
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]!.title).toBe("gitleaks: key");
    expect(result.findings[1]!.title).toBe("Promoted finding");
    expect(result.curator_skipped).toBe(false);
  });

  it("skips a single malformed curate block but keeps the rest (per-block resilience)", async () => {
    const cache = cacheReturning({
      content: [
        { type: "tool_use", id: "ok", name: CURATE_TOOL_NAME, input: CURATE_INPUT },
        // malformed: start_line 0 violates ge(1) → CurateParseError, skipped, call survives.
        { type: "tool_use", id: "bad", name: CURATE_TOOL_NAME, input: { ...CURATE_INPUT, start_line: 0 } },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
      stop_reason: "tool_use",
    });
    const curator = new AnalysisCurator({ cache });
    const result = await curator.curate([finding()], { prMeta: prMeta() });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe("Promoted finding");
    expect(result.curator_skipped).toBe(false);
  });
});

describe("AnalysisCurator — fail-open on unexpected error", () => {
  it("role-not-configured → always-promote-only + curator_skipped (fail-open, no raise)", async () => {
    const cache: LlmClientCacheLike = {
      async forRole(): Promise<LlmClient> {
        throw new LlmRoleNotConfiguredError("no secondary row");
      },
    };
    const curator = new AnalysisCurator({ cache });
    const result = await curator.curate(
      [finding({ tool: "gitleaks", rule_id: "key" }), finding({ tool: "eslint" })],
      { prMeta: prMeta() },
    );
    // The gitleaks always-promote survives; the eslint finding is dropped (degraded). No raise.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe("gitleaks: key");
    expect(result.curator_skipped).toBe(true);
  });

  it("a non-LLM unexpected error from parsing → always-promote-only + curator_skipped", async () => {
    // A response with a content shape that explodes deep in the transform is unlikely; instead model an
    // unexpected error class raised from forRole that is NOT an LlmInvocationError subclass.
    const cache: LlmClientCacheLike = {
      async forRole(): Promise<LlmClient> {
        throw new RangeError("unexpected non-LLM failure");
      },
    };
    const curator = new AnalysisCurator({ cache });
    const result = await curator.curate(
      [finding({ tool: "trivy", rule_id: "cve" }), finding({ tool: "ruff" })],
      { prMeta: prMeta() },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe("trivy: cve");
    expect(result.curator_skipped).toBe(true);
  });
});

describe("AnalysisCurator — typed errors re-raise (NOT swallowed by fail-open)", () => {
  it("budget exceeded → re-raises BedrockBudgetExceededError", async () => {
    const curator = new AnalysisCurator({ cache: cacheWithBudgetDeny() });
    await expect(
      curator.curate([finding()], { prMeta: prMeta() }),
    ).rejects.toBeInstanceOf(BedrockBudgetExceededError);
  });

  it("invocation error → re-raises LlmInvocationError", async () => {
    const curator = new AnalysisCurator({ cache: cacheThrowingFromSdk(new LlmInvocationError("flake")) });
    await expect(
      curator.curate([finding()], { prMeta: prMeta() }),
    ).rejects.toBeInstanceOf(LlmInvocationError);
  });
});
