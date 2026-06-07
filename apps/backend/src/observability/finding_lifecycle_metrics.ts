// Finding-delivery-lifecycle WORKFLOW-BODY metrics — port of the workflow-meter counters in the frozen
// Python vendor/codemaster-py/codemaster/observability/finding_lifecycle_metrics.py (ADR-0056). Closes
// FOLLOW-UP-lifecycle-bookkeeping-otel-counters from Stage 3.
//
// SCOPE (this module): the two counters the WORKFLOW BODY emits from its lifecycle-bookkeeping block —
//   * codemaster_finding_lifecycle_setter_succeeded_total{setter}        (H-3)
//   * codemaster_finding_lifecycle_setter_failed_total{setter, retryable}
// Both source from `workflow.metric_meter()` in the Python so the emit is replay-safe (Temporal suppresses
// it on history replay → no double-count on worker restart). The TS analogue is `metricMeter` from
// `@temporalio/workflow`. The ACTIVITY-body counters (transition / setter_invoked) live with the repo
// setters in the activity runtime (a separate emit path; not ported here — they fire from the Node side).
//
// ── LABELS (bounded enums; cardinality discipline) ──
//   setter ∈ {finalized, skipped, degraded, finalized_len_mismatch}  (finalized_len_mismatch is
//     failure-only by construction — the F9 rfid/comment_id length-mismatch path; it never appears on the
//     succeeded counter).
//   retryable ∈ {"true", "false"}  (string form, matching the Prometheus bool serialization convention the
//     Python pins).
// NO installation_id / repository_id / per-PR labels.
//
// ── EXPORTER DEFERRED (emit-rides-with-subsystem; names land now) ──
// Names copied VERBATIM from the Python constants. Until a MeterProvider is installed the `.add()` calls are
// no-ops (safe).
//
// SANDBOX SAFETY (ADR-0065/0066): imports ONLY `@temporalio/workflow` — NO node:crypto, NO clock, NO RNG, NO
// uuid, NO env, NO I/O.

import { metricMeter, inWorkflowContext } from "@temporalio/workflow";

/** The setter label on the SUCCEEDED counter (finalized_len_mismatch is failure-only, so excluded here). */
export type LifecycleSuccessLabel = "finalized" | "skipped" | "degraded";
/** The setter label on the FAILED counter (includes the F9 finalized_len_mismatch failure-only value). */
export type LifecycleFailureLabel = "finalized" | "skipped" | "degraded" | "finalized_len_mismatch";

// Counter NAMES — copied VERBATIM from the Python constants.
export const LIFECYCLE_SETTER_SUCCEEDED_COUNTER_NAME =
  "codemaster_finding_lifecycle_setter_succeeded_total";
export const LIFECYCLE_SETTER_FAILED_COUNTER_NAME =
  "codemaster_finding_lifecycle_setter_failed_total";

// Instruments are created PER-EMIT (1:1 with the Python `meter.create_counter(...)` per call) — NOT cached
// at module scope. Temporal's `metricMeter` can only be touched while a workflow context is active; touching
// it outside one throws `IllegalStateError`. Each emit GUARDS on `inWorkflowContext()` and no-ops outside a
// workflow — faithful to the Python (whose `workflow.metric_meter()` requires a workflow loop) AND lets
// non-workflow callers (unit tests) import this module without the emit throwing. The Temporal
// MetricMeter.createCounter is idempotent by name, so per-call creation inside the context is cheap.

/**
 * Increment the setter-succeeded counter from the workflow body — called immediately after a lifecycle
 * activity dispatch returns cleanly. 1:1 with `record_lifecycle_setter_succeeded`. Replay-safe via metricMeter.
 */
export function recordLifecycleSetterSucceeded(args: { setter: LifecycleSuccessLabel }): void {
  if (!inWorkflowContext()) {
    return;
  }
  metricMeter
    .createCounter(
      LIFECYCLE_SETTER_SUCCEEDED_COUNTER_NAME,
      undefined,
      "Count of lifecycle-setter activity dispatches that returned successfully from the workflow body. " +
        "Label: setter in {finalized, skipped, degraded}. Use alongside the setter_failed counter to " +
        "compute failure rate. Bounded enum labels only.",
    )
    .add(1, { setter: args.setter });
}

/**
 * Increment the setter-failed counter from the workflow body — called when a lifecycle activity dispatch
 * raises (or the F9 finalized_len_mismatch path fires). 1:1 with `record_lifecycle_setter_failed`. The
 * `retryable` label is pinned to the string form `"true"` / `"false"` (the Prometheus bool serialization
 * convention). Replay-safe via metricMeter.
 */
export function recordLifecycleSetterFailed(args: {
  setter: LifecycleFailureLabel;
  retryable?: boolean;
}): void {
  if (!inWorkflowContext()) {
    return;
  }
  const retryable = args.retryable ?? true;
  metricMeter
    .createCounter(
      LIFECYCLE_SETTER_FAILED_COUNTER_NAME,
      undefined,
      "Count of lifecycle-setter activity dispatches that raised in the workflow body. Labels: setter in " +
        "{finalized, skipped, degraded, finalized_len_mismatch}; retryable in {true, false}. " +
        "Bookkeeping-only; the review has already posted. Bounded enum labels only.",
    )
    .add(1, { setter: args.setter, retryable: retryable ? "true" : "false" });
}
