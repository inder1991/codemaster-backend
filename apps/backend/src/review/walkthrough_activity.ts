// generateWalkthrough — port of the frozen Python generate_walkthrough Temporal activity
//   vendor/codemaster-py/codemaster/review/walkthrough_activity.py::WalkthroughActivities (S8.5.2b)
//   + the COLLAPSED-ON walkthrough fallback that lives in the Python WORKFLOW body
//   (vendor/codemaster-py/codemaster/workflows/review_pull_request.py:2222-2325).
//
// Takes a PrMetaV1 + AggregatedFindingsV1 (+ pre-resolved linked_issues / suggested_reviewers) and
// produces a WalkthroughV1 via an Opus call with WALKTHROUGH_TOOL_SCHEMA. The activity holds an
// injected LlmClientCache and resolves the platform-scoped LlmClient per call (the WALKTHROUGH role
// resolves to claude-opus-4-7 via the central purpose→model seed — distinct from the review role's
// sonnet). Untrusted PR content (title / description / file paths) is wrapped by wrapUntrusted; the
// `truncated` flag from aggregation propagates verbatim (the model cannot override it).
//
// ── Where the fallback lives (a deliberate restructure during the port) ──────────────────────────
//
// In the frozen Python, `generate_walkthrough` RAISES `ApplicationError` on every failure path
// (budget / output-unsafe-terminal / invocation / parse), and the WORKFLOW BODY catches
// `(BedrockInvocationError, ActivityError)` and synthesizes the fallback walkthrough. This TS port
// FOLDS that fallback INTO the activity: the LLM-path errors are caught here and the activity returns
// the synthesized fallback WalkthroughV1 directly instead of throwing. The behaviour is identical to
// the Python (activity-raises → workflow-catches-and-synthesizes) composition; only the seam moved.
//
// The fallback ALWAYS synthesizes file_rows via synthesizeFileRowsFromAggregated — the Python
// `workflow.patched("walkthrough-cost-cap-synthesis")` gate is COLLAPSED-ON per the gate ledger
// (apps/backend/src/review/pipeline/gates.ts), so the empty-file_rows legacy branch is dead code and
// is NOT ported. The synthesized fallback mirrors the collapsed-on Python branch byte-for-byte:
//   tldr = "Walkthrough generation temporarily unavailable. {n} finding(s) detected; see inline
//           comments below."
//   file_rows = synthesizeFileRowsFromAggregated(aggregated.findings)
//   configuration_section_md = ""
//   truncated = false
//   degradation_note = LLM_FALLBACK_SYNTHESIS_NOTE
//
// Runtime context: this is an ACTIVITY (the normal Node runtime, NOT the workflow V8-isolate sandbox),
// so the LLM client / crypto / uuid / clock all live INSIDE the activity, exactly like
// bedrockReviewChunk — none of it is in the workflow bundle.

import { createHash } from "node:crypto";

import { LlmInvocationError, LlmOutputUnsafeError } from "#backend/integrations/llm/errors.js";
import type { LlmClient } from "#backend/integrations/llm/client.js";
import { BedrockBudgetExceededError } from "#backend/cost/enforcer.js";
import { purposeChunkId } from "#backend/integrations/llm/invocation_ledger.js";
import { buildSystemPrompt } from "#backend/llm/review_prompt.js";
import { modelForPurpose } from "#backend/llm/model_router.js";
import { wrapUntrusted } from "#backend/security/trust_tier_wrapping.js";
import { redactText } from "#backend/redact/output_redaction.js";

import {
  LLM_FALLBACK_SYNTHESIS_NOTE,
  synthesizeFileRowsFromAggregated,
} from "#backend/review/file_rows_synthesizer.js";
import {
  WALKTHROUGH_TOOL_SCHEMA,
  WalkthroughParseError,
  parseWalkthroughToolUse,
} from "#backend/review/walkthrough_schema.js";

import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import type { GenerateWalkthroughInputV1 } from "#contracts/generate_walkthrough_input.v1.js";
import type { LlmMessage } from "#contracts/llm_message.v1.js";
import {
  ORIGINAL_TEXT_MAX_BYTES,
  OutputSafetySanitizationEventV1,
} from "#contracts/review_chunk_response.v1.js";
import type { LinkedIssueV1, PrMetaV1, WalkthroughV1 } from "#contracts/walkthrough.v1.js";

/** The cache the activity resolves the platform-scoped LlmClient from. Mirrors `LlmClientCache`. */
export type LlmClientCacheLike = {
  forRole(role: string): Promise<LlmClient>;
};

/**
 * Output-token budget for the walkthrough call. 1:1 with the frozen Python `WALKTHROUGH_MAX_TOKENS`:
 * the invoke default (1024) is too small — on a findings-heavy PR the TL;DR alone can consume the
 * budget before file_rows is emitted (stop_reason=max_tokens), so the rendered review carries NO
 * per-file table even though the activity "succeeds". 4096 leaves room for TL;DR + table. Surfaced by
 * the 2026-06-02 smoke (PR #122).
 */
export const WALKTHROUGH_MAX_TOKENS = 4096;

/**
 * de-Temporal Phase 2 (D2 / W2.2) — the tool-schema-version component of the walkthrough's LLM-invocation
 * idempotency key. A content-addressable digest of WALKTHROUGH_TOOL_SCHEMA: when the tool schema changes
 * (which changes the SHAPE of the structured output, and therefore the parse), the key changes and a
 * stale stored response is NOT replayed. Per-site (distinct from review_activity's REVIEW_TOOL_SCHEMA_VERSION),
 * so two PR-level purposes never share a tool-schema digest. `createHash` is the gate-sanctioned hashing
 * primitive (clock_random gate bans random fns, NOT createHash; mirrors review_activity.ts:55).
 */
export const WALKTHROUGH_TOOL_SCHEMA_VERSION = `wts-${createHash("sha256")
  .update(Buffer.from(JSON.stringify(WALKTHROUGH_TOOL_SCHEMA), "utf-8"))
  .digest("hex")
  .slice(0, 16)}`;

/**
 * Strip the `refs/heads/` prefix GitHub sometimes returns so the prompt sees the bare branch name
 * (`main`, not `refs/heads/main`). 1:1 with the frozen Python `_normalize_ref`.
 */
function normalizeRef(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const prefix = "refs/heads/";
  if (raw.startsWith(prefix)) {
    return raw.slice(prefix.length);
  }
  return raw;
}

/**
 * Render the enrichment fields when populated. 1:1 with the frozen Python `_format_pr_context`. Empty
 * / null values are silently dropped so a pre-DM.12 PrMetaV1 (every field None) produces the same body
 * it did before. Adversarial values stay inside the wrapUntrusted block around the whole message.
 */
function formatPrContext(prMeta: PrMetaV1): Array<string> {
  const parts: Array<string> = [];
  if (prMeta.author_login !== null) {
    parts.push(`- author: @${prMeta.author_login}`);
  } else if (prMeta.author_login === null && prMeta.opened_at !== null) {
    // Author row missing despite a populated opened_at — render the placeholder so the model sees we
    // know the PR exists but the author rendering failed.
    parts.push("- author: (deleted user)");
  }
  if (prMeta.draft) {
    parts.push("- status: DRAFT (work-in-progress; tone-down review)");
  }
  const base = normalizeRef(prMeta.base_ref);
  const head = normalizeRef(prMeta.head_ref);
  if (base && head) {
    parts.push(`- branches: ${head} → ${base}`);
  } else if (base) {
    parts.push(`- base: ${base}`);
  } else if (head) {
    parts.push(`- head: ${head}`);
  }
  if (prMeta.opened_at !== null) {
    parts.push(`- opened: ${dateIso(prMeta.opened_at)}`);
  }
  return parts;
}

/**
 * Render the `opened_at` datetime's date component as an ISO date (YYYY-MM-DD), mirroring the Python
 * `pr_meta.opened_at.date().isoformat()`. `opened_at` on the wire is an RFC3339 string (Zod
 * `.datetime({offset:true})`); the leading 10 chars are the `YYYY-MM-DD` calendar date in the
 * payload's own offset — identical to what Python's `.date()` reads off the parsed datetime (both take
 * the date as written, with no timezone re-projection).
 */
function dateIso(rfc3339: string): string {
  return rfc3339.slice(0, 10);
}

/** Python `str(bool)` — `True` / `False` (capitalized). Mirrors the f-string rendering of a bool. */
function pyBool(value: boolean): string {
  return value ? "True" : "False";
}

/**
 * Build the walkthrough LLM user message. 1:1 with the frozen Python `_build_user_message`. Exported
 * for the Tier-1 parity oracle (the dual-run replays the recorded interaction keyed on these exact
 * bytes, so this is CHAR-FOR-CHAR significant).
 */
export function buildWalkthroughUserMessage(args: {
  prMeta: PrMetaV1;
  aggregated: AggregatedFindingsV1;
}): string {
  const { prMeta, aggregated } = args;
  const parts: Array<string> = [
    `# pull request: ${prMeta.repo}`,
    `## title\n${prMeta.pr_title}`,
  ];
  const prContext = formatPrContext(prMeta);
  if (prContext.length > 0) {
    parts.push("## context");
    parts.push(...prContext);
  }
  parts.push(`## description\n${prMeta.pr_description}`);
  parts.push("");
  parts.push(`## aggregated findings (${aggregated.findings.length})`);
  if (aggregated.findings.length === 0) {
    parts.push("(no actionable findings)");
  } else {
    for (const f of aggregated.findings) {
      parts.push(
        `- [${f.severity}] ${f.file}:${f.start_line}-${f.end_line} (${f.category}) ${f.title}`,
      );
    }
  }
  parts.push("");
  parts.push("## stats");
  parts.push(`- input_count: ${aggregated.dedupe_stats.input_count}`);
  parts.push(`- exact_dropped: ${aggregated.dedupe_stats.exact_dropped}`);
  parts.push(`- semantic_merged: ${aggregated.dedupe_stats.semantic_merged}`);
  parts.push(`- capped: ${aggregated.dedupe_stats.capped}`);
  // Python f-string renders a bool as `True`/`False` (capitalized); JS `${bool}` renders `true`/`false`.
  // The dual-run replays the recorded interaction keyed on these exact bytes, so emit the Python repr.
  parts.push(`- semantic_skipped: ${pyBool(aggregated.dedupe_stats.semantic_skipped)}`);
  return wrapUntrusted(parts.join("\n"));
}

/**
 * Force `truncated` and degradation hints from aggregation onto the model's walkthrough — the model
 * cannot lie about these. 1:1 with the frozen Python `_propagate_aggregation_signals`.
 */
function propagateAggregationSignals(
  walkthrough: WalkthroughV1,
  aggregated: AggregatedFindingsV1,
): WalkthroughV1 {
  const forcedTruncated = aggregated.dedupe_stats.capped > 0;
  if (
    walkthrough.truncated === forcedTruncated &&
    (walkthrough.degradation_note !== null || !aggregated.dedupe_stats.semantic_skipped)
  ) {
    return walkthrough;
  }
  let note = walkthrough.degradation_note;
  if (aggregated.dedupe_stats.semantic_skipped && !note) {
    note = "semantic-merge stage skipped (embedder unavailable)";
  }
  return {
    ...walkthrough,
    degradation_note: note,
    truncated: forcedTruncated,
  };
}

/**
 * Build the COLLAPSED-ON synthesized fallback walkthrough. 1:1 with the
 * `workflow.patched("walkthrough-cost-cap-synthesis")` true branch in the frozen Python workflow body
 * (review_pull_request.py:2305-2315). The legacy empty-file_rows branch is dead code (gate
 * collapsed-on) and is NOT ported.
 */
function synthesizedFallback(aggregated: AggregatedFindingsV1): WalkthroughV1 {
  const nFindings = aggregated.findings.length;
  const synthesized = synthesizeFileRowsFromAggregated(aggregated.findings);
  return {
    schema_version: 1,
    tldr:
      `Walkthrough generation temporarily unavailable. ` +
      `${nFindings} finding(s) detected; see inline comments below.`,
    file_rows: synthesized,
    configuration_section_md: "",
    degradation_note: LLM_FALLBACK_SYNTHESIS_NOTE,
    truncated: false,
    suggested_reviewers: [],
    linked_issues: [],
    sanitization_event: null,
  };
}

/** The 64KB UTF-8-byte cap + marker the audit payload's original_text carries (1:1 with Python). */
function capOriginalText(text: string): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= ORIGINAL_TEXT_MAX_BYTES) {
    return text;
  }
  return (
    new TextDecoder("utf-8").decode(encoded.subarray(0, ORIGINAL_TEXT_MAX_BYTES)) + "…[truncated]"
  );
}

/**
 * Drive one walkthrough invocation. 1:1 in intent with the frozen Python `_do_generate` PLUS the
 * collapsed-on workflow-body fallback folded in: the LLM-path errors that the Python activity converts
 * to `ApplicationError` (and the workflow body catches) are caught here and return the synthesized
 * fallback directly.
 *
 * The happy path parses the emit_walkthrough tool_use block, propagates aggregation signals, attaches
 * the sanitization event (when the secret-leaked sanitize-and-continue branch fired), and embeds the
 * pre-resolved linked_issues / suggested_reviewers tuples.
 */
export async function doGenerateWalkthrough(
  args: {
    prMeta: PrMetaV1;
    aggregated: AggregatedFindingsV1;
    linkedIssues: ReadonlyArray<LinkedIssueV1>;
    suggestedReviewers: ReadonlyArray<string>;
  },
  deps: { cache: LlmClientCacheLike },
): Promise<WalkthroughV1> {
  const { prMeta, aggregated, linkedIssues, suggestedReviewers } = args;
  const role = "primary";

  // Resolve the platform-scoped LlmClient via the cache. LlmRoleNotConfigured/Disabled are subclasses
  // of LlmInvocationError, so a resolve failure routes into the same graceful-degrade fallback as an
  // upstream invocation flake (the Python maps both to type="BedrockInvocationError" and the workflow
  // catch synthesizes; here we synthesize directly).
  let llmClient: LlmClient;
  try {
    llmClient = await deps.cache.forRole(role);
  } catch (e) {
    if (e instanceof LlmInvocationError) {
      return synthesizedFallback(aggregated);
    }
    throw e;
  }

  const systemPrompt = buildSystemPrompt({ policyRevision: aggregated.policy_revision });
  const messages: Array<LlmMessage> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildWalkthroughUserMessage({ prMeta, aggregated }) },
  ];
  // ADR-0060 step 0: source the walkthrough model from the central purpose→model seed (claude-opus-4-7,
  // distinct from the review role's sonnet). The DB-backed async resolve merges DB rows over the seed
  // (out of scope here — no DB in this slice); the pure seed resolver IS the unconfigured fallback.
  const walkthroughModel = modelForPurpose("walkthrough");

  let sanitizationEvent: OutputSafetySanitizationEventV1 | null = null;
  let rawBlocks: ReadonlyArray<Record<string, unknown>>;
  try {
    const result = await llmClient.invokeModel({
      role,
      model: walkthroughModel as Parameters<LlmClient["invokeModel"]>[0]["model"],
      messages,
      maxTokens: WALKTHROUGH_MAX_TOKENS,
      tools: [WALKTHROUGH_TOOL_SCHEMA as unknown as Record<string, unknown>],
      purpose: "walkthrough",
      // TS hardening divergence (ADR-0068) — the REAL installation_id flows to the cost-cap (per-org
      // isolation), blob put, and telemetry/Langfuse rows. Mirrors the review_activity decision; Python
      // platform-scopes the call (substitutes the all-ones sentinel). Genuine platform jobs would pass
      // PLATFORM_INVOCATION_INSTALLATION_ID; the walkthrough is per-PR, so the PR's installation owns it.
      installationId: prMeta.installation_id,
      // de-Temporal Phase 2 (D2 / W2.2 / F9) — ledger this PR-level paid call by PURPOSE. The stable key is
      // review_id (prMeta.pr_id — the PR/review identity) + the purpose chunk-key surrogate
      // (purposeChunkId("walkthrough"), E8) + role + model + prompt hash + WALKTHROUGH_TOOL_SCHEMA_VERSION.
      // run_id is deliberately NOT in the key (D2: the output need not change per run). On a retry the
      // stored provider response replays instead of buying a second paid Bedrock completion. F9: the SAME
      // "walkthrough" token drives BOTH the chunk-key surrogate AND the metric purpose label
      // (ledgerPurpose), so cost observability and replay keying never diverge. The client only acts on
      // this when constructed with a ledger; unit tests / platform jobs (no ledger) behave as the frozen
      // Python (invoke, no replay).
      idempotency: {
        reviewId: prMeta.pr_id,
        chunkId: purposeChunkId("walkthrough"),
        toolSchemaVersion: WALKTHROUGH_TOOL_SCHEMA_VERSION,
        ledgerPurpose: "walkthrough",
      },
    });
    rawBlocks = result.raw_content_blocks;
  } catch (e) {
    // (a) Budget exceeded → Python raises non-retryable; the workflow catch synthesizes. Synthesize here.
    if (e instanceof BedrockBudgetExceededError) {
      return synthesizedFallback(aggregated);
    }
    // (b) Output unsafe → SANITIZE-AND-CONTINUE iff the decision reasons INCLUDE secret_leaked AND
    //     secret findings exist; otherwise terminal (Python raises non-retryable → workflow synthesizes).
    if (e instanceof LlmOutputUnsafeError) {
      const decision = e.decision;
      if (!decision.reasons.includes("secret_leaked") || decision.findings.length === 0) {
        // Non-secret block (length / privileged_tag / tool_call_shape) → structurally-broken response;
        // Python raises BedrockOutputUnsafeError (non-retryable) and the workflow catch synthesizes.
        return synthesizedFallback(aggregated);
      }
      const redaction = redactText(e.contentText, decision.findings);
      const truncatedOriginal = capOriginalText(e.contentText);
      // Sprint 1 v2 review item M3 — the client sets request_id unconditionally before the raise. If it
      // is ever null here the deterministic audit_event_id derivation would silently break idempotency;
      // assert the invariant explicitly (1:1 with the Python RuntimeError).
      if (e.requestId === null) {
        throw new Error(
          "LlmOutputUnsafeError carried no request_id — " +
            "expected the LlmClient to set it unconditionally before raise. Audit-row idempotency " +
            "depends on a stable request_id; this is a hard invariant break.",
          { cause: e },
        );
      }
      const detectorKinds = [...new Set(decision.findings.map((f) => f.kind))].sort();
      sanitizationEvent = OutputSafetySanitizationEventV1.parse({
        installation_id: prMeta.installation_id,
        request_id: e.requestId,
        original_text: truncatedOriginal,
        redacted_text: redaction.redactedText,
        spans_redacted: redaction.spansRedacted,
        detector_kinds: detectorKinds,
        stage: "walkthrough",
      });
      // tool_use blocks (the structured walkthrough payload) survive untouched — the validator's
      // text-only scan didn't redact them. Parse and fall through to the propagators below.
      rawBlocks = e.rawContentBlocks;
    } else if (e instanceof LlmInvocationError) {
      // (c) Any other invocation error → Python raises retryable; the workflow catch synthesizes.
      return synthesizedFallback(aggregated);
    } else {
      throw e;
    }
  }

  let walkthrough: WalkthroughV1;
  try {
    walkthrough = parseWalkthroughToolUse(rawBlocks);
  } catch (e) {
    if (e instanceof WalkthroughParseError) {
      // Python raises non-retryable WalkthroughParseError → the workflow catch synthesizes.
      return synthesizedFallback(aggregated);
    }
    throw e;
  }

  let propagated = propagateAggregationSignals(walkthrough, aggregated);
  if (sanitizationEvent !== null) {
    propagated = { ...propagated, sanitization_event: sanitizationEvent };
  }
  if (linkedIssues.length > 0) {
    // DM-WIRE T4 — embed the pre-resolved linked-issues tuple. Empty → leave the default [].
    propagated = { ...propagated, linked_issues: [...linkedIssues] };
  }
  if (suggestedReviewers.length > 0) {
    // S23.AR.3 (B5 producer) — embed the pre-resolved suggested-reviewers tuple. Empty → leave [].
    propagated = { ...propagated, suggested_reviewers: [...suggestedReviewers] };
  }
  return propagated;
}

/**
 * Bound-method holder for the generate_walkthrough activity — 1:1 with the frozen Python
 * `WalkthroughActivities(cache=...)`. The worker bootstrap constructs it with the role-keyed
 * LlmClientCache (the WALKTHROUGH role resolves to opus) and registers its `generateWalkthrough` bound
 * method. The method is an arrow property so it stays bound when destructured into the activities map
 * (Temporal registers the function value directly, losing `this`). Mirrors AggregateFindingsActivity.
 *
 * The activity's single positional input is the {@link GenerateWalkthroughInputV1} envelope (CLAUDE.md
 * invariant 11 / ADR-0047) — the Python activity's 4-positional dispatch
 * (pr_meta, aggregated, linked_issues, suggested_reviewers) is closed into one typed envelope here.
 */
export class WalkthroughActivities {
  private readonly cache: LlmClientCacheLike;

  public constructor({ cache }: { cache: LlmClientCacheLike }) {
    this.cache = cache;
  }

  public readonly generateWalkthrough = async (
    input: GenerateWalkthroughInputV1,
  ): Promise<WalkthroughV1> => {
    return doGenerateWalkthrough(
      {
        prMeta: input.pr_meta,
        aggregated: input.aggregated,
        linkedIssues: input.linked_issues,
        suggestedReviewers: input.suggested_reviewers,
      },
      { cache: this.cache },
    );
  };
}
