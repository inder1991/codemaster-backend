import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import {
  pyParseCurateToolUse,
  shutdownCurateRef,
  type ContentBlock,
} from "./curate_oracle.js";

import { CurateParseError, parseCurateToolUse } from "#backend/analysis/curator_schema.js";

afterAll(() => {
  shutdownCurateRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS `parseCurateToolUse` is byte-equal to the frozen Python
// `parse_curate_tool_use` (vendor/codemaster-py/codemaster/analysis/curator_schema.py) over adversarial
// content-block lists, driven over the dedicated ref (tools/parity/run_curate_ref.py).
//
// Two observable behaviors are compared per input:
//   * SUCCESS — the findings list (ORDER-significant) is byte-equal. `confidence` is a bare Python
//     float that cannot byte-round-trip through the canonicalizer (1.0 vs "1"); it is STRIPPED from the
//     canonical compare on both sides (`stripConfidence`) and asserted STRUCTURALLY (`confidences`) —
//     the established bare-float handling (mirrors dedup.parity.test.ts / aggregate.parity.test.ts).
//   * RAISE — a malformed curate_finding block raises CurateParseError on BOTH sides, carrying the SAME
//     block_id. parse_curate_tool_use raises on the FIRST malformed block (it is not per-block-resilient
//     — that resilience lives in the curator's parseWithSkipMalformed wrapper), so the block_id is the
//     first offending block's id.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Build one well-formed curate_finding tool_use block. */
function curateBlock(
  input: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): ContentBlock {
  return { type: "tool_use", id: "c1", name: "curate_finding", input, ...overrides };
}

const VALID_INPUT = {
  file: "src/app.ts",
  start_line: 10,
  end_line: 12,
  severity: "issue",
  category: "bug",
  title: "Possible null deref",
  body: "The value may be null here.",
  confidence: 0.7,
};

/** Deep-clone with every `confidence` key removed (Python serializes 1.0; JS serializes 1). */
function stripConfidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripConfidence);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "confidence") continue;
      out[k] = stripConfidence(v);
    }
    return out;
  }
  return value;
}

/** The confidence floats of each finding, in order — the structural assertion the canonical strip omits. */
function confidences(findings: ReadonlyArray<Record<string, unknown>>): Array<number> {
  return findings.map((x) => x["confidence"] as number);
}

/**
 * Run the SAME blocks through the TS parser and the frozen Python, asserting parity of BOTH outcomes
 * (success findings byte-equal + order, OR raise + block_id). Returns nothing — every assertion is here.
 */
async function assertParity(blocks: ReadonlyArray<ContentBlock>): Promise<void> {
  const py = await pyParseCurateToolUse(blocks);

  let tsRaisedBlockId: string | null = null;
  let tsFindings: ReadonlyArray<Record<string, unknown>> = [];
  try {
    tsFindings = parseCurateToolUse([...blocks]) as unknown as ReadonlyArray<Record<string, unknown>>;
  } catch (e) {
    if (e instanceof CurateParseError) {
      tsRaisedBlockId = e.blockId;
    } else {
      throw e;
    }
  }

  if (py.raised) {
    // Python raised → TS must raise with the SAME block_id.
    expect(tsRaisedBlockId).not.toBeNull();
    expect(tsRaisedBlockId).toBe(py.blockId);
    return;
  }

  // Python did NOT raise → TS must NOT raise, and the findings lists must match byte-for-byte.
  expect(tsRaisedBlockId).toBeNull();
  expect(canonicalize(stripConfidence(tsFindings))).toBe(canonicalize(stripConfidence(py.findings)));
  expect(confidences(tsFindings)).toEqual(confidences(py.findings));
}

describe("parse_curate_tool_use parity (Pydantic ↔ TS) — success paths", () => {
  it("empty block list → empty findings", async () => {
    await assertParity([]);
  }, 30_000);

  it("a single well-formed curate_finding block", async () => {
    await assertParity([curateBlock(VALID_INPUT)]);
  });

  it("multiple curate blocks all promote, in order", async () => {
    await assertParity([
      curateBlock({ ...VALID_INPUT, file: "a.ts", confidence: 0.1 }, { id: "a" }),
      curateBlock({ ...VALID_INPUT, file: "b.ts", confidence: 0.9 }, { id: "b" }),
      curateBlock({ ...VALID_INPUT, file: "c.ts", confidence: 1.0 }, { id: "c" }),
    ]);
  });

  it("non-dict / non-tool_use / wrong-tool blocks are filtered out", async () => {
    await assertParity([
      "not-a-dict" as unknown as ContentBlock,
      { type: "text", text: "preamble" },
      { type: "tool_use", id: "x", name: "emit_walkthrough", input: { tldr: "x" } },
      curateBlock(VALID_INPUT),
    ]);
  });

  it("a curate block with an explicit suggestion + every severity/category enum value", async () => {
    await assertParity([
      curateBlock({ ...VALID_INPUT, severity: "nit", category: "style", suggestion: "Rename." }, { id: "s1" }),
      curateBlock({ ...VALID_INPUT, severity: "blocker", category: "security", suggestion: null }, { id: "s2" }),
      curateBlock({ ...VALID_INPUT, severity: "suggestion", category: "performance" }, { id: "s3" }),
    ]);
  });

  it("over-length title is coerced (truncated) identically on both sides", async () => {
    // ReviewFindingV1.title max_length=200; both the Python coerce_for_contract and the TS
    // coerceForContract truncate to value[:197] + "..." BEFORE validation.
    await assertParity([curateBlock({ ...VALID_INPUT, title: "x".repeat(640) })]);
  });

  it("over-length body is coerced identically (max_length=2000)", async () => {
    await assertParity([curateBlock({ ...VALID_INPUT, body: "y".repeat(5000) })]);
  });

  // NOTE on multi-byte over-length: a MULTI-BYTE over-length string (e.g. 300×"🙂" in a max-200 title)
  // does NOT round-trip identically — the frozen Python coerces to 200 CODE POINTS then Pydantic's
  // code-point `max_length` accepts it, whereas the TS path coerces to 200 code points then Zod's
  // `.max()` counts UTF-16 CODE UNITS (397) and REJECTS it (the curator then drops that block). This is
  // a pre-existing divergence in the SHARED TS contract layer (coerceForContract + Zod `.max()`), NOT a
  // curator-parser difference: the walkthrough/review parsers exhibit it identically. It is therefore
  // out of this curator port's scope and is surfaced as drift rather than asserted here. ASCII
  // over-length (the realistic LLM-overshoot case) DOES round-trip — covered by the two cases above.
});

describe("parse_curate_tool_use parity (Pydantic ↔ TS) — raise paths (CurateParseError + block_id)", () => {
  it("input missing → raises with the block id", async () => {
    const block = curateBlock(VALID_INPUT, { id: "missing-input" });
    delete (block as Record<string, unknown>)["input"];
    await assertParity([block]);
  });

  it("input not an object → raises with the block id", async () => {
    await assertParity([curateBlock(VALID_INPUT, { id: "scalar-input", input: 42 })]);
  });

  it("start_line < 1 → contract validation fails → raises with the block id", async () => {
    await assertParity([curateBlock({ ...VALID_INPUT, start_line: 0 }, { id: "bad-line" })]);
  });

  it("end_line < start_line → cross-field validator fails → raises", async () => {
    await assertParity([curateBlock({ ...VALID_INPUT, start_line: 12, end_line: 5 }, { id: "range" })]);
  });

  it("missing required field (no body) → raises", async () => {
    const input = { ...VALID_INPUT } as Record<string, unknown>;
    delete input["body"];
    await assertParity([curateBlock(input, { id: "no-body" })]);
  });

  it("unknown severity enum value → raises", async () => {
    await assertParity([curateBlock({ ...VALID_INPUT, severity: "catastrophic" }, { id: "bad-sev" })]);
  });

  it("block id absent → raises with <no-id>", async () => {
    const block = curateBlock({ ...VALID_INPUT, start_line: 0 });
    delete (block as Record<string, unknown>)["id"];
    await assertParity([block]);
  });

  it("raises on the FIRST malformed block (id of the first offender) even after good ones", async () => {
    await assertParity([
      curateBlock(VALID_INPUT, { id: "good" }),
      curateBlock({ ...VALID_INPUT, start_line: 0 }, { id: "first-bad" }),
      curateBlock({ ...VALID_INPUT, end_line: 0 }, { id: "second-bad" }),
    ]);
  });

  it("extra field (additionalProperties violation in the contract) → raises", async () => {
    // ReviewFindingV1 is .strict() — an unexpected key fails validation. The LLM tool schema declares
    // additionalProperties:false, but the parser validates against the contract, so an extra key raises.
    await assertParity([curateBlock({ ...VALID_INPUT, rogue_field: "x" }, { id: "extra" })]);
  });
});
