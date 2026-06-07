// Unit tests for the common-root-manifest candidate seeding (EXCEEDS the frozen Python, which passes
// only changed_paths). Pure function — no I/O — so it runs in validate-fast even though the workflow body
// it feeds does not.

import { describe, expect, it } from "vitest";

import {
  buildManifestCandidatePaths,
  COMMON_ROOT_MANIFESTS,
} from "#backend/review/manifest_candidates.js";

describe("buildManifestCandidatePaths", () => {
  it("appends every common root manifest when none were changed", () => {
    const out = buildManifestCandidatePaths(["src/app.ts", "README.md"]);
    for (const m of COMMON_ROOT_MANIFESTS) {
      expect(out).toContain(m);
    }
  });

  it("preserves the changed paths first, in their original order", () => {
    const changed = ["services/api/handler.ts", "src/app.ts"];
    const out = buildManifestCandidatePaths(changed);
    expect(out.slice(0, changed.length)).toEqual(changed);
  });

  it("does not duplicate a root manifest that was itself changed", () => {
    const out = buildManifestCandidatePaths(["package.json", "src/app.ts"]);
    expect(out.filter((p) => p === "package.json")).toHaveLength(1);
    // the other root manifests are still appended
    expect(out).toContain("go.mod");
  });

  it("seeds only PRIMARY parseable manifests (no lockfiles)", () => {
    // lockfiles are large + redundant with the primary manifest; the parsers turn primary manifests into
    // dependency records, so those are what we seed.
    expect(COMMON_ROOT_MANIFESTS).not.toContain("package-lock.json");
    expect(COMMON_ROOT_MANIFESTS).not.toContain("Cargo.lock");
    expect(COMMON_ROOT_MANIFESTS).not.toContain("go.sum");
    expect(COMMON_ROOT_MANIFESTS).toContain("package.json");
    expect(COMMON_ROOT_MANIFESTS).toContain("go.mod");
  });

  it("returns a stable result for an empty changed set (just the root manifests)", () => {
    expect(buildManifestCandidatePaths([])).toEqual([...COMMON_ROOT_MANIFESTS]);
  });
});
