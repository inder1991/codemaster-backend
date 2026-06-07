// LlmBackedRerankPort — a bounded LLM reranker (ENHANCEMENT beyond the frozen Python, which ships ONLY
// the IdentityRerankPort no-op). Implements {@link LlmRerankerPort}: a small LLM (Haiku) scores each
// RRF-fused candidate in [0,1] for relevance to the query; LlmRerank keeps the top-5.
//
// Bounded on three axes the user asked for:
//   - TIMEOUT: a soft wall-clock bound (Promise.race). On timeout the rerank is abandoned + the call
//     falls back. NOTE: invokeModel has no AbortSignal seam, so the abandoned call may still complete in
//     the background (charging its cost) — the bound is on REVIEW LATENCY, not on the in-flight request.
//   - COST CAP: enforced INSIDE invokeModel (BedrockBudgetExceededError). Unlike the curator (which
//     re-raises it), rerank is optional polish — a cost-cap breach maps to LlmRerankUnavailableError so
//     LlmRerank.apply falls back to the RRF order instead of failing the review.
//   - TRACE ROWS: emitted by invokeModel (telemetry.llm_calls + Langfuse), attributed to the PR's
//     installation_id + the `retrieval_rerank` purpose bucket.
//
// FALLBACK: every failure (role resolution, timeout, cost cap, invocation error, malformed scores) is
// mapped to {@link LlmRerankUnavailableError}; {@link LlmRerank.apply} catches it and falls back to the
// RRF order with degraded=true, so a rerank flake never fails the review.
//
// OPT-IN: IdentityRerankPort stays the safe default. The retrieve_knowledge activity constructs THIS
// port per-invocation with the query's installation_id (cost attribution) + a configured "secondary"
// role; until the owner seeds that role + flips the wiring, identity rerank runs (1:1 with Python). The
// port carries installation_id at construction because LlmRerankerPort.rerank() does not receive it.

import { transportAbortSignal } from "#platform/transport_timeout.js";

import { BedrockBudgetExceededError } from "#backend/cost/enforcer.js";
import type { LlmClient } from "#backend/integrations/llm/client.js";
import { modelForPurpose } from "#backend/llm/model_router.js";
import { LlmRerankUnavailableError, type LlmRerankerPort } from "#backend/retrieval/llm_rerank.js";

import type { KnowledgeChunkV1 } from "#contracts/knowledge_chunks.v1.js";
import type { LlmMessage } from "#contracts/llm_message.v1.js";

/** The narrow cache the reranker resolves its LlmClient from (mirrors LlmClientCache.forRole). */
export type RerankLlmCacheLike = {
  forRole(role: string): Promise<LlmClient>;
};

/** Cost-attribution bucket for rerank spend (distinct from review / curation). */
const RERANK_PURPOSE = "retrieval_rerank";
const RERANK_TOOL_NAME = "submit_relevance_scores";
/** Per-candidate body snippet rendered into the prompt — enough signal, bounded prompt cost. */
const BODY_SNIPPET_CHARS = 600;
const DEFAULT_TIMEOUT_MS = 4_000;
/** The scores array is tiny (≤ pre-rerank-top-k floats) — a small completion cap keeps cost down. */
const RERANK_MAX_TOKENS = 256;

const RERANK_SYSTEM_PROMPT =
  "You rank candidate knowledge documents by their relevance to a code-review query. You will be given " +
  "the query and a numbered list of candidates. Call the submit_relevance_scores tool with one score " +
  "in the range [0.0, 1.0] for EACH candidate, in the SAME order and the SAME count as the list. A " +
  "higher score means more relevant. Do not add commentary.";

/** Structured-output tool: one relevance score in [0,1] per candidate, in order. */
export const RERANK_TOOL_SCHEMA = {
  name: RERANK_TOOL_NAME,
  description:
    "Submit one relevance score in [0.0, 1.0] for each candidate document, in the SAME order and count " +
    "as the numbered list.",
  input_schema: {
    type: "object",
    properties: {
      scores: {
        type: "array",
        items: { type: "number", minimum: 0, maximum: 1 },
        description: "One score per candidate; same order; same length as the candidate list.",
      },
    },
    required: ["scores"],
  },
} as const;

/** Typed soft-timeout marker (internal; mapped to LlmRerankUnavailableError below). */
class RerankTimeoutError extends Error {
  public constructor(ms: number) {
    super(`rerank LLM call exceeded ${ms}ms`);
    this.name = "RerankTimeoutError";
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Sentinel the timeout branch resolves with (so a won race never leaves an unhandled rejection). */
const TIMED_OUT: unique symbol = Symbol("rerank-timeout");

/**
 * Race `p` against a soft timeout. The timer is the sanctioned {@link transportAbortSignal} seam (the
 * only place `AbortSignal.timeout` is allow-listed by the clock/random gate); here we merely LISTEN to
 * its abort. The timeout branch RESOLVES with {@link TIMED_OUT} (never rejects), so when `p` wins the
 * still-pending timeout settles harmlessly. Throws {@link RerankTimeoutError} when the timeout wins.
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const signal = transportAbortSignal(ms);
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    if (signal.aborted) {
      resolve(TIMED_OUT);
      return;
    }
    signal.addEventListener("abort", () => resolve(TIMED_OUT), { once: true });
  });
  const winner = await Promise.race([p, timeout]);
  if (winner === TIMED_OUT) {
    throw new RerankTimeoutError(ms);
  }
  return winner;
}

/** Render the user prompt: the query + a numbered, snippet-clamped candidate list. */
function buildRerankUserMessage(
  query: string,
  candidates: ReadonlyArray<KnowledgeChunkV1>,
): string {
  const lines: Array<string> = [`Query: ${query}`, "", "Candidates:"];
  candidates.forEach((c, i) => {
    const snippet = c.body.slice(0, BODY_SNIPPET_CHARS).replace(/\s+/g, " ").trim();
    lines.push(`${i + 1}. [${c.relative_path}] ${snippet}`);
  });
  lines.push("", `Return exactly ${candidates.length} score(s) via submit_relevance_scores.`);
  return lines.join("\n");
}

/** Extract the scores array from the first well-formed submit_relevance_scores tool_use block. */
function parseScores(
  blocks: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<number> | null {
  for (const block of blocks) {
    if (block["type"] !== "tool_use" || block["name"] !== RERANK_TOOL_NAME) {
      continue;
    }
    const input = block["input"];
    if (input === null || typeof input !== "object") {
      continue;
    }
    const scores = (input as { scores?: unknown }).scores;
    if (
      Array.isArray(scores) &&
      scores.every((s) => typeof s === "number" && Number.isFinite(s))
    ) {
      return scores as ReadonlyArray<number>;
    }
  }
  return null;
}

/**
 * LLM-backed {@link LlmRerankerPort}. Carries `installationId` (cost attribution) since the port
 * interface does not pass it. Construct per retrieve_knowledge invocation with the query's id.
 */
export class LlmBackedRerankPort implements LlmRerankerPort {
  private readonly cache: RerankLlmCacheLike;
  private readonly installationId: string;
  private readonly timeoutMs: number;
  private readonly modelOverride: string | undefined;

  public constructor(args: {
    cache: RerankLlmCacheLike;
    installationId: string;
    timeoutMs?: number;
    modelOverride?: string;
  }) {
    this.cache = args.cache;
    this.installationId = args.installationId;
    this.timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.modelOverride = args.modelOverride;
  }

  public async rerank(args: {
    query: string;
    candidates: ReadonlyArray<KnowledgeChunkV1>;
  }): Promise<ReadonlyArray<number>> {
    const { query, candidates } = args;
    if (candidates.length === 0) {
      return [];
    }

    let client: LlmClient;
    try {
      client = await this.cache.forRole("secondary");
    } catch (e) {
      // A role-resolution failure (not-configured / disabled) → fall back to RRF order.
      throw new LlmRerankUnavailableError(`rerank role resolution failed: ${errMsg(e)}`);
    }

    const messages: Array<LlmMessage> = [
      { role: "system", content: RERANK_SYSTEM_PROMPT },
      { role: "user", content: buildRerankUserMessage(query, candidates) },
    ];
    // Haiku (cheap, fast) for rerank — the curator's secondary model. An explicit override wins (tests).
    const model = this.modelOverride ?? modelForPurpose("analysis_curator");

    let result: Awaited<ReturnType<LlmClient["invokeModel"]>>;
    try {
      result = await withTimeout(
        client.invokeModel({
          role: "secondary",
          model: model as Parameters<LlmClient["invokeModel"]>[0]["model"],
          messages,
          tools: [RERANK_TOOL_SCHEMA as unknown as Record<string, unknown>],
          maxTokens: RERANK_MAX_TOKENS,
          purpose: RERANK_PURPOSE,
          installationId: this.installationId,
        }),
        this.timeoutMs,
      );
    } catch (e) {
      // Cost-cap breach / invocation failure / soft timeout → rerank is best-effort polish, so map to
      // LlmRerankUnavailableError (LlmRerank.apply falls back to RRF order). invokeModel already enforced
      // the cost cap + emitted the trace row. UNLIKE the curator, we do NOT re-raise the budget error:
      // skipping rerank degrades quality but loses no findings.
      if (e instanceof BedrockBudgetExceededError) {
        throw new LlmRerankUnavailableError(`rerank cost-cap reached: ${e.message}`);
      }
      throw new LlmRerankUnavailableError(`rerank LLM call failed: ${errMsg(e)}`);
    }

    const scores = parseScores([...result.raw_content_blocks]);
    if (scores === null) {
      throw new LlmRerankUnavailableError(
        "rerank response had no parseable submit_relevance_scores tool_use block",
      );
    }
    // A score-count mismatch is intentionally NOT raised here — LlmRerank.apply detects it and falls
    // back, so the single mismatch-handling path lives in one place.
    return scores;
  }
}
