// label_detection — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/label_detection.py::detect_labels (Sub-spec B T6).
//
// Two-stage detection-pipeline orchestrator (spec §3.5 lines 369-386): classifiers populate
// FileClassification on every ChangedFile, then detectors run in any order and union their emissions.
//
// `DETECTION_PIPELINE_VERSION` is persisted in each retrieval trace (§3.10) so "retrieval changed
// between deploys" boils down to comparing the persisted version against the current value.

import { classifyFiles } from "#backend/retrieval/detection/classifiers.js";
import {
  FrameworkDetector,
  InfraDetector,
  LanguageDetector,
  type LabelDetector,
} from "#backend/retrieval/detection/detectors.js";

import type { PRContext } from "#contracts/pr_context.v1.js";

/** Bumps on any detector mapping change or pipeline composition change (Python constant). */
export const DETECTION_PIPELINE_VERSION = 1 as const;

/**
 * Default detector tuple (Python `_DEFAULT_DETECTORS`). Exposed as a frozen constant for tests +
 * observability so callers can introspect the active set without re-importing the orchestrator.
 */
export const DEFAULT_DETECTORS: ReadonlyArray<LabelDetector> = [
  new LanguageDetector(),
  new FrameworkDetector(),
  new InfraDetector(),
];

/**
 * Run the two-stage detection pipeline over `ctx` (1:1 with the Python `detect_labels`).
 *
 * Returns `[unionOfEmissions, perDetectorEmissions]` where the union ALWAYS contains `"default"`
 * (spec §3.5 line 379). The per-detector breakdown is keyed by `detector.name` so callers can persist
 * it in retrieval traces without re-running anything.
 */
export function detectLabels(
  ctx: PRContext,
  opts: { detectors?: ReadonlyArray<LabelDetector> } = {},
): readonly [ReadonlySet<string>, Map<string, ReadonlySet<string>>] {
  const classifiedCtx = classifyFiles(ctx);
  const use = opts.detectors ?? DEFAULT_DETECTORS;

  const byDetector = new Map<string, ReadonlySet<string>>();
  const labels = new Set<string>(["default"]);
  for (const det of use) {
    const emitted = det.detect(classifiedCtx);
    byDetector.set(det.name, emitted);
    for (const label of emitted) {
      labels.add(label);
    }
  }

  return [labels, byDetector] as const;
}
