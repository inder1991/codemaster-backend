/**
 * Finding Arbitration Layer — 1:1 PURE-function port of the frozen Python
 * `vendor/codemaster-py/codemaster/review/arbitration_layer.py::arbitrate` (Phase D /
 * static-analysis-coverage-gap fix).
 *
 * Consumes Tier-1 static-analysis findings ({@link AnalysisFindingV1}), Tier-2 LLM findings (paired
 * `[uuid, ReviewFindingV1]`), the LLM-emitted SUPPRESS intents ({@link ArbitrationIntentV1}), and the
 * pre-loaded {@link SuppressionPolicy}; produces one {@link ArbitrationDecisionV1} per input finding plus
 * the rejected-intent observability side-channel, wrapped in an {@link ArbitrationResultV1}.
 *
 * ## Purity (CLAUDE.md / ADR-0031 workflow-boundary contract purity)
 *
 * NO clock, NO randomness, NO async, NO DB, NO crypto. `now` is passed in as an ISO string value (the
 * orchestrator sources it from `workflow.now()` at the call site so this function stays clock-free). The
 * function is safe to call from either the workflow body or the activity; the activity is its real caller.
 *
 * ## Decimal handling (parity-exact)
 *
 * Confidence flows in as the canonical-decimal STRING the contract carries (Pydantic dumps `Decimal` as a
 * string). For the `-confidence` sort key + the `>= min_confidence` policy check we compare NUMERICALLY
 * (`Number(...)`), but the value we WRITE onto a decision / rejected-intent is the ORIGINAL string,
 * byte-faithful to the Python `Decimal`'s textual form. So a `"0.95"` intent confidence surfaces as
 * `suppression_confidence: "0.95"`, never re-serialized through a lossy float.
 *
 * ## Deterministic ordering
 *
 * Intents are sorted by `(target_finding_id, -confidence, reason)` (highest-confidence intent wins per
 * target; ties broken by reason). Decisions are sorted by `(suppression_state, finding_id)`; rejected by
 * `(reason_rejected, target_finding_id)`. UUID-int sort ≡ lowercase-canonical-string sort (verified), so a
 * plain string compare on the wire UUID is parity-equivalent to Python's `sorted(uuid_objects)`.
 *
 * ## Conflict resolution
 *
 * When the policy says NOT suppressible (gitleaks / trivy defaults; per-rule `suppressible=false`), the
 * LLM's intent is DROPPED regardless of confidence — the operator-controlled, CI-gated policy is the
 * structural backstop the LLM cannot override. Secrets and CVEs are NEVER LLM-suppressible.
 */

import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import type { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";
import type { ArbitrationDecisionV1 } from "#contracts/finding_arbitration.v1.js";
import type {
  ArbitrationResultV1,
  RejectedIntent,
  RejectionReason,
} from "#contracts/arbitration_result.v1.js";
import type { Tier2Pair } from "#contracts/apply_arbitration_input.v1.js";

import {
  isSuppressible,
  KNOWN_TOOLS,
  lookupRuleOrDefault,
  selectToolBranch,
  type SuppressionPolicy,
} from "./suppression_policy.js";

/**
 * Diagnose WHY a policy lookup said suppressible=false (1:1 with the Python `_rejection_reason`). Extracted
 * to keep `arbitrate`'s branch count down; the granularity drives the orchestrator's counter cardinality.
 */
function rejectionReason(args: {
  policy: SuppressionPolicy;
  tool: string;
  rule_id: string;
}): RejectionReason {
  const { policy, tool, rule_id } = args;
  // Python `getattr(policy, tool, None)` — an unknown tool has no branch → policy_forbids.
  if (!KNOWN_TOOLS.has(tool)) {
    return "policy_forbids";
  }
  const branch = selectToolBranch(policy, tool);
  const rule = lookupRuleOrDefault(branch, rule_id);
  if (!rule.suppressible) {
    return "policy_forbids";
  }
  return "below_min_confidence";
}

/** Build a NONE-state decision object (every suppression_* field null) for `findingId`. */
function noneDecision(findingId: string): ArbitrationDecisionV1 {
  return {
    schema_version: 1,
    finding_id: findingId,
    suppression_state: "NONE",
    suppression_reason: null,
    suppression_confidence: null,
    suppression_model: null,
    suppression_prompt_version: null,
    suppressed_at: null,
    suppressed_by_finding_id: null,
  };
}

/**
 * Run the arbitration layer. See module docstring for full semantics. PURE function — no Clock, no I/O, no
 * randomness, no DB. 1:1 with the frozen Python `arbitrate`.
 *
 * `now` is the caller-supplied ISO-8601 instant string (written onto SUPPRESSED_BY_LLM decisions'
 * `suppressed_at`); `tier1Findings` / `tier2Findings` / `intents` are the already-parsed contract shapes.
 */
export function arbitrate(args: {
  tier1Findings: ReadonlyArray<AnalysisFindingV1>;
  tier2Findings: ReadonlyArray<Tier2Pair>;
  intents: ReadonlyArray<ArbitrationIntentV1>;
  policy: SuppressionPolicy;
  model: string;
  promptVersion: string;
  now: string;
}): ArbitrationResultV1 {
  const { tier1Findings, tier2Findings, intents, policy, model, promptVersion, now } = args;

  // 1. Deterministic intent index. Sort by (target_finding_id, -confidence, reason): for duplicate intents
  //    on the same target the highest-confidence intent wins; ties broken by reason lexicographic order.
  const sortedIntents = [...intents].sort((a, b) => {
    if (a.target_finding_id !== b.target_finding_id) {
      return a.target_finding_id < b.target_finding_id ? -1 : 1;
    }
    // -confidence: descending numeric. (Number() over the canonical-decimal string is exact for the LLM's
    //  ≤3-place fractional confidences; equal numeric values fall through to the reason tiebreak.)
    const ca = Number(a.confidence);
    const cb = Number(b.confidence);
    if (ca !== cb) return cb - ca;
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    return 0;
  });

  const intentByTarget = new Map<string, ArbitrationIntentV1>();
  const duplicateLosers: Array<ArbitrationIntentV1> = [];
  for (const intent of sortedIntents) {
    if (!intentByTarget.has(intent.target_finding_id)) {
      intentByTarget.set(intent.target_finding_id, intent);
    } else {
      duplicateLosers.push(intent);
    }
  }

  // 2. Tier-1 id set — to detect dangling intents (intents whose target resolves to no Tier-1 finding).
  const tier1IdSet = new Set(tier1Findings.map((f) => f.finding_id));

  const decisions: Array<ArbitrationDecisionV1> = [];
  const rejected: Array<RejectedIntent> = [];

  // 3. Tier-1 findings — each may be the target of an intent.
  for (const finding of tier1Findings) {
    const intent = intentByTarget.get(finding.finding_id);
    if (intent === undefined) {
      decisions.push(noneDecision(finding.finding_id));
      continue;
    }

    const lookup = isSuppressible({
      policy,
      tool: finding.tool,
      rule_id: finding.rule_id,
      confidence: Number(intent.confidence),
    });

    if (lookup.suppressible) {
      decisions.push({
        schema_version: 1,
        finding_id: finding.finding_id,
        suppression_state: "SUPPRESSED_BY_LLM",
        suppression_reason: intent.reason,
        // Byte-faithful: write the ORIGINAL canonical-decimal string (the Python Decimal's textual form).
        suppression_confidence: intent.confidence,
        suppression_model: model,
        suppression_prompt_version: promptVersion,
        suppressed_at: now,
        suppressed_by_finding_id: null,
      });
    } else {
      // Reject — finding stands. Reason granularity matters for counter cardinality; also surface the LLM's
      // confidence + reason so the persistence path can write the full operator-audit row.
      rejected.push({
        target_finding_id: intent.target_finding_id,
        reason_rejected: rejectionReason({ policy, tool: finding.tool, rule_id: finding.rule_id }),
        intent_confidence: intent.confidence,
        intent_reason: intent.reason,
      });
      decisions.push(noneDecision(finding.finding_id));
    }
  }

  // 4. Tier-2 findings — pass through as NONE in v1 (arbitration is currently a Tier-1-only funnel).
  for (const [tier2Id] of tier2Findings) {
    decisions.push(noneDecision(tier2Id));
  }

  // 5. Intents that did NOT resolve to any Tier-1 finding → "target_not_found" (defensive against an LLM
  //    hallucinating a target UUID). Walked in deterministic sorted order.
  for (const intent of sortedIntents) {
    if (!tier1IdSet.has(intent.target_finding_id)) {
      rejected.push({
        target_finding_id: intent.target_finding_id,
        reason_rejected: "target_not_found",
        intent_confidence: intent.confidence,
        intent_reason: intent.reason,
      });
    }
  }

  // 6. Duplicate-intent losers (non-winning intents on the same target). Surfaced for observability.
  for (const loser of duplicateLosers) {
    rejected.push({
      target_finding_id: loser.target_finding_id,
      reason_rejected: "duplicate_intent_loser",
      intent_confidence: loser.confidence,
      intent_reason: loser.reason,
    });
  }

  // 7. Deterministic output ordering. decisions: (suppression_state, finding_id). rejected:
  //    (reason_rejected, target_finding_id). Replay-safe — same input set → same output sequence.
  decisions.sort((a, b) => {
    if (a.suppression_state !== b.suppression_state) {
      return a.suppression_state < b.suppression_state ? -1 : 1;
    }
    if (a.finding_id !== b.finding_id) return a.finding_id < b.finding_id ? -1 : 1;
    return 0;
  });
  rejected.sort((a, b) => {
    if (a.reason_rejected !== b.reason_rejected) {
      return a.reason_rejected < b.reason_rejected ? -1 : 1;
    }
    if (a.target_finding_id !== b.target_finding_id) {
      return a.target_finding_id < b.target_finding_id ? -1 : 1;
    }
    return 0;
  });

  return { decisions, rejected_intents: rejected };
}
