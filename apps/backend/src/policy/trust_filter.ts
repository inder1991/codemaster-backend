// Trust-tier post-filter — 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/policy/trust_filter.py (Sprint 25 / A-6-a).
//
// `postFilterFindings` / `postFilterFindingsWithMetadata` are the LAST line of defense for platform safety
// on LLM-emitted review findings. They run every entry in SYSTEM_INVARIANTS against every finding, in
// order, BEFORE the findings reach downstream consumers (per ADR 0042 location 2; in the TS port the call
// is RELOCATED to the orchestrator Step 7.2 so the persisted row + walkthrough + GitHub comment all see the
// same filtered findings — the R-23 relocation).
//
// Fail-mode contract per ADR 0042:
//   * Per-invariant enforcement throws → fail-CLOSED at the FINDING level. The original finding is preserved
//     unchanged (suppression attempt NOT honored); the
//     codemaster_policy_invariant_enforcement_error_total{invariant_id} counter increments. A bug in
//     invariant code must NOT become an effective suppression backdoor.
//   * SYSTEM_INVARIANTS registry empty → fail-CLOSED at the activity boundary
//     ({@link EmptyInvariantsRegistryError} thrown). The TS post-filter is invoked from inside the
//     orchestrator's `applyPolicyPostFilter` step, which is fail-open via stageOutcome — but the registry is
//     statically non-empty (2 active invariants), so the empty case is purely a defensive guard.
//
// The filter is intentionally pure (no I/O, no DB lookups, no clock reads) so a Temporal replay produces
// identical output. SANDBOX SAFETY (ADR-0065/0066): runs in the workflow sandbox at Step 7.2 — NO
// node:crypto, NO clock, NO RNG, NO uuid, NO env, NO I/O. The enforcement-error counter routes through the
// sandbox-safe workflow `metricMeter` (workflow_policy_metrics.ts), never the OTel activity meter.

import { recordInvariantEnforcementError } from "#backend/observability/workflow_policy_metrics.js";

import { SYSTEM_INVARIANTS, EmptyInvariantsRegistryError } from "./system_invariants.js";

import type { ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

/**
 * Per-finding policy-filter outcome metadata — the JS shape of the Python `dict[str, Any]` rows. Aligned by
 * input index with the filtered findings. `invariant_violation_attempted` is true iff >=1 invariant changed
 * the finding; `invariants_fired` are the invariant_ids that modified it, in registry order. Threaded into
 * the persist activity's `precomputed_metadata` (→ `core.review_findings.policy_metadata`) so forensics on
 * "did SI-001 restore this finding?" is structurally answerable from the row alone.
 */
export type FindingPolicyMetadata = {
  readonly invariant_violation_attempted: boolean;
  readonly invariants_fired: ReadonlyArray<string>;
};

/**
 * Apply every SYSTEM_INVARIANT to every finding. Returns a new array in the same order as the input; each
 * finding is either returned unchanged or in its invariant-corrected form (e.g. severity upgraded to the
 * platform floor). 1:1 with the Python `post_filter_findings` (delegates to the metadata variant).
 *
 * @throws {EmptyInvariantsRegistryError} when SYSTEM_INVARIANTS is empty (defensive misconfig guard).
 */
export function postFilterFindings(
  findings: ReadonlyArray<ReviewFindingV1>,
  bundle: ResolvedGuidanceBundleV1,
): ReadonlyArray<ReviewFindingV1> {
  const [out] = postFilterFindingsWithMetadata(findings, bundle);
  return out;
}

/**
 * Apply every SYSTEM_INVARIANT to every finding AND surface per-finding metadata describing which invariants
 * fired. Returns `[filteredFindings, metadata]` aligned by input index. 1:1 with the Python
 * `post_filter_findings_with_metadata`.
 *
 * Fired-detection uses reference identity (`current !== previous`): each enforcement helper returns the SAME
 * finding object on its no-op path and a fresh object only when it floors severity, so a reference change is
 * exactly the Python's `current != previous` value-equality signal (the only mutation any invariant performs
 * is the severity floor — a strict subset change). See system_invariants.ts for the equality rationale.
 *
 * @throws {EmptyInvariantsRegistryError} when SYSTEM_INVARIANTS is empty.
 */
export function postFilterFindingsWithMetadata(
  findings: ReadonlyArray<ReviewFindingV1>,
  bundle: ResolvedGuidanceBundleV1,
): [ReadonlyArray<ReviewFindingV1>, ReadonlyArray<FindingPolicyMetadata>] {
  if (SYSTEM_INVARIANTS.length === 0) {
    throw new EmptyInvariantsRegistryError(
      "SYSTEM_INVARIANTS registry is empty; review pipeline refuses to emit findings until invariants are loaded.",
    );
  }

  const out: Array<ReviewFindingV1> = [];
  const metadata: Array<FindingPolicyMetadata> = [];
  for (const original of findings) {
    let current = original;
    const fired: Array<string> = [];
    for (const invariant of SYSTEM_INVARIANTS) {
      try {
        const previous = current;
        current = invariant.enforcement(current, bundle);
        if (current !== previous) {
          fired.push(invariant.invariant_id);
        }
      } catch (exc) {
        // Fail-CLOSED at the finding level. Preserve the finding AS-IS at the state before the failing
        // invariant tried to mutate it (the catch leaves `current` at its pre-call value). Continue applying
        // subsequent invariants — a single buggy enforcement shouldn't disable the whole chain. R-8: emit
        // the canonical PolicyInvariantEnforcementError counter so the SRE alert can fire (logging-only
        // would leave buggy enforcement as a silent suppression backdoor — exactly what ADR 0042 forbids).
        void exc;
        recordInvariantEnforcementError({ invariantId: invariant.invariant_id });
      }
    }
    out.push(current);
    metadata.push({
      invariant_violation_attempted: fired.length > 0,
      invariants_fired: fired,
    });
  }
  return [out, metadata];
}
