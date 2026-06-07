// pr_context_builder — port of the frozen Python
//   vendor/codemaster-py/codemaster/review/pr_context_builder.py
//   (closes FOLLOW-UP-confluence-pr-context-full-pr).
//
// The Sub-spec B T17 wiring constructs a {@link PRContext} for every chunk it sends to
// `retrieve_knowledge_activity`. Two pure helpers build it:
//
//   - `buildPrContextFull` uses the enrichment result captured at the top of the workflow body
//     (`enrich_pr_files_activity_v2`) to construct ONE PRContext containing every changed file, then
//     reuses it across all chunks in the fan-out.
//   - `buildPrContextMvp` is the legacy per-chunk single-file construction, kept available for the
//     unpatched-replay path so in-flight workflows that started before the marker landed continue to
//     replay deterministically.
//
// Both helpers are pure — no I/O, no clock, no random — so they're importable inside the Temporal
// workflow sandbox without triggering non-determinism checks (the workflow picks between them via
// `workflow.patched("confluence-pr-context-full-pr")`).
//
// ── classify_files seam ─────────────────────────────────────────────────────────────────────────
// The Python `build_pr_context_full` calls the detection-pipeline orchestrator
// `codemaster.retrieval.detection.classifiers.classify_files` directly to populate each ChangedFile's
// `classification` (is_generated / is_vendored / is_test). That subsystem IS now ported
// ({@link classifyFiles} in retrieval/detection/classifiers.ts), and `buildPrContextFull` DEFAULTS to it
// — so classification flags populate exactly as in Python (Tier-1-parity-tested). The classifier stays an
// INJECTED seam ({@link PrContextClassifier}) so tests can substitute a stub; {@link identityClassifier}
// is the no-op opt-out. All other fields (path / additions / deletions order, head_sha + branch
// passthrough, manifest threading) are byte-for-byte 1:1 with the frozen Python.

import {
  ChangedFile,
  PRContext,
  type ManifestSnapshot,
} from "#contracts/pr_context.v1.js";

import type { PrFileV1 } from "#contracts/pr_file.v1.js";
import type { PrFilesEnrichmentResultV1 } from "#contracts/pr_files_enrichment.v1.js";

import { classifyFiles } from "#backend/retrieval/detection/classifiers.js";

/**
 * The detection-pipeline classifier seam (Python `classify_files: (PRContext) -> PRContext`). Takes a
 * raw PRContext + returns one with every ChangedFile's `classification` populated. Replay-safe (pure).
 */
export type PrContextClassifier = (ctx: PRContext) => PRContext;

/**
 * Identity classifier — returns the PRContext unchanged (all ChangedFile.classification flags stay at
 * their constructed default of all-false / reason=null). The no-op OPT-OUT from the real
 * {@link classifyFiles} default (used by tests that want to assert un-classified input).
 */
export const identityClassifier: PrContextClassifier = (ctx) => ctx;

/** Construct a fully-defaulted ChangedFile classification (Pydantic `FileClassification()` default). */
function defaultClassification(): ChangedFile["classification"] {
  return { is_generated: false, is_vendored: false, is_test: false, reason: null };
}

function changedFileFromPrFile(pf: PrFileV1): ChangedFile {
  return ChangedFile.parse({
    path: pf.file_path,
    additions: pf.additions,
    deletions: pf.deletions,
    classification: defaultClassification(),
  });
}

/**
 * Build the workflow-body-level full-PR PRContext from the `enrich_pr_files_activity_v2` result
 * (1:1 with the Python `build_pr_context_full`).
 *
 * Returns `null` when `enrichment` is `null`/`undefined` — the workflow's enrich step is fail-open
 * (skipped / v1-replay / errored branches all leave enrichment unbound). When this returns null, the
 * caller falls back to {@link buildPrContextMvp} per chunk.
 *
 * Each ChangedFile is passed through the injected {@link PrContextClassifier} (Python's `classify_files`)
 * so `classification` is populated at construction time. `manifestSnapshots` defaults to `[]` (the
 * pre-manifest behavior); the workflow body threads `fetch_manifest_snapshots_activity`'s result here.
 */
export function buildPrContextFull(args: {
  prId: string;
  headSha: string;
  repoDefaultBranch: string;
  enrichment: PrFilesEnrichmentResultV1 | null | undefined;
  // `| undefined` (not just `?`) so callers under `exactOptionalPropertyTypes` may forward a possibly-
  // undefined value (e.g. pickPrContext threading its own optional through).
  manifestSnapshots?: ReadonlyArray<ManifestSnapshot> | undefined;
  classify?: PrContextClassifier | undefined;
}): PRContext | null {
  const { enrichment } = args;
  if (enrichment === null || enrichment === undefined) {
    return null;
  }
  // Default to the real detection-pipeline classify_files (1:1 with Python's build_pr_context_full, which
  // always classifies). Callers may still inject a stub via `classify` for testing. Pure + replay-safe.
  const classify = args.classify ?? classifyFiles;
  const rawCtx = PRContext.parse({
    pr_id: args.prId,
    head_sha: args.headSha,
    repo_default_branch: args.repoDefaultBranch,
    changed_files: enrichment.files.map(changedFileFromPrFile),
    manifests: [...(args.manifestSnapshots ?? [])],
  });
  return classify(rawCtx);
}

/**
 * Legacy per-chunk single-file PRContext shipped in Sub-spec B T17 MVP wiring (1:1 with the Python
 * `build_pr_context_mvp`).
 *
 * Kept available for the unpatched-replay path so in-flight workflows that started before
 * `workflow.patched("confluence-pr-context-full-pr")` landed continue to replay deterministically.
 * Single-file by design — placeholder additions/deletions = 0, no classification, no manifests.
 */
export function buildPrContextMvp(args: {
  prId: string;
  headSha: string;
  repoDefaultBranch: string;
  chunkPath: string;
}): PRContext {
  return PRContext.parse({
    pr_id: args.prId,
    head_sha: args.headSha,
    repo_default_branch: args.repoDefaultBranch,
    changed_files: [
      {
        path: args.chunkPath,
        additions: 0,
        deletions: 0,
        classification: defaultClassification(),
      },
    ],
    manifests: [],
  });
}

/**
 * Convenience selector used by the workflow body (1:1 with the Python `pick_pr_context`).
 *
 * Returns the full PR context when `useFull` is true AND the enrichment is usable; falls back to the MVP
 * per-chunk context otherwise. The boolean is passed in (not derived here) so the workflow body owns the
 * `workflow.patched` gate evaluation — keeps the marker visible at the call site for audit + grep.
 *
 * `manifestSnapshots` is threaded only into the full-PR branch (the MVP fallback is single-file by
 * design — manifests don't apply when we only know one chunk path).
 */
export function pickPrContext(args: {
  useFull: boolean;
  prId: string;
  headSha: string;
  repoDefaultBranch: string;
  enrichment: PrFilesEnrichmentResultV1 | null | undefined;
  chunkPath: string;
  manifestSnapshots?: ReadonlyArray<ManifestSnapshot>;
  classify?: PrContextClassifier;
}): PRContext {
  if (args.useFull) {
    const full = buildPrContextFull({
      prId: args.prId,
      headSha: args.headSha,
      repoDefaultBranch: args.repoDefaultBranch,
      enrichment: args.enrichment,
      manifestSnapshots: args.manifestSnapshots,
      classify: args.classify,
    });
    if (full !== null) {
      return full;
    }
  }
  return buildPrContextMvp({
    prId: args.prId,
    headSha: args.headSha,
    repoDefaultBranch: args.repoDefaultBranch,
    chunkPath: args.chunkPath,
  });
}
