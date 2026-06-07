/**
 * Unit tests for `assembleLinkedIssues` — the 1:1 port of the frozen Python
 * `codemaster/llm/walkthrough_sections/linked_issues.py::assemble_linked_issues`.
 *
 * The pure assembler maps parser output (`IssueLink` triples) → the walkthrough's
 * `LinkedIssueV1` envelope tuple, layering a `(title, state)` resolver dict on top and applying:
 *   - cross-source dedup (strongest linkage kind per issue number; first-seen wins on ties),
 *   - display ordering (`closes` > `fixes` > `resolves` > `mentioned`, then issue number ASC),
 *   - graceful degradation (missing resolver key → `title=null, state=null`).
 *
 * These are the parity-significant behaviours; the test drives the exported pure function directly.
 */

import { describe, it, expect } from "vitest";

import { assembleLinkedIssues } from "#backend/llm/walkthrough_sections/linked_issues.js";

import type { IssueLink } from "#contracts/issue_link.v1.js";

function link(
  github_issue_number: number,
  linkage_kind: IssueLink["linkage_kind"],
  source: IssueLink["source"] = "description",
): IssueLink {
  return { github_issue_number, linkage_kind, source };
}

describe("assembleLinkedIssues", () => {
  it("returns an empty array when there are no parsed links", () => {
    expect(assembleLinkedIssues({ parsed: [] })).toEqual([]);
  });

  it("maps each parsed link to a LinkedIssueV1, populating title+state from the resolver", () => {
    const out = assembleLinkedIssues({
      parsed: [link(42, "closes")],
      titleResolver: new Map([[42, ["Fix the widget", "open"] as const]]),
    });
    expect(out).toEqual([
      { issue_number: 42, linkage_kind: "closes", title: "Fix the widget", state: "open" },
    ]);
  });

  it("degrades a missing resolver key to title=null, state=null", () => {
    const out = assembleLinkedIssues({ parsed: [link(7, "mentioned")] });
    expect(out).toEqual([{ issue_number: 7, linkage_kind: "mentioned", title: null, state: null }]);
  });

  it("orders auto-closing kinds first then by issue number ASC; mentioned last", () => {
    // Intentionally out-of-order input: mentioned #1, resolves #9, closes #5, fixes #5-no... use #3.
    const out = assembleLinkedIssues({
      parsed: [link(1, "mentioned"), link(9, "resolves"), link(5, "closes"), link(3, "fixes")],
    });
    expect(out.map((l) => [l.linkage_kind, l.issue_number])).toEqual([
      ["closes", 5],
      ["fixes", 3],
      ["resolves", 9],
      ["mentioned", 1],
    ]);
  });

  it("cross-source dedups to one entry per issue number, strongest linkage kind winning", () => {
    // #5 appears as a bare mention (title source) AND a closes (description). closes wins.
    const out = assembleLinkedIssues({
      parsed: [link(5, "mentioned", "title"), link(5, "closes", "description")],
    });
    expect(out).toEqual([{ issue_number: 5, linkage_kind: "closes", title: null, state: null }]);
  });

  it("keeps first-seen linkage kind on an equal-rank tie", () => {
    // Two `mentioned` links for #8 across sources → ONE entry (first-seen wins; same rank).
    const out = assembleLinkedIssues({
      parsed: [link(8, "mentioned", "description"), link(8, "mentioned", "title")],
    });
    expect(out).toEqual([{ issue_number: 8, linkage_kind: "mentioned", title: null, state: null }]);
  });
});
