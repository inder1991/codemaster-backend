// Arbitration walkthrough footer — 1:1 port of the frozen Python
// vendor/codemaster-py/codemaster/review/arbitration_footer.py (Phase D Task D.8).
//
// Pure-function renderer that turns an {@link ArbitrationResultV1} and the Tier-1 {@link ToolStatusV1} tuple
// into a markdown block appended to the post-review walkthrough body. Output shape (markdown, both sections
// optional):
//
//     ---
//
//     <details>
//     <summary>Suppressed findings (operator audit)</summary>
//
//     - SUPPRESSED_BY_LLM x 2
//     - SUPPRESSED_BY_POLICY x 1
//
//     </details>
//
//     <details>
//     <summary>Tool degradation</summary>
//
//     - eslint: timed_out (87/100 files, TimeoutError)
//
//     </details>
//
// When ALL decisions are NONE and ALL tool_statuses are completed, the renderer returns an empty string (no
// footer appended). The consumer (posting.ts::renderWalkthroughForPost) checks for the empty string and
// conditionally appends.
//
// CLAUDE.md invariant 9: this renderer is consumer-side; the post_review_results activity still posts with
// `event = COMMENT`. The footer is part of the walkthrough body markdown — visible in the GitHub review's
// parent comment, not a separate review action.
//
// SANDBOX SAFETY (ADR-0065/0066): pure string work over its inputs — NO node:crypto, NO clock, NO RNG, NO
// uuid, NO env, NO I/O. posting.ts (workflow sandbox) imports it, so the type-only contract imports keep the
// bundle crypto-free.

import type { ArbitrationResultV1 } from "#contracts/arbitration_result.v1.js";
import type { ToolStatusV1 } from "#contracts/tool_status.v1.js";

/** Per-state count of non-NONE decisions, or "" for empty input. 1:1 with `_render_suppressed_section`. */
function renderSuppressedSection(result: ArbitrationResultV1): string {
  const suppressed = result.decisions.filter((d) => d.suppression_state !== "NONE");
  if (suppressed.length === 0) {
    return "";
  }
  // Count per suppression_state (Counter analogue).
  const counts = new Map<string, number>();
  for (const d of suppressed) {
    counts.set(d.suppression_state, (counts.get(d.suppression_state) ?? 0) + 1);
  }
  const lines: Array<string> = ["<details>", "<summary>Suppressed findings (operator audit)</summary>", ""];
  // Deterministic — sort by state name so the rendered output is stable across replay. Byte-wise string
  // compare (mirrors Python `sorted(counts)`).
  const states = [...counts.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const state of states) {
    lines.push(`- ${state} x ${counts.get(state)!}`);
  }
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}

/** Per-tool non-completed status line, or "" for empty input. 1:1 with `_render_tool_degradation_section`. */
function renderToolDegradationSection(toolStatuses: ReadonlyArray<ToolStatusV1>): string {
  const degraded = toolStatuses.filter((s) => s.status !== "completed");
  if (degraded.length === 0) {
    return "";
  }
  const lines: Array<string> = ["<details>", "<summary>Tool degradation</summary>", ""];
  // Deterministic — sort by tool_name so the rendered output is stable across replay. Byte-wise compare.
  const sorted = [...degraded].sort((a, b) =>
    a.tool_name < b.tool_name ? -1 : a.tool_name > b.tool_name ? 1 : 0,
  );
  for (const s of sorted) {
    let suffix = `${s.files_scanned}/${s.files_total} files`;
    if (s.error_class !== null && s.error_class !== "") {
      suffix += `, ${s.error_class}`;
    }
    lines.push(`- ${s.tool_name}: ${s.status} (${suffix})`);
  }
  lines.push("");
  lines.push("</details>");
  return lines.join("\n");
}

/**
 * Render the optional arbitration footer. 1:1 with the Python `render_arbitration_footer_md`.
 *
 * @returns the empty string when both sections are empty (no suppressed findings, all tools completed);
 *   otherwise a horizontal-rule-separated markdown block ready for direct concatenation onto the walkthrough
 *   body.
 */
export function renderArbitrationFooterMd(args: {
  result: ArbitrationResultV1;
  toolStatuses: ReadonlyArray<ToolStatusV1>;
}): string {
  const sections = [
    renderSuppressedSection(args.result),
    renderToolDegradationSection(args.toolStatuses),
  ].filter((s) => s !== "");
  if (sections.length === 0) {
    return "";
  }
  return "\n\n---\n\n" + sections.join("\n\n");
}
