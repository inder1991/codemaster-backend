// Unit tests for the detection pipeline + computeEffectiveLabels — ports of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/label_detection.py::detect_labels
//   vendor/codemaster-py/codemaster/retrieval/effective_labels.py::compute_effective_labels
//
// Tier-1 PARITY: every DETECTED / Cn fixture below was extracted by running the frozen Python
// `detect_labels` / `compute_effective_labels` directly against the same inputs (see inline PARITY
// comments capturing the Python output). Pure-function tests — no DB.

import { describe, expect, it } from "vitest";

import { computeEffectiveLabels } from "#backend/retrieval/effective_labels.js";
import { DETECTION_PIPELINE_VERSION, detectLabels } from "#backend/retrieval/label_detection.js";

import { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import { PRContext } from "#contracts/pr_context.v1.js";

const SHA = "a".repeat(40);
const PR_ID = "00000000-0000-0000-0000-000000000001";

/** Build a parsed PRContext from changed-file paths + optional manifests. */
function prContext(args: {
  paths?: ReadonlyArray<string>;
  manifests?: ReadonlyArray<{
    path: string;
    deps?: ReadonlyArray<string>;
    records?: ReadonlyArray<{ name: string; type?: string }>;
  }>;
}): PRContext {
  return PRContext.parse({
    pr_id: PR_ID,
    head_sha: SHA,
    changed_files: (args.paths ?? []).map((p) => ({ path: p, additions: 1, deletions: 0 })),
    manifests: (args.manifests ?? []).map((m) => ({
      path: m.path,
      parsed_dependencies: m.deps ?? [],
      parsed_dependency_records: (m.records ?? []).map((r) => ({
        ecosystem: "pip",
        name: r.name,
        dependency_type: r.type ?? "unknown",
        source_manifest: m.path,
      })),
    })),
    repo_default_branch: "main",
  });
}

/** Build a parsed CodemasterConfigV1 with confluence include/exclude raw labels (canonicalized at parse). */
function config(inc: ReadonlyArray<string> = [], exc: ReadonlyArray<string> = []): CodemasterConfigV1 {
  return CodemasterConfigV1.parse({
    knowledge: { confluence: { include_labels: inc, exclude_labels: exc } },
  });
}

describe("detectLabels (two-stage detection pipeline)", () => {
  it("DETECTION_PIPELINE_VERSION is 1", () => {
    expect(DETECTION_PIPELINE_VERSION).toBe(1);
  });

  it("unions language + framework + infra emissions, skipping vendored/generated files", () => {
    const ctx = prContext({
      paths: [
        "src/app.py",
        "web/page.tsx",
        "node_modules/lib/x.js", // vendored → skipped by language detector
        "api/service.pb.go", // generated → skipped by language detector
        "deploy/Chart.yaml",
        "infra/main.tf",
      ],
      manifests: [
        { path: "package.json", deps: ["react", "express", "UNKNOWNLIB"] },
        { path: "requirements.txt", records: [{ name: "fastapi", type: "prod" }] },
      ],
    });
    const [detected, byDetector] = detectLabels(ctx);
    // PARITY: Python DETECTED.
    expect([...detected].sort()).toEqual([
      "default",
      "framework:express",
      "framework:fastapi",
      "framework:react",
      "infra:helm",
      "infra:terraform",
      "lang:python",
      "lang:typescript",
    ]);
    // PARITY: per-detector breakdown.
    expect([...(byDetector.get("framework") ?? new Set())].sort()).toEqual([
      "framework:express",
      "framework:fastapi",
      "framework:react",
    ]);
    expect([...(byDetector.get("infra") ?? new Set())].sort()).toEqual([
      "infra:helm",
      "infra:terraform",
    ]);
    expect([...(byDetector.get("language") ?? new Set())].sort()).toEqual([
      "lang:python",
      "lang:typescript",
    ]);
  });

  it("always includes 'default' even with no changed files", () => {
    const [detected] = detectLabels(prContext({}));
    expect([...detected]).toEqual(["default"]);
  });

  it("a dotfile has no language suffix (Python pathlib semantics)", () => {
    const [detected] = detectLabels(prContext({ paths: [".gitignore"] }));
    expect([...detected]).toEqual(["default"]);
  });
});

describe("computeEffectiveLabels (restrictive-only resolution)", () => {
  // detected over (src/app.py + web/page.tsx) = {default, lang:python, lang:typescript}.
  const ctx = prContext({ paths: ["src/app.py", "web/page.tsx"] });
  const PLATFORM = new Set([
    "default",
    "lang:python",
    "lang:typescript",
    "topic:security_policy",
    "framework:react",
  ]);

  it("C1: no include/exclude → base = detected ∩ platform", () => {
    const [eff] = computeEffectiveLabels({ prContext: ctx, yamlConfig: config(), platformExposedLabels: PLATFORM });
    // PARITY C1.
    expect([...eff].sort()).toEqual(["default", "lang:python", "lang:typescript"]);
  });

  it("C2: legal include (on platform ceiling, not detected) is added", () => {
    const [eff] = computeEffectiveLabels({
      prContext: ctx,
      yamlConfig: config(["security_policy"]), // canonicalizes → topic:security_policy
      platformExposedLabels: PLATFORM,
    });
    // PARITY C2.
    expect([...eff].sort()).toEqual([
      "default",
      "lang:python",
      "lang:typescript",
      "topic:security_policy",
    ]);
  });

  it("C3: illegal include (NOT on platform ceiling) is dropped", () => {
    const [eff] = computeEffectiveLabels({
      prContext: ctx,
      yamlConfig: config(["compliance"]), // canonicalizes → topic:compliance, NOT on PLATFORM
      platformExposedLabels: PLATFORM,
    });
    // PARITY C3: dropped → identical to C1.
    expect([...eff].sort()).toEqual(["default", "lang:python", "lang:typescript"]);
  });

  it("C4: exclude removes a detected label", () => {
    const [eff] = computeEffectiveLabels({
      prContext: ctx,
      yamlConfig: config([], ["python"]), // canonicalizes → lang:python
      platformExposedLabels: PLATFORM,
    });
    // PARITY C4.
    expect([...eff].sort()).toEqual(["default", "lang:typescript"]);
  });

  it("C5: a restrictive platform ceiling narrows the base set", () => {
    const [eff] = computeEffectiveLabels({
      prContext: ctx,
      yamlConfig: config(),
      platformExposedLabels: new Set(["default"]),
    });
    // PARITY C5.
    expect([...eff].sort()).toEqual(["default"]);
  });

  it("C6: include + exclude of the same label → exclude wins", () => {
    const [eff] = computeEffectiveLabels({
      prContext: ctx,
      yamlConfig: config(["security_policy"], ["security_policy"]),
      platformExposedLabels: PLATFORM,
    });
    // PARITY C6: topic:security_policy added by include then removed by exclude.
    expect([...eff].sort()).toEqual(["default", "lang:python", "lang:typescript"]);
  });

  it("returns the per-detector breakdown alongside the effective set", () => {
    const [, byDetector] = computeEffectiveLabels({
      prContext: ctx,
      yamlConfig: config(),
      platformExposedLabels: PLATFORM,
    });
    expect([...(byDetector.get("language") ?? new Set())].sort()).toEqual([
      "lang:python",
      "lang:typescript",
    ]);
  });
});
