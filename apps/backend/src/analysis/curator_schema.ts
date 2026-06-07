// CURATE_TOOL_SCHEMA + parseCurateToolUse — 1:1 port of the frozen Python
//   vendor/codemaster-py/codemaster/analysis/curator_schema.py (Sprint 9 / S9.2.2).
//
// The Anthropic tool-use schema the Haiku curator hands the model for linter-finding curation, plus
// the parser that turns each `curate_finding` tool_use block back into a ReviewFindingV1. The model's
// job per call: receive a list of AnalysisFindingV1s + PR metadata; for each finding, decide PROMOTE
// (emit one ReviewFindingV1) or DROP (silently skip).
//
// Parser policy (byte-faithful with Python `parse_curate_tool_use`):
//   * Non-dict blocks ignored; non-tool_use blocks ignored; non-curate_finding tool blocks ignored.
//   * Malformed individual blocks raise CurateParseError(block_id, reason); the curator catches
//     per-block, logs, skips (whole call survives) — see curator.ts::parseWithSkipMalformed.
//   * input missing / not an object → CurateParseError.
//   * Over-length strings are coerced (truncated) BEFORE validation via coerceForContract so a
//     length overshoot never crashes the parser — the same resilience the review-pipeline parsers
//     carry (Python smoke #7, 2026-05-16). Non-length validation errors still surface as CurateParseError.
//
// The schema is key-ORDER-significant (the LLM sees the exact byte sequence in the function-calling
// tool definition), so the object-literal key order mirrors the Python dict insertion order exactly.
// The Tier-1 parity test (test/parity/curate.parity.test.ts) proves parseCurateToolUse is byte-equal
// to the frozen Python over adversarial tool-use blocks.

import { coerceForContract } from "#backend/llm/contract_coercion.js";

import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

import type { JsonValue } from "#backend/llm/review_prompt.js";

/** The single tool the curator exposes. 1:1 with the Python `CURATE_TOOL_NAME`. */
export const CURATE_TOOL_NAME = "curate_finding" as const;

/**
 * The Anthropic tool-use schema for curation. Key-order-significant (the function-calling definition is
 * serialized byte-for-byte to the model), so the property order mirrors the frozen Python dict exactly.
 * `suggestion` is the ONLY optional field (it is absent from `required`).
 */
export const CURATE_TOOL_SCHEMA: { readonly [k: string]: JsonValue } = {
  name: CURATE_TOOL_NAME,
  description:
    "Promote ONE linter finding to a reviewer-facing comment. " +
    "Call this tool zero, one, or many times — once per finding " +
    "you decide is worth surfacing. Findings you don't call this " +
    "tool for are silently dropped. Do NOT invoke any other tool.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["file", "start_line", "end_line", "severity", "category", "title", "body", "confidence"],
    properties: {
      file: { type: "string", minLength: 1 },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 1 },
      severity: { type: "string", enum: ["nit", "suggestion", "issue", "blocker"] },
      category: {
        type: "string",
        enum: ["bug", "security", "performance", "style", "test", "docs", "config", "other"],
      },
      title: { type: "string", minLength: 1, maxLength: 200 },
      body: { type: "string", minLength: 1, maxLength: 2000 },
      suggestion: { type: ["string", "null"] },
      confidence: { type: "number", minimum: 0.0, maximum: 1.0 },
    },
  },
};

/**
 * Raised when a `curate_finding` tool block can't be validated. Carries the originating `blockId` so
 * the curator can log a precise marker without retaining the payload. Mirrors the Python class:
 * message = `block {block_id}: {reason}`.
 */
export class CurateParseError extends Error {
  public readonly blockId: string;
  public readonly reason: string;
  public constructor(args: { blockId: string; reason: string }) {
    super(`block ${args.blockId}: ${args.reason}`);
    this.name = "CurateParseError";
    this.blockId = args.blockId;
    this.reason = args.reason;
  }
}

/** True iff `value` is a plain (non-array, non-null) object — the Python `isinstance(x, dict)`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract every well-formed `curate_finding` block as a ReviewFindingV1. 1:1 with the frozen Python
 * `parse_curate_tool_use`.
 *
 * Non-curate / non-tool_use / non-dict blocks are silently ignored. A `curate_finding` block whose
 * `input` is missing/non-object raises CurateParseError; a block whose input fails contract validation
 * (after over-length coercion) raises CurateParseError carrying the block id. The curator catches these
 * per-block so a single malformed block doesn't poison the whole response.
 */
export function parseCurateToolUse(
  blocks: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<ReviewFindingV1> {
  const out: Array<ReviewFindingV1> = [];
  for (const block of blocks) {
    if (!isPlainObject(block)) {
      continue;
    }
    if (block["type"] !== "tool_use") {
      continue;
    }
    if (block["name"] !== CURATE_TOOL_NAME) {
      continue;
    }
    // Python: `str(block.get("id", "<no-id>"))`. `id` may be any type; stringify, defaulting to "<no-id>".
    const rawId = block["id"];
    const blockId = rawId === undefined ? "<no-id>" : String(rawId);
    const payload = block["input"];
    if (!isPlainObject(payload)) {
      throw new CurateParseError({
        blockId,
        reason: "tool_use.input is missing or not an object",
      });
    }
    // Pre-validate coerce: LLMs overshoot declared max_length; truncate over-length strings so a length
    // violation never crashes the parser. Non-length validation errors still surface as CurateParseError.
    const coerced = coerceForContract(payload, ReviewFindingV1, { blockId });
    const result = ReviewFindingV1.safeParse(coerced);
    if (!result.success) {
      throw new CurateParseError({ blockId, reason: result.error.message });
    }
    out.push(result.data);
  }
  return out;
}
