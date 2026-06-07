// platform_labels — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/platform_labels.py::PLATFORM_EXPOSED_LABELS (Sub-spec B T17).
//
// The full set of labels the platform exposes to repo-level `.codemaster.yaml` configurations + the
// Confluence retriever's `cc.labels && :effective_labels` overlap filter. The set is the platform's
// CEILING: repos can NARROW it via include_labels / exclude_labels but never elevate (spec §3.7
// restrictive-only — see `effective_labels.ts`).
//
// Single source-of-truth, assembled from (1:1 with the Python `_build_platform_exposed_labels`):
//   * the always-emitted `default` label
//   * the curated topic labels (`topic:security_policy` is the only curated topic in v1)
//   * every label the three detectors can emit (LanguageDetector / FrameworkDetector / InfraDetector —
//     the EXTENSION_TO_LANG_LABEL values, the FRAMEWORK_MAPPINGS values, the INFRA_PATTERNS labels).
//
// Future moves (faithful to the Python's deferred-promotion note): promote to `core.platform_config`
// (operator-tunable) then to Vault (runtime-mutable without redeploy). Until then, edits land via PR
// review.
//
// SANDBOX SAFETY (ADR-0065/0066): pure frozen data computed at module load over static const tables. NO
// node:crypto / uuid / clock / RNG / timers — importable inside the workflow sandbox if ever needed (the
// workflow body imports it to thread platform_exposed_labels onto RetrieveKnowledgeInputV1).

import {
  EXTENSION_TO_LANG_LABEL,
  INFRA_PATTERNS,
} from "#backend/retrieval/detection/detectors.js";
import { FRAMEWORK_MAPPINGS } from "#backend/retrieval/detection/framework_mappings.js";

/** Build the platform ceiling (1:1 with the Python `_build_platform_exposed_labels`). */
function buildPlatformExposedLabels(): ReadonlySet<string> {
  const base = new Set<string>(["default"]);

  // Curated topic labels (extend as the corpus grows + IDP curates new topics).
  base.add("topic:security_policy");

  // Every label the three detectors can emit.
  for (const label of Object.values(EXTENSION_TO_LANG_LABEL)) {
    base.add(label);
  }
  for (const label of Object.values(FRAMEWORK_MAPPINGS)) {
    base.add(label);
  }
  for (const [, label] of INFRA_PATTERNS) {
    base.add(label);
  }

  return base;
}

/**
 * The platform's label ceiling — the `frozenset[str]` Python `PLATFORM_EXPOSED_LABELS` (Final). Frozen at
 * module load; the union of the curated topics + the three detector mapping tables. Wrapped in a
 * `ReadonlySet` so callers cannot mutate the shared ceiling.
 */
export const PLATFORM_EXPOSED_LABELS: ReadonlySet<string> = buildPlatformExposedLabels();
