// Pure pipeline helpers — 1:1 ports of the workflow-sandbox-safe pure functions in the frozen Python.
//
// Sources:
//   vendor/codemaster-py/codemaster/workflows/review_pull_request.py
//     * _stage_outcome_for_publication      (~155)
//     * _fix_prompt_stage_outcome           (~169)
//     * _resolve_degraded_payload           (~192)
//     * _config_change_notice_finding       (~225)
//     * _compose_orchestrator_degradation_note (~356)
//   vendor/codemaster-py/codemaster/workflows/review_pipeline_orchestrator.py
//     * _path_filters_excluded_all_finding  (~365)
//     * _infer_pr_topology_kind             (~394)
//
// All seven are pure functions over their inputs — NO clock reads, NO random, NO uuid mint, NO env-var
// access, NO I/O — so they are workflow-sandbox-safe (ADR-0065/0066) and replay-deterministic. The
// Tier-1 parity check (test/parity/pipeline_helpers_oracle.ts) drives the frozen Python and byte-compares
// canonical JSON (bare-float `confidence` is stripped before the compare per the established gotcha — the
// canonicalizer rejects bare floats).
//
// DEFERRED to Stage 1: _build_analyzed_payload (review_pull_request.py:269) depends on
// ReviewPipelineResult, which is a Stage 1 build item (the orchestrator's typed return) and is NOT yet
// ported under #contracts. Per the task's "verify each helper's deps exist before porting" rule, it is
// left for Stage 1. _maybe_append_config_notice (review_pull_request.py:246) depends on
// AggregatedFindingsV1 mutation + the workflow.patched gate; it is the wrapping caller of
// _config_change_notice_finding and is wired in the orchestrator/aggregate path (Stage 1/5), so only the
// pure leaf (_config_change_notice_finding) is ported here.

import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { PublicationOutcome } from "#contracts/posted_review.v1.js";

import type { PostReviewCapture } from "./state.js";
import type { ReviewPipelineResult } from "./pipeline_result.js";
import type { ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";
import type { PolicyCitationContextV1, PolicyCitationEnforcement } from "#contracts/policy_citation.v1.js";
import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// _stage_outcome_for_publication (review_pull_request.py:155)
//
// Map a PublicationOutcome to the workflow's stage-outcome vocabulary (pipeline_metrics.OUTCOMES).
//   INLINE_POSTED                          → 'ok'        (happy path)
//   BODY_ONLY_POSTED, DEGRADED_UNPOSTED    → 'fallback'  (reduced fidelity)
//   None (capture never populated)         → 'ok'        (defensive default)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function stageOutcomeForPublication(outcome: PublicationOutcome | null): string {
  if (outcome === null || outcome === PublicationOutcome.enum.inline_posted) {
    return "ok";
  }
  return "fallback";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// _fix_prompt_stage_outcome (review_pull_request.py:169)
//
// Map a generate_fix_prompt_activity result to a pipeline stage outcome.
//   not generated                → 'skipped'
//   generation_mode === 'llm'    → 'ok'
//   otherwise (deterministic)    → 'fallback'
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function fixPromptStageOutcome(args: {
  generated: boolean;
  generationMode: string;
}): string {
  if (!args.generated) {
    return "skipped";
  }
  return args.generationMode === "llm" ? "ok" : "fallback";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// _resolve_degraded_payload (review_pull_request.py:192)
//
// Decide which rfids to flip to a degraded outcome.
//   BODY_ONLY_POSTED  → (keptRfids, 'body_only_fallback')
//   DEGRADED_UNPOSTED → (keptRfids, 'failed')
//   INLINE_POSTED / None → ([], null)
//
// The Python returns a 2-tuple (rfids_to_flip, outcome_value); TS returns a typed object. rfids are UUID
// strings on the wire (no uuid mint in the sandbox).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export type ResolvedDegradedPayload = {
  rfidsToFlip: ReadonlyArray<string>;
  outcomeValue: string | null;
};

export function resolveDegradedPayload(
  outcome: PublicationOutcome | null,
  keptRfids: ReadonlyArray<string>,
): ResolvedDegradedPayload {
  if (outcome === PublicationOutcome.enum.body_only_posted) {
    return { rfidsToFlip: keptRfids, outcomeValue: "body_only_fallback" };
  }
  if (outcome === PublicationOutcome.enum.degraded_unposted) {
    return { rfidsToFlip: keptRfids, outcomeValue: "failed" };
  }
  return { rfidsToFlip: [], outcomeValue: null };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// _build_analyzed_payload (review_pull_request.py:269)
//
// Build the ANALYZED-event payload dict the workflow body dispatches to
// record_review_lifecycle_event_activity at Step 5.5. Pure projection over its inputs (no clock / random /
// uuid / I/O) → workflow-sandbox-safe + replay-deterministic.
//
// ── GATE COLLAPSE (analyzed-on-degraded-pipeline-result collapse-on) ──
// The frozen Python branches on `workflow.patched("analyzed-on-degraded-pipeline-result")`: the unpatched
// branch emits the v7-A baseline shape `{findings_count, head_sha}`, the patched branch adds the three
// publication/degradation fields. This is a NEW Temporal workflow type with ZERO histories, so the gate is
// unconditionally TRUE — only the PATCHED branch is ported (straight-line). The pre-patch baseline branch
// is dead code and is NOT ported.
//
// Provenance preservation is LOAD-BEARING: `publication_degradation_notes` (delivery-state) and
// `pipeline_degradation_notes` (system-orchestration-state) are SEPARATE lists, never merged — downstream
// consumers (Grafana panels, alert routing, SLOs, RCA tooling) filter by provenance. The payload is an
// untyped `dict[str, Any]` in Python (tactical observability plumbing, NOT a versioned event-schema
// contract); the TS analogue is `Record<string, unknown>` (the audit payload the event input accepts).
//
// `publication_outcome` is the PublicationOutcome wire .value string (or null when no publication happened,
// e.g. the orchestrator raised before reaching post_review). `pipeline_degradation_notes` is sourced from
// `pipeline_result.degradationNotes` (null pipeline_result → []).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function buildAnalyzedPayload(args: {
  findingsCount: number;
  headSha: string;
  postedReviewCapture: PostReviewCapture;
  pipelineResult: ReviewPipelineResult | null;
}): Record<string, unknown> {
  const publicationOutcome: string | null = args.postedReviewCapture.publicationOutcome;
  const pipelineDegradationNotes: ReadonlyArray<string> =
    args.pipelineResult !== null ? args.pipelineResult.degradationNotes : [];
  return {
    findings_count: args.findingsCount,
    head_sha: args.headSha,
    publication_outcome: publicationOutcome,
    publication_degradation_notes: [...args.postedReviewCapture.degradationNotes],
    pipeline_degradation_notes: [...pipelineDegradationNotes],
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// build_policy_citation_context (codemaster/policy/citation_context_builder.py:37)
//
// Union `rule_id` across all per-changed-path policy bundles into a single PolicyCitationContextV1 the
// citationValidate activity consumes as its policy-citation context. Pure helper (no clock / random / uuid
// / I/O) → workflow-sandbox-safe + replay-deterministic.
//
// Deduplicates rule_ids that apply across multiple changed paths (e.g. a repo-root CLAUDE.md rule the
// scope resolver surfaced in every bundle). Emits in SORTED order for determinism (replay/log-diff
// stability). An empty bundle map yields an empty-rule_ids context (legal: "no policy rules apply"; under
// enforce-mode the validator drops ALL policy_rule citations when valid_rule_ids is empty).
//
// Default enforcement = "observe" per the phased-rollout plan (log mismatches, keep findings; operators
// flip to "enforce" after the drift-window data stabilizes).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function buildPolicyCitationContext(
  policyBundles: ReadonlyMap<string, ResolvedGuidanceBundleV1>,
  enforcement: PolicyCitationEnforcement = "observe",
): PolicyCitationContextV1 {
  const ruleIds = new Set<string>();
  for (const bundle of policyBundles.values()) {
    for (const deduped of bundle.applicable_rules) {
      ruleIds.add(deduped.rule.rule_id);
    }
  }
  return {
    schema_version: 1,
    valid_rule_ids: [...ruleIds].sort(),
    enforcement,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// _config_change_notice_finding (review_pull_request.py:225)
//
// spec §7 — informational finding when a PR edits .codemaster.yaml. Returns a validated ReviewFindingV1.
// Bare-float `confidence` (0.99) is a contract field; the parity oracle strips it before the canonical
// compare (the canonicalizer rejects bare floats) and asserts it structurally + by range.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function configChangeNoticeFinding(): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: ".codemaster.yaml",
    start_line: 1,
    end_line: 1,
    severity: "suggestion",
    category: "config",
    title: "codemaster: this PR modifies .codemaster.yaml",
    body:
      "This PR modifies `.codemaster.yaml` (review settings). Confirm " +
      "the change is intended; settings in this file affect how " +
      "codemaster reviews this and future PRs.",
    suggestion: null,
    confidence: 0.99,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// _maybe_append_config_notice (review_pull_request.py:246)
//
// spec §7 — append the .codemaster.yaml config-change notice when the PR touched .codemaster.yaml.
// Returns a (possibly new) AggregatedFindingsV1 with the notice appended; otherwise returns `aggregated`
// unchanged. Pure + sandbox-safe (no clock / random / uuid / I/O) — only constructs a fresh
// AggregatedFindingsV1 from its inputs + the pure configChangeNoticeFinding leaf.
//
// ── GATE COLLAPSE (repo-config-wiring collapse-on) ──
// The frozen Python takes a `patched` kwarg (`workflow.patched("repo-config-wiring")`) and no-ops when
// false. This drives a NEW Temporal workflow type with ZERO histories, so the gate is unconditionally TRUE
// — the `if not patched: return aggregated` early-out is dead code and is NOT ported. Only the membership
// guard remains.
//
// The membership check uses the PRE-path_filters changed-paths snapshot (the orchestrator's
// `repo.changedPaths`, = the Python `original_changed_paths`) so a `path_filters` exclusion of
// .codemaster.yaml cannot hide the notice. Callers MUST append AFTER the MAX_INLINE_FINDINGS cap so the
// notice is never capped away.
//
// IDEMPOTENT — does not double-append. A second call over an already-noticed AggregatedFindingsV1 is a
// no-op (the notice is detected by its sentinel file + category + title, the same shape
// configChangeNoticeFinding mints). The Python relied on the caller wiring (one append site); the TS port
// hardens the function itself so a re-invocation in a fan-out / retry path can never duplicate the notice.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const CONFIG_YAML_PATH = ".codemaster.yaml";

/** Does `findings` already carry the config-change notice? Detected by the sentinel
 *  (file, category, title) the notice mints — so a re-append is a no-op (idempotency guard). */
function hasConfigNotice(findings: ReadonlyArray<ReviewFindingV1>): boolean {
  for (const f of findings) {
    if (
      f.file === CONFIG_YAML_PATH &&
      f.category === "config" &&
      f.title === "codemaster: this PR modifies .codemaster.yaml"
    ) {
      return true;
    }
  }
  return false;
}

export function maybeAppendConfigNotice(
  aggregated: AggregatedFindingsV1,
  changedPaths: ReadonlyArray<string>,
): AggregatedFindingsV1 {
  // Membership: .codemaster.yaml in the PRE-path_filters changed set (the Python `if ".codemaster.yaml"
  // not in set(changed_paths): return aggregated`).
  if (!changedPaths.includes(CONFIG_YAML_PATH)) {
    return aggregated;
  }
  // Idempotency: never double-append (see header).
  if (hasConfigNotice(aggregated.findings)) {
    return aggregated;
  }
  // Python: AggregatedFindingsV1(findings=(*aggregated.findings, notice), dedupe_stats=..., policy_revision=...).
  // schema_version is preserved (the Python keeps the model's existing version on the rebuild).
  return {
    schema_version: aggregated.schema_version,
    findings: [...aggregated.findings, configChangeNoticeFinding()],
    dedupe_stats: aggregated.dedupe_stats,
    policy_revision: aggregated.policy_revision,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// _path_filters_excluded_all_finding (review_pipeline_orchestrator.py:365)
//
// spec §6.4 — informational finding when path_filters excludes every changed file. Mirrors
// _config_warning_finding field-for-field so it renders through the same category="config" surface.
// Bare-float `confidence` (0.99) handled by the oracle exactly as configChangeNoticeFinding above.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function pathFiltersExcludedAllFinding(): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: ".codemaster.yaml",
    start_line: 1,
    end_line: 1,
    severity: "suggestion",
    category: "config",
    title: "codemaster: 0 files reviewed (path_filters)",
    body:
      "codemaster reviewed 0 files: `path_filters` in .codemaster.yaml " +
      "excluded all changed files. Adjust path_filters if this is " +
      "unintended.",
    suggestion: null,
    confidence: 0.99,
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// _infer_pr_topology_kind (review_pipeline_orchestrator.py:394)
//
// Map a chunk path to the PRTopologyKind Literal value for the LLM-prompt inventory tagging. Heuristic
// extension + path matching; the LLM uses `kind` for narrative context only, not scope decisions.
//
// ORDER IS LOAD-BEARING — the test check runs BEFORE the doc check, so e.g. "TESTING.md" → "test" (it
// startsWith "test"), not "doc". Preserve the exact branch order from the Python.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const _DOC_SUFFIXES: ReadonlyArray<string> = [".md", ".rst", ".txt"];
const _CONFIG_SUFFIXES: ReadonlyArray<string> = [".yaml", ".yml", ".toml", ".json", ".ini", ".cfg"];
const _CODE_SUFFIXES: ReadonlyArray<string> = [
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".go",
  ".rs",
  ".java",
];

export function inferPrTopologyKind(path: string): string {
  const lower = path.toLowerCase();
  if (lower.includes("/test") || lower.startsWith("test") || lower.includes("test_")) {
    return "test";
  }
  if (_DOC_SUFFIXES.some((s) => lower.endsWith(s))) {
    return "doc";
  }
  if (
    _CONFIG_SUFFIXES.some((s) => lower.endsWith(s)) ||
    lower.startsWith(".") ||
    lower.endsWith(".dockerfile")
  ) {
    return "config";
  }
  if (_CODE_SUFFIXES.some((s) => lower.endsWith(s))) {
    return "code";
  }
  return "other";
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// _compose_orchestrator_degradation_note (review_pull_request.py:356)
//
// Compose a single WalkthroughV1.degradation_note string from the orchestrator's degradation_notes tuple.
//   * Empty (after strip+dedup) notes → returns priorNote unchanged.
//   * Non-empty → joins the deduped, non-empty, stripped entries with ", " and prefixes
//     "pipeline degraded: "; when priorNote is non-empty, appends with a "; " separator.
//
// Dedup uses a seen-set over the STRIPPED value (n.strip()); empty-after-strip entries are dropped.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function composeOrchestratorDegradationNote(args: {
  notes: ReadonlyArray<string>;
  priorNote: string | null;
}): string | null {
  const deduped: Array<string> = [];
  const seen = new Set<string>();
  for (const n of args.notes) {
    const nClean = n.trim();
    if (nClean === "" || seen.has(nClean)) {
      continue;
    }
    seen.add(nClean);
    deduped.push(nClean);
  }
  if (deduped.length === 0) {
    return args.priorNote;
  }
  const composed = `pipeline degraded: ${deduped.join(", ")}`;
  if (args.priorNote !== null && args.priorNote !== "") {
    return `${args.priorNote}; ${composed}`;
  }
  return composed;
}
