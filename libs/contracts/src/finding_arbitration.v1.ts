import { z } from "zod";

// Zod port of contracts/finding_arbitration/v1.py::ArbitrationDecisionV1 (frozen Python).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in finding_arbitration.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - SuppressionState (Python Literal of 3 values) → z.enum.
//  - ArbitrationDecisionV1 (ConfigDict extra=forbid, frozen) → .strict() + the single
//    @model_validator(mode="after") `_check_metadata_invariant` re-authored as .superRefine().
//
// NOTE on `suppression_confidence`: the Python contract types it as a nullable `Decimal`
// (`Field(default=None, ge=Decimal("0"), le=Decimal("1"))`, NO decimal_places cap). Pydantic
// `model_dump(mode="json")` serializes Decimal as a STRING preserving its exact textual form
// (e.g. "0.5", "1", "0.1234"). We model it as a STRING here and pass it through unchanged so the
// wire shape matches Pydantic byte-for-byte (mirrors arbitration_intent.v1.ts). We re-author the
// ge/le range invariant by hand via .superRefine(); there is intentionally NO decimal-places cap.
//
// NOTE on `suppressed_at`: nullable Pydantic `datetime`; model_dump(mode="json") emits an RFC3339
// string. The repo canonicalizer (test/parity/canonical.ts) normalizes both the Pydantic "...Z"
// form and JS Date.toISOString to microsecond-precision UTC, so any RFC3339 string round-trips.

export const MAX_REASON_CHARS = 2048;
export const MAX_MODEL_CHARS = 200;
export const MAX_PROMPT_VERSION_CHARS = 64;

// SuppressionState = Literal["NONE", "SUPPRESSED_BY_LLM", "SUPPRESSED_BY_POLICY"].
// SUPPRESSED_BY_DUPLICATE_MERGE was removed 2026-05-17 (no producer; reserved-unreachable PG label).
export const SuppressionState = z.enum(["NONE", "SUPPRESSED_BY_LLM", "SUPPRESSED_BY_POLICY"]);
export type SuppressionState = z.infer<typeof SuppressionState>;

// Canonical decimal text in [0, 1]: a non-negative number with optional fractional digits.
// Restricting to the canonical Decimal form keeps the pass-through string identical to Pydantic's
// model_dump output. The frozen contract has NO decimal_places cap, so fractional length is open.
// eslint-disable-next-line security/detect-unsafe-regex -- bounded + anchored, no nested/ambiguous quantifiers (no ReDoS); mirrors the frozen Pydantic contract pattern
const CONFIDENCE_TEXT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

const confidenceField = z
  .string()
  .regex(CONFIDENCE_TEXT, "suppression_confidence must be a canonical non-negative decimal string")
  .superRefine((value, ctx) => {
    const n = Number(value);
    if (!(n >= 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "suppression_confidence must be >= 0" });
    if (!(n <= 1)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "suppression_confidence must be <= 1" });
  });

// ArbitrationDecisionV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// The single @model_validator(mode="after") `_check_metadata_invariant` is re-authored below as
// .superRefine(); it mirrors migration 0083 CHECK ck_review_findings_suppression_metadata.
export const ArbitrationDecisionV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    // Pydantic uuid.UUID: validates UUID syntax, model_dump emits lowercase canonical form.
    finding_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    suppression_state: SuppressionState,
    suppression_reason: z.string().max(MAX_REASON_CHARS).nullable().default(null),
    // Decimal in [0, 1], carried as its canonical string form (see header note). Nullable, default null.
    suppression_confidence: confidenceField.nullable().default(null),
    suppression_model: z.string().max(MAX_MODEL_CHARS).nullable().default(null),
    suppression_prompt_version: z.string().max(MAX_PROMPT_VERSION_CHARS).nullable().default(null),
    // Pydantic datetime → RFC3339 string on dump (see header note). Nullable, default null.
    suppressed_at: z.string().datetime({ offset: true }).nullable().default(null),
    suppressed_by_finding_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase())
      .nullable()
      .default(null),
  })
  .strict()
  // @model_validator(mode="after") _check_metadata_invariant — all-or-nothing.
  // NONE → every suppression_* field must be None; non-NONE → reason + confidence + suppressed_at required.
  .superRefine((v, ctx) => {
    if (v.suppression_state === "NONE") {
      // NONE → every suppression_* field must be null. Explicit [name, value] pairs (no dynamic
      // indexing) keep this loop free of object-injection sinks.
      const noneFields: ReadonlyArray<readonly [string, unknown]> = [
        ["suppression_reason", v.suppression_reason],
        ["suppression_confidence", v.suppression_confidence],
        ["suppression_model", v.suppression_model],
        ["suppression_prompt_version", v.suppression_prompt_version],
        ["suppressed_at", v.suppressed_at],
        ["suppressed_by_finding_id", v.suppressed_by_finding_id],
      ];
      for (const [field, value] of noneFields) {
        if (value !== null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `suppression_state=NONE requires ${field} to be None`,
          });
        }
      }
    } else {
      // non-NONE → reason + confidence + suppressed_at are required (must be non-null).
      const requiredFields: ReadonlyArray<readonly [string, unknown]> = [
        ["suppression_reason", v.suppression_reason],
        ["suppression_confidence", v.suppression_confidence],
        ["suppressed_at", v.suppressed_at],
      ];
      for (const [field, value] of requiredFields) {
        if (value === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `suppression_state=${v.suppression_state} requires ${field} to be populated`,
          });
        }
      }
    }
  });
export type ArbitrationDecisionV1 = z.infer<typeof ArbitrationDecisionV1>;
