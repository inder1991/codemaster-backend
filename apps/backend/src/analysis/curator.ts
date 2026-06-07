// AnalysisCurator — 1:1 port of the frozen Python
//   vendor/codemaster-py/codemaster/analysis/curator.py (Sprint 9 / S9.2.2).
//
// Promotes AnalysisFindingV1s (linter output) to ReviewFindingV1s (reviewer-facing comments) via two
// paths:
//
//   1. ALWAYS-PROMOTE: gitleaks + trivy findings translate 1:1 to
//      ReviewFindingV1(severity="blocker", category="security") with NO LLM invocation. The runner
//      already stamps severity_raw="blocker"; we honour it without curation.
//   2. CURATED: eslint / ruff (and any future eligible tool's) findings are sent to Haiku via the
//      CURATE_TOOL_SCHEMA. The model decides which to promote; non-promoted findings are dropped.
//
// Degradation (curator_skipped):
//   * zero findings → skipped (empty result, no LLM call).
//   * only always-promote tools present (nothing curatable) → skipped (no Haiku call).
//   * an UNEXPECTED failure during the Haiku path → FAIL-OPEN: return the always-promote findings
//     only + curator_skipped=True (the workflow surfaces it in the walkthrough degradation_note).
//
// Typed-error re-raise (NOT swallowed by fail-open): the Python maps budget / output-unsafe /
// invocation errors to ApplicationError and re-raises them (carrying the right non_retryable
// semantics) so the activity short-circuits. The TS LlmClient already raises those typed errors
// (BedrockBudgetExceededError / LlmOutputUnsafeError / LlmInvocationError), so the port re-throws them
// directly instead of re-wrapping — the Orchestrate-phase caller maps them. The fail-open catch only
// covers genuinely unexpected errors (e.g. a role-resolution failure from forRole, or an unknown
// error class), matching the Python `except ApplicationError: raise` / `except Exception: degrade`.
//
// ── PORT NOTE: the curator's LlmClientCache seam ─────────────────────────────────────────────────
// The frozen Python curator takes an injected BedrockClient + resolves its model at call time via the
// DB-backed purpose→model resolver. This TS port mirrors the sibling walkthrough_activity.ts port: it
// holds an injected LlmClientCache and resolves the curator's LlmClient per call via the SECONDARY
// role (Haiku — the secondary slot per the primary/secondary contract). The model is sourced from the
// central purpose→model seed (analysis_curator → claude-haiku-4-5; ADR-0060 step 0); the DB-backed
// async resolve that merges DB rows over the seed is out of scope here (no DB in this slice), so the
// pure seed resolver IS the unconfigured fallback — identical to the walkthrough port.
//
// Runtime context: this runs inside the static_analysis ACTIVITY (the normal Node runtime, NOT the
// workflow V8-isolate sandbox), so the LLM client / crypto / clock all live in the activity, exactly
// like bedrockReviewChunk + generateWalkthrough.

import { BedrockBudgetExceededError } from "#backend/cost/enforcer.js";
import { buildSystemPrompt } from "#backend/llm/review_prompt.js";
import { modelForPurpose } from "#backend/llm/model_router.js";
import { wrapUntrusted } from "#backend/security/trust_tier_wrapping.js";

import type { LlmClient } from "#backend/integrations/llm/client.js";
import {
  LlmInvocationError,
  LlmOutputUnsafeError,
  LlmRoleDisabledError,
  LlmRoleNotConfiguredError,
} from "#backend/integrations/llm/errors.js";

import {
  CURATE_TOOL_SCHEMA,
  CurateParseError,
  parseCurateToolUse,
} from "#backend/analysis/curator_schema.js";

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import type { LlmMessage } from "#contracts/llm_message.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import type { PrMetaV1 } from "#contracts/walkthrough.v1.js";

/** The cache the curator resolves the Haiku LlmClient from. Mirrors `LlmClientCache.forRole`. */
export type LlmClientCacheLike = {
  forRole(role: string): Promise<LlmClient>;
};

/**
 * Tools whose findings ALWAYS bypass the curator + go straight to ReviewFindingV1 at severity=blocker,
 * category=security. 1:1 with the frozen Python `_ALWAYS_PROMOTE_TOOLS = frozenset({"gitleaks",
 * "trivy"})`. A ReadonlySet keeps the membership test off a dynamic object index.
 */
const ALWAYS_PROMOTE_TOOLS: ReadonlySet<string> = new Set<string>(["gitleaks", "trivy"]);

/**
 * Curator output. 1:1 with the frozen Python frozen dataclass `CuratedResult`.
 *
 * `findings` is the full curated set (always-promote + Haiku-promoted). `curator_skipped` is True when
 * the Haiku call was skipped (zero curatable input) or failed (degradation path); callers surface it
 * via the walkthrough degradation_note. Named `curator_skipped` (snake_case) to match the Python
 * field the downstream StaticAnalysisResultV1 envelope carries.
 */
export type CuratedResult = {
  readonly findings: ReadonlyArray<ReviewFindingV1>;
  readonly curator_skipped: boolean;
};

/** Translate an always-promote (gitleaks/trivy) finding 1:1. 1:1 with the Python `_auto_promote`. */
function autoPromote(finding: AnalysisFindingV1): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: finding.file,
    start_line: finding.start_line,
    end_line: finding.end_line,
    severity: "blocker",
    category: "security",
    title: `${finding.tool}: ${finding.rule_id}`,
    body: finding.message,
    suggestion: finding.fix_suggestion,
    confidence: 0.99,
  });
}

/**
 * Assemble the untrusted-wrapped user content for Haiku. 1:1 with the frozen Python
 * `_build_curator_user_message`. Exported for the Tier-1 parity oracle — char-for-char significant
 * (the recorded LLM interaction is keyed on these exact bytes).
 */
export function buildCuratorUserMessage(args: {
  prMeta: PrMetaV1;
  findings: ReadonlyArray<AnalysisFindingV1>;
}): string {
  const { prMeta, findings } = args;
  const parts: Array<string> = [
    `# pull request: ${prMeta.repo}`,
    `## title\n${prMeta.pr_title}`,
    `## description\n${prMeta.pr_description}`,
    "",
    `## linter findings to triage (${findings.length})`,
    "Decide which findings are worth surfacing as reviewer " +
      "comments. Promote each kept finding via the curate_finding " +
      "tool exactly once. Drop the rest by NOT calling the tool " +
      "for them. Do not modify the file/line/range.",
    "",
  ];
  for (const f of findings) {
    parts.push(
      `- [${f.tool}:${f.rule_id}] ${f.file}:${f.start_line}-${f.end_line} ` +
        `(${f.severity_raw}) ${f.message}`,
    );
  }
  return wrapUntrusted(parts.join("\n"));
}

/**
 * Parse curate tool_use blocks one-at-a-time so a single malformed block doesn't poison the whole
 * response. 1:1 with the frozen Python `_parse_with_skip_malformed` (the curator-local one, which does
 * NOT enforce v9-MINIMAL scope / v10 evidence_refs — curator findings are Tier-1 derivatives that are
 * structurally chunk-local with no LLM-cited evidence, so the contract defaults scope=chunk_observed +
 * evidence_refs=[] are correct without enforcement). A CurateParseError on one block is logged + skipped.
 */
function parseWithSkipMalformed(
  blocks: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<ReviewFindingV1> {
  const out: Array<ReviewFindingV1> = [];
  for (const block of blocks) {
    try {
      const chunk = parseCurateToolUse([block]);
      out.push(...chunk);
    } catch (e) {
      if (e instanceof CurateParseError) {
        // Skip the malformed block; the rest of the call survives. Observability-only WARN log on the
        // Python side (block_id + reason) has no return-value effect, so it is intentionally omitted.
        continue;
      }
      throw e;
    }
  }
  return out;
}

/**
 * Promote linter findings to reviewer-facing comments via Haiku. 1:1 with the frozen Python
 * `AnalysisCurator`.
 */
export class AnalysisCurator {
  private readonly cache: LlmClientCacheLike;
  private readonly modelOverride: string | undefined;
  private readonly policyRevision: number;

  public constructor(args: {
    cache: LlmClientCacheLike;
    // ADR-0060: the curator resolves its model via the purpose→model seed (analysis_curator →
    // claude-haiku-4-5) by default. An explicit model= still overrides (eval / tests).
    model?: string;
    policyRevision?: number;
  }) {
    this.cache = args.cache;
    this.modelOverride = args.model;
    this.policyRevision = args.policyRevision ?? 0;
  }

  /**
   * Curate `findings` against `prMeta`. Always-promote tools (gitleaks/trivy) bypass the LLM; the rest
   * go to Haiku via the curate_finding tool. Returns the full curated set + curator_skipped.
   */
  public async curate(
    findings: ReadonlyArray<AnalysisFindingV1>,
    args: { prMeta: PrMetaV1 },
  ): Promise<CuratedResult> {
    if (findings.length === 0) {
      return { findings: [], curator_skipped: true };
    }

    const alwaysPromote: Array<ReviewFindingV1> = [];
    const curatable: Array<AnalysisFindingV1> = [];
    for (const f of findings) {
      if (ALWAYS_PROMOTE_TOOLS.has(f.tool)) {
        alwaysPromote.push(autoPromote(f));
      } else {
        curatable.push(f);
      }
    }

    // Skip the Haiku call entirely when there's nothing to curate.
    if (curatable.length === 0) {
      return { findings: alwaysPromote, curator_skipped: true };
    }

    try {
      const curated = await this.invokeHaiku(curatable, { prMeta: args.prMeta });
      return { findings: [...alwaysPromote, ...curated], curator_skipped: false };
    } catch (e) {
      // Re-raise the typed LLM errors the LlmClient maps to ApplicationError on the Python side
      // (budget / output-unsafe / invocation) — they carry the right non_retryable semantics for the
      // Orchestrate-phase caller. Everything else (e.g. a role-resolution failure, an unknown error
      // class) FAILS OPEN: return the always-promote findings only + curator_skipped, so a curator
      // flake never fails the review. 1:1 with the Python `except ApplicationError: raise` /
      // `except Exception: degrade`.
      if (isTypedLlmError(e)) {
        throw e;
      }
      return { findings: alwaysPromote, curator_skipped: true };
    }
  }

  // ─── internals ───────────────────────────────────────────────────────────────────────────────

  private async invokeHaiku(
    curatable: ReadonlyArray<AnalysisFindingV1>,
    args: { prMeta: PrMetaV1 },
  ): Promise<ReadonlyArray<ReviewFindingV1>> {
    const role = "secondary";
    // Resolve the Haiku LlmClient via the SECONDARY role. A resolution failure (role-not-configured /
    // disabled — subclasses of LlmInvocationError) is NOT a typed-ApplicationError-equivalent here: in
    // the Python it would surface from the bedrock client only at invoke time, but a forRole failure is
    // a curator-degradation, so it routes into the fail-open catch in curate() (isTypedLlmError is
    // false for it because forRole errors are caught and treated as unexpected per the Python outer
    // except Exception). To make that explicit we let forRole errors propagate to curate()'s catch.
    const llmClient = await this.cache.forRole(role);

    const systemPrompt = buildSystemPrompt({ policyRevision: this.policyRevision });
    const messages: Array<LlmMessage> = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: buildCuratorUserMessage({ prMeta: args.prMeta, findings: curatable }),
      },
    ];
    // ADR-0060 step 0: source the curator model from the central purpose→model seed
    // (analysis_curator → claude-haiku-4-5). An explicit override wins (eval / tests).
    const model = this.modelOverride ?? modelForPurpose("analysis_curator");

    const result = await llmClient.invokeModel({
      role,
      model: model as Parameters<LlmClient["invokeModel"]>[0]["model"],
      messages,
      tools: [CURATE_TOOL_SCHEMA as unknown as Record<string, unknown>],
      // S17.X-tool-dispatch — purpose pins routing + cost-cap attribution to the analysis-curator
      // budget.
      purpose: "analysis_curator",
      // The REAL installation_id flows to the cost-cap (per-org isolation), blob put, and
      // telemetry/Langfuse rows — mirrors the walkthrough port. Python platform-scopes the call; the
      // curation is per-PR, so the PR's installation owns it.
      installationId: args.prMeta.installation_id,
    });

    return parseWithSkipMalformed([...result.raw_content_blocks]);
  }
}

/**
 * True iff `e` is one of the typed LLM errors the Python curator re-raises as a non-retryable /
 * retryable ApplicationError (budget / output-unsafe / invocation) — these must NOT be swallowed by the
 * fail-open path; the Orchestrate-phase caller maps them. Everything else fails open.
 *
 * The role-resolution failures (LlmRoleNotConfiguredError / LlmRoleDisabledError) are SUBCLASSES of
 * LlmInvocationError but are EXCLUDED here: a forRole failure is a curator-degradation (the Python
 * outer `except Exception` fail-open), not an invoke-time ApplicationError, so it must fail open to the
 * always-promote findings. The explicit subclass exclusion makes that boundary unambiguous (an
 * instanceof LlmInvocationError check alone would wrongly re-raise them).
 */
function isTypedLlmError(e: unknown): boolean {
  if (e instanceof LlmRoleNotConfiguredError || e instanceof LlmRoleDisabledError) {
    return false;
  }
  return (
    e instanceof BedrockBudgetExceededError ||
    e instanceof LlmOutputUnsafeError ||
    e instanceof LlmInvocationError
  );
}
