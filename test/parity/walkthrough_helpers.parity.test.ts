import { beforeAll, afterAll, describe, expect, it } from "vitest";

import {
  pyBuildUserMessage,
  pyConstants,
  pySynthesizeFileRows,
  shutdownWalkthroughHelpersRef,
} from "./walkthrough_helpers_oracle.js";
import { canonicalize } from "./canonical.js";

import {
  LLM_FALLBACK_SYNTHESIS_NOTE,
  synthesizeFileRowsFromAggregated,
} from "#backend/review/file_rows_synthesizer.js";
import { buildWalkthroughUserMessage } from "#backend/review/walkthrough_activity.js";
import { WALKTHROUGH_TOOL_SCHEMA } from "#backend/review/walkthrough_schema.js";

import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { PrMetaV1 } from "#contracts/walkthrough.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

// Tier-1 parity for the generate_walkthrough DETERMINISTIC surface — the live Opus call is proven
// later in the dual-run. This suite proves the TS port is byte-identical to the frozen Python over:
//   1. the static WALKTHROUGH_TOOL_SCHEMA + LLM_FALLBACK_SYNTHESIS_NOTE constant;
//   2. _build_user_message (the walkthrough LLM prompt body) — CHAR-FOR-CHAR (the dual-run replays the
//      recorded interaction keyed on these exact bytes), across the enrichment-field render matrix and
//      the findings/stats render;
//   3. synthesize_file_rows_from_aggregated (the fallback per-file table) — structural canonical
//      compare across grouping, severity-desc ordering, and the 49+1 overflow cap.
// Both sides operate on the IDENTICAL wire dict: the TS fixture is parsed through the Zod contract
// (producing the wire shape), serialized to JSON, and `model_validate`d on the Python side. Fixtures
// live ONLY here.

afterAll(() => shutdownWalkthroughHelpersRef());

// Warm up the long-lived Python ref ONCE (cold venv import can exceed the default 5s timeout).
beforeAll(async () => {
  await pyConstants();
}, 30_000);

const PR_ID = "11111111-1111-4111-8111-111111111111";
const INST_ID = "22222222-2222-4222-8222-222222222222";

/** Parse a pr_meta fixture through Zod PrMetaV1 → JSON-safe wire dict (identical to the dual-run wire). */
function wirePrMeta(input: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(PrMetaV1.parse(input)));
}

/** Parse an aggregated fixture through Zod AggregatedFindingsV1 → JSON-safe wire dict. */
function wireAggregated(input: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(AggregatedFindingsV1.parse(input)));
}

/** Parse a findings array through Zod ReviewFindingV1 → JSON-safe wire dicts. */
function wireFindings(input: ReadonlyArray<Record<string, unknown>>): Array<unknown> {
  return input.map((f) => JSON.parse(JSON.stringify(ReviewFindingV1.parse(f))));
}

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: "src/app.ts",
    start_line: 10,
    end_line: 12,
    severity: "issue",
    category: "bug",
    title: "A finding",
    body: "Body text describing the issue at hand.",
    confidence: 0.8,
    ...overrides,
  };
}

function aggregated(
  findings: ReadonlyArray<Record<string, unknown>>,
  stats: Partial<Record<string, number | boolean>> = {},
  policyRevision = 0,
): Record<string, unknown> {
  return {
    findings,
    dedupe_stats: {
      input_count: 0,
      exact_dropped: 0,
      semantic_merged: 0,
      capped: 0,
      semantic_skipped: false,
      ...stats,
    },
    policy_revision: policyRevision,
  };
}

// ── static constants ────────────────────────────────────────────────────────────────────────────

describe("walkthrough constants — byte-exact vs frozen Python", () => {
  it("WALKTHROUGH_TOOL_SCHEMA matches (deep structural + key order via JSON)", async () => {
    const { toolSchema } = await pyConstants();
    expect(WALKTHROUGH_TOOL_SCHEMA).toEqual(toolSchema);
    // Key ORDER parity: Python json.dumps + JS JSON.stringify both emit insertion order, so identical
    // byte output proves the property declaration order (the LLM sees this sequence) matches.
    expect(JSON.stringify(WALKTHROUGH_TOOL_SCHEMA)).toBe(JSON.stringify(toolSchema));
  });

  it("LLM_FALLBACK_SYNTHESIS_NOTE matches char-for-char", async () => {
    const { fallbackNote } = await pyConstants();
    expect(LLM_FALLBACK_SYNTHESIS_NOTE).toBe(fallbackNote);
  });
});

// ── _build_user_message parity ────────────────────────────────────────────────────────────────────

describe("buildWalkthroughUserMessage — char-for-char vs frozen _build_user_message", () => {
  it("minimal pr_meta + no findings (renders '(no actionable findings)')", async () => {
    const prMeta = wirePrMeta({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Add request handler",
      pr_description: "Introduces the top-level handler.",
    });
    const agg = wireAggregated(aggregated([]));
    const tsOut = buildWalkthroughUserMessage({
      prMeta: PrMetaV1.parse(prMeta),
      aggregated: AggregatedFindingsV1.parse(agg),
    });
    const pyOut = await pyBuildUserMessage(prMeta, agg);
    expect(tsOut).toBe(pyOut);
  });

  it("all enrichment fields populated (author, draft, branches, opened_at) + findings + stats", async () => {
    const prMeta = wirePrMeta({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Refactor handler",
      pr_description: "Multi-file refactor.",
      author_login: "octocat",
      draft: true,
      base_ref: "refs/heads/main",
      head_ref: "refs/heads/feature/x",
      opened_at: "2026-05-01T08:30:00+00:00",
    });
    const agg = wireAggregated(
      aggregated(
        [
          finding({ file: "src/b.ts", severity: "blocker", title: "Boom", start_line: 1, end_line: 2 }),
          finding({ file: "src/a.ts", severity: "nit", title: "Tiny", start_line: 5, end_line: 5 }),
        ],
        { input_count: 5, exact_dropped: 1, semantic_merged: 2, capped: 0, semantic_skipped: true },
        3,
      ),
    );
    const tsOut = buildWalkthroughUserMessage({
      prMeta: PrMetaV1.parse(prMeta),
      aggregated: AggregatedFindingsV1.parse(agg),
    });
    const pyOut = await pyBuildUserMessage(prMeta, agg);
    expect(tsOut).toBe(pyOut);
  });

  it("author None but opened_at present → '(deleted user)' placeholder", async () => {
    const prMeta = wirePrMeta({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Deleted-author PR",
      pr_description: "desc",
      author_login: null,
      opened_at: "2026-01-15T00:00:00+00:00",
    });
    const agg = wireAggregated(aggregated([finding()]));
    const tsOut = buildWalkthroughUserMessage({
      prMeta: PrMetaV1.parse(prMeta),
      aggregated: AggregatedFindingsV1.parse(agg),
    });
    const pyOut = await pyBuildUserMessage(prMeta, agg);
    expect(tsOut).toBe(pyOut);
  });

  it("base-only and head-only branch rendering", async () => {
    const baseOnly = wirePrMeta({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Base only",
      pr_description: "desc",
      base_ref: "develop",
    });
    const headOnly = wirePrMeta({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Head only",
      pr_description: "desc",
      head_ref: "topic",
    });
    const agg = wireAggregated(aggregated([]));
    for (const prMeta of [baseOnly, headOnly]) {
      const tsOut = buildWalkthroughUserMessage({
        prMeta: PrMetaV1.parse(prMeta),
        aggregated: AggregatedFindingsV1.parse(agg),
      });
      const pyOut = await pyBuildUserMessage(prMeta, agg);
      expect(tsOut).toBe(pyOut);
    }
  });

  it("empty pr_title + empty pr_description (no enrichment context block)", async () => {
    const prMeta = wirePrMeta({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "",
      pr_description: "",
    });
    const agg = wireAggregated(aggregated([finding({ category: "security", severity: "suggestion" })]));
    const tsOut = buildWalkthroughUserMessage({
      prMeta: PrMetaV1.parse(prMeta),
      aggregated: AggregatedFindingsV1.parse(agg),
    });
    const pyOut = await pyBuildUserMessage(prMeta, agg);
    expect(tsOut).toBe(pyOut);
  });

  it("non-ASCII title / description / finding title (unicode byte parity)", async () => {
    const prMeta = wirePrMeta({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "国際化対応",
      pr_description: "日本語の説明 — handles unicode 🎉",
      author_login: "ünïcode",
    });
    const agg = wireAggregated(aggregated([finding({ title: "絵文字 🚀 finding", file: "src/日本.ts" })]));
    const tsOut = buildWalkthroughUserMessage({
      prMeta: PrMetaV1.parse(prMeta),
      aggregated: AggregatedFindingsV1.parse(agg),
    });
    const pyOut = await pyBuildUserMessage(prMeta, agg);
    expect(tsOut).toBe(pyOut);
  });
});

// ── synthesize_file_rows_from_aggregated parity ───────────────────────────────────────────────────

describe("synthesizeFileRowsFromAggregated — structural parity vs frozen synthesizer", () => {
  it("empty findings → []", async () => {
    const tsRows = synthesizeFileRowsFromAggregated([]);
    const pyRows = await pySynthesizeFileRows([]);
    expect(canonicalize(tsRows)).toBe(canonicalize(pyRows));
    expect(tsRows).toHaveLength(0);
  });

  it("single finding → singular 'finding' wording", async () => {
    const findings = wireFindings([finding()]);
    const tsRows = synthesizeFileRowsFromAggregated(findings as Array<ReviewFindingV1>);
    const pyRows = await pySynthesizeFileRows(findings);
    expect(canonicalize(tsRows)).toBe(canonicalize(pyRows));
  });

  it("grouping by file + severity-desc ordering (blocker on top) + plural wording", async () => {
    const findings = wireFindings([
      finding({ file: "src/low.ts", severity: "nit", start_line: 1, end_line: 1 }),
      finding({ file: "src/low.ts", severity: "suggestion", start_line: 2, end_line: 2 }),
      finding({ file: "src/high.ts", severity: "blocker", start_line: 3, end_line: 3 }),
      finding({ file: "src/mid.ts", severity: "issue", start_line: 4, end_line: 4 }),
    ]);
    const tsRows = synthesizeFileRowsFromAggregated(findings as Array<ReviewFindingV1>);
    const pyRows = await pySynthesizeFileRows(findings);
    expect(canonicalize(tsRows)).toBe(canonicalize(pyRows));
    // The blocker file ranks first.
    expect((tsRows[0] as { path: string }).path).toBe("src/high.ts");
  });

  it("same-rank files break ties by path-asc (deterministic)", async () => {
    const findings = wireFindings([
      finding({ file: "src/zeta.ts", severity: "issue", start_line: 1, end_line: 1 }),
      finding({ file: "src/alpha.ts", severity: "issue", start_line: 2, end_line: 2 }),
      finding({ file: "src/mid.ts", severity: "issue", start_line: 3, end_line: 3 }),
    ]);
    const tsRows = synthesizeFileRowsFromAggregated(findings as Array<ReviewFindingV1>);
    const pyRows = await pySynthesizeFileRows(findings);
    expect(canonicalize(tsRows)).toBe(canonicalize(pyRows));
    expect(tsRows.map((r) => r.path)).toEqual(["src/alpha.ts", "src/mid.ts", "src/zeta.ts"]);
  });

  it(">50 files → 49 real rows + 1 overflow row (severity_max=MAX, count=SUM of tail)", async () => {
    // 60 distinct files, each one finding. The tail (files 50..60) elides into the overflow row; seed a
    // blocker DEEP in the tail so the overflow severity_max=blocker assertion is meaningful.
    const records: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 60; i += 1) {
      // pad so path-asc ordering is stable; all same severity except one deep-tail blocker.
      const sev = i === 58 ? "blocker" : "nit";
      records.push(
        finding({ file: `src/file_${String(i).padStart(3, "0")}.ts`, severity: sev, start_line: 1, end_line: 1 }),
      );
    }
    const findings = wireFindings(records);
    const tsRows = synthesizeFileRowsFromAggregated(findings as Array<ReviewFindingV1>);
    const pyRows = await pySynthesizeFileRows(findings);
    expect(canonicalize(tsRows)).toBe(canonicalize(pyRows));
    expect(tsRows).toHaveLength(50);
    expect((tsRows[49] as { path: string }).path).toBe("…(additional files)");
  });

  it("multiple findings per file accumulate finding_count", async () => {
    const findings = wireFindings([
      finding({ file: "src/busy.ts", severity: "nit", start_line: 1, end_line: 1 }),
      finding({ file: "src/busy.ts", severity: "issue", start_line: 2, end_line: 2 }),
      finding({ file: "src/busy.ts", severity: "blocker", start_line: 3, end_line: 3 }),
    ]);
    const tsRows = synthesizeFileRowsFromAggregated(findings as Array<ReviewFindingV1>);
    const pyRows = await pySynthesizeFileRows(findings);
    expect(canonicalize(tsRows)).toBe(canonicalize(pyRows));
    expect((tsRows[0] as { finding_count: number; severity_max: string }).finding_count).toBe(3);
    expect((tsRows[0] as { severity_max: string }).severity_max).toBe("blocker");
  });
});
