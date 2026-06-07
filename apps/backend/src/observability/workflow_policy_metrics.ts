// Workflow-body policy-engine metrics — 1:1 port of the WORKFLOW-meter variants in the frozen Python
// vendor/codemaster-py/codemaster/observability/policy_metrics.py (Sprint 25 / T-3).
//
// These four counters fire from inside the WORKFLOW SANDBOX (the orchestrator's policy-compute step + the
// Step 7.2 inline post-filter), so the Python sources them from `workflow.metric_meter()` — the replay-safe
// meter Temporal suppresses on history replay (so a worker restart does not double-count). The TS analogue
// is `metricMeter` from `@temporalio/workflow` (a `MetricMeter`; `createCounter(name).add(value, tags)`),
// which is the ONLY sandbox-legal metric surface — `getMeter` (`@opentelemetry/api`) is the ACTIVITY-runtime
// seam and must NOT be reached from the workflow body.
//
// `record_invariant_enforcement_error` in the Python is CONTEXT-AWARE (it tries `workflow.metric_meter()`
// first, falling back to the OTel global meter when called from the persist ACTIVITY body). In the TS port
// the post-filter runs ONLY in the workflow body (Step 7.2 relocation; the TS persist activity does no
// post-filter of its own — see persist_review_findings.activity.ts), so this module is the single
// workflow-body emit path; there is no activity-body caller to dual-context.
//
// ── EXPORTER DEFERRED (emit-rides-with-subsystem; names land now) ──
// The metric NAMES are copied VERBATIM from the Python (Grafana-query-stable; renaming requires ADR) so the
// deferred end-of-migration name-parity gate + existing dashboards/alerts map unchanged. The exporter wiring
// is the only deferred piece — until a MeterProvider is installed these `.add()` calls are no-ops (safe).
//
// ── CARDINALITY DISCIPLINE ──
// NO installation_id / repository_id / per-PR labels. invariant_id ∈ {SI-001..., SI-005...}; category ∈ the
// bounded Category enum. Per-installation drill-down lives in Tempo traces, NOT metric labels.
//
// SANDBOX SAFETY (ADR-0065/0066): imports ONLY `@temporalio/workflow` (sandbox-legal) — NO node:crypto, NO
// clock, NO RNG, NO uuid, NO env, NO I/O.

import { metricMeter, inWorkflowContext } from "@temporalio/workflow";

// Counter NAMES — copied VERBATIM from the Python policy_metrics module constants.
export const INVARIANT_VIOLATION_ATTEMPTED_NAME =
  "codemaster_policy_invariant_violation_attempted_total";
export const INVARIANT_ENFORCEMENT_ERROR_NAME =
  "codemaster_policy_invariant_enforcement_error_total";
export const POLICY_BUNDLE_HIT_NAME = "codemaster_policy_bundle_hit_total";
export const POLICY_BUNDLE_TOTAL_NAME = "codemaster_policy_bundle_total";

// Instruments are created PER-EMIT (1:1 with the Python `meter.create_counter(...)` per call) — NOT cached
// at module scope. Temporal's `metricMeter` can only be touched while a workflow context is active; touching
// it outside one throws `IllegalStateError`. Each emit GUARDS on `inWorkflowContext()` and no-ops outside a
// workflow — faithful to the Python (whose `workflow.metric_meter()` requires a workflow loop) AND lets the
// orchestrator unit tests drive the pure pipeline directly without the emit throwing. The Temporal
// MetricMeter.createCounter is idempotent by name, so per-call creation inside the context is cheap.

/**
 * Workflow-body counter — emitted from the Step 7.2 inline post-filter when an invariant fires (the current
 * finding differs from the pre-invariant version). 1:1 with `record_invariant_violation_attempted`.
 *
 * Low-cardinality labels only: `invariant_id` ∈ {SI-001..., SI-005...}, `category` ∈ the bounded Category
 * enum.
 */
export function recordInvariantViolationAttempted(args: {
  invariantId: string;
  category: string;
}): void {
  if (!inWorkflowContext()) {
    return;
  }
  metricMeter
    .createCounter(
      INVARIANT_VIOLATION_ATTEMPTED_NAME,
      undefined,
      "Count of policy-engine invariant fires per review. Low-cardinality labels only (no installation_id; " +
        "per-installation drill-down is via Tempo traces).",
    )
    .add(1, { invariant_id: args.invariantId, category: args.category });
}

/**
 * Workflow-body counter — emitted from the Step 7.2 inline post-filter when an enforcement callable RAISES
 * (fail-CLOSED at finding level per ADR 0042: the finding is preserved unchanged AND this counter
 * increments so SREs see the bug). 1:1 with `record_invariant_enforcement_error`. Pages SRE via the
 * `PolicyInvariantEnforcementError` alert (any non-zero increase over 5min).
 */
export function recordInvariantEnforcementError(args: { invariantId: string }): void {
  if (!inWorkflowContext()) {
    return;
  }
  metricMeter
    .createCounter(
      INVARIANT_ENFORCEMENT_ERROR_NAME,
      undefined,
      "Count of invariant enforcement exceptions (fail-CLOSED path). Non-zero rate triggers SRE alert.",
    )
    .add(1, { invariant_id: args.invariantId });
}

/**
 * Workflow-body counter — numerator for the policy-adoption ratio. Emitted when a review's policy_bundles
 * contained >=1 applicable rule across its chunks. 1:1 with `record_policy_bundle_hit`. Pair with
 * {@link recordPolicyBundleTotal} for Grafana to compute the ratio.
 */
export function recordPolicyBundleHit(): void {
  if (!inWorkflowContext()) {
    return;
  }
  metricMeter
    .createCounter(
      POLICY_BUNDLE_HIT_NAME,
      undefined,
      "Reviews where the policy_bundles dict contained >=1 applicable rule. Numerator for the " +
        "adoption-ratio metric (denominator is POLICY_BUNDLE_TOTAL_NAME).",
    )
    .add(1);
}

/**
 * Workflow-body counter — denominator for the policy-adoption ratio. Emitted once per review whenever the
 * policy engine ran (collapse-on: the policy-compute step always runs in the TS port). 1:1 with
 * `record_policy_bundle_total`.
 */
export function recordPolicyBundleTotal(): void {
  if (!inWorkflowContext()) {
    return;
  }
  metricMeter
    .createCounter(
      POLICY_BUNDLE_TOTAL_NAME,
      undefined,
      "Total reviews where the policy engine ran (FF on + patched). Denominator for the adoption-ratio metric.",
    )
    .add(1);
}
