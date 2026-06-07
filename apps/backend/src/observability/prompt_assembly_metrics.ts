/**
 * Prompt-assembly OTel metric helpers — 1:1 port of the frozen Python
 * `codemaster/observability/prompt_assembly_metrics.py` (Sprint 26 / B-4 + R-10 follow-up).
 *
 * Counter family for `codemaster.review.prompt_assembler.assemblePrompt`. Emitted from the
 * review-chunk-activity body (activity context, NOT the workflow sandbox), so the meter routes through
 * the standard `#platform/observability/metrics.js::getMeter` seam — the same activity-runtime meter
 * the sibling counter modules (policy_metrics.ts, chunk_response_parser.ts) use. The seam returns a
 * no-op Meter when no MeterProvider is registered, so emission is optional/defensive: instruments
 * register and `.add()` calls are no-ops until an exporter is wired (no null-checks, no TODOs).
 *
 * The Python module lazy-imports `opentelemetry.metrics` and no-ops on ImportError; `@opentelemetry/api`
 * always resolves and `getMeter` always returns a Meter (no-op when no provider), so the TS port needs
 * no import guard — the no-op Meter IS the "OTel SDK absent" behaviour.
 *
 * ## Cardinality discipline (the same the Python module enforces)
 * NO `installation_id` / `repository_id` / per-PR labels. Labels restricted to bounded enum spaces
 * (5 categories × 3 intents = 15 label combinations max). Per-installation drill-down lives in Tempo
 * traces (span attributes), NOT in metric labels.
 *
 * Counter NAMES copied VERBATIM from the Python `*_NAME` constants (Grafana-query-stable; a rename
 * requires an ADR) so the deferred metric-name-parity gate passes and existing dashboards/alerts map
 * unchanged.
 */
import { type Counter, getMeter } from "#platform/observability/metrics.js";

import type { AssembledPromptV1 } from "#contracts/assembled_prompt.v1.js";

// ─── Counter NAMES (Grafana-query-stable; rename requires ADR) ──
export const POLICY_TOKENS_NAME = "codemaster_review_prompt_policy_tokens";
export const KNOWLEDGE_TOKENS_NAME = "codemaster_review_prompt_knowledge_tokens";
export const POLICY_DROPPED_NAME = "codemaster_review_prompt_policy_dropped_total";
export const OVER_BUDGET_FORCED_INCLUDE_NAME =
  "codemaster_review_prompt_over_budget_forced_include_total";
export const KNOWLEDGE_DROPPED_NAME = "codemaster_review_prompt_knowledge_dropped_total";

// Meter + instruments cached at MODULE scope (created once at import), mirroring the Python lazy-cache
// that avoids per-emit create_* lock contention. Meter name = the dotted module path the Python uses
// (`get_meter("codemaster.review.prompt_assembler")`).
const METER = getMeter("codemaster.review.prompt_assembler");

const POLICY_TOKENS_COUNTER: Counter = METER.createCounter(POLICY_TOKENS_NAME, {
  description:
    "Cumulative policy-block tokens used by assemblePrompt. Rate = current policy density across the fleet.",
});
const KNOWLEDGE_TOKENS_COUNTER: Counter = METER.createCounter(KNOWLEDGE_TOKENS_NAME, {
  description:
    "Cumulative knowledge-block tokens used by assemblePrompt. Rate = retrieval-context density per review.",
});
const POLICY_DROPPED_COUNTER: Counter = METER.createCounter(POLICY_DROPPED_NAME, {
  description:
    "Count of policy rules dropped wholesale by assemblePrompt for budget reasons. Labels: category x intent (5x3=15 max).",
});
const OVER_BUDGET_COUNTER: Counter = METER.createCounter(OVER_BUDGET_FORCED_INCLUDE_NAME, {
  description:
    "Count of rules that exceeded policy_max_tokens but were kept anyway because they're intent=forbid OR category=security. Rising rate → operator should raise the budget.",
});
const KNOWLEDGE_DROPPED_COUNTER: Counter = METER.createCounter(KNOWLEDGE_DROPPED_NAME, {
  description:
    "Count of knowledge chunks dropped by assemblePrompt for budget reasons. Rising rate → retrieval over-fetching OR budget too tight.",
});

/** Token-count counter — records the policy-block token usage of one assembled prompt. */
export function recordPolicyTokens(n: number): void {
  POLICY_TOKENS_COUNTER.add(Math.trunc(n));
}

/** Token-count counter — records knowledge-block usage. */
export function recordKnowledgeTokens(n: number): void {
  KNOWLEDGE_TOKENS_COUNTER.add(Math.trunc(n));
}

/** Dropped-rule counter (per dropped rule, with bounded labels). */
export function recordPolicyDropped(args: { category: string; intent: string }): void {
  POLICY_DROPPED_COUNTER.add(1, { category: args.category, intent: args.intent });
}

/** Counter for forbid-intent or security-category rules that forced the budget over rather than
 * dropping. */
export function recordOverBudgetForcedInclude(args: { category: string; intent: string }): void {
  OVER_BUDGET_COUNTER.add(1, { category: args.category, intent: args.intent });
}

/** Count of knowledge chunks dropped due to total budget cap. No-op for n <= 0 (matches Python). */
export function recordKnowledgeDropped(n: number): void {
  if (n <= 0) {
    return;
  }
  KNOWLEDGE_DROPPED_COUNTER.add(Math.trunc(n));
}

/**
 * Emit all 5 counters for one AssembledPromptV1 envelope. Called from the review-chunk activity body
 * (the prompt builder's budget path) after each assemblePrompt call. Reads counts off the envelope; no
 * additional state needed. 1:1 with the Python `emit_assembled_prompt_counters`.
 *
 * R-25 (multi-lens audit 2026-05-22) — reads the explicit `policy_tokens` + `knowledge_tokens` +
 * `forced_rules` fields the assembler emits, so per-half token attribution and per-rule forced-include
 * attribution are exact (not post-hoc inferred). The Zod-parsed envelope always carries these fields
 * (defaulted), so no defensive getattr fallback is needed on the TS side.
 */
export function emitAssembledPromptCounters(assembled: AssembledPromptV1): void {
  recordPolicyTokens(assembled.policy_tokens);
  // R-25: knowledge_tokens counter now actually fires (pre-fix it was exported + never called).
  if (assembled.knowledge_tokens > 0) {
    recordKnowledgeTokens(assembled.knowledge_tokens);
  }
  recordKnowledgeDropped(assembled.knowledge_dropped_count);

  for (const deduped of assembled.dropped_policy_rules) {
    recordPolicyDropped({ category: deduped.rule.category, intent: deduped.rule.intent });
  }

  // R-25: per-rule attribution is exact — the assembler captured WHICH rules over-ran the budget.
  // Emit one counter per forced rule with its actual (category, intent).
  for (const deduped of assembled.forced_rules) {
    recordOverBudgetForcedInclude({
      category: deduped.rule.category,
      intent: deduped.rule.intent,
    });
  }
}
