// WALKTHROUGH_TOOL_SCHEMA + parseWalkthroughToolUse — 1:1 port of the frozen Python
//   vendor/codemaster-py/codemaster/review/walkthrough_schema.py (S8.5.2a).
//
// The single Anthropic tool the Opus walkthrough activity hands to the model, plus the parser that
// turns the response back into a WalkthroughV1 envelope.
//
// Parser policy (byte-faithful with Python):
//   * Non-tool_use blocks (text / images) are ignored.
//   * tool_use blocks with names other than `emit_walkthrough` are ignored.
//   * No walkthrough block → WalkthroughParseError("no walkthrough block").
//   * Multiple emit_walkthrough blocks: the first wins; the rest are logged WARN and discarded.
//   * Malformed input → WalkthroughParseError(block_id, reason).
//
// The schema is key-ORDER-significant (the LLM sees the exact byte sequence in the function-calling
// tool definition), so the object-literal key order mirrors Python dict insertion order exactly. A
// frozen JSON document matches the Python `Final[dict[str, Any]]` contract.

import { coerceForContract } from "#backend/llm/contract_coercion.js";

import { WalkthroughV1 } from "#contracts/walkthrough.v1.js";

import type { JsonValue } from "#backend/llm/review_prompt.js";

export const WALKTHROUGH_TOOL_NAME = "emit_walkthrough" as const;

export const WALKTHROUGH_TOOL_SCHEMA: { readonly [k: string]: JsonValue } = {
  name: WALKTHROUGH_TOOL_NAME,
  description:
    "Emit the PR-level walkthrough exactly once. Call this tool only " +
    "after you have inspected every aggregated finding.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["tldr"],
    properties: {
      tldr: { type: "string", minLength: 1, maxLength: 500 },
      file_rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "change_summary", "severity_max", "finding_count"],
          properties: {
            path: { type: "string", minLength: 1 },
            change_summary: { type: "string", minLength: 1, maxLength: 300 },
            severity_max: { type: "string", enum: ["nit", "suggestion", "issue", "blocker"] },
            finding_count: { type: "integer", minimum: 0 },
          },
        },
      },
      configuration_section_md: { type: "string", maxLength: 2000 },
      degradation_note: { type: ["string", "null"] },
      truncated: { type: "boolean" },
    },
  },
};

/** Raised when the model's emit_walkthrough block cannot be validated. Mirrors the Python class:
 *  message = `block {block_id}: {reason}`; carries blockId + reason. */
export class WalkthroughParseError extends Error {
  public readonly blockId: string;
  public readonly reason: string;
  public constructor(args: { blockId: string; reason: string }) {
    super(`block ${args.blockId}: ${args.reason}`);
    this.name = "WalkthroughParseError";
    this.blockId = args.blockId;
    this.reason = args.reason;
  }
}

/** True iff `value` is a plain (non-array, non-null) object — the Python `isinstance(x, dict)`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the first emit_walkthrough block as a WalkthroughV1. 1:1 with the frozen Python
 * `parse_walkthrough_tool_use`.
 *
 * Raises WalkthroughParseError if no walkthrough block was emitted or if the block fails validation.
 * Subsequent walkthrough blocks are dropped (the model is supposed to call the tool exactly once);
 * the Python WARN-log of the extra-block count is observability-only with no behaviour change, so the
 * observable return is identical whether or not it would fire.
 */
export function parseWalkthroughToolUse(
  blocks: ReadonlyArray<Record<string, unknown>>,
): WalkthroughV1 {
  const walkthroughBlocks: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (!isPlainObject(block)) {
      continue;
    }
    if (block["type"] !== "tool_use") {
      continue;
    }
    if (block["name"] !== WALKTHROUGH_TOOL_NAME) {
      continue;
    }
    walkthroughBlocks.push(block);
  }

  if (walkthroughBlocks.length === 0) {
    throw new WalkthroughParseError({ blockId: "<none>", reason: "no walkthrough block" });
  }

  // Multiple walkthrough blocks → first wins; the rest are discarded (Python WARN-logs the count; that
  // log is observability-only with no return-value effect).

  const block = walkthroughBlocks[0]!;
  // Python: `str(block.get("id", "<no-id>"))`. `id` may be any type; stringify, defaulting to "<no-id>".
  const rawId = block["id"];
  const blockId = rawId === undefined ? "<no-id>" : String(rawId);
  const payload = block["input"];
  if (!isPlainObject(payload)) {
    throw new WalkthroughParseError({
      blockId,
      reason: "tool_use.input is missing or not an object",
    });
  }

  // Pre-validate coerce: LLMs overshoot declared max_length; truncate over-length strings (including
  // nested FileRowV1.change_summary and LinkedIssueV1.title) so length violations never crash the
  // parser. Non-length validation errors (missing fields, wrong types) still surface as
  // WalkthroughParseError. See Python smoke #7 (2026-05-16).
  const coerced = coerceForContract(payload, WalkthroughV1, { blockId });
  const result = WalkthroughV1.safeParse(coerced);
  if (!result.success) {
    throw new WalkthroughParseError({ blockId, reason: result.error.message });
  }
  return result.data;
}
