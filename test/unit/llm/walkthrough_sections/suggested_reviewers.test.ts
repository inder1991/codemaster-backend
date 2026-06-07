/**
 * Unit tests for `rankSuggestedReviewers` — the 1:1 port of the frozen Python
 * `codemaster/llm/walkthrough_sections/suggested_reviewers.py::rank_suggested_reviewers`.
 *
 * The pure ranker takes the PR's changed files + the parsed CODEOWNERS rules and returns the top-N
 * reviewer logins (markdown-escaped, leading `@` stripped), ranked by file-match-count DESC then
 * login alpha-ASC. The gitignore-style glob matcher + the markdown-escape table are the
 * parity-significant sub-behaviours; the test drives the exported pure function directly.
 */

import { describe, it, expect } from "vitest";

import { rankSuggestedReviewers, DEFAULT_TOP_N } from "#backend/llm/walkthrough_sections/suggested_reviewers.js";

import type { CodeOwnerRule } from "#backend/domain/repos/code_owners_repo.js";

function rule(path_pattern: string, ...owner_logins: Array<string>): CodeOwnerRule {
  return { path_pattern, owner_logins, line_number: 0 };
}

describe("rankSuggestedReviewers", () => {
  it("returns an empty array when there are no files", () => {
    expect(rankSuggestedReviewers({ prFiles: [], rules: [rule("*", "@a")] })).toEqual([]);
  });

  it("returns an empty array when there are no rules", () => {
    expect(rankSuggestedReviewers({ prFiles: ["a.py"], rules: [] })).toEqual([]);
  });

  it("returns an empty array when no rule matches any file", () => {
    expect(rankSuggestedReviewers({ prFiles: ["a.py"], rules: [rule("*.ts", "@a")] })).toEqual([]);
  });

  it("strips the leading @ from a matched owner login", () => {
    expect(rankSuggestedReviewers({ prFiles: ["a.py"], rules: [rule("*.py", "@alice")] })).toEqual([
      "alice",
    ]);
  });

  it("ranks by file-match-count DESC", () => {
    // @bob owns BOTH files (via `*`); @alice owns only the .py one. bob first.
    const out = rankSuggestedReviewers({
      prFiles: ["a.py", "b.ts"],
      rules: [rule("*", "@bob"), rule("*.py", "@alice")],
    });
    expect(out).toEqual(["bob", "alice"]);
  });

  it("breaks count ties by login alpha-ASC", () => {
    // @charlie and @alice each match the single file once. alice sorts first.
    const out = rankSuggestedReviewers({
      prFiles: ["a.py"],
      rules: [rule("*.py", "@charlie", "@alice")],
    });
    expect(out).toEqual(["alice", "charlie"]);
  });

  it("truncates to the default top-N (3)", () => {
    expect(DEFAULT_TOP_N).toBe(3);
    const out = rankSuggestedReviewers({
      prFiles: ["a.py"],
      rules: [rule("*.py", "@a", "@b", "@c", "@d", "@e")],
    });
    expect(out).toHaveLength(3);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("honours an explicit top_n override", () => {
    const out = rankSuggestedReviewers({
      prFiles: ["a.py"],
      rules: [rule("*.py", "@a", "@b", "@c")],
      topN: 2,
    });
    expect(out).toEqual(["a", "b"]);
  });

  it("matches trailing-slash directory patterns against contained files", () => {
    // `/docs/` → `docs/**` (fnmatch cross-segment) → matches `docs/guide/intro.md`.
    const out = rankSuggestedReviewers({
      prFiles: ["docs/guide/intro.md"],
      rules: [rule("/docs/", "@docsteam")],
    });
    expect(out).toEqual(["docsteam"]);
  });

  it("markdown-escapes special characters in a login (defence-in-depth)", () => {
    // A pathological login with a markdown-active char; the escape table prefixes a backslash.
    const out = rankSuggestedReviewers({
      prFiles: ["a.py"],
      rules: [rule("*.py", "@a_b")],
    });
    expect(out).toEqual(["a\\_b"]);
  });
});
