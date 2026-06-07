// floors — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/floors.py::reserve_priority_floors (Sub-spec B T11 2/3).
//
// Stage-3 token-budget reservation: before the general MMR/rerank pass consumes the budget, reserve at
// least one slot for SECURITY_POLICY + REPO_ADR (high-authority tiers) so a giant infra PR can't squeeze
// mandatory guidance out of the LLM context.
//
// Per spec §3.5 lines 877-919:
//   - SECURITY_POLICY: min_reserved_slots = 1 (floor wins over budget cap)
//   - REPO_ADR:        min_reserved_slots = 1 (same)
//   - everything else: 0 (best-effort within budget cap)
//
// When the floor genuinely cannot be honored (the candidate chunk exceeds remaining budget), the
// starvation is recorded in the result so the retrieval trace + structured logs can surface it. The
// observability counter `codemaster_retrieval_starvation_total` is deferred per user direction
// (2026-05-26) — structured logs are the substitute.
//
// Operates on any mixed iterable of chunks that satisfy {@link FloorClassifiable} structurally — both
// KnowledgeChunkV1 and ConfluenceRetrievedChunk are intentionally compatible (T11 part 1 extension +
// T10 fixup respectively).

import {
  PRIORITY_TIER_NAME,
  PriorityTier,
  priorityTier,
  type PriorityClassifiable,
} from "#backend/retrieval/precedence.js";
import { estimateTokens } from "#backend/chunking/token_budget.js";

/**
 * Structural shape floors operates on (Python `_FloorClassifiable` Protocol). KnowledgeChunkV1 (after
 * T11 part 1) and ConfluenceRetrievedChunk (after T10 fixup) both satisfy it. `doc_kind` is read by
 * `priorityTier` via the normalized accessor (ConfluenceRetrievedChunk does not carry it → null).
 */
export type FloorClassifiable = {
  labels: ReadonlyArray<string>;
  source: string;
  doc_kind?: string | null;
  match_specificity_score: number;
  age_days: number;
  // OPTIONAL: the real KnowledgeChunkV1 contract carries NO token_count field (confirmed: neither the
  // Python nor TS contract has it), so a wrapped repo/knowledge chunk reaches floors without it.
  // Missing → ESTIMATED from `body` by reservePriorityFloors (see below), not treated as 0 — Python's
  // `_FloorClassifiable` Protocol requires a real `token_count: int`, and a 0-cost floor pick would
  // under-budget the rerank pass. Pre-fix the bare read produced `budget -= undefined` → NaN.
  token_count?: number;
  // OPTIONAL content for the token-count estimate fallback. KnowledgeChunkV1 carries `body`;
  // ConfluenceRetrievedChunk carries a cached `token_count` (so never reaches the estimate branch).
  body?: string;
};

/** Tiers that get the minimum-reserved-slots treatment, in priority order (highest-authority first). */
const FLOOR_TIERS: ReadonlyArray<PriorityTier> = [
  PriorityTier.SECURITY_POLICY,
  PriorityTier.REPO_ADR,
];

/**
 * Output of {@link reservePriorityFloors} (Python `FloorResult` dataclass).
 *
 * - `selected`: chunks reserved by the floor pass (already deducted from the budget). The caller
 *   removes these from the remainder before rerank.
 * - `starvationTiers`: tiers that had candidates but couldn't fit within `budgetRemaining`.
 *   Operator-visible in the retrieval trace.
 * - `budgetRemaining`: tokens left for the rerank pass after the floors are honored.
 */
export type FloorResult = {
  selected: ReadonlyArray<unknown>;
  starvationTiers: ReadonlyArray<PriorityTier>;
  budgetRemaining: number;
};

/**
 * Return a chunk-like object satisfying {@link PriorityClassifiable} (Python `_normalize`).
 * ScoredKnowledgeChunkV1 wraps KnowledgeChunkV1 in `.chunk`; ConfluenceRetrievedChunk is itself. The
 * normalization is read-only; we never mutate.
 */
function normalize(chunk: unknown): FloorClassifiable {
  if (chunk !== null && typeof chunk === "object" && "chunk" in chunk) {
    const inner = (chunk as { chunk: unknown }).chunk;
    if (inner !== null && typeof inner === "object") {
      return inner as FloorClassifiable;
    }
  }
  return chunk as FloorClassifiable;
}

/** Adapt a {@link FloorClassifiable} to the {@link PriorityClassifiable} shape priorityTier needs. */
function asPriorityClassifiable(c: FloorClassifiable): PriorityClassifiable {
  return { labels: c.labels, source: c.source, doc_kind: c.doc_kind ?? null };
}

/**
 * Reserve one slot per floor tier (SECURITY_POLICY, REPO_ADR) when candidates exist for that tier
 * (1:1 with the Python `reserve_priority_floors`).
 *
 * Selection within a tier: highest match_specificity DESC, then lowest age_days (freshest first).
 * Deterministic. The budget is consumed from `tokenBudget` as floors are picked. If a tier's best
 * candidate exceeds remaining budget, that tier is added to `starvationTiers` and skipped.
 */
export function reservePriorityFloors(
  candidates: Iterable<unknown>,
  opts: { tokenBudget: number },
): FloorResult {
  const candidatesList = [...candidates];
  const selected: Array<unknown> = [];
  const starvation: Array<PriorityTier> = [];
  let budget = opts.tokenBudget;

  for (const tier of FLOOR_TIERS) {
    // Build the candidate list for this tier (using the normalized view so doc_kind on
    // ScoredKnowledgeChunkV1.chunk is reachable). Identity-exclude already-selected picks.
    const tierCandidates = candidatesList.filter(
      (c) => !selected.includes(c) && priorityTier(asPriorityClassifiable(normalize(c))) === tier,
    );
    if (tierCandidates.length === 0) {
      continue;
    }

    // Sort: highest specificity DESC, then youngest age ASC (fresh first). Stable sort — JS
    // Array.prototype.sort is stable (ES2019+), matching Python's stable `list.sort`.
    tierCandidates.sort((a, b) => {
      const na = normalize(a);
      const nb = normalize(b);
      const specDiff = nb.match_specificity_score - na.match_specificity_score;
      if (specDiff !== 0) {
        return specDiff;
      }
      return na.age_days - nb.age_days;
    });

    const pick = tierCandidates[0]!;
    // When the real KnowledgeChunkV1 normalizes without a token_count, ESTIMATE the cost from its body
    // (estimateTokens is the 1:1 port of Python's estimate_tokens) rather than treating it as 0-cost —
    // a large knowledge floor pick reserved for free would silently under-budget the rerank pass.
    // `estimateTokens("")` returns 1, so a chunk with neither token_count nor body still costs ≥1 (never
    // NaN, never a free reservation).
    const pickNorm = normalize(pick);
    const pickTokens = pickNorm.token_count ?? estimateTokens(pickNorm.body ?? "");
    if (pickTokens > budget) {
      starvation.push(tier);
      // Structured-log substitute for the deferred starvation counter (Python `_LOG.warning`).
      console.warn(
        JSON.stringify({
          event: "retrieval_starvation",
          // eslint-disable-next-line security/detect-object-injection -- read-only lookup in a frozen const map keyed by the typed PriorityTier enum (a closed numeric set), not user input
          tier: PRIORITY_TIER_NAME[tier],
          candidate_tokens: pickTokens,
          budget_remaining: budget,
        }),
      );
      continue;
    }

    selected.push(pick);
    budget -= pickTokens;
  }

  return {
    selected,
    starvationTiers: starvation,
    budgetRemaining: budget,
  };
}
