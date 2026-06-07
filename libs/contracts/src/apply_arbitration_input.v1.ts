import { z } from "zod";

import { AnalysisFindingV1 } from "./analysis_findings.v1.js";
import { ArbitrationIntentV1 } from "./arbitration_intent.v1.js";
import { ReviewFindingV1 } from "./review_findings.v1.js";

// Zod port of the `ApplyArbitrationInput` envelope defined inline in the frozen Python activity module
// `vendor/codemaster-py/codemaster/review/arbitration_apply_activity.py`. Parity-validated in
// apply_arbitration_input.v1.parity.test.ts (the oracle imports the class from that Python module).
//
// Typed envelope for `apply_arbitration_activity` (CLAUDE.md invariant 11 — one positional Pydantic
// input per Temporal activity). Pydantic `ConfigDict(extra="forbid", frozen=True)` → .strict() (frozen
// is a TS-side concern, not wire). schema_version is `Literal[1] = 1` → z.literal(1).default(1) (a
// future bump is an explicit contract change here, mirroring record_tool_runs_input.v1).
//
// ── The UUID-keyed-dict JSON-safety story (CLAUDE.md invariant 11 / check_temporal_activity_input_json_safe) ──
//
// Temporal serializes activity inputs through the default JSON payload converter, which restricts dict
// keys to JSON primitives. A `dict[UUID, UUID]` annotation raises `TypeError: keys must be str, int,
// float, bool or None, not UUID` at dispatch (smoke #10, 2026-05-17). The frozen Python therefore types
// `tier2_review_finding_id_by_arbitration_id` as `dict[str, uuid.UUID]` — the keys are already STRINGS
// (the arbitration-intent UUID stringified), JSON-safe by construction; the activity reconstructs the
// `uuid.UUID(k)` map inside the Node/activity runtime, NOT at the wire boundary. We mirror that exact
// shape here: `Record<string, uuidLower>` — string keys, UUID-string values. (We DO lowercase the value
// UUIDs to match Pydantic's `uuid.UUID` dump; the keys are passed through verbatim, exactly as the Python
// `dict[str, ...]` does — Pydantic does NOT normalize string dict keys.)
//
// `tier2_findings` is the LIST-OF-PAIRS shape `tuple[tuple[uuid.UUID, ReviewFindingV1], ...]` — each pair
// serializes as a 2-element JSON array `[uuid_str, review_finding_dict]` (NOT a UUID-keyed dict, so it is
// also JSON-safe). We model it as `z.tuple([uuidLower, ReviewFindingV1])` so the positional pair shape +
// the nested ReviewFindingV1 contract (its own .strict() + line-range / evidence-ref superRefines) carry
// over unchanged.

// uuid.UUID → string; Pydantic model_dump(mode="json") emits lowercase canonical form.
const uuidLower = (): z.ZodEffects<z.ZodString, string, string> =>
  z
    .string()
    .uuid()
    .transform((s) => s.toLowerCase());

// `tuple[uuid.UUID, ReviewFindingV1]` → fixed-length 2-tuple. The arbitration-intent UUID first, then the
// LLM ReviewFindingV1. Pydantic dumps the inner tuple as a JSON array of exactly two elements.
export const Tier2Pair = z.tuple([uuidLower(), ReviewFindingV1]);
export type Tier2Pair = z.infer<typeof Tier2Pair>;

export const ApplyArbitrationInputV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    installation_id: uuidLower(),
    pr_id: uuidLower(),
    run_id: uuidLower(),
    review_id: uuidLower(),
    // tuple[AnalysisFindingV1, ...] → z.array(AnalysisFindingV1).
    tier1_findings: z.array(AnalysisFindingV1),
    // tuple[tuple[uuid.UUID, ReviewFindingV1], ...] → z.array of the 2-tuple pair.
    tier2_findings: z.array(Tier2Pair),
    // dict[str, uuid.UUID] — JSON-safe: STRING keys (verbatim, NOT lowercased by Pydantic), UUID-string
    // values (lowercased on dump). z.record(keySchema, valueSchema) preserves the keys as-is.
    tier2_review_finding_id_by_arbitration_id: z.record(z.string(), uuidLower()),
    // tuple[ArbitrationIntentV1, ...] → z.array(ArbitrationIntentV1).
    intents: z.array(ArbitrationIntentV1),
    model: z.string(),
    prompt_version: z.string(),
    // Pydantic datetime → RFC3339 string on dump. The activity parses it to a Date for the suppressed_at
    // column (a KNOWN instant, not a wall-clock read — outside the clock/random gate's scope).
    now: z.string().datetime({ offset: true }),
  })
  .strict();

export type ApplyArbitrationInputV1 = z.infer<typeof ApplyArbitrationInputV1>;
