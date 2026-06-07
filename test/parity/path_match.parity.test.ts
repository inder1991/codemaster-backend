import { afterAll, describe, expect, it } from "vitest";

import {
  pyFilterReviewPaths,
  pyGlobRegex,
  pyMatchesGlob,
  pyMatchPathInstructions,
  shutdownPathMatchRef,
  type PathInstructionDict,
} from "./path_match_oracle.js";
import {
  filterReviewPaths,
  globToRegexSource,
  matchesGlob,
  matchPathInstructions,
} from "#backend/config/path_match.js";
import { PathInstructionV1 } from "#contracts/codemaster_config.v1.js";

afterAll(() => {
  shutdownPathMatchRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// path_match parity (FIX #6+#9): prove the TS port of the frozen gitignore-style glob matcher is
// byte-equal to the source-of-truth (vendor/codemaster-py/codemaster/config/path_match.py). ONE
// matcher backs BOTH consumers — `path_instructions` (matchPathInstructions) AND `path_filters`
// (filterReviewPaths) — so a single corpus exercises:
//   * `**` (cross-segment), leading `/` (root anchor), trailing `/` (directory normalisation),
//     negation (`!` in path_filters), unanchored (gitignore "match anywhere"), plus `*`/`?` and the
//     ReviewFindingV1-style chunk-path edge cases (dotted names, nested dirs, regex-special chars).
//
// Two layers of evidence:
//   1. WHITE-BOX regex translation: globToRegexSource(pat) === _glob_to_regex(pat).pattern for every
//      pattern. This pins the EXACT translation, not just outcomes.
//   2. OUTCOME parity: matchesGlob / filterReviewPaths / matchPathInstructions agree with the frozen
//      Python over a broad path × pattern cross-product.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

// Pattern corpus spanning every glob feature + edge case.
const PATTERNS: ReadonlyArray<string> = [
  // ── ** cross-segment ──
  "src/**/c.py",
  "**/c.py",
  "**",
  "**/*.py",
  "foo/**/*.py",
  "foo/**bar.py", // mid-segment ** (no surrounding slashes) → `.*`
  "a**c",
  "a/**", // trailing /** → consumes slash → `a/.*`
  "/src/**",
  // ── leading / (root anchor) ──
  "/src/*.py",
  "/README.md",
  "/a/b/c.ts",
  // ── trailing / (directory normalisation) ──
  "docs/",
  "node_modules/",
  "a/b/", // multi-segment dir
  // ── * single-segment ──
  "*.py",
  "src/*.py",
  "src/m*n.ts",
  "*", // matches a single segment only
  // ── ? single char ──
  "a/?",
  "file?.ts",
  "v?.?.?",
  // ── literal / regex-special chars (must be re.escape'd, not interpreted) ──
  "weird[1].py",
  "a+b.py",
  "test.test.py",
  "a(b).py",
  "a|b.py",
  "a{b}.py",
  "a$b.py",
  "a^b.py",
  "a#b.ts", // # is in Python re.escape's special set
  "a~b.ts", // ~ is in Python re.escape's special set
  "with space.ts", // space is escaped by Python re.escape
  "café.py", // non-ASCII passthrough
  "a=b.py", // = is NOT escaped by Python re.escape
  "a:b.py", // : is NOT escaped
  "a@b.py", // @ is NOT escaped
  // ── plain literals + nested ──
  "README.md",
  "src/index.ts",
  ".codemaster.yaml",
];

// Path corpus — includes ReviewFindingV1-style chunk paths (the `path` a finding/chunk carries:
// repo-relative, nested, dotted, occasionally with regex-special bytes).
const PATHS: ReadonlyArray<string> = [
  "c.py",
  "src/c.py",
  "src/a/b/c.py",
  "src/a/b.py",
  "src/foo.py",
  "src/a/foo.py",
  "x/src/foo.py",
  "README.md",
  "docs/README.md",
  "docs",
  "docs/readme.md",
  "docs/sub/readme.md",
  "node_modules/pkg/index.js",
  "a/b",
  "a/bc",
  "a/x/c",
  "ab/c",
  "axxc",
  "foo/bar.py",
  "foo/x/bar.py",
  "foo.txt",
  "a/b/foo.txt",
  "",
  "test.test.py",
  "src/main.ts",
  "src/index.ts",
  "weird[1].py",
  "a+b.py",
  "a(b).py",
  "a|b.py",
  "a{b}.py",
  "a$b.py",
  "a^b.py",
  "a#b.ts",
  "a~b.ts",
  "with space.ts",
  "café.py",
  "a=b.py",
  "a:b.py",
  "a@b.py",
  "file1.ts",
  "fileX.ts",
  "v1.2.3",
  "a/b/c.ts",
  ".codemaster.yaml",
  "deep/nested/dir/structure/file.py",
];

// JS `RegExp.source` escapes a literal forward-slash as `\/` (since `/` delimits a JS regex literal);
// Python's `re.Pattern.pattern` keeps it bare. That `\/`-vs-`/` difference is a SERIALIZATION artifact
// only — `\/` and `/` are semantically identical inside a regex, and the outcome-parity suite below
// proves the COMPILED regexes match identically. Normalize the JS source's `\/` → `/` so the white-box
// comparison pins the translation logic (the `.*` / `[^/]*` / `[^/]` / escape decisions) without
// tripping on the cross-language delimiter-escaping convention.
function normalizeRegexSource(source: string): string {
  return source.replace(/\\\//gu, "/");
}

describe("path_match — white-box regex translation parity", () => {
  it.each(PATTERNS)("globToRegexSource(%j) === frozen _glob_to_regex(...).pattern", async (pat) => {
    const ts = normalizeRegexSource(globToRegexSource(pat));
    const py = await pyGlobRegex(pat);
    expect(ts).toBe(py);
  });
});

describe("path_match — matchesGlob outcome parity (path × pattern cross-product)", () => {
  for (const pattern of PATTERNS) {
    it(`pattern ${JSON.stringify(pattern)} matches identically across all paths`, async () => {
      const tsResults = PATHS.map((path) => matchesGlob({ path, pattern }));
      const pyResults = await Promise.all(PATHS.map((path) => pyMatchesGlob(path, pattern)));
      expect(tsResults).toEqual(pyResults);
    });
  }
});

describe("path_match — filterReviewPaths parity (negation, anchoring, last-match-wins)", () => {
  // path_filters scenarios: include-only (allow-list), exclude-only (deny-list), mixed last-match,
  // empty (keep-all), negation precedence, and the anchored-vs-unanchored divergence (filters are
  // root-anchored; the bare matcher is not).
  const FILTER_SCENARIOS: ReadonlyArray<ReadonlyArray<string>> = [
    [], // empty → keep all (back-compat)
    ["**/*.py"], // include-only allow-list
    ["!dist/**"], // exclude-only deny-list
    ["src/**", "!**/dist/**"], // mixed: include src, then carve out dist anywhere
    ["src/**", "!src/generated/**", "src/generated/keep.py"], // last-match-wins re-include
    ["!drop.py"],
    ["y.py"], // anchored: only top-level y.py (NOT x/y.py)
    ["**/y.py"], // ** re-enables nested match
    ["docs/"], // trailing-slash dir filter (anchored)
    ["*.py"], // single-segment include (anchored → top-level only)
    ["!*.md", "README.md"], // exclude all md, re-include one
  ];
  const FILTER_PATHS: ReadonlyArray<string> = [
    "a.py",
    "b.js",
    "dist/x.js",
    "src/a.py",
    "src/dist/y.py",
    "src/generated/gen.py",
    "src/generated/keep.py",
    "keep.py",
    "drop.py",
    "x/y.py",
    "y.py",
    "docs/a.md",
    "docs/b.md",
    "src/c.py",
    "README.md",
    "CHANGELOG.md",
  ];

  it.each(FILTER_SCENARIOS.map((f, i) => [i, f] as const))(
    "filterReviewPaths scenario #%i parity",
    async (_i, filters) => {
      const ts = filterReviewPaths(FILTER_PATHS, filters);
      const py = await pyFilterReviewPaths(FILTER_PATHS, filters);
      expect(ts).toEqual(py);
    },
  );
});

describe("path_match — matchPathInstructions parity (declaration order, ADR-0001)", () => {
  // The helper the workflow body uses to build ReviewContextV1.matched_path_instructions. Verify:
  // empty rules → [], single/multi match in declaration order, leading-/ anchored rule, no-match.
  const RULES: ReadonlyArray<PathInstructionDict> = [
    { path: "src/**/*.py", instructions: "python files in src" },
    { path: "*.md", instructions: "all markdown" },
    { path: "/README.md", instructions: "root readme only" },
    { path: "**/*.ts", instructions: "all typescript anywhere" },
    { path: "docs/", instructions: "docs directory itself" },
  ];
  const CHUNK_PATHS: ReadonlyArray<string> = [
    "src/a/b.py",
    "README.md",
    "docs/README.md",
    "src/x.md",
    "lib/util.ts",
    "src/deep/util.ts",
    "docs",
    "nothing/matches/here.rb",
    "",
  ];

  it("empty rules → [] for any path", async () => {
    expect(matchPathInstructions([], "src/a.py")).toEqual([]);
    expect(await pyMatchPathInstructions([], "src/a.py")).toEqual([]);
  });

  it.each(CHUNK_PATHS)("chunk path %j matches the same rules in declaration order", async (p) => {
    const ts = matchPathInstructions(RULES, p).map((r) => ({
      path: r.path,
      instructions: r.instructions,
    }));
    const py = await pyMatchPathInstructions(RULES, p);
    expect(ts).toEqual(py);
  });

  it("returns validated PathInstructionV1 instances usable downstream", () => {
    const matched = matchPathInstructions(RULES, "src/a/b.py");
    expect(matched.length).toBeGreaterThan(0);
    // Each returned element is the original contract instance — re-parse to confirm shape integrity.
    for (const m of matched) {
      expect(() => PathInstructionV1.parse(m)).not.toThrow();
    }
  });
});
