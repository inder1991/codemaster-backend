// Manifest path matcher — 1:1 TS port of the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_matcher.py
//   (FOLLOW-UP-confluence-pr-context-manifests Commit 2).
//
// Pure module: maps a repo-relative path to a {@link ManifestPattern} (or null) so the
// fetch_manifest_snapshots activity knows which paths to fetch and which ecosystem they belong to.
// NO I/O, NO async. Sandbox-safe (used inside the activity, not the workflow body).
//
// Patterns are declared in priority order (root-relevant exact matches first, then suffix patterns, then
// lockfiles last). The activity's prioritizer reads `is_lockfile` to drop lockfiles when the token
// budget binds.
//
// Monorepo correctness: paths like `services/api/package.json` or `src/foo/build.gradle.kts` MUST match.
// The matcher walks the basename (everything after the last `/`) so subdirectory paths work transparently.
//
// Tier 3 exclusion: any path containing `vendor/`, `node_modules/`, or `third_party/` is rejected
// regardless of basename match. Vendored dependencies are noise.

/** Python `Literal["exact", "suffix"]`. */
export type ManifestPatternKind = "exact" | "suffix";

/**
 * One manifest path pattern + ecosystem + lockfile flag (1:1 with the Python `ManifestPattern` frozen
 * dataclass). `kind` is `"exact"` (basename equality) or `"suffix"` (basename endswith). `ecosystem` is
 * the inferred language/runtime/build-system. `is_lockfile` flags pinning artifacts that drop priority
 * under budget rationing (manifests describing intent win over lockfiles describing resolution).
 */
export type ManifestPattern = {
  readonly kind: ManifestPatternKind;
  readonly pattern: string;
  readonly ecosystem: string | null;
  readonly is_lockfile: boolean;
};

function pattern(
  kind: ManifestPatternKind,
  pat: string,
  ecosystem: string | null,
  is_lockfile = false,
): ManifestPattern {
  return { kind, pattern: pat, ecosystem, is_lockfile };
}

// ─── Tier 1 — MUST support in v1 (high-signal, common, cheap) — 22 patterns ───────────────────────
export const TIER_1_PATTERNS: ReadonlyArray<ManifestPattern> = [
  // Python
  pattern("exact", "pyproject.toml", "python"),
  pattern("exact", "requirements.txt", "python"),
  pattern("exact", "requirements-dev.txt", "python"),
  pattern("exact", "Pipfile", "python"),
  pattern("exact", "Pipfile.lock", "python", true),
  // Node / JavaScript / TypeScript
  pattern("exact", "package.json", "node"),
  pattern("exact", "package-lock.json", "node", true),
  pattern("exact", "yarn.lock", "node", true),
  pattern("exact", "pnpm-lock.yaml", "node", true),
  // Go
  pattern("exact", "go.mod", "go"),
  pattern("exact", "go.sum", "go", true),
  // Rust
  pattern("exact", "Cargo.toml", "rust"),
  pattern("exact", "Cargo.lock", "rust", true),
  // Ruby
  pattern("exact", "Gemfile", "ruby"),
  pattern("exact", "Gemfile.lock", "ruby", true),
  // Java (Maven)
  pattern("exact", "pom.xml", "java"),
  // Gradle (Java/Kotlin/Android)
  pattern("exact", "build.gradle", "gradle"),
  pattern("exact", "build.gradle.kts", "gradle"),
  // PHP (Composer)
  pattern("exact", "composer.json", "php"),
  pattern("exact", "composer.lock", "php", true),
];

// ─── Tier 2 — Strongly recommended — 10 patterns ──────────────────────────────────────────────────
export const TIER_2_PATTERNS: ReadonlyArray<ManifestPattern> = [
  // Python — Poetry
  pattern("exact", "poetry.lock", "python", true),
  // .NET
  pattern("exact", "Directory.Packages.props", "dotnet"),
  pattern("suffix", ".csproj", "dotnet"),
  // Elixir
  pattern("exact", "mix.exs", "elixir"),
  pattern("exact", "mix.lock", "elixir", true),
  // Bazel
  pattern("exact", "WORKSPACE", "bazel"),
  pattern("exact", "MODULE.bazel", "bazel"),
  // Docker (high-signal context for runtime + build env)
  pattern("exact", "Dockerfile", "docker"),
  pattern("exact", "docker-compose.yml", "docker"),
  pattern("exact", "compose.yaml", "docker"),
];

export const ALL_PATTERNS: ReadonlyArray<ManifestPattern> = [...TIER_1_PATTERNS, ...TIER_2_PATTERNS];

// ─── Tier 3 — explicit exclusion (path-segment substrings) ────────────────────────────────────────
export const EXCLUDED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "vendor/",
  "node_modules/",
  "third_party/",
]);

/**
 * Return the first matching {@link ManifestPattern} for `path`, or null if it is not a manifest OR is in
 * a Tier-3 excluded segment (1:1 with the Python `match_path`). Tier-3 exclusion runs FIRST (a vendored
 * `package.json` is rejected immediately). Pure function — determined entirely by the input string.
 */
export function matchPath(path: string): ManifestPattern | null {
  if (path === "") {
    return null;
  }
  // Tier 3 rejection: substring match on path-segment prefixes (catches nested vendor dirs).
  for (const excluded of EXCLUDED_PATH_SEGMENTS) {
    if (path.includes(excluded)) {
      return null;
    }
  }
  // Walk to the basename (everything after the last "/").
  const slash = path.lastIndexOf("/");
  const basename = slash >= 0 ? path.slice(slash + 1) : path;
  if (basename === "") {
    return null;
  }
  for (const pat of ALL_PATTERNS) {
    if (pat.kind === "exact" && basename === pat.pattern) {
      return pat;
    }
    // Suffix match against the BASENAME so `api.csproj` matches `.csproj` but the bare `.csproj` (no
    // name prefix) falls through — a real .NET project always has a name.
    if (pat.kind === "suffix" && basename.endsWith(pat.pattern) && basename !== pat.pattern) {
      return pat;
    }
  }
  return null;
}
