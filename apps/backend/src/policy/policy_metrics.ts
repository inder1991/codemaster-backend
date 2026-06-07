/**
 * Policy-engine OTel metric helpers — 1:1 port of the frozen Python
 * `codemaster/observability/policy_metrics.py` (Sprint 25 / T-3), scoped to the helpers the ported
 * subsystems actually emit. `recordInvalidCitation` is the citation-validator's activity-body counter
 * (the only policy metric the citation_validate port reaches).
 *
 * ## Cardinality discipline (the same the Python module enforces)
 * NO `installation_id` / `repository_id` / per-PR labels on any counter. The platform serves 60+ orgs x
 * ~3,000 repos; per-installation labels would be a Prometheus cardinality explosion. Per-installation
 * drill-down lives in Tempo traces (span attributes), NOT in metric labels. The only label here is the
 * bounded-enum `enforcement_mode ∈ {observe, enforce}`.
 *
 * ## Emit context
 * The Python helper has TWO meter contexts: workflow-body emits use `workflow.metric_meter()`;
 * activity-body / FastAPI emits use `opentelemetry.metrics.get_meter("codemaster.policy")`.
 * `record_invalid_citation` is the ACTIVITY-body variant (it fires from inside
 * `citation_validate_activity`, never the workflow sandbox), so the TS port routes through the standard
 * `#platform/observability/metrics.js::getMeter` seam — the same activity-runtime meter the sibling
 * counter modules (chunk_response_parser.ts) use. The seam returns a no-op Meter when no MeterProvider
 * is registered, so emission is safe before the exporter is wired (no null-checks, no TODOs).
 *
 * The Python lazy-imports `opentelemetry.metrics` and no-ops on ImportError; `@opentelemetry/api` always
 * resolves and `getMeter` always returns a Meter (no-op when no provider), so the TS port needs no
 * import guard — the no-op Meter IS the "OTel SDK absent" behaviour.
 */
import { type Counter, getMeter } from "#platform/observability/metrics.js";

import type { PolicyCitationEnforcement } from "#contracts/policy_citation.v1.js";

// Counter NAME — copied VERBATIM from the Python `INVALID_CITATION_NAME` (Grafana-query-stable;
// renaming requires ADR). Keeps the deferred metric-name-parity gate + existing dashboards/alerts
// mapping unchanged.
const INVALID_CITATION_NAME = "codemaster_policy_invalid_citation_total";

// Meter + instrument cached at MODULE scope (created once at import), mirroring the Python lazy-cache
// that avoids per-emit create_* lock contention. Meter name = the dotted module path the Python uses.
const METER = getMeter("codemaster.policy");
const INVALID_CITATION_COUNTER: Counter = METER.createCounter(INVALID_CITATION_NAME, {
  description:
    "Count of policy_rule citations failing the validator membership check, labeled by enforcement mode.",
});

/**
 * Activity-body counter (citation_validate_activity context) — 1:1 with the Python
 * `record_invalid_citation(*, enforcement_mode)`.
 *
 * Emitted once per policy_rule citation whose locator is NOT in this review's resolved policy bundle.
 * The `enforcement_mode` label:
 *   - `observe` — observe-mode mismatch logged via WARN, finding KEPT (rollout phase 1).
 *   - `enforce` — enforce-mode mismatch DROPS the finding (phase 2).
 */
export function recordInvalidCitation(enforcementMode: PolicyCitationEnforcement): void {
  INVALID_CITATION_COUNTER.add(1, { enforcement_mode: enforcementMode });
}
