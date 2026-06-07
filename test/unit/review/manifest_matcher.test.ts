// Unit tests for manifest_matcher.matchPath — 1:1 with the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_matcher.py::match_path.
// Pure function; the expectations are transcribed directly from the Python tier tables + match logic.

import { describe, expect, it } from "vitest";

import { ALL_PATTERNS, matchPath } from "#backend/review/manifest_matcher.js";

describe("matchPath — Tier 1/2 exact + suffix basenames", () => {
  it.each([
    ["pyproject.toml", "python", false],
    ["requirements.txt", "python", false],
    ["Pipfile.lock", "python", true],
    ["package.json", "node", false],
    ["package-lock.json", "node", true],
    ["pnpm-lock.yaml", "node", true],
    ["go.mod", "go", false],
    ["go.sum", "go", true],
    ["Cargo.toml", "rust", false],
    ["Cargo.lock", "rust", true],
    ["Gemfile", "ruby", false],
    ["pom.xml", "java", false],
    ["build.gradle.kts", "gradle", false],
    ["composer.json", "php", false],
    ["poetry.lock", "python", true],
    ["Dockerfile", "docker", false],
  ])("%s → ecosystem=%s is_lockfile=%s", (path, ecosystem, isLockfile) => {
    const m = matchPath(path);
    expect(m).not.toBeNull();
    expect(m!.ecosystem).toBe(ecosystem);
    expect(m!.is_lockfile).toBe(isLockfile);
  });

  it("matches a .csproj by SUFFIX (kind=suffix, ecosystem=dotnet)", () => {
    const m = matchPath("api.csproj");
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("suffix");
    expect(m!.ecosystem).toBe("dotnet");
  });

  it("rejects a BARE `.csproj` (no name prefix — a real project always has a name)", () => {
    expect(matchPath(".csproj")).toBeNull();
  });
});

describe("matchPath — monorepo subdirectory paths match by basename", () => {
  it.each([
    "services/api/package.json",
    "src/foo/build.gradle.kts",
    "backend/pyproject.toml",
    "/pyproject.toml", // leading slash → basename still resolves
  ])("%s matches via its basename", (path) => {
    expect(matchPath(path)).not.toBeNull();
  });

  it("a deeply-nested .csproj matches by suffix", () => {
    expect(matchPath("services/api/Api.csproj")?.ecosystem).toBe("dotnet");
  });
});

describe("matchPath — Tier 3 exclusions (vendored noise)", () => {
  it.each([
    "vendor/foo/package.json",
    "node_modules/foo/package.json",
    "third_party/lib/go.mod",
    "deps/node_modules/foo/package.json", // nested vendor dir
    "src/vendor/pyproject.toml",
  ])("%s is rejected even though the basename matches", (path) => {
    expect(matchPath(path)).toBeNull();
  });
});

describe("matchPath — non-manifests and edge cases", () => {
  it.each(["", "src/app.ts", "README.md", "Makefile", "config.yaml", "foo/bar"])(
    "%s → null (not a manifest)",
    (path) => {
      expect(matchPath(path)).toBeNull();
    },
  );

  it("the registry has the expected count (20 Tier-1 + 10 Tier-2 = 30)", () => {
    expect(ALL_PATTERNS.length).toBe(30);
  });
});
