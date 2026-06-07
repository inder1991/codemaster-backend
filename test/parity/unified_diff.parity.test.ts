import { afterAll, describe, expect, it } from "vitest";

import { pyParseUnifiedDiff, shutdownUnifiedDiffRef } from "./unified_diff_oracle.js";
import {
  MalformedHunkHeaderError,
  parseUnifiedDiffRanges,
} from "#backend/integrations/github/unified_diff_parser.js";

// Tier-1 parity: the TS `parseUnifiedDiffRanges` must produce byte-identical post-image ranges to the
// frozen Python `parse_unified_diff_ranges` over a corpus spanning the real GitHub PR-file `patch`
// shapes the activity feeds it — added files, deleted files, modified files, renamed files (GitHub
// emits a patch for the content delta of a rename), multi-hunk diffs, pure-deletion hunks, implicit
// counts, and the malformed-header raise path. A match proves the regex + count + sort logic ports 1:1.

afterAll(() => shutdownUnifiedDiffRef());

/** A representative GitHub-PR-files `patch` body for each diff shape the enrichment activity sees. */
const PATCHES: ReadonlyArray<readonly [string, string]> = [
  ["empty", ""],
  // ADDED file: the whole post-image is one hunk from the empty pre-image (+0,0 → +1,N).
  ["added_whole_file", "@@ -0,0 +1,4 @@\n+line1\n+line2\n+line3\n+line4\n"],
  // ADDED single line (no off-by-one).
  ["added_single", "@@ -9,0 +10,1 @@\n+single\n"],
  // MODIFIED file: equal-size pre/post hunk.
  [
    "modified_equal",
    "@@ -20,5 +20,5 @@\n-old1\n-old2\n-old3\n-old4\n-old5\n+new1\n+new2\n+new3\n+new4\n+new5\n",
  ],
  // MODIFIED with surrounding context lines counted into the post-image span.
  [
    "modified_with_context",
    "@@ -50,3 +50,5 @@\n context1\n-removed\n context2\n+added1\n+added2\n context3\n",
  ],
  // DELETED file / pure-deletion hunk (+K,0) → contributes NO post-image range.
  ["deleted_whole_file", "@@ -1,3 +0,0 @@\n-x\n-y\n-z\n"],
  ["pure_deletion_midfile", "@@ -100,3 +99,0 @@\n-x\n-y\n-z\n"],
  // RENAMED file with a content edit: GitHub returns a normal content patch for the moved file.
  ["renamed_with_edit", "@@ -1,2 +1,3 @@\n unchanged\n-old line\n+new line\n+extra\n"],
  // MULTI-HUNK across a file.
  ["multi_hunk", "@@ -4,0 +5,3 @@\n+a\n+b\n+c\n@@ -29,0 +30,3 @@\n+d\n+e\n+f\n"],
  // MULTI-HUNK declared OUT OF ORDER → both sides must sort ascending.
  ["multi_hunk_unsorted", "@@ -29,0 +30,3 @@\n+a\n+b\n+c\n@@ -4,0 +5,3 @@\n+d\n+e\n+f\n"],
  // Implicit count of one (`+10` with no comma).
  ["implicit_count_one", "@@ -9,1 +10 @@\n-old\n+new\n"],
  // A mix: an addition hunk THEN a pure-deletion hunk (the deletion must be dropped, addition kept).
  ["mixed_add_then_delete", "@@ -1,0 +2,2 @@\n+a\n+b\n@@ -40,3 +41,0 @@\n-x\n-y\n-z\n"],
  // Large line numbers (multi-digit start + count).
  ["large_line_numbers", "@@ -1000,0 +1024,128 @@\n+x\n"],
];

describe("parseUnifiedDiffRanges — Tier-1 parity vs frozen Python", () => {
  for (const [name, patch] of PATCHES) {
    it(`matches the frozen parser: ${name}`, async () => {
      const ref = await pyParseUnifiedDiff(patch);
      // The corpus above contains no malformed headers, so the frozen side must return ranges.
      expect("ranges" in ref).toBe(true);
      const expected = (ref as { ranges: ReadonlyArray<readonly [number, number]> }).ranges.map(
        ([s, e]) => [s, e],
      );
      expect(parseUnifiedDiffRanges(patch)).toEqual(expected);
    }, 30_000);
  }
});

describe("parseUnifiedDiffRanges — malformed-header raise parity", () => {
  const MALFORMED: ReadonlyArray<readonly [string, string]> = [
    ["prose_header", "@@ this is not a hunk header @@\n+x\n"],
    ["missing_plus_section", "@@ -1,2 @@\n+x\n"],
    ["garbage_after_at", "@@@nope\n+x\n"],
  ];
  for (const [name, patch] of MALFORMED) {
    it(`both sides raise on a malformed header: ${name}`, async () => {
      const ref = await pyParseUnifiedDiff(patch);
      // The frozen parser raised ValueError → the driver surfaced the value-error marker.
      expect("error" in ref).toBe(true);
      expect((ref as { error: "value_error" }).error).toBe("value_error");
      // The TS port raises its faithful analogue.
      expect(() => parseUnifiedDiffRanges(patch)).toThrow(MalformedHunkHeaderError);
    }, 30_000);
  }
});
