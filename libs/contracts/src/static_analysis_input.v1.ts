import { z } from "zod";

import { ChangedLineRange } from "./chunk_and_redact.v1.js";
import { PrMetaV1 } from "./walkthrough.v1.js";

// NEW typed-input envelope introduced DURING the Python→TS port — there is NO Python Pydantic
// counterpart for the ENVELOPE itself to byte-diff against. The frozen Python `static_analysis_activity`
// (vendor/codemaster-py/codemaster/activities/static_analysis.py, dispatched at
// review_pull_request.py:1431-1448) takes FOUR positional arguments —
//   `(workspace_path: str,
//     files: tuple[str, ...],
//     changed_line_ranges: dict[str, tuple[tuple[int, int], ...]],
//     pr_meta_dict: dict[str, Any])`
// — which violates CLAUDE.md invariant 11 / ADR-0047 ("every Temporal activity takes EXACTLY ONE
// positional argument typed as a Pydantic v2 BaseModel"). The TS port CLOSES that violation: the
// activity's single positional input is this `StaticAnalysisInputV1` envelope (consistent with the
// chunk_and_redact.v1 / classify_files.v1 / aggregate_findings.v1 envelopes that closed the other known
// live invariant-11 dispatches).
//
// Because there is no Python contract for the envelope, its parity coverage is round-trip / validation
// only (accepts a valid payload; `.strict()` rejects unknown keys). The NESTED `pr_meta` field IS a real
// ported contract (PrMetaV1), so its nested shape is byte-diffed against the frozen Python PrMetaV1 in
// the parity test — the orchestrator hands the activity `pr_meta_arg.model_dump(mode="json")`.
//
// Field mapping (Python positional → envelope field):
//  - `workspace_path: str` → z.string(). The Python wraps it in `Path(workspace_path)`; the activity
//    treats it as an opaque string. No min-length bound (the Python str is loose).
//  - `files: tuple[str, ...]` → `sandbox_files: z.array(z.string())`. The orchestrator passes the
//    classify router's `sandbox_files` bucket here, so the envelope field is named for what it carries.
//    Tuples serialize to JSON arrays. Defaults to [] (the empty-routing fast path the Python guards with
//    `if not files`). INPUT ORDER would be parity-significant once Stage-4 runners iterate it.
//  - `changed_line_ranges: dict[str, tuple[tuple[int, int], ...]]` → z.record(z.array(line-range)).
//    JSON object keys are the relative paths; each value is an array of inclusive 1-based [start, end]
//    pairs. Reuses the already-ported `ChangedLineRange` tuple from chunk_and_redact.v1 (do NOT redefine
//    it). Defaults to {}.
//  - `pr_meta_dict: dict[str, Any]` → `pr_meta: PrMetaV1`. The Python passes the JSON dump of the typed
//    PrMetaV1; the TS port carries the typed contract directly (the wire shape is identical). REQUIRED —
//    no default (the orchestrator always supplies it).
//  - `schema_version: int = 1` → z.number().int().default(1) (NOT z.literal(1): a literal would
//    false-reject a future schema_version=2 wire payload). Mirrors the sibling envelopes.

export const StaticAnalysisInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    workspace_path: z.string(),
    sandbox_files: z.array(z.string()).default([]),
    changed_line_ranges: z.record(z.string(), z.array(ChangedLineRange)).default({}),
    pr_meta: PrMetaV1,
  })
  .strict();
export type StaticAnalysisInputV1 = z.infer<typeof StaticAnalysisInputV1>;
