/**
 * `classifyFiles` activity — Phase-2.1 core-loop activity #2 port. 1:1 in intent with the frozen Python
 * `@activity.defn classify_files` + `_do_classify`
 * (vendor/codemaster-py/codemaster/activities/classify_files.py): walk the cloned workspace, run the
 * Sprint-7 file classifier on each changed file, and route via `decideRoute` (S7.1.3) into the three
 * buckets — `review_files`, `sandbox_files`, `skip_files` — plus the per-file `classifications` and
 * isolated `classifier_failures`. Returns a `FileRoutingV1` envelope in INPUT ORDER.
 *
 * ## Failure-isolation (the parity-significant behavior)
 *
 * A per-file read failure (`OSError` in Python → a thrown `readFileSync` here) OR a classifier exception
 * records the offending path in `classifier_failures` and `continue`s — the file is absent from ALL
 * three routing buckets AND from `classifications`, but the remaining files still route. One bad file
 * never poisons the rest of the PR's routing.
 *
 * ## decideRoute Set semantics (frozenset membership, ported exactly)
 *
 * `decideRoute(cls)` returns a `Set<RoutingBucket>` mirroring the Python `frozenset[RoutingBucket]`.
 * Membership checks are byte-identical to the frozen Python:
 *   - `"skip" ∈ decision`  → `skip.push(relative)` (terminal — never also review/sandbox).
 *   - else: `"review" ∈ decision` → `review.push`; `"sandbox" ∈ decision` → `sandbox.push`.
 * A CODE file routes to BOTH `review` AND `sandbox` (the Set carries both members) — that dual-bucket
 * membership is preserved exactly. The orchestrator (Phase 2.2) enforces Tier-1 (sandbox) → Tier-2
 * (review) sequencing; the router/activity stay free of orchestration concerns.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The frozen Python activity dispatches with TWO positional arguments
 * (`classify_files(workspace_path, files)`) — a known live invariant-11 violation, sibling to
 * `aggregate_findings`'s 2-positional dispatch. This port CLOSES it: the single positional input is the
 * {@link ClassifyFilesInputV1} envelope (workspace_path + files + schema_version). There is no Python
 * Pydantic counterpart for the envelope — it is introduced during the port.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. The byte read uses
 * `node:fs` synchronously (a filesystem read, NOT a clock/random seam — the check_clock_random gate
 * permits fs reads). `doClassify` is the pure orchestration tests/parity drive directly; `classifyFiles`
 * is the registered activity that constructs the REAL {@link MagikaFileClassifier} and delegates.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type FileClassifierPort, MagikaFileClassifier } from "#backend/files/magika_classifier.js";
import { decideRoute } from "#backend/files/router.js";

import { ClassifyFilesInputV1 } from "#contracts/classify_files.v1.js";
import type { FileClassificationV1 } from "#contracts/file_classification.v1.js";
import type { FileRoutingV1 } from "#contracts/file_routing.v1.js";

/**
 * The `_do_classify` orchestration, ported EXACTLY (iteration order + failure isolation + bucketing):
 *
 *   for relative in files:
 *     absolute = workspace / relative
 *     try body = read_bytes(absolute) except OSError: failures.push(relative); continue
 *     try cls = await classifier.classify({ path: relative, body }) except *: failures.push; continue
 *     classifications.push(cls)
 *     decision = decideRoute(cls)                  // a Set<RoutingBucket> (Python frozenset)
 *     if "skip" ∈ decision: skip.push(relative)
 *     else:
 *       if "review"  ∈ decision: review.push(relative)
 *       if "sandbox" ∈ decision: sandbox.push(relative)   // a CODE file lands in BOTH
 *
 * Returns the `FileRoutingV1` envelope with the four path lists + classifications, all in INPUT ORDER.
 * Exported so the Tier-1 parity oracle drives the same orchestration the activity runs (mirrors the
 * frozen Python exporting `_do_classify` from the activity module). The classifier is INJECTED so the
 * parity test can substitute a deterministic stub for the magika ML (out of scope here; separately
 * covered by test:magika).
 */
export async function doClassify(args: {
  workspace: string;
  files: ReadonlyArray<string>;
  classifier: FileClassifierPort;
}): Promise<FileRoutingV1> {
  const { workspace, files, classifier } = args;

  const review: Array<string> = [];
  const sandbox: Array<string> = [];
  const skip: Array<string> = [];
  const classifications: Array<FileClassificationV1> = [];
  const failures: Array<string> = [];

  for (const relative of files) {
    const absolute = join(workspace, relative);

    let body: Uint8Array;
    try {
      body = readFileSync(absolute);
    } catch {
      // Mirrors the Python `except OSError` branch: record the read failure + skip from all buckets.
      failures.push(relative);
      continue;
    }

    let cls: FileClassificationV1;
    try {
      cls = await classifier.classify({ path: relative, body });
    } catch {
      // Mirrors the Python `except Exception` branch: any classifier error isolates this one file.
      failures.push(relative);
      continue;
    }

    classifications.push(cls);
    const decision = decideRoute(cls);
    // Phase B (2026-05-16): decision is a Set (Python frozenset); a CODE file appears in BOTH "review"
    // and "sandbox". The orchestrator enforces Tier-1 (sandbox) → Tier-2 (review) sequencing.
    if (decision.has("skip")) {
      skip.push(relative);
    } else {
      if (decision.has("review")) review.push(relative);
      if (decision.has("sandbox")) sandbox.push(relative);
    }
  }

  return {
    schema_version: 1,
    review_files: review,
    sandbox_files: sandbox,
    skip_files: skip,
    classifications,
    classifier_failures: failures,
  };
}

/**
 * The registered activity. Takes the single typed {@link ClassifyFilesInputV1} envelope (invariant 11),
 * constructs the REAL {@link MagikaFileClassifier} (one per call; the model is memoized at module scope
 * so every instance shares the single loaded model), and delegates to {@link doClassify}.
 */
export async function classifyFiles(input: ClassifyFilesInputV1): Promise<FileRoutingV1> {
  // Parse at the activity boundary: a wrong-shape dispatch (e.g. a camelCase key from a drifting caller)
  // throws a clear ZodError here instead of silently reading `undefined` downstream.
  const parsed = ClassifyFilesInputV1.parse(input);
  const classifier = new MagikaFileClassifier();
  return doClassify({
    workspace: parsed.workspace_path,
    files: parsed.files,
    classifier,
  });
}
