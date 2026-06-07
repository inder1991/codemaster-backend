// Unit test for the collapsed-gate ledger (gates.ts). The ledger is a documentation constant, so the test
// asserts its INTEGRITY: it accounts for exactly the 25 frozen-Python markers, every entry is collapse-on,
// every entry names a real plan stage + a coupled group (or "" standalone), and the marker key matches the
// entry's `marker` field. This is the audit lever for gate drift — if a marker is added/removed in the
// frozen Python without updating the ledger, COLLAPSED_GATE_COUNT / the set assertions fail.
import { describe, it, expect } from "vitest";

import { COLLAPSED_GATES, COLLAPSED_GATE_COUNT } from "#backend/review/pipeline/gates.js";

// The 25 markers transcribed from the frozen Python (review_pull_request.py +
// review_pipeline_orchestrator.py): all workflow.patched("...") + the one deprecate_patch("repo-path-cutover")
// + the multiline-string-arg confluence-pr-context-full-pr. Cross-checked by
// `grep -rEoh 'patched\(\s*"[^"]*"' ... | sort -u` (+ the two the simple grep misses).
const PYTHON_MARKERS = new Set<string>([
  "analyzed-on-degraded-pipeline-result",
  "arbitration-layer",
  "bedrock-review-chunk-envelope",
  "citation-validate-activity",
  "confluence-label-routing",
  "confluence-pr-context-full-pr",
  "confluence-pr-context-manifests",
  "enrich-pr-files-v2",
  "fix-prompt-v1",
  "manifest-dependency-parsing",
  "output-safety-emit-chunk",
  "output-safety-emit-walkthrough",
  "persist-input-v2",
  "persist-review-walkthrough",
  "policy-engine-wiring",
  "policy-post-filter-relocated",
  "pr-mutex-lease-renewal",
  "pr-topology-manifest",
  "prompt-budget-enforcement-v1",
  "repo-config-wiring",
  "repo-path-cutover",
  "retrieval-knowledge-wiring",
  "static-analysis-orchestrator-v2",
  "tier2-linter-aware-prompt",
  "walkthrough-cost-cap-synthesis",
]);

describe("COLLAPSED_GATES ledger — integrity", () => {
  it("accounts for exactly the 25 frozen-Python markers", () => {
    expect(PYTHON_MARKERS.size).toBe(25);
    expect(COLLAPSED_GATE_COUNT).toBe(25);
    expect(Object.keys(COLLAPSED_GATES).length).toBe(25);
  });

  it("ledger keys are exactly the frozen-Python marker set (no drift either direction)", () => {
    const ledgerKeys = new Set(Object.keys(COLLAPSED_GATES));
    expect([...ledgerKeys].sort()).toEqual([...PYTHON_MARKERS].sort());
  });

  it("every entry's key matches its marker field", () => {
    for (const [key, entry] of Object.entries(COLLAPSED_GATES)) {
      expect(entry.marker).toBe(key);
    }
  });

  it("every entry collapses ON (no false-branch collapse — TS has no in-flight histories)", () => {
    for (const entry of Object.values(COLLAPSED_GATES)) {
      expect(entry.disposition).toBe("collapse-on");
    }
  });

  it("every entry names a valid plan stage (1..5)", () => {
    for (const entry of Object.values(COLLAPSED_GATES)) {
      expect(entry.portedInStage).toBeGreaterThanOrEqual(1);
      expect(entry.portedInStage).toBeLessThanOrEqual(5);
    }
  });

  it("only repo-path-cutover is flagged viaDeprecatePatch (the lifecycle's final step)", () => {
    const deprecated = Object.values(COLLAPSED_GATES)
      .filter((e) => e.viaDeprecatePatch)
      .map((e) => e.marker);
    expect(deprecated).toEqual(["repo-path-cutover"]);
  });

  it("the six coupled groups are present and named", () => {
    const groups = new Set(
      Object.values(COLLAPSED_GATES)
        .map((e) => e.coupledGroup)
        .filter((g) => g !== ""),
    );
    expect(groups).toEqual(
      new Set([
        "config+policy+persist",
        "Phase-B static-analysis",
        "confluence cluster",
        "enrich→confluence bridge",
        "repo-path retirement cohort",
        "output-safety emit pair",
      ]),
    );
  });

  it("the ledger object is frozen (immutable documentation constant)", () => {
    expect(Object.isFrozen(COLLAPSED_GATES)).toBe(true);
  });
});
