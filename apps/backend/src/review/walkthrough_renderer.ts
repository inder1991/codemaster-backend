// Walkthrough renderer — 1:1 TS port of the frozen Python
//   vendor/codemaster-py/codemaster/review/walkthrough_renderer.py (Sprint 8 / S8.5.3).
//
// Pure function: `renderWalkthrough(WalkthroughV1) -> string` returns the markdown body of the PR-top
// comment. Section order + truncation priority (highest = always preserved):
//   1. TL;DR (required) — `🤖 **codemaster review** — {tldr}`
//   2. Truncated notice (if `walkthrough.truncated`)
//   3. Degradation note (if present)
//   4. File table (truncated from the tail under safety-cap pressure)
//   5. Configuration section (collapsible <details>)
//   6. Linked issues
//   7. Suggested reviewers
//
// Length cap: respects OutputSafetyValidator's MAX_OUTPUT_CHARS limit. When the rendered output exceeds
// the cap, the file table is truncated row-by-row and a "(table truncated to fit safety cap)" marker is
// appended; TL;DR + degradation note are preserved. The last-resort path drops the config / linked /
// suggested sections by reconstructing a minimal envelope.
//
// PARITY NOTE — length counting: Python's `len(str)` counts Unicode CODE POINTS, while JS `string.length`
// counts UTF-16 code units (the 🤖 header emoji is 1 code point but 2 code units). The safety-cap
// comparison therefore uses `[...s].length` (code-point count) so the truncation boundary is byte-exact
// with the frozen Python. Proven in test/parity/walkthrough_renderer.parity.test.ts.
//
// Sandbox-pure: no crypto, clock, RNG, I/O — safe inside the Temporal workflow sandbox (it renders the
// post body the orchestrator hands to the post_review activity).

import {
  formatLinkedIssuesMd,
} from "#backend/llm/walkthrough_sections/linked_issues.js";
import {
  formatSuggestedReviewersMd,
} from "#backend/llm/walkthrough_sections/suggested_reviewers.js";
import { MAX_OUTPUT_CHARS } from "#backend/security/output_safety.js";

import type { FileRowV1, WalkthroughV1 } from "#contracts/walkthrough.v1.js";

const HEADER_PREFIX = "🤖 **codemaster review** — ";
const TRUNCATED_NOTICE =
  "> ⚠️ The per-review finding cap was hit; only the top-50 findings are surfaced below.";

/** Python `len(str)` counts Unicode code points; `[...s].length` matches it (UTF-16-pair-safe). */
function codePointLength(s: string): number {
  return [...s].length;
}

/** Python `str.rstrip()`: strip trailing whitespace. */
function rstrip(s: string): string {
  return s.replace(/\s+$/, "");
}

/** Render the per-file markdown table (1:1 with `_render_table`). Empty rows → "". */
function renderTable(rows: ReadonlyArray<FileRowV1>): string {
  if (rows.length === 0) {
    return "";
  }
  const out: Array<string> = ["| File | Change | Severity | Findings |", "| --- | --- | :---: | :---: |"];
  for (const row of rows) {
    out.push(`| \`${row.path}\` | ${row.change_summary} | ${row.severity_max} | ${row.finding_count} |`);
  }
  return out.join("\n");
}

/** Render the collapsible configuration section (1:1 with `_render_config_section`). Empty md → "". */
function renderConfigSection(md: string): string {
  if (md === "") {
    return "";
  }
  return `<details>\n<summary>configuration</summary>\n\n${md}\n</details>`;
}

/**
 * Render the walkthrough envelope to markdown (1:1 with the Python `_assemble`). `rows` is the (possibly
 * tail-truncated) row set to render; `tableTruncated` appends the truncation marker.
 */
function assemble(
  walkthrough: WalkthroughV1,
  rows: ReadonlyArray<FileRowV1>,
  tableTruncated: boolean,
): string {
  const parts: Array<string> = [`${HEADER_PREFIX}${walkthrough.tldr}`];
  if (walkthrough.truncated) {
    parts.push("");
    parts.push(TRUNCATED_NOTICE);
  }
  if (walkthrough.degradation_note) {
    parts.push("");
    parts.push(`> ℹ️ Degradation: ${walkthrough.degradation_note}`);
  }
  parts.push("");
  if (rows.length > 0) {
    parts.push(renderTable(rows));
  } else if (walkthrough.file_rows.length > 0 && rows.length === 0) {
    // Original had rows but they were truncated.
    parts.push("_(file table omitted; see GitHub diff for per-file changes)_");
  } else if (walkthrough.file_rows.length === 0 && !tableTruncated) {
    parts.push("_no actionable findings_");
  }
  if (tableTruncated) {
    parts.push("");
    parts.push("_(table truncated to fit safety cap)_");
  }
  const configMd = renderConfigSection(walkthrough.configuration_section_md);
  if (configMd) {
    parts.push("");
    parts.push(configMd);
  }
  // linked_issues + suggested_reviewers sections. Both formatters return "" for empty tuples; the truthy
  // check keeps the output free of orphan headers. Last-resort truncation drops these implicitly via the
  // minimal-envelope reconstruction below (which omits both fields).
  const linkedMd = formatLinkedIssuesMd(walkthrough.linked_issues);
  if (linkedMd) {
    parts.push("");
    parts.push(rstrip(linkedMd));
  }
  const suggestedMd = formatSuggestedReviewersMd(walkthrough.suggested_reviewers);
  if (suggestedMd) {
    parts.push("");
    parts.push(rstrip(suggestedMd));
  }
  return rstrip(parts.join("\n")) + "\n";
}

/**
 * Drop file rows from the tail until the rendered output fits the cap (1:1 with `_truncate_table_to_fit`).
 * TL;DR + degradation note are preserved. Last resort: a minimal envelope that drops the config / linked /
 * suggested sections (reconstructed with empty file_rows / config / linked / suggested).
 */
function truncateTableToFit(walkthrough: WalkthroughV1, maxChars: number): string {
  const rows = [...walkthrough.file_rows];
  while (rows.length > 0) {
    rows.pop();
    const body = assemble(walkthrough, rows, true);
    if (codePointLength(body) <= maxChars) {
      return body;
    }
  }
  // Even the no-table form is too long → drop the configuration / linked / suggested sections as a last
  // resort (1:1 with the Python minimal-WalkthroughV1 reconstruction, which defaults those fields empty).
  const minimal: WalkthroughV1 = {
    ...walkthrough,
    file_rows: [],
    configuration_section_md: "",
    linked_issues: [],
    suggested_reviewers: [],
  };
  return assemble(minimal, [], true);
}

/**
 * Render the walkthrough envelope as a single markdown body (1:1 with `render_walkthrough`). The length
 * cap defaults to MAX_OUTPUT_CHARS so callers can pass the result straight into OutputSafetyValidator.
 */
export function renderWalkthrough(walkthrough: WalkthroughV1, maxChars: number = MAX_OUTPUT_CHARS): string {
  const body = assemble(walkthrough, walkthrough.file_rows, false);
  if (codePointLength(body) <= maxChars) {
    return body;
  }
  return truncateTableToFit(walkthrough, maxChars);
}
