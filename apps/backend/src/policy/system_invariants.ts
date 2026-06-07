// SYSTEM_INVARIANTS registry — 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/policy/system_invariants.py (Sprint 25 / A-6-a).
//
// Platform-owned safety properties applied to every review finding AFTER the LLM emits and BEFORE Postgres
// persistence (per ADR 0042). The registry is intentionally small + frozen — adding/removing entries
// requires a same-PR update to the regression-cap test so the platform-safety contract can't be silently
// weakened.
//
// The post-filter (trust_filter.ts) runs each enforcement callable over each finding in order. Enforcement
// return values:
//   * the SAME finding object (no change required) → invariant didn't fire,
//   * a NEW finding object (severity floored) → invariant fired; the post-filter records it via the
//     observability counter,
//   * a thrown error → fail-CLOSED per ADR 0042: the original finding is preserved unchanged + the
//     codemaster_policy_invariant_enforcement_error_total{invariant_id} counter increments. A bug in
//     invariant code must NOT become an effective suppression backdoor.
//
// The 2 active invariants (T-7 dropped SI-002/003/004 as vacuous no-ops in the current contract):
//   * SI-001 — security findings non-suppressible (severity floor)
//   * SI-005 — severity grading platform-owned (defense-in-depth floor alongside SI-001)
//
// ── EQUALITY SEMANTICS (the only porting subtlety) ──
// The Python detects "invariant fired" via `current != previous` (Pydantic value-equality after a
// `model_copy(update=...)`). The TS enforcement helpers return the EXACT same object reference when no
// change is required and a fresh object only when the severity is floored, so the post-filter uses
// reference identity (`current !== previous`) as the fired signal — value-equivalent to the Python because
// the only mutation any invariant performs is the severity upgrade (a strict subset change). Returning the
// same reference on the no-op path is load-bearing: it keeps the fired-detection from false-positiving on
// an unchanged finding.
//
// SANDBOX SAFETY (ADR-0065/0066): pure functions over their inputs — NO node:crypto, NO clock, NO RNG, NO
// uuid, NO env, NO I/O. The post-filter runs INSIDE the workflow sandbox at Step 7.2, so this module + its
// only runtime import (the type-only contract shapes) stay crypto-free.

import type { ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

/**
 * Raised by {@link postFilterFindings} / {@link postFilterFindingsWithMetadata} when {@link SYSTEM_INVARIANTS}
 * is empty — fail-CLOSED at the activity boundary (a misconfigured deploy that deleted entries without
 * updating the regression-cap test). The review pipeline refuses to emit findings until invariants load.
 * 1:1 with the Python `EmptyInvariantsRegistryError`.
 */
export class EmptyInvariantsRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EmptyInvariantsRegistryError";
  }
}

/**
 * One platform-safety invariant. 1:1 with the Python frozen `@dataclass SystemInvariant`. The `enforcement`
 * callable takes a finding + the review-level bundle and returns the finding either unchanged (same ref) or
 * in its invariant-corrected form (a fresh object).
 */
export type SystemInvariant = {
  readonly invariant_id: string;
  readonly description: string;
  readonly enforcement: (
    finding: ReviewFindingV1,
    bundle: ResolvedGuidanceBundleV1,
  ) => ReviewFindingV1;
  readonly rationale: string;
};

// ─── Severity floor for safety-critical categories (1:1 with the Python constants) ─────────────────

/** Severity rank — higher = more severe (1:1 with the Python `_SEVERITY_RANK`). Switch-based so there is no
 *  object-injection sink (the input is the bounded Severity enum, but the switch is sink-free regardless).
 *  An unknown value ranks below the floor (defensive — a future severity would be floored, never silently
 *  passed). */
function severityRank(severity: string): number {
  switch (severity) {
    case "nit":
      return 0;
    case "suggestion":
      return 1;
    case "issue":
      return 2;
    case "blocker":
      return 3;
    default:
      return -1;
  }
}

/** The safety floor severity (`issue`) + its rank. 1:1 with `_SAFETY_FLOOR_SEVERITY` / `_SAFETY_FLOOR_RANK`. */
const SAFETY_FLOOR_SEVERITY = "issue";
const SAFETY_FLOOR_RANK = severityRank(SAFETY_FLOOR_SEVERITY);

/**
 * Helper shared by SI-001 / SI-005. When the finding's category matches `categoryMustBe` and its severity is
 * BELOW the safety floor (`issue`), upgrade to `issue`; otherwise return the finding UNCHANGED (same ref).
 * 1:1 with the Python `_enforce_severity_floor` (which returns the same instance on the no-op path and a
 * `model_copy(update={"severity": ...})` on the floor path).
 */
function enforceSeverityFloor(
  finding: ReviewFindingV1,
  categoryMustBe: string,
): ReviewFindingV1 {
  if (finding.category !== categoryMustBe) {
    return finding;
  }
  const rank = severityRank(finding.severity);
  if (rank >= SAFETY_FLOOR_RANK) {
    return finding;
  }
  // Floor fired: a fresh object with the severity floored (the Python model_copy(update=...) analogue). The
  // reference change is the post-filter's fired signal.
  return { ...finding, severity: SAFETY_FLOOR_SEVERITY };
}

/**
 * SI-001 enforcement: security findings can't be silently downgraded below `issue` regardless of repo
 * policy. 1:1 with `_enforce_security_non_suppressible`. The bundle is accepted for symmetry but unused.
 */
function enforceSecurityNonSuppressible(
  finding: ReviewFindingV1,
  bundle: ResolvedGuidanceBundleV1,
): ReviewFindingV1 {
  void bundle; // surfaced for SystemInvariant.enforcement signature symmetry; unused by this invariant.
  return enforceSeverityFloor(finding, "security");
}

/**
 * SI-005 enforcement: severity grading of platform-emitted findings is platform-owned. For safety-critical
 * categories the floor is enforced; for non-safety categories the LLM's grading is respected. Defense-in-
 * depth alongside SI-001. 1:1 with `_enforce_severity_grading_platform_owned`.
 */
function enforceSeverityGradingPlatformOwned(
  finding: ReviewFindingV1,
  bundle: ResolvedGuidanceBundleV1,
): ReviewFindingV1 {
  void bundle; // surfaced for SystemInvariant.enforcement signature symmetry; unused by this invariant.
  if (finding.category === "security") {
    return enforceSeverityFloor(finding, "security");
  }
  return finding;
}

/**
 * The frozen platform-safety registry. 1:1 with the Python `SYSTEM_INVARIANTS` tuple (2 active invariants;
 * SI-002/003/004 dropped in T-7). Any change requires a same-PR regression-cap test update.
 */
export const SYSTEM_INVARIANTS: ReadonlyArray<SystemInvariant> = [
  {
    invariant_id: "SI-001-security-finding-non-suppressible",
    description: "Security findings cannot be suppressed by repo policy",
    enforcement: enforceSecurityNonSuppressible,
    rationale:
      "Repo content under any contributor's control must not silence platform safety output. Severity " +
      "floor (>= 'issue') enforced post-emission so a policy-induced LLM downgrade is corrected.",
  },
  {
    invariant_id: "SI-005-severity-grading-platform-owned",
    description: "Repo policy cannot alter severity grading of platform-emitted findings",
    enforcement: enforceSeverityGradingPlatformOwned,
    rationale:
      "Defense in depth alongside SI-001: even if SI-001's wording shifts in a future revision, SI-005 " +
      "keeps the floor enforced. Kept separate so the audit trail surfaces both the category-specific " +
      "(SI-001) and the platform-wide (SI-005) intentions.",
  },
];
