/**
 * Common root-manifest seeding for the `fetch_manifest_snapshots` candidate set.
 *
 * EXCEEDS the frozen Python: `review_pull_request.py:953` passes `candidate_paths=changed_paths` ONLY, so
 * a PR whose changed files are not themselves manifests depends entirely on the GitHub Tree-API
 * nearest-walk to discover the enclosing manifest — and that walk returns `[]` on any tree fetch failure
 * or >100k-entry truncation (large monorepos). When that happens, the repo's top-level dependency context
 * disappears from the review silently.
 *
 * Seeding the common root manifests as DIRECT candidates makes root-level dependency context independent
 * of the Tree API: the nearest-walk becomes a pure enhancement on top of an always-present root baseline.
 *
 * Sandbox-safe: pure string logic (no clock / random / crypto / node builtins), so the workflow body can
 * import it inside the V8 isolate.
 */

/**
 * The PRIMARY (non-lockfile) root manifests the dependency parsers can turn into records — kept in sync
 * with the `PARSER_TABLE` primary entries in
 * `apps/backend/src/activities/parse_manifest_dependencies.activity.ts`. Lockfiles (package-lock.json,
 * Cargo.lock, go.sum, …) are intentionally excluded: they are large, redundant with the primary manifest,
 * and a wasted fetch when seeded blindly at the root.
 */
export const COMMON_ROOT_MANIFESTS: ReadonlyArray<string> = [
  "package.json", // node
  "pyproject.toml", // python
  "requirements.txt", // python
  "Pipfile", // python
  "go.mod", // go
  "Cargo.toml", // rust
  "composer.json", // php
];

/**
 * Union the changed paths with {@link COMMON_ROOT_MANIFESTS}. Changed paths keep their original order and
 * come FIRST (so the activity's priority sort still ranks changed/root-changed manifests ahead of the
 * appended root fallbacks); a root manifest that was itself changed is not duplicated.
 */
export function buildManifestCandidatePaths(changedPaths: ReadonlyArray<string>): Array<string> {
  const seen = new Set<string>(changedPaths);
  const out = [...changedPaths];
  for (const manifest of COMMON_ROOT_MANIFESTS) {
    if (!seen.has(manifest)) {
      seen.add(manifest);
      out.push(manifest);
    }
  }
  return out;
}
