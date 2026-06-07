// Policy citation-context builder — partial 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/policy/citation_context_builder.py. SCOPE (this port): the
// `merge_per_chunk_bundles` helper the Step 7.2 inline post-filter calls to union the per-chunk
// ResolvedGuidanceBundleV1 entries into ONE review-level bundle before running SYSTEM_INVARIANTS over the
// aggregated findings (A-6-b / ADR 0042). The broader citation-context surface (the policy_rule citation
// validator's context) is built elsewhere (helpers.ts::buildPolicyCitationContext) — only the merge helper
// the post-filter needs lands here.
//
// SANDBOX SAFETY (ADR-0065/0066): pure function over its input — NO node:crypto, NO clock, NO RNG, NO uuid,
// NO env, NO I/O. The merge runs INSIDE the workflow sandbox at Step 7.2 (it reads state.policyBundles).

import type { DedupedRuleV1, ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";

/** The placeholder changed_path the review-level merged bundle carries (the Python `_REVIEW_LEVEL_CHANGED_PATH`).
 *  `min_length=1` on changed_path is satisfied without committing to a real path; `"*"` signals "review-level
 *  union" to forensic readers. */
const REVIEW_LEVEL_CHANGED_PATH = "*";

/**
 * Union per-chunk {@link ResolvedGuidanceBundleV1} entries into a single review-level bundle for the
 * post-filter's {@link postFilterFindings} call. 1:1 with the Python `merge_per_chunk_bundles`.
 *
 * Deduplicates by `rule.rule_id` — a rule that applies to multiple changed paths (e.g. a repo-root CLAUDE.md
 * rule) appears ONCE in the merged `applicable_rules`. Walks rules + explanations in LOCKSTEP (R-32) so the
 * parallel-tuple invariant survives the merge: when a duplicate rule is skipped, its parallel explanation is
 * skipped too. Tolerates a bundle whose `resolution_explanation` length disagrees with its `applicable_rules`
 * length (some upstream constructors emit `()`) by substituting empty strings. Emits in sorted rule_id order
 * for determinism (so Temporal replay produces identical output). Empty input yields an empty-rules bundle
 * with `changed_path="*"`.
 *
 * @param policyBundles the per-changed-path bundles (the orchestrator passes `state.policyBundles` as a Map).
 */
export function mergePerChunkBundles(
  policyBundles: ReadonlyMap<string, ResolvedGuidanceBundleV1>,
): ResolvedGuidanceBundleV1 {
  const seenRuleIds = new Set<string>();
  const mergedPairs: Array<readonly [DedupedRuleV1, string]> = [];
  for (const bundle of policyBundles.values()) {
    // Zip in lockstep — when we skip a duplicate rule, we MUST also skip its parallel explanation. Tolerate
    // a length mismatch (some constructors emit explanations as []) by substituting empty strings.
    const explanations: ReadonlyArray<string> =
      bundle.resolution_explanation.length === bundle.applicable_rules.length
        ? bundle.resolution_explanation
        : bundle.applicable_rules.map(() => "");
    for (let i = 0; i < bundle.applicable_rules.length; i += 1) {
      // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded loop cursor into workflow-local arrays, not external input
      const deduped = bundle.applicable_rules[i]!;
      // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded loop cursor into a length-aligned local array
      const explanation = explanations[i]!;
      const ruleId = deduped.rule.rule_id;
      if (seenRuleIds.has(ruleId)) {
        continue;
      }
      seenRuleIds.add(ruleId);
      mergedPairs.push([deduped, explanation]);
    }
  }
  // Stable sort by rule_id; ties impossible (seenRuleIds dedup). String localeCompare-free comparison to
  // match the Python's byte-wise string sort exactly.
  mergedPairs.sort((a, b) => {
    const x = a[0].rule.rule_id;
    const y = b[0].rule.rule_id;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return {
    schema_version: 1,
    changed_path: REVIEW_LEVEL_CHANGED_PATH,
    applicable_rules: mergedPairs.map((pair) => pair[0]),
    resolution_explanation: mergedPairs.map((pair) => pair[1]),
  };
}
