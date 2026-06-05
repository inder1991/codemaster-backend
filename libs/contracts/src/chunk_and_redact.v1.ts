import { z } from "zod";

// NEW typed-input envelope introduced DURING the Python→TS port — there is NO Python Pydantic
// counterpart to diff against. The frozen Python `chunk_and_redact_activity`
// (vendor/codemaster-py/codemaster/activities/chunk_and_redact.py) dispatches with THREE positional
// arguments — `(workspace_path: str, files: tuple[str, ...], changed_line_ranges: dict[str,
// tuple[tuple[int, int], ...]])` — which violates CLAUDE.md invariant 11 / ADR-0047 ("every Temporal
// activity takes EXACTLY ONE positional argument typed as a Pydantic v2 BaseModel"). The TS port
// CLOSES that violation: the activity's single positional input is this `ChunkAndRedactInputV1`
// envelope (consistent with the classify_files.v1 / aggregate_findings.v1 envelopes that closed the
// other known live invariant-11 dispatches).
//
// Because there is no Python contract for this envelope, its parity coverage is round-trip /
// validation only (accepts a valid payload; `.strict()` rejects unknown keys) — there is no
// source-of-truth to byte-diff against. The DOWNSTREAM parity (the DiffChunkV1[] the activity
// returns) is proven against the frozen Python activity via the post-pass parity oracle.
//
// Field mapping:
//  - `workspace_path: str` positional → z.string(). The Python wraps it in `Path(...).resolve()`; the
//    TS activity resolves it via node:path the same way. No min-length bound (the Python str is loose).
//  - `files: tuple[str, ...]` positional → z.array(z.string()). Tuples serialize to JSON arrays; the
//    activity iterates this in INPUT ORDER (chunk accumulation order is parity-significant).
//  - `changed_line_ranges: dict[str, tuple[tuple[int, int], ...]]` → z.record(z.array(line-range)).
//    JSON object keys are the relative paths; each value is an array of inclusive 1-based [start, end]
//    pairs. The Python `.get(rel_path, ())` lookup → a `?? []` default per file in the activity.
//  - `schema_version: int = 1` → z.number().int().default(1) (NOT z.literal(1): a literal would
//    false-reject a future schema_version=2 wire payload). Mirrors the classify_files.v1 envelope.

/** A single inclusive 1-based [start_line, end_line] changed-line pair. Tuple-typed to mirror the
 *  Python `tuple[int, int]`; serializes to a 2-element JSON array. */
export const ChangedLineRange = z.tuple([z.number().int(), z.number().int()]);
export type ChangedLineRange = z.infer<typeof ChangedLineRange>;

export const ChunkAndRedactInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    workspace_path: z.string(),
    files: z.array(z.string()),
    changed_line_ranges: z.record(z.string(), z.array(ChangedLineRange)).default({}),
  })
  .strict();
export type ChunkAndRedactInputV1 = z.infer<typeof ChunkAndRedactInputV1>;
