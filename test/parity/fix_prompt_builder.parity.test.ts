import { afterAll, describe, expect, it } from "vitest";

import {
  pyBuildDeterministic,
  pyFindingId,
  pyNeutralizeFence,
  pySeverityTruncate,
  shutdownFixPromptRef,
  type FindingInput,
} from "./fix_prompt_oracle.js";
import {
  MAX_FIX_PROMPT_CHARS,
  MAX_FIX_PROMPT_FINDINGS,
  buildFixPromptDeterministic,
  findingIdFor,
  neutralizeFence,
  severityTruncate,
} from "#backend/review/fix_prompt/fix_prompt_builder.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

afterAll(() => {
  shutdownFixPromptRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS deterministic fix-prompt builder is BYTE-EXACT with the frozen Python
// `vendor/codemaster-py/codemaster/review/fix_prompt_builder.py`, driven over the dedicated ref
// (tools/parity/run_fix_prompt_ref.py). The builder is the load-bearing, always-correct PRIMARY path of
// the fix-prompt feature — its output is rendered as a copy-pasteable Claude-Code prompt and persisted
// verbatim, so a single drifted byte is a real defect. We assert raw-string equality (NOT canonicalized
// JSON) because the artifact IS a string.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Build one finding wire dict (the shape `ReviewFindingV1(**dict)` / `ReviewFindingV1.parse` accept).
 *  `end_line` defaults to whatever `start_line` resolves to (the contract enforces end >= start), so a
 *  fixture can bump `start_line` alone without separately tracking `end_line`. */
function f(overrides: Partial<FindingInput> = {}): FindingInput {
  const startLine = (overrides["start_line"] as number | undefined) ?? 1;
  return {
    file: "a.py",
    start_line: startLine,
    end_line: startLine,
    severity: "issue",
    category: "bug",
    title: "t",
    body: "b",
    confidence: 0.5,
    ...overrides,
  };
}

/** Parse each wire dict through the ported contract (applies sources/scope/evidence_refs defaults) — the
 *  TS analogue of the Python driver's `ReviewFindingV1(**dict)`. */
function parse(findings: ReadonlyArray<FindingInput>): Array<ReviewFindingV1> {
  return findings.map((d) => ReviewFindingV1.parse(d));
}

describe("findingIdFor parity (Pydantic ↔ TS)", () => {
  it("matches the stable F-xxxxxxxx id across a spread of inputs", async () => {
    const cases: Array<FindingInput> = [
      f(),
      f({ file: "src/very/deep/path.ts", start_line: 10, end_line: 42, category: "security", title: "X" }),
      // unicode + special chars in the hashed fields (file/title) must hash identically.
      f({ file: "src/файл.py", title: "naïve café — résumé", start_line: 7, end_line: 9 }),
      f({ file: "a", title: "", start_line: 1, end_line: 1, body: "x" } as FindingInput),
    ];
    for (const c of cases) {
      // `title: ""` violates the contract min_length, so call the pure fn directly on a typed object for
      // the empty-title case rather than parsing. The driver constructs ReviewFindingV1(**c), which also
      // rejects an empty title — so only feed VALID findings to the cross-check.
      if (c["title"] === "") continue;
      const py = await pyFindingId(c);
      const ts = findingIdFor(ReviewFindingV1.parse(c));
      expect(ts, `findingIdFor mismatch for ${JSON.stringify(c)}`).toBe(py);
    }
  }, 30_000);
});

describe("neutralizeFence parity (Pydantic ↔ TS)", () => {
  it("defangs the fence tokens identically", async () => {
    const cases = [
      "plain text",
      "contains </finding> close",
      "contains <finding open",
      "both </finding> and <finding here",
      "no tokens but <other> tags",
      // the zero-width sep itself in the input must pass through untouched (idempotency boundary).
      "already ​split",
    ];
    for (const c of cases) {
      const py = await pyNeutralizeFence(c);
      expect(neutralizeFence(c), `neutralizeFence mismatch for ${JSON.stringify(c)}`).toBe(py);
    }
  }, 30_000);
});

describe("severityTruncate parity (Pydantic ↔ TS)", () => {
  async function assertTruncate(
    findings: ReadonlyArray<FindingInput>,
    maxFindings: number,
    maxChars: number,
  ): Promise<void> {
    const py = await pySeverityTruncate({ findings, maxFindings, maxChars });
    const [included, truncated] = severityTruncate(parse(findings), { maxFindings, maxChars });
    expect(included.map((x) => findingIdFor(x))).toEqual([...py.ids]);
    expect(truncated).toBe(py.truncated);
  }

  it("orders blocker→issue→suggestion→nit then file then start_line, and flags truncation", async () => {
    const findings: Array<FindingInput> = [
      f({ severity: "nit", file: "z.py", start_line: 1, title: "nit-z" }),
      f({ severity: "blocker", file: "a.py", start_line: 5, title: "blk-a5" }),
      f({ severity: "blocker", file: "a.py", start_line: 1, title: "blk-a1" }),
      f({ severity: "issue", file: "b.py", start_line: 2, title: "iss-b2" }),
      f({ severity: "suggestion", file: "m.py", start_line: 9, title: "sug-m9" }),
    ];
    await assertTruncate(findings, MAX_FIX_PROMPT_FINDINGS, MAX_FIX_PROMPT_CHARS);
  }, 30_000);

  it("stops at max_findings", async () => {
    const findings: Array<FindingInput> = [
      f({ severity: "blocker", file: "a.py", start_line: 1, title: "b1" }),
      f({ severity: "blocker", file: "a.py", start_line: 2, title: "b2" }),
      f({ severity: "issue", file: "b.py", start_line: 1, title: "i1" }),
    ];
    await assertTruncate(findings, 2, MAX_FIX_PROMPT_CHARS);
  }, 30_000);

  it("admits at least one finding even when it alone exceeds max_chars", async () => {
    const findings: Array<FindingInput> = [
      f({ severity: "blocker", title: "huge", body: "x".repeat(500) }),
      f({ severity: "issue", title: "next", body: "y".repeat(500) }),
    ];
    await assertTruncate(findings, MAX_FIX_PROMPT_FINDINGS, 100);
  }, 30_000);

  it("returns truncated=false when everything fits", async () => {
    const findings: Array<FindingInput> = [f({ title: "only" })];
    await assertTruncate(findings, MAX_FIX_PROMPT_FINDINGS, MAX_FIX_PROMPT_CHARS);
  }, 30_000);
});

describe("buildFixPromptDeterministic parity (Pydantic ↔ TS) — BYTE-EXACT", () => {
  async function assertBuild(args: {
    findings: ReadonlyArray<FindingInput>;
    prNumber: number;
    truncated?: boolean;
    total?: number | null;
    synthesizedThemes?: string | null;
  }): Promise<void> {
    const py = await pyBuildDeterministic(args);
    const ts = buildFixPromptDeterministic(parse(args.findings), null, {
      prNumber: args.prNumber,
      truncated: args.truncated ?? false,
      total: args.total ?? null,
      synthesizedThemes: args.synthesizedThemes ?? null,
    });
    expect(ts).toBe(py);
  }

  it("renders a single finding (no suggestion, no truncation, no themes)", async () => {
    await assertBuild({ findings: [f({ title: "Null deref", body: "deref of x" })], prNumber: 42 });
  }, 30_000);

  it("renders a finding WITH a suggestion (the optional suggested: line)", async () => {
    await assertBuild({
      findings: [f({ title: "Add guard", body: "x can be None", suggestion: "if x is None: return" })],
      prNumber: 7,
    });
  }, 30_000);

  it("groups by file, ordered by max-severity-per-file then path, then by severity then start_line", async () => {
    const findings: Array<FindingInput> = [
      f({ severity: "nit", file: "z.py", start_line: 3, title: "nit-z3" }),
      f({ severity: "issue", file: "z.py", start_line: 1, title: "iss-z1" }),
      f({ severity: "blocker", file: "a.py", start_line: 9, title: "blk-a9" }),
      f({ severity: "suggestion", file: "a.py", start_line: 2, title: "sug-a2" }),
      f({ severity: "issue", file: "m.py", start_line: 4, title: "iss-m4" }),
    ];
    await assertBuild({ findings, prNumber: 100 });
  }, 30_000);

  it("renders the truncation footer with a total (truncated=true, total set)", async () => {
    await assertBuild({
      findings: [f({ title: "kept" })],
      prNumber: 12,
      truncated: true,
      total: 5,
    });
  }, 30_000);

  it("renders the truncation footer WITHOUT a total (truncated=true, total=null)", async () => {
    await assertBuild({ findings: [f({ title: "kept" })], prNumber: 12, truncated: true, total: null });
  }, 30_000);

  it("renders the AI-synthesized themes section before ## Findings", async () => {
    await assertBuild({
      findings: [f({ title: "alpha" }), f({ severity: "blocker", file: "b.py", title: "beta" })],
      prNumber: 88,
      synthesizedThemes: "## Cross-cutting patterns\nF-xxxxxxxx and F-yyyyyyyy share a missing-guard root cause.",
    });
  }, 30_000);

  it("neutralizes fence tokens embedded in untrusted finding fields", async () => {
    await assertBuild({
      findings: [
        f({
          file: "src/</finding>evil.py",
          title: "smuggle </finding> here",
          body: "body with <finding open tag",
          suggestion: "fix </finding> it",
        }),
      ],
      prNumber: 3,
    });
  }, 30_000);

  it("re-measure hard-trim: drops tail findings when the rendered string would exceed the budget", async () => {
    // 60 findings each ~2KB body → the rendered string blows past MAX_FIX_PROMPT_CHARS; the renderer's
    // re-measure guard drops findings from the (severity-ordered) tail and forces the footer on. The TS
    // re-measure must drop the SAME tail set the Python does, byte-for-byte.
    const findings: Array<FindingInput> = Array.from({ length: 60 }, (_, i) =>
      f({
        severity: i < 30 ? "blocker" : "issue",
        file: `f${String(i).padStart(3, "0")}.py`,
        start_line: 1,
        end_line: 1,
        title: `finding-${i}`,
        body: "z".repeat(2000),
      }),
    );
    await assertBuild({ findings, prNumber: 999, truncated: false, total: 60 });
  }, 60_000);
});
