// effective_labels — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/effective_labels.py::compute_effective_labels
//   (Sub-spec B T9, spec §3.7, r2-#12).
//
// RESTRICTIVE-ONLY resolution: repo config CAN narrow the platform-exposed label set; it CANNOT
// elevate. This is the content-bleed protection within the single-company / multi-org deployment.
//
// The platform's allow-list (`platformExposedLabels`) is the ceiling. A repo's `.codemaster.yaml` can:
//   - INCLUDE labels — narrows the active set to a subset of the platform ceiling. Requested labels NOT
//     on the platform list are silently dropped + logged as `repo_config_visibility_violation_attempt`
//     (operator-greppable).
//   - EXCLUDE labels — removes from whatever the include set is.
//
// Returns `[effectiveLabels, perDetectorOutputs]` so callers (T11+) can persist the per-detector
// breakdown for retrieval-trace explainability. Pure modulo the structured log emission (logging is
// side-channel observability, not state).

import { detectLabels } from "#backend/retrieval/label_detection.js";

import type { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import type { PRContext } from "#contracts/pr_context.v1.js";

/** Set intersection (Python `&`). */
function intersect(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) {
    if (b.has(x)) {
      out.add(x);
    }
  }
  return out;
}

/** Set difference `a - b` (Python `-`). */
function difference(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) {
    if (!b.has(x)) {
      out.add(x);
    }
  }
  return out;
}

/** Set union (Python `|`). */
function union(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const out = new Set<string>(a);
  for (const x of b) {
    out.add(x);
  }
  return out;
}

/**
 * Resolve the active retrieval label set for one PR (1:1 with the Python `compute_effective_labels`).
 *
 * Semantics (spec §3.7):
 *   1. Run detectors. `detected ∪ {"default"}` is the base set.
 *   2. Intersect with `platformExposedLabels` (restrictive ceiling).
 *   3. Add legal entries from `yamlConfig.knowledge.confluence.include_labels` (only those also on the
 *      platform ceiling). Illegal entries emit a structured-log warning per attempt.
 *   4. Subtract `yamlConfig.knowledge.confluence.exclude_labels`.
 *
 * @returns `[effectiveLabels, perDetectorOutputs]`.
 */
export function computeEffectiveLabels(args: {
  prContext: PRContext;
  yamlConfig: CodemasterConfigV1;
  platformExposedLabels: ReadonlySet<string>;
}): readonly [ReadonlySet<string>, Map<string, ReadonlySet<string>>] {
  const [detected, byDetector] = detectLabels(args.prContext);

  // base = (detected | {"default"}) & platform_exposed_labels.
  const detectedWithDefault = union(detected, new Set(["default"]));
  const base = intersect(detectedWithDefault, args.platformExposedLabels);

  const confluenceCfg = args.yamlConfig.knowledge.confluence;
  const requestedInclude = new Set(confluenceCfg.include_labels);
  const requestedExclude = new Set(confluenceCfg.exclude_labels);

  const legalInclude = intersect(requestedInclude, args.platformExposedLabels);
  const illegalInclude = difference(requestedInclude, args.platformExposedLabels);
  for (const label of illegalInclude) {
    const ns = label.includes(":") ? label.split(":", 1)[0]! : "bare";
    // Structured-log substitute for the deferred counter (Python `_LOG.warning`).
    console.warn(
      JSON.stringify({
        event: "repo_config_visibility_violation_attempt",
        label_namespace: ns,
        label,
        pr_id: String(args.prContext.pr_id),
      }),
    );
  }

  const effective = difference(union(base, legalInclude), requestedExclude);
  return [effective, byDetector] as const;
}
