// gates — the COLLAPSED-gate ledger (finding 3 of the full-port plan).
//
// This is a FROZEN DOCUMENTATION CONSTANT, not runtime branching. There is NO runtime workflow.patched()
// call in the TS port.
//
// WHY EVERY GATE COLLAPSES (TSDoc — read before adding any patched() to the TS workflow):
//
//   The Python review workflow accreted 25 `workflow.patched(<marker>)` gates across review_pull_request.py
//   + review_pipeline_orchestrator.py. Each gate exists to keep IN-FLIGHT Python workflow histories
//   replay-deterministic across a deploy that changed the workflow body: `workflow.patched(marker)` returns
//   TRUE for executions started AFTER the marker landed (they run the new branch) and FALSE for executions
//   already in-flight when the marker landed (they replay the OLD branch). The marker is a temporal fork in
//   the workflow code keyed on "did this execution's history record the patch?".
//
//   The TS port is a NEW Temporal workflow TYPE (ReviewPullRequestWorkflow → its own TS bundle, distinct
//   from the Python). It has ZERO pre-existing histories. Therefore, for EVERY marker, `patched()` would be
//   UNCONDITIONALLY TRUE — there is no in-flight TS history that could take a false/legacy branch. So:
//
//     * Every gate's CURRENT-PROD (true) branch is taken as STRAIGHT-LINE code.
//     * The `patched()` / `deprecate_patch()` calls and ALL legacy/false branches are DEAD CODE and MUST
//       NOT be ported (porting them re-introduces dormant optionality — a remove-rollout-scaffolding
//       violation; the gap-synth's "introduce 24 gates" recommendation is OVERRIDDEN by this ledger).
//
//   TS introduces its OWN `patched()` ONLY when a future TS deploy changes the TS workflow body in a way
//   that breaks in-flight TS replay (a genuine in-flight TS migration). That is the only legitimate future
//   use — keyed on TS histories, never carried over from the Python markers below.
//
//   COUPLED GROUPS (plan §3): some markers are interdependent (config+policy+persist; Phase-B static
//   analysis; confluence cluster; enrich→confluence bridge; repo-path retirement; output-safety emit pair).
//   Collapsing one without its partners breaks DATAFLOW/QUALITY (not replay — TS has no history). The
//   `coupledGroup` field records each marker's atomic-port unit so a stage implementer ports the whole
//   group together. EMPTY string = not part of a coupled group.
//
// SANDBOX SAFETY (ADR-0065/0066): pure frozen data. NO node:crypto / uuid / clock / RNG / timers.

/** The stage (per the full-port plan §6) where each collapsed gate's straight-line code is ported. */
export type PortStage = 1 | 2 | 3 | 4 | 5;

/** One ledger entry. `disposition` is always "collapse-on" at this port (no gate collapses to its FALSE
 *  branch — the false branches are all legacy in-flight-replay paths with no TS history to serve). */
export type CollapsedGateEntry = {
  /** The Python marker string passed to workflow.patched()/deprecate_patch(). */
  readonly marker: string;
  /** Always "collapse-on": the current-prod (true) branch becomes straight-line TS. */
  readonly disposition: "collapse-on";
  /** The plan stage that ports this gate's straight-line code. */
  readonly portedInStage: PortStage;
  /** The coupled-port group (plan §3) this marker belongs to; "" when standalone. */
  readonly coupledGroup: string;
  /** Whether the Python expressed this as deprecate_patch() (the final retirement-lifecycle step) rather
   *  than patched(). Informational only — both collapse identically in the historyless TS port. */
  readonly viaDeprecatePatch: boolean;
  /** One-line note on what the collapsed straight-line code does. */
  readonly note: string;
};

export const COLLAPSED_GATES = Object.freeze({
  // ── config + policy + persist (coupled group) ────────────────────────────────────────────────
  "repo-config-wiring": {
    marker: "repo-config-wiring",
    disposition: "collapse-on",
    portedInStage: 1,
    coupledGroup: "config+policy+persist",
    viaDeprecatePatch: false,
    note: "Load .codemaster.yaml once (load_repo_config) and publish into state.repoConfig; also gates the config-change notice append.",
  },
  "policy-engine-wiring": {
    marker: "policy-engine-wiring",
    disposition: "collapse-on",
    portedInStage: 5,
    coupledGroup: "config+policy+persist",
    viaDeprecatePatch: false,
    note: "compute_policy_rules populates state.policyBundles; per-chunk closure reads policyBundles.get(path).",
  },
  "persist-input-v2": {
    marker: "persist-input-v2",
    disposition: "collapse-on",
    portedInStage: 5,
    coupledGroup: "config+policy+persist",
    viaDeprecatePatch: false,
    note: "persist_review_findings takes the typed PersistReviewFindingsInputV1 with the policy bundle as a member (not positional).",
  },
  "policy-post-filter-relocated": {
    marker: "policy-post-filter-relocated",
    disposition: "collapse-on",
    portedInStage: 5,
    coupledGroup: "config+policy+persist",
    viaDeprecatePatch: false,
    note: "Inline pre-persist post-filter captures per-finding metadata into state.inlinePostFilterMetadata; persist bypasses its own re-filter (R-23).",
  },

  // ── Phase-B static analysis (coupled group) ──────────────────────────────────────────────────
  "static-analysis-orchestrator-v2": {
    marker: "static-analysis-orchestrator-v2",
    disposition: "collapse-on",
    portedInStage: 5,
    coupledGroup: "Phase-B static-analysis",
    viaDeprecatePatch: false,
    note: "Orchestrator threads tier1_findings/tool_statuses from static_analysis into the fan-out.",
  },
  "tier2-linter-aware-prompt": {
    marker: "tier2-linter-aware-prompt",
    disposition: "collapse-on",
    portedInStage: 5,
    coupledGroup: "Phase-B static-analysis",
    viaDeprecatePatch: false,
    note: "ReviewContextV1 built with tier1_findings + tool_statuses populated; prompt renders the linter-aware section.",
  },
  "bedrock-review-chunk-envelope": {
    marker: "bedrock-review-chunk-envelope",
    disposition: "collapse-on",
    portedInStage: 5,
    coupledGroup: "Phase-B static-analysis",
    viaDeprecatePatch: false,
    note: "bedrock_review_chunk returns the typed ReviewChunkResponseV1 envelope (re-validate the dict).",
  },

  // ── confluence cluster (coupled group; AND-gated; DELETE the MVP per-chunk fallback) ──────────
  "confluence-pr-context-manifests": {
    marker: "confluence-pr-context-manifests",
    disposition: "collapse-on",
    portedInStage: 4,
    coupledGroup: "confluence cluster",
    viaDeprecatePatch: false,
    note: "PR-context manifests keyed off enrich-pr-files-v2.files.",
  },
  "confluence-label-routing": {
    marker: "confluence-label-routing",
    disposition: "collapse-on",
    portedInStage: 4,
    coupledGroup: "confluence cluster",
    viaDeprecatePatch: false,
    note: "Confluence label-routing keyed off enrich-pr-files-v2.files.",
  },
  "manifest-dependency-parsing": {
    marker: "manifest-dependency-parsing",
    disposition: "collapse-on",
    portedInStage: 4,
    coupledGroup: "confluence cluster",
    viaDeprecatePatch: false,
    note: "Parse manifest dependencies (ecosystem parsers) keyed off enrich-pr-files-v2.files.",
  },
  "confluence-pr-context-full-pr": {
    marker: "confluence-pr-context-full-pr",
    disposition: "collapse-on",
    portedInStage: 4,
    coupledGroup: "confluence cluster",
    viaDeprecatePatch: false,
    note: "pick_pr_context(use_full=true) — the full-PR context builder; DELETE the per-chunk MVP fallback (FOLLOW-UP-retire-pr-context-mvp-helper).",
  },

  // ── enrich → confluence bridge (port enrich-v2 FIRST; it is the cluster's data source) ────────
  "enrich-pr-files-v2": {
    marker: "enrich-pr-files-v2",
    disposition: "collapse-on",
    portedInStage: 4,
    coupledGroup: "enrich→confluence bridge",
    viaDeprecatePatch: false,
    note: "enrich_pr_files_v2 is the data source for the confluence cluster — port FIRST; drop the v1 enrich fallback.",
  },

  // ── repo-path retirement cohort ──────────────────────────────────────────────────────────────
  "repo-path-cutover": {
    marker: "repo-path-cutover",
    disposition: "collapse-on",
    portedInStage: 4,
    coupledGroup: "repo-path retirement cohort",
    viaDeprecatePatch: true,
    note: "Post-cutover: ClonedRepoV1.repo_path explicit; drop derived-path fallback. (Python expressed via deprecate_patch — the lifecycle's final step.)",
  },
  "citation-validate-activity": {
    marker: "citation-validate-activity",
    disposition: "collapse-on",
    portedInStage: 3,
    coupledGroup: "repo-path retirement cohort",
    viaDeprecatePatch: false,
    note: "Citation validation runs at its own activity boundary; drop the inline-citation fallback.",
  },

  // ── output-safety emit pair (coupled group) ──────────────────────────────────────────────────
  "output-safety-emit-chunk": {
    marker: "output-safety-emit-chunk",
    disposition: "collapse-on",
    portedInStage: 3,
    coupledGroup: "output-safety emit pair",
    viaDeprecatePatch: false,
    note: "Dispatch emit_output_safety_audit when the chunk envelope carries a sanitization_event.",
  },
  "output-safety-emit-walkthrough": {
    marker: "output-safety-emit-walkthrough",
    disposition: "collapse-on",
    portedInStage: 3,
    coupledGroup: "output-safety emit pair",
    viaDeprecatePatch: false,
    note: "Dispatch emit_output_safety_audit when the walkthrough envelope carries a sanitization_event.",
  },

  // ── standalone gates ─────────────────────────────────────────────────────────────────────────
  "pr-topology-manifest": {
    marker: "pr-topology-manifest",
    disposition: "collapse-on",
    portedInStage: 1,
    coupledGroup: "",
    viaDeprecatePatch: false,
    note: "Orchestrator builds the PR-topology manifest from selection.to_review and passes it to fan_out_review for per-chunk PR-level scope awareness (v8).",
  },
  "retrieval-knowledge-wiring": {
    marker: "retrieval-knowledge-wiring",
    disposition: "collapse-on",
    portedInStage: 1,
    coupledGroup: "",
    viaDeprecatePatch: false,
    note: "Per-chunk embed_query + retrieve_knowledge wired (fail-open via stageOutcome); populates state.queryVectorCache.",
  },
  "arbitration-layer": {
    marker: "arbitration-layer",
    disposition: "collapse-on",
    portedInStage: 5,
    coupledGroup: "",
    viaDeprecatePatch: false,
    note: "apply_arbitration routes Tier-1 findings + LLM intents through the suppression policy; populates state.arbitration.",
  },
  "analyzed-on-degraded-pipeline-result": {
    marker: "analyzed-on-degraded-pipeline-result",
    disposition: "collapse-on",
    portedInStage: 3,
    coupledGroup: "",
    viaDeprecatePatch: false,
    note: "ANALYZED lifecycle payload adds publication_outcome + the two separate degradation-note lists (_build_analyzed_payload patched branch).",
  },
  "persist-review-walkthrough": {
    marker: "persist-review-walkthrough",
    disposition: "collapse-on",
    portedInStage: 1,
    coupledGroup: "",
    viaDeprecatePatch: false,
    note: "Persist the walkthrough to core.review_walkthroughs via stageOutcome('persist_walkthrough') (fail-open).",
  },
  "fix-prompt-v1": {
    marker: "fix-prompt-v1",
    disposition: "collapse-on",
    portedInStage: 5,
    coupledGroup: "",
    viaDeprecatePatch: false,
    note: "After post_review, dispatch generate_fix_prompt (advisory copy-pasteable fix prompt; fail-open).",
  },
  "pr-mutex-lease-renewal": {
    marker: "pr-mutex-lease-renewal",
    disposition: "collapse-on",
    portedInStage: 2,
    coupledGroup: "",
    viaDeprecatePatch: false,
    note: "renew_pr_review_mutex_lease heartbeat during the chain (fail-open); release in finally.",
  },
  "prompt-budget-enforcement-v1": {
    marker: "prompt-budget-enforcement-v1",
    disposition: "collapse-on",
    portedInStage: 5,
    coupledGroup: "",
    viaDeprecatePatch: false,
    note: "Per-chunk prompt-token-budget enforcement before the bedrock_review_chunk dispatch.",
  },
  "walkthrough-cost-cap-synthesis": {
    marker: "walkthrough-cost-cap-synthesis",
    disposition: "collapse-on",
    portedInStage: 5,
    coupledGroup: "",
    viaDeprecatePatch: false,
    note: "Walkthrough synthesis honours the cost cap (degrades to a stub on budget exceed).",
  },
}) satisfies Readonly<Record<string, CollapsedGateEntry>>;

/** The exact count of Python markers this ledger accounts for. A failing assertion here means a marker was
 *  added/removed in the frozen Python without updating the ledger — the audit lever for gate drift. */
export const COLLAPSED_GATE_COUNT = 25 as const;
