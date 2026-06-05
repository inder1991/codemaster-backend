// doReview + bedrockReviewChunk — 1:1 port of the frozen Python
//   vendor/codemaster-py/codemaster/review/activities.py::_do_review (972-1177) and
//   ReviewActivities.bedrock_review_chunk (1200-1224).
//
// doReview drives one review-chunk LLM invocation and returns (findings, intents, sanitization_event).
// bedrockReviewChunk wraps that into the ReviewChunkResponseV1 envelope — the activity return shape.
//
// The OBSERVABLE OUTPUT is the ReviewChunkResponseV1 — a DETERMINISTIC pure transform of the cassette
// LLM response. doReview composes the (already-ported) reuse modules: buildSystemPrompt + buildUserMessage
// (the LLM input), the LlmClient.invokeModel transform (which runs the REAL output-safety validator),
// and parseWithSkipMalformed (the scope/evidence-enforcing parser). The three error paths + the
// sanitize-and-continue branch are ported byte-faithfully.
//
// Temporal mapping: the Python raises `temporalio.exceptions.ApplicationError(msg, type=..., non_retryable=...)`.
// The TS analogue is `ApplicationFailure.create({ message, type, nonRetryable })` from @temporalio/common
// (the same class the Python ApplicationError serializes to over the wire).

import { ApplicationFailure } from "@temporalio/common";

import { BedrockBudgetExceededError } from "#backend/cost/enforcer.js";
import {
  LlmInvocationError,
  LlmOutputUnsafeError,
  LlmRoleDisabledError,
  LlmRoleNotConfiguredError,
} from "#backend/integrations/llm/errors.js";
import type { LlmClient } from "#backend/integrations/llm/client.js";
import { buildSystemPrompt, REVIEW_TOOL_SCHEMA, ARBITRATION_INTENT_TOOL_SCHEMA } from "#backend/llm/review_prompt.js";
import { modelForPurpose } from "#backend/llm/model_router.js";
import { buildUserMessage } from "#backend/review/prompt_builder.js";
import { parseWithSkipMalformed } from "#backend/review/chunk_response_parser.js";
import { redactText } from "#backend/redact/output_redaction.js";

import type { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";
import type { LlmMessage } from "#contracts/llm_message.v1.js";
import { ORIGINAL_TEXT_MAX_BYTES, OutputSafetySanitizationEventV1, ReviewChunkResponseV1 } from "#contracts/review_chunk_response.v1.js";
import type { ReviewContextV1 } from "#contracts/review_context.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

/** The cache the activity resolves the platform-scoped LlmClient from. Mirrors `LlmClientCache`. */
export type LlmClientCacheLike = {
  forRole(role: string): Promise<LlmClient>;
};

/**
 * `_evidence_ids_from_context` (Python ~840-862): the allowed-evidence-id set the parser enforces.
 *   * empty `retrieved_evidence` → `null` ("no v10 manifest was issued for this chunk"; validation
 *     disabled — back-compat). This is NOT `frozenset()` (which would mean "evidence explicitly
 *     forbidden"); the distinction is load-bearing for the parser kwarg semantics.
 *   * otherwise → the set of `ev.evidence_id`.
 */
function evidenceIdsFromContext(context: ReviewContextV1): ReadonlySet<string> | null {
  if (context.retrieved_evidence.length === 0) {
    return null;
  }
  return new Set(context.retrieved_evidence.map((ev) => ev.evidence_id));
}

/** The 3-tuple doReview returns: (findings, arbitration intents, sanitization event | null). */
export type DoReviewResult = {
  findings: Array<ReviewFindingV1>;
  intents: Array<ArbitrationIntentV1>;
  sanitizationEvent: OutputSafetySanitizationEventV1 | null;
};

/**
 * Drive a single review-chunk invocation. 1:1 with the Python `_do_review`.
 *
 * ADR-0060 step 0: when `model` is undefined (the default), it resolves from the central purpose→model
 * seed for `review_finding` (unchanged value: claude-sonnet-4-6). An explicit `model` still overrides.
 */
export async function doReview(
  context: ReviewContextV1,
  args: { cache: LlmClientCacheLike; model?: string },
): Promise<DoReviewResult> {
  const role = "primary";

  // Resolve the platform-scoped LlmClient via the cache. LlmRoleNotConfigured/Disabled →
  // ApplicationFailure(type="BedrockInvocationError", non_retryable=false) routing to graceful-degrade.
  let llmClient: LlmClient;
  try {
    llmClient = await args.cache.forRole(role);
  } catch (e) {
    if (e instanceof LlmRoleNotConfiguredError || e instanceof LlmRoleDisabledError) {
      throw ApplicationFailure.create({
        message: e.message,
        type: "BedrockInvocationError",
        nonRetryable: false,
      });
    }
    throw e;
  }

  // ADR-0060 step 0: resolve the review_finding model from the central seed unless overridden. The
  // DB-backed async resolve_model_for_purpose merges DB rows over the seed (out of scope — no DB in
  // this slice); the pure seed resolver IS the unconfigured fallback, which is the cassette behavior.
  const resolvedModel = args.model ?? modelForPurpose("review_finding");

  const systemPrompt = buildSystemPrompt({ policyRevision: context.policy_revision });
  const messages: Array<LlmMessage> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildUserMessage(context) },
  ];

  let result;
  try {
    result = await llmClient.invokeModel({
      role,
      model: resolvedModel as Parameters<LlmClient["invokeModel"]>[0]["model"],
      messages,
      tools: [
        REVIEW_TOOL_SCHEMA as unknown as Record<string, unknown>,
        ARBITRATION_INTENT_TOOL_SCHEMA as unknown as Record<string, unknown>,
      ],
      purpose: "review_finding",
      // R-W1 (2026-05-22): 2048 covers ~3 findings cleanly (2× the prior 1024 default).
      maxTokens: 2048,
    });
  } catch (e) {
    // (a) Budget exceeded → non-retryable.
    if (e instanceof BedrockBudgetExceededError) {
      throw ApplicationFailure.create({
        message: e.message,
        type: "BedrockBudgetExceededError",
        nonRetryable: true,
      });
    }
    // (b) Output unsafe → SANITIZE-AND-CONTINUE iff the decision reasons INCLUDE secret_leaked AND
    //     secret findings exist (Python 1076: `"secret_leaked" not in reasons or not findings` → terminal);
    //     otherwise non-retryable. A secret_leaked reason alongside a non-secret reason still sanitizes.
    if (e instanceof LlmOutputUnsafeError) {
      return sanitizeAndContinue(e, context);
    }
    // (c) Any other bedrock invocation error → retryable.
    if (e instanceof LlmInvocationError) {
      throw ApplicationFailure.create({
        message: e.message,
        type: "BedrockInvocationError",
        nonRetryable: false,
      });
    }
    throw e;
  }

  // Happy path — parse with the SAME allowed_evidence_ids doReview computes from context.
  const { findings, intents } = parseWithSkipMalformed(result.raw_content_blocks, {
    allowedEvidenceIds: evidenceIdsFromContext(context),
  });

  // R-WR4-capture (2026-05-22): per-chunk truncation observability. The Python increments a counter +
  // WARN-logs on max_tokens; that is observability-only with NO downstream behaviour change — `findings`
  // returned is unchanged. The counter/log is a pure side-effect (deferred follow-up; see notes), so
  // the observable return is identical whether or not it fires.

  return { findings, intents, sanitizationEvent: null };
}

/**
 * The output-safety sanitize-and-continue branch (Python 1067-1136). The EXACT condition: the decision
 * reasons must include `secret_leaked` AND carry secret findings; otherwise the block is terminal
 * (length / privileged_tag / tool_call_shape indicate a structurally-broken response, not a sanitizable
 * one) → non-retryable ApplicationFailure.
 */
function sanitizeAndContinue(e: LlmOutputUnsafeError, context: ReviewContextV1): DoReviewResult {
  const decision = e.decision;
  if (!decision.reasons.includes("secret_leaked") || decision.findings.length === 0) {
    throw ApplicationFailure.create({
      message: e.message,
      type: "BedrockOutputUnsafeError",
      nonRetryable: true,
    });
  }

  const redaction = redactText(e.contentText, decision.findings);

  // 64KB cap on original_text in the audit payload (mirrors Python's UTF-8-byte truncation + marker).
  let truncatedOriginal = e.contentText;
  const encoded = new TextEncoder().encode(truncatedOriginal);
  if (encoded.length > ORIGINAL_TEXT_MAX_BYTES) {
    truncatedOriginal =
      new TextDecoder("utf-8").decode(encoded.subarray(0, ORIGINAL_TEXT_MAX_BYTES)) + "…[truncated]";
  }

  // Sprint 1 v2 review item M3: the client unconditionally sets request_id before the raise site. If it
  // is ever null here, the deterministic audit_event_id derivation would silently break idempotency —
  // assert the invariant explicitly rather than fall back to a fresh id.
  if (e.requestId === null) {
    throw new Error(
      "LlmOutputUnsafeError carried no request_id — " +
        "expected the LlmClient to set it unconditionally before raise. Audit-row idempotency depends " +
        "on a stable request_id; this is a hard invariant break.",
    );
  }

  const detectorKinds = [...new Set(decision.findings.map((f) => f.kind))].sort();
  const sanitizationEvent = OutputSafetySanitizationEventV1.parse({
    installation_id: context.installation_id,
    request_id: e.requestId,
    original_text: truncatedOriginal,
    redacted_text: redaction.redactedText,
    spans_redacted: redaction.spansRedacted,
    detector_kinds: detectorKinds,
    stage: "review_chunk",
  });

  // tool_use blocks (the structured findings) survive untouched — the validator's text-only scan didn't
  // redact them. Parse them with the SAME allowed_evidence_ids the happy path uses.
  const { findings, intents } = parseWithSkipMalformed(e.rawContentBlocks, {
    allowedEvidenceIds: evidenceIdsFromContext(context),
  });

  return { findings, intents, sanitizationEvent };
}

/**
 * The `bedrock_review_chunk` activity body (Python 1200-1224). Resolves the LlmClient via the injected
 * cache, drives doReview, and wraps the 3-tuple into the ReviewChunkResponseV1 envelope.
 *
 * The Python keeps the cache on a `ReviewActivities` instance because Temporal disallows keyword-only
 * args on activity functions; the TS port takes the cache as an explicit collaborator (worker bootstrap
 * binds it).
 */
export async function bedrockReviewChunk(
  context: ReviewContextV1,
  args: { cache: LlmClientCacheLike },
): Promise<ReviewChunkResponseV1> {
  const { findings, intents, sanitizationEvent } = await doReview(context, { cache: args.cache });
  return ReviewChunkResponseV1.parse({
    findings,
    arbitration_intents: intents,
    sanitization_event: sanitizationEvent,
  });
}
