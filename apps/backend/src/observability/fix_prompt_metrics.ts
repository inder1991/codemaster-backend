/**
 * Observability counters for the fix-prompt feature — 1:1 port of the frozen Python
 * `vendor/codemaster-py/codemaster/observability/fix_prompt_metrics.py`.
 *
 * * `codemaster_fix_prompt_generated_total{generation_mode}` — one per generated fix prompt, labelled by
 *   mode (`llm` | `deterministic_fallback`). Bounded cardinality (2 label values).
 * * `codemaster_fix_prompt_truncated_total` — incremented when the generated prompt was severity-truncated
 *   to fit the budget (no labels).
 *
 * ## Cardinality discipline (the same the Python module enforces)
 * NO `installation_id` / `repository_id` / per-PR labels. The only label is the bounded-enum
 * `generation_mode ∈ {llm, deterministic_fallback}`. Per-installation drill-down lives in Tempo traces.
 *
 * ## Emit context
 * This counter fires from inside the ACTIVITY body (`generate_fix_prompt_activity`), never the workflow
 * sandbox, so the TS port routes through the standard `#platform/observability/metrics.js::getMeter` seam
 * (the same activity-runtime meter the sibling counter modules use). The seam returns a no-op Meter when
 * no MeterProvider is registered, so emission is safe before the exporter is wired — the structural
 * analogue of the Python `get_meter(...) is None` no-op (the Python lazy-creates instruments on first
 * emit; here the meter+instruments cache at module scope, which is equivalent because `getMeter` always
 * returns a Meter and a no-op Meter's `createCounter`/`add` are themselves no-ops).
 */

import { type Counter, getMeter } from "#platform/observability/metrics.js";

// Counter NAMES — copied VERBATIM from the Python `GENERATED_NAME` / `TRUNCATED_NAME`
// (Grafana-query-stable; renaming requires ADR).
export const GENERATED_NAME = "codemaster_fix_prompt_generated_total";
export const TRUNCATED_NAME = "codemaster_fix_prompt_truncated_total";

// Meter + instruments cached at MODULE scope (created once at import), mirroring the Python lazy-cache
// that avoids per-emit create_* lock contention. Meter name = the dotted module path the Python uses.
const METER = getMeter("codemaster.fix_prompt");
const GENERATED_COUNTER: Counter = METER.createCounter(GENERATED_NAME, {
  description: "Fix prompts generated, by generation mode.",
});
const TRUNCATED_COUNTER: Counter = METER.createCounter(TRUNCATED_NAME, {
  description: "Fix prompts that were severity-truncated to fit the budget.",
});

/**
 * Emit the generated{generation_mode} counter (+ the truncated counter when the prompt was truncated).
 * 1:1 with the Python `record_fix_prompt_generated(*, generation_mode, truncated)`. No-op when no
 * MeterProvider is registered (the no-op Meter swallows the `add`).
 */
export function recordFixPromptGenerated(args: {
  generationMode: string;
  truncated: boolean;
}): void {
  GENERATED_COUNTER.add(1, { generation_mode: args.generationMode });
  if (args.truncated) {
    TRUNCATED_COUNTER.add(1);
  }
}
