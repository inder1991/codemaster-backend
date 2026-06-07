import { describe, expect, it } from "vitest";

import {
  CURATE_TOOL_NAME,
  CURATE_TOOL_SCHEMA,
  CurateParseError,
  parseCurateToolUse,
} from "#backend/analysis/curator_schema.js";

// Unit coverage of the DETERMINISTIC curate-tool-use parser + the frozen tool schema. 1:1 with the
// frozen Python `vendor/codemaster-py/codemaster/analysis/curator_schema.py` (parse_curate_tool_use,
// CURATE_TOOL_SCHEMA, CurateParseError). The Tier-1 parity test
// (test/parity/curate.parity.test.ts) proves byte-equality against the source-of-truth; this file
// asserts the local TS contract behaviors (block filtering, malformed-block raise, coercion).

/** A well-formed curate_finding tool_use block whose input parses to a ReviewFindingV1. */
function curateBlock(
  input: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "tool_use",
    id: "c1",
    name: CURATE_TOOL_NAME,
    input,
    ...overrides,
  };
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

describe("CURATE_TOOL_SCHEMA — frozen tool definition", () => {
  it("declares the curate_finding tool name", () => {
    expect(CURATE_TOOL_SCHEMA["name"]).toBe("curate_finding");
    expect(CURATE_TOOL_NAME).toBe("curate_finding");
  });

  it("requires exactly the eight non-suggestion fields (key-order-significant)", () => {
    const schema = CURATE_TOOL_SCHEMA["input_schema"] as Record<string, unknown>;
    expect(schema["required"]).toEqual([
      "file",
      "start_line",
      "end_line",
      "severity",
      "category",
      "title",
      "body",
      "confidence",
    ]);
    expect(schema["additionalProperties"]).toBe(false);
  });
});

describe("parseCurateToolUse — block filtering (non-raising)", () => {
  it("extracts a single well-formed curate_finding block as a ReviewFindingV1", () => {
    const out = parseCurateToolUse([curateBlock(VALID_INPUT)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.file).toBe("src/app.ts");
    expect(out[0]!.severity).toBe("issue");
    expect(out[0]!.category).toBe("bug");
    // ReviewFindingV1 contract defaults applied.
    expect(out[0]!.suggestion).toBeNull();
    expect(out[0]!.scope).toBe("chunk_observed");
    expect(out[0]!.evidence_refs).toEqual([]);
  });

  it("ignores non-dict blocks", () => {
    const out = parseCurateToolUse([null as unknown as Record<string, unknown>, curateBlock(VALID_INPUT)]);
    expect(out).toHaveLength(1);
  });

  it("ignores blocks whose type is not tool_use", () => {
    const out = parseCurateToolUse([
      { type: "text", text: "preamble" },
      curateBlock(VALID_INPUT),
    ]);
    expect(out).toHaveLength(1);
  });

  it("ignores tool_use blocks with a different tool name", () => {
    const out = parseCurateToolUse([
      { type: "tool_use", id: "x", name: "emit_walkthrough", input: { tldr: "x" } },
      curateBlock(VALID_INPUT),
    ]);
    expect(out).toHaveLength(1);
  });

  it("returns the blocks in order; multiple curate blocks all promote", () => {
    const out = parseCurateToolUse([
      curateBlock({ ...VALID_INPUT, file: "a.ts" }),
      curateBlock({ ...VALID_INPUT, file: "b.ts" }),
    ]);
    expect(out.map((x) => x.file)).toEqual(["a.ts", "b.ts"]);
  });

  it("empty block list → empty tuple", () => {
    expect(parseCurateToolUse([])).toHaveLength(0);
  });
});

describe("parseCurateToolUse — malformed blocks raise CurateParseError", () => {
  it("raises when tool_use.input is missing", () => {
    const block = curateBlock(VALID_INPUT);
    delete (block as Record<string, unknown>)["input"];
    expect(() => parseCurateToolUse([block])).toThrow(CurateParseError);
  });

  it("raises when tool_use.input is not an object", () => {
    expect(() => parseCurateToolUse([curateBlock(VALID_INPUT, { input: "not-an-object" })])).toThrow(
      CurateParseError,
    );
  });

  it("raises with the block id when the input fails contract validation", () => {
    // start_line < 1 violates the ReviewFindingV1 ge(1) constraint.
    try {
      parseCurateToolUse([curateBlock({ ...VALID_INPUT, start_line: 0 }, { id: "bad-block" })]);
      expect.unreachable("expected CurateParseError");
    } catch (e) {
      expect(e).toBeInstanceOf(CurateParseError);
      expect((e as CurateParseError).blockId).toBe("bad-block");
    }
  });

  it("defaults block_id to <no-id> when absent", () => {
    const block = curateBlock({ ...VALID_INPUT, severity: "invalid-severity" });
    delete (block as Record<string, unknown>)["id"];
    try {
      parseCurateToolUse([block]);
      expect.unreachable("expected CurateParseError");
    } catch (e) {
      expect((e as CurateParseError).blockId).toBe("<no-id>");
    }
  });
});

describe("parseCurateToolUse — over-length coercion (matches review-pipeline coercion)", () => {
  it("truncates an over-length title to the contract max rather than raising", () => {
    const longTitle = "x".repeat(500); // ReviewFindingV1.title max_length=200
    const out = parseCurateToolUse([curateBlock({ ...VALID_INPUT, title: longTitle })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.title.length).toBe(200);
    expect(out[0]!.title.endsWith("...")).toBe(true);
  });
});
