import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pyRenderWalkthrough, shutdownWalkthroughHelpersRef } from "./walkthrough_helpers_oracle.js";

import { renderWalkthrough } from "#backend/review/walkthrough_renderer.js";

import { WalkthroughV1 } from "#contracts/walkthrough.v1.js";

// Tier-1 PARITY: drives the frozen Python `render_walkthrough` over a matrix of WalkthroughV1 wire shapes
// and asserts the TS `renderWalkthrough` is BYTE-IDENTICAL. Both sides operate on the SAME wire dict (the
// TS fixture parsed through the Zod contract → JSON → Python `model_validate`). The GitHub review body is
// posted from this exact markdown, so char-for-char fidelity matters (incl. astral-char length counting
// for the safety-cap truncation boundary).

afterAll(() => shutdownWalkthroughHelpersRef());

// Warm up the long-lived Python ref ONCE (cold venv import can exceed the default 5s timeout).
beforeAll(async () => {
  await pyRenderWalkthrough(JSON.parse(JSON.stringify(WalkthroughV1.parse({ tldr: "warmup" }))));
}, 30_000);

/** Parse a WalkthroughV1 fixture through Zod → JSON-safe wire dict (identical to the dual-run wire). */
function wire(input: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(WalkthroughV1.parse(input)));
}

async function assertParity(input: Record<string, unknown>, maxChars?: number): Promise<void> {
  const parsed = WalkthroughV1.parse(input);
  const ts = renderWalkthrough(parsed, maxChars);
  const py = await pyRenderWalkthrough(wire(input), maxChars);
  expect(ts).toBe(py);
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "src/app.ts",
    change_summary: "Refactored the handler",
    severity_max: "issue",
    finding_count: 2,
    ...over,
  };
}

describe("render_walkthrough parity (TS ↔ frozen Python)", () => {
  it("minimal — tldr only (no actionable findings)", async () => {
    await assertParity({ tldr: "Looks good overall." });
  });

  it("renders the file table (paths backticked, severity centered)", async () => {
    await assertParity({
      tldr: "Reviewed the auth changes.",
      file_rows: [
        row(),
        row({ path: "src/db.ts", severity_max: "blocker", finding_count: 1, change_summary: "Pool fix" }),
      ],
    });
  });

  it("truncated notice (finding cap hit)", async () => {
    await assertParity({ tldr: "Capped.", truncated: true, file_rows: [row()] });
  });

  it("degradation note", async () => {
    await assertParity({ tldr: "Partial review.", degradation_note: "static analysis timed out" });
  });

  it("configuration section (collapsible details)", async () => {
    await assertParity({
      tldr: "Config changed.",
      file_rows: [
        row({ path: ".codemaster.yaml", change_summary: "tuned rules", severity_max: "nit", finding_count: 0 }),
      ],
      configuration_section_md: "- rule X enabled\n- rule Y disabled",
    });
  });

  it("linked issues (title/state matrix incl. unavailable)", async () => {
    await assertParity({
      tldr: "Closes some issues.",
      linked_issues: [
        { issue_number: 42, linkage_kind: "closes", title: "Fix the bug", state: "open" },
        { issue_number: 7, linkage_kind: "mentioned", title: null, state: null },
        { issue_number: 9, linkage_kind: "fixes", title: "Another", state: "closed" },
      ],
    });
  });

  it("suggested reviewers", async () => {
    await assertParity({ tldr: "Needs review.", suggested_reviewers: ["alice", "bob-dev"] });
  });

  it("all sections combined", async () => {
    await assertParity({
      tldr: "Comprehensive change across modules.",
      truncated: true,
      degradation_note: "confluence retrieval degraded",
      file_rows: [
        row(),
        row({ path: "src/x.ts", severity_max: "suggestion", finding_count: 3, change_summary: "tidy" }),
      ],
      configuration_section_md: "config body here",
      linked_issues: [{ issue_number: 1, linkage_kind: "resolves", title: "T", state: "open" }],
      suggested_reviewers: ["carol"],
    });
  });

  it("length-cap truncation: drops file rows from the tail under a small cap", async () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      row({ path: `src/file_${i}.ts`, change_summary: `change number ${i} here`, finding_count: i }),
    );
    await assertParity({ tldr: "Big PR with many files touched here.", file_rows: rows }, 320);
  });

  it("length-cap last resort: cap below even the no-table form", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => row({ path: `src/file_${i}.ts` }));
    await assertParity(
      {
        tldr: "Tiny cap forces the minimal-envelope last-resort path.",
        file_rows: rows,
        configuration_section_md: "x".repeat(50),
      },
      90,
    );
  });
});
