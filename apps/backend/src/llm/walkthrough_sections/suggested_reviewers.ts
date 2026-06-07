/**
 * Suggested-reviewers walkthrough section — 1:1 TS port of the frozen Python
 * `codemaster/llm/walkthrough_sections/suggested_reviewers.py` (Sprint 22 / S22.DM.15).
 *
 * Pure ranker. Inputs: the PR's changed files + the parsed CODEOWNERS rules ({@link CodeOwnerRule}).
 * Output: the top-N GitHub login strings (markdown-escaped, leading `@` stripped), ranked by
 * file-match-count DESC then login alpha-ASC.
 *
 * Algorithm (ported exactly):
 *   1. For each PR file, find ALL matching CODEOWNERS rules.
 *   2. Per matched rule, attribute one file-match to each listed `owner_login`.
 *   3. Rank by count DESC, ties broken by alpha-sorted login; take top-N (default 3).
 *   4. Strip the leading `@` + markdown-escape (the walkthrough body is GitHub markdown).
 *
 * Both the activity-consumed ranker (`rank_suggested_reviewers`) AND the walkthrough-rendering
 * formatter (`format_suggested_reviewers_md`) are ported here, 1:1 with the frozen Python.
 */

import type { CodeOwnerRule } from "#backend/domain/repos/code_owners_repo.js";

/**
 * Markdown special characters escaped when a CODEOWNERS login survives parsing. Mirrors the Python
 * `_MARKDOWN_ESCAPE_TABLE` exactly: backslash, italic/bold, code, brackets, parens, pipe, angle
 * brackets, hash. Hyphen / dot / slash are valid login chars and are NOT escaped (they don't trigger
 * markdown rendering inline).
 */
const MARKDOWN_ESCAPE_TABLE = new Set("\\`*_{}[]()|<>#".split(""));

/** Default top-N reviewer count, 1:1 with the Python `DEFAULT_TOP_N`. */
export const DEFAULT_TOP_N = 3;

/**
 * Translate a Python `fnmatch` glob to a RegExp source, 1:1 with CPython's `fnmatch.translate`
 * semantics for the metacharacters CODEOWNERS uses: `*` → `.*` (CROSS-segment — fnmatch does not stop
 * at `/`), `?` → `.`, `[seq]` → a character class (with `!` → `^` negation), everything else escaped
 * literally. The result is anchored at both ends (CPython wraps it in `(?s:...)\Z`).
 */
function fnmatchTranslate(pat: string): string {
  let res = "";
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const c = pat[i]!;
    i += 1;
    if (c === "*") {
      res += ".*";
    } else if (c === "?") {
      res += ".";
    } else if (c === "[") {
      let j = i;
      if (j < n && pat[j] === "!") j += 1;
      if (j < n && pat[j] === "]") j += 1;
      while (j < n && pat[j] !== "]") j += 1;
      if (j >= n) {
        // Unterminated `[` — fnmatch treats it as a literal `[`.
        res += "\\[";
      } else {
        let stuff = pat.slice(i, j);
        if (!stuff.includes("-")) {
          stuff = stuff.replace(/\\/g, "\\\\");
        } else {
          // Preserve ranges; escape backslashes within. (CODEOWNERS glob ranges are vanishingly rare;
          // this branch mirrors CPython's range-preserving path for fidelity.)
          stuff = stuff.replace(/\\/g, "\\\\");
        }
        i = j + 1;
        let cls = stuff;
        if (cls.startsWith("!")) {
          cls = "^" + cls.slice(1);
        } else if (cls.startsWith("^") || cls.startsWith("[")) {
          cls = "\\" + cls;
        }
        res += "[" + cls + "]";
      }
    } else {
      res += escapeRegexLiteral(c);
    }
  }
  return res;
}

/** Escape a single literal char for inclusion in a RegExp (mirrors `re.escape` on one char). */
function escapeRegexLiteral(ch: string): string {
  return /[.^$*+?()[\]{}|\\]/.test(ch) ? "\\" + ch : ch;
}

/**
 * gitignore-style glob match for CODEOWNERS patterns, 1:1 with the Python `_matches_codeowners_glob`.
 * Normalises the leading-slash root anchor (fnmatch ignores it), converts a trailing `/` (directory
 * pattern) to `prefix/**`, collapses `**` → `*` (fnmatch is already cross-segment so the doubled star
 * is a no-op), then runs the fnmatch translation. The `s` flag makes `.` match newlines (CPython's
 * `(?s:...)`), harmless for path strings.
 */
function matchesCodeownersGlob(args: { pattern: string; filePath: string }): boolean {
  const { pattern, filePath } = args;
  // Empty pattern never matches.
  if (pattern === "") return false;
  // Normalise leading slash (root anchor) — fnmatch doesn't care.
  let norm = pattern.replace(/^\/+/, "");
  // Trailing slash means "this dir and contents". Convert to `prefix/**` for fnmatch.
  if (norm.endsWith("/")) {
    norm = norm + "**";
  }
  // `**` translates to fnmatch's `*` (already cross-segment).
  norm = norm.replace(/\*\*/g, "*");
  const re = new RegExp("(?:" + fnmatchTranslate(norm) + ")$", "s");
  return re.test(filePath);
}

/**
 * Strip the leading `@` for display + escape any markdown special chars, 1:1 with the Python
 * `_markdown_escape_login`. The parser's regex pre-validates the login shape; this is defence-in-depth.
 */
function markdownEscapeLogin(login: string): string {
  const bare = login.replace(/^@+/, "");
  let out = "";
  for (const ch of bare) {
    out += MARKDOWN_ESCAPE_TABLE.has(ch) ? "\\" + ch : ch;
  }
  return out;
}

/**
 * Return the top-N reviewer logins (markdown-escaped, no `@`), 1:1 with `rank_suggested_reviewers`.
 *
 * Empty array when there's no CODEOWNERS coverage of the PR files. The walkthrough renderer omits the
 * section header when this returns empty.
 */
export function rankSuggestedReviewers(args: {
  prFiles: ReadonlyArray<string>;
  rules: ReadonlyArray<CodeOwnerRule>;
  topN?: number;
}): Array<string> {
  const { prFiles, rules } = args;
  const topN = args.topN ?? DEFAULT_TOP_N;

  if (prFiles.length === 0 || rules.length === 0) {
    return [];
  }

  const counts = new Map<string, number>();
  for (const path of prFiles) {
    for (const rule of rules) {
      if (!matchesCodeownersGlob({ pattern: rule.path_pattern, filePath: path })) {
        continue;
      }
      for (const owner of rule.owner_logins) {
        counts.set(owner, (counts.get(owner) ?? 0) + 1);
      }
    }
  }

  if (counts.size === 0) {
    return [];
  }

  // Sort by count DESC, login alpha ASC. 1:1 with the Python `key=lambda kv: (-kv[1], kv[0])`.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return ranked.slice(0, topN).map(([login]) => markdownEscapeLogin(login));
}

/**
 * Render the suggested-reviewers walkthrough section (1:1 with `format_suggested_reviewers_md`). Returns
 * "" for an empty list so the caller never emits an orphan header. Each line: `- @<reviewer>` (the
 * reviewer strings are already markdown-escaped + `@`-stripped by {@link rankSuggestedReviewers}).
 */
export function formatSuggestedReviewersMd(reviewers: ReadonlyArray<string>): string {
  if (reviewers.length === 0) {
    return "";
  }
  const lines: Array<string> = ["### Suggested reviewers"];
  for (const r of reviewers) {
    lines.push(`- @${r}`);
  }
  return lines.join("\n") + "\n";
}
