// path_match — 1:1 port of the frozen Python
// codemaster/config/path_match.py (Sprint 10 / S10.0.1 gitignore-style glob matcher).
//
// ONE matcher backs BOTH consumers:
//   1. ADR-0001 per-glob `path_instructions` — `matchPathInstructions(rules, path)` returns every
//      `PathInstructionV1` whose `path` glob matches the chunk path, in declaration order. The
//      frozen workflow body (`review_pull_request.py::_review_chunk`) calls the Python original
//      `match_path_instructions(path=..., rules=_repo_config.path_instructions)` to populate
//      `ReviewContextV1.matched_path_instructions`.
//   2. `.codemaster.yaml::path_filters` — `filterReviewPaths(paths, pathFilters)` selects which
//      files are reviewed via gitignore last-match-wins (bare INCLUDES, '!'-prefixed EXCLUDES).
//
// Glob semantics (locked — see the Python module docstring):
//   * `**` — matches zero or more path segments (crosses `/`).
//   * `*`  — matches zero or more characters EXCEPT `/`.
//   * `?`  — matches exactly one character (not `/`).
//   * Trailing `/` not significant (stripped; treated as a directory match — see edge note below).
//   * Leading `/` is anchor-to-root; without it the match is unanchored (matches anywhere).
//   * Case-sensitive (gitignore default on linux).
//
// Byte-parity notes (vs the frozen Python `re` module):
//   * The translation walks the pattern char-by-char, emitting `.*` for `**`, `[^/]*` for `*`,
//     `[^/]` for `?`, and a faithful single-char `re.escape` for everything else. `**/` consumes a
//     trailing `/` so the pattern matches "any descendant" cleanly. This reproduces Python's regex
//     verbatim (verified against `_glob_to_regex(...).pattern` in the parity test).
//   * `escapeRegexChar` replicates Python `re.escape`'s EXACT special-char set (the 3.13/3.14
//     `_special_chars_map`: whitespace 9-13/32 plus `# $ & ( ) * + - . ? [ \ ] ^ { | } ~`). Every
//     other code point — including `/`, `=`, `:`, `@`, non-ASCII — passes through verbatim.
//   * The compiled `RegExp` uses NO `u` (unicode) flag. Python's regex is not unicode-strict about
//     identity escapes (`\#`, `\~`, `\ `), so a non-`u` JS RegExp matches Python's `Pattern.fullmatch`
//     behaviour exactly; a `u`-flag RegExp would THROW on those escapes. The body is `^...$`-anchored,
//     so `RegExp.test` is the parity-equivalent of Python's `fullmatch` for the newline-free path inputs.
//   * Module-level memoization mirrors Python's `@lru_cache(maxsize=512)` on `_glob_to_regex` — a
//     pure compile cache keyed by the raw pattern string. Cache hits/misses are not observable, so
//     using an unbounded `Map` instead of an LRU has no parity impact (patterns per review are few).

import type { PathInstructionV1 } from "#contracts/codemaster_config.v1.js";

// Compile cache, keyed by the raw pattern string. Mirrors `@lru_cache(maxsize=512)` on the Python
// `_glob_to_regex` — a pure, side-effect-free compile cache (an unbounded Map is parity-equivalent;
// see the byte-parity note above).
const REGEX_CACHE = new Map<string, RegExp>();

// Python `re.escape`'s special-char set (3.13/3.14 `_special_chars_map`). Each of these code points
// gets a leading backslash; every other char passes through verbatim. Single-char only — matches the
// per-char `re.escape(ch)` call sites in the Python translator.
const RE_ESCAPE_CHARS: ReadonlySet<string> = new Set([
  "\t", // 9
  "\n", // 10
  "\v", // 11 (0x0b)
  "\f", // 12 (0x0c)
  "\r", // 13
  " ", // 32
  "#", // 35
  "$", // 36
  "&", // 38
  "(", // 40
  ")", // 41
  "*", // 42
  "+", // 43
  "-", // 45
  ".", // 46
  "?", // 63
  "[", // 91
  "\\", // 92
  "]", // 93
  "^", // 94
  "{", // 123
  "|", // 124
  "}", // 125
  "~", // 126
]);

/** Faithful single-char Python `re.escape`: backslash-prefix the special set; pass everything else. */
function escapeRegexChar(ch: string): string {
  return RE_ESCAPE_CHARS.has(ch) ? `\\${ch}` : ch;
}

/**
 * Translate a gitignore-style glob to a compiled `RegExp`, memoized by raw pattern.
 *
 * 1:1 port of the Python `_glob_to_regex`. The body is built `^...$`-anchored (root-anchored when the
 * pattern begins with `/`, otherwise prefixed with the unanchored `(?:.* slash)?` prefix for
 * gitignore's "match anywhere" behaviour). Compiled WITHOUT the `u` flag — see the module byte-parity note.
 */
function globToRegex(pattern: string): RegExp {
  const cached = REGEX_CACHE.get(pattern);
  if (cached !== undefined) return cached;

  // Strip trailing slash (directory match) for normalisation — Python `pattern.rstrip("/")`.
  let pat = pattern.replace(/\/+$/u, "");

  const anchorRoot = pat.startsWith("/");
  if (anchorRoot) {
    pat = pat.slice(1);
  }

  // Tokenise to handle `**` correctly. Translate one char (or one `**` token) at a time; mid-segment
  // `**` is treated like `.*` (matches any chars including `/`).
  const out: Array<string> = [];
  let i = 0;
  while (i < pat.length) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounds-checked numeric loop index into a local string, not user-controlled key access
    const ch = pat[i]!;
    if (ch === "*") {
      if (i + 1 < pat.length && pat[i + 1] === "*") {
        // `**` — multi-segment.
        out.push(".*");
        i += 2;
        // Consume an optional trailing `/` that follows `**/` so the pattern matches "any descendant"
        // cleanly without forcing an extra separator.
        // eslint-disable-next-line security/detect-object-injection -- `i` is bounds-checked; numeric index into a local string
        if (i < pat.length && pat[i] === "/") {
          i += 1;
        }
      } else {
        // `*` — anything except `/`.
        out.push("[^/]*");
        i += 1;
      }
    } else if (ch === "?") {
      out.push("[^/]");
      i += 1;
    } else {
      // Both the Python `elif ch in ".+()|^$[]{}\\"` and the `else` branch funnel through
      // `re.escape(ch)`; the single-char `escapeRegexChar` reproduces both verbatim.
      out.push(escapeRegexChar(ch));
      i += 1;
    }
  }

  const body = out.join("");
  // Unanchored patterns may match anywhere in the path (gitignore behaviour); anchored bind to root.
  // The dynamic regex is the WHOLE POINT — `body` is the glob→regex translation of a trusted repo
  // config pattern (max 200 chars, contract-validated), mirroring the frozen Python `re.compile`.
  // eslint-disable-next-line security/detect-non-literal-regexp -- glob translation of a contract-validated config pattern; 1:1 with the frozen Python re.compile
  const regex = anchorRoot ? new RegExp(`^${body}$`) : new RegExp(`^(?:.*/)?${body}$`);
  REGEX_CACHE.set(pattern, regex);
  return regex;
}

/** True iff `path` matches the gitignore-style `pattern`. Port of Python `matches_glob`. */
export function matchesGlob(args: { path: string; pattern: string }): boolean {
  return globToRegex(args.pattern).test(args.path);
}

/**
 * White-box diagnostic: the compiled `RegExp.source` for `pattern`. Mirrors the Python original's
 * `_glob_to_regex(pattern).pattern`. Exported so the parity test can pin the EXACT regex translation
 * (not just match outcomes) against the source-of-truth; not part of the matcher's runtime surface.
 */
export function globToRegexSource(pattern: string): string {
  return globToRegex(pattern).source;
}

/**
 * Return every rule whose `path` glob matches `chunkPath`, in declaration order.
 *
 * 1:1 port of Python `match_path_instructions`. This is the helper the workflow body uses to build
 * `ReviewContextV1.matched_path_instructions` from `repo_config.path_instructions` for a chunk path.
 * The argument order is `(rules, chunkPath)` per the task contract; the Python original is keyword-
 * only `match_path_instructions(path=..., rules=...)` — same semantics, TS-idiomatic positional shape.
 */
export function matchPathInstructions(
  rules: ReadonlyArray<PathInstructionV1>,
  chunkPath: string,
): Array<PathInstructionV1> {
  if (rules.length === 0) {
    return [];
  }
  return rules.filter((r) => matchesGlob({ path: chunkPath, pattern: r.path }));
}

/**
 * Match `path` against `pattern` using ROOT-ANCHORED semantics.
 *
 * Port of Python `_filter_matches_glob`. All patterns are treated as root-anchored by prepending `/`
 * when not already present. `**` still crosses directory boundaries; `*` and `?` do not. This differs
 * from `matchesGlob`'s default unanchored behaviour and is the correct semantic for `path_filters`.
 */
function filterMatchesGlob(path: string, pattern: string): boolean {
  const anchored = pattern.startsWith("/") ? pattern : `/${pattern}`;
  return matchesGlob({ path, pattern: anchored });
}

/**
 * Select which paths are reviewed, gitignore last-match-wins. Port of Python `filter_review_paths`.
 *
 * Bare pattern INCLUDES; '!'-prefixed EXCLUDES. The LAST matching pattern decides. Default state:
 * any include exists → allow-list (default excluded); only excludes → deny-list (default included).
 * Empty `pathFilters` keeps everything (back-compat). Output is always an order-preserving subsequence
 * of `paths`.
 */
export function filterReviewPaths(
  paths: ReadonlyArray<string>,
  pathFilters: ReadonlyArray<string>,
): Array<string> {
  if (pathFilters.length === 0) {
    return [...paths];
  }

  const hasIncludes = pathFilters.some((f) => !f.startsWith("!"));

  const kept: Array<string> = [];
  for (const path of paths) {
    let included = !hasIncludes;
    for (const f of pathFilters) {
      if (f.startsWith("!")) {
        if (filterMatchesGlob(path, f.slice(1))) {
          included = false;
        }
      } else if (filterMatchesGlob(path, f)) {
        included = true;
      }
    }
    if (included) {
      kept.push(path);
    }
  }
  return kept;
}
