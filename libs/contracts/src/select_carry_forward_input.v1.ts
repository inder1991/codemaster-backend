import { z } from "zod";

import { DiffChunkV1 } from "./diff_chunking.v1.js";
import { ReviewFindingV1 } from "./review_findings.v1.js";

// NEW typed-input envelope introduced DURING the Python→TS port — there is NO Python Pydantic
// counterpart to diff against. The frozen Python `CarryForwardActivity.select_carry_forward`
// (vendor/codemaster-py/codemaster/review/carry_forward.py) dispatches with FOUR positional arguments —
// `(parent_findings, current_chunks, changed_line_ranges, parent_review_id)` — which violates
// CLAUDE.md invariant 11 / ADR-0047 ("every Temporal activity takes EXACTLY ONE positional argument
// typed as a Pydantic v2 BaseModel"). The TS port CLOSES that violation: the activity's single positional
// input is this `SelectCarryForwardInputV1` envelope. The four fields mirror the Python dispatch args
// 1:1 (same names, same shapes). Because there is no Python contract for this envelope, the parity test
// covers round-trip / validation only — there is no source-of-truth to byte-diff against.
//
// ConfigDict(extra="forbid") parity → .strict() (mirrors aggregate_findings.v1.ts / the other
// port-introduced input envelopes).
//
// schema_version GOTCHA: introduced field with NO Python counterpart. Modeled as a plain-int default
// (z.number().int().default(1), NOT z.literal(1)) so a future schema_version=2 wire payload is accepted
// and re-emitted — matching the bare-int idiom of the sibling contracts this envelope nests
// (CarryForwardSelectionV1 / DiffChunkV1 / ReviewFindingV1, all plain-int schema_version).
//
// parent_findings / current_chunks GOTCHA: Python `tuple[ReviewFindingV1, ...]` /
// `tuple[DiffChunkV1, ...]` → JSON arrays. The sibling Zod schemas are IMPORTED, not redefined, so the
// nested contracts (and their @model_validator line-range / evidence-ref checks) are enforced inside the
// envelope. Default `[]` mirrors the activity's tolerance for an empty parent review / empty chunk set.
//
// changed_line_ranges GOTCHA: Python `dict[str, tuple[tuple[int, int], ...]]` — a map from file path to
// a tuple of (start, end) line-range pairs. JSON has no tuple type, so the wire shape is
// `Record<string, Array<[int, int]>>` → z.record(z.array(z.tuple([int, int]))). Each inner pair MUST be
// exactly two integers (z.tuple is fixed-arity, so a 1- or 3-element array is rejected). A file present
// with an EMPTY array is the "no-change for that file" branch the selector honors; a file ABSENT from
// the map is the "renamed/new path → fully changed" branch. The dict KEY is a string path → JSON-safe
// activity input (no UUID/Enum/datetime keys; satisfies the Temporal JSON-safe-input discipline).
// Default `{}` mirrors the first-push case (no prior change map).
//
// parent_review_id GOTCHA: Python `uuid.UUID | None = None` → z.string().uuid().nullable().default(null).
// UUIDs are spelled lowercase in fixtures so Pydantic's lowercasing-on-dump matches Zod's pass-through.
// `None` on the first push (no prior review whose findings we carried).
export const SelectCarryForwardInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    parent_findings: z.array(ReviewFindingV1).default([]),
    current_chunks: z.array(DiffChunkV1).default([]),
    changed_line_ranges: z
      .record(z.array(z.tuple([z.number().int(), z.number().int()])))
      .default({}),
    parent_review_id: z.string().uuid().nullable().default(null),
  })
  .strict();

export type SelectCarryForwardInputV1 = z.infer<typeof SelectCarryForwardInputV1>;
