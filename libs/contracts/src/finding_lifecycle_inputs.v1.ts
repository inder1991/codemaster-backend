import { z } from "zod";

// Zod port of contracts/finding_lifecycle_inputs/v1.py (frozen Python — B.10 / ADR-0056).
// Parity-validated in finding_lifecycle_inputs.v1.parity.test.ts.
//
// Three activity-input contracts for the finding-lifecycle setter activities
// (record_delivery_finalized / record_delivery_skipped / record_delivery_degraded).
// Every contract is ConfigDict(frozen=True, extra="forbid") → .strict() (frozen is a TS-side
// concern, not wire). schema_version is a bare Python `int` default 1 → z.number().int().default(1)
// (NOT z.literal — that would false-reject schema_version=2 on a future bump).
//
// UUID fields (run_id, review_id, posted_review_pr_id) and tuples of UUIDs (rfids) are emitted by
// Pydantic model_dump(mode="json") as lowercase RFC4122 strings, so the Zod port validates the string
// form and lowercases (Pydantic lowercases UUIDs on dump). installation_id is intentionally `str`
// (JSON-friendly across the Temporal wire). comment_ids is tuple[int, ...] → array of ints.
//
// Each tuple field is required in Python (Field(...)), so the Zod array has NO default — an omitted
// rfids/comment_ids/reasons must reject in both layers.

// FRAG-7 (PA audit v2): rfids cap matches the aggregator's hard 50-finding cap. comment_ids / reasons
// inherit the same cap (one entry per rfid).
export const LIFECYCLE_RFIDS_MAX_LENGTH = 50;

// L-3 (PA audit v2): single source of truth for the degraded-outcome vocabulary.
// record_delivery_degraded accepts ONLY these values; finalize / skip own inline_delivered /
// not_applicable respectively. The pattern below derives from this set (no duplication).
export const DEGRADED_OUTCOMES: ReadonlyArray<string> = ["body_only_fallback", "failed"] as const;

// Regex derived from DEGRADED_OUTCOMES; sorted for a stable string representation (mirrors the frozen
// Python `_DEGRADED_OUTCOME_PATTERN = "^(" + "|".join(sorted(DEGRADED_OUTCOMES)) + ")$"`).
// The source is a module-private const array of literal strings (no external/runtime input), so the
// non-literal RegExp constructor here is not a ReDoS / injection vector.
// eslint-disable-next-line security/detect-non-literal-regexp -- pattern derived from the trusted module-private DEGRADED_OUTCOMES literal set; mirrors the frozen Pydantic contract's set-derived pattern
export const DEGRADED_OUTCOME_PATTERN = new RegExp(
  "^(" + [...DEGRADED_OUTCOMES].sort().join("|") + ")$",
);

// uuid.UUID → string; Pydantic model_dump(mode="json") emits lowercase canonical form.
const uuidLower = (): z.ZodEffects<z.ZodString, string, string> =>
  z
    .string()
    .uuid()
    .transform((s) => s.toLowerCase());

// FinalizedInputV1 — input for record_delivery_finalized_activity.
// @model_validator(mode="after") _check_parity (len(rfids) == len(comment_ids)) → .superRefine().
export const FinalizedInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    installation_id: z.string().min(1),
    run_id: uuidLower(),
    review_id: uuidLower(),
    rfids: z.array(uuidLower()).max(LIFECYCLE_RFIDS_MAX_LENGTH),
    comment_ids: z.array(z.number().int()).max(LIFECYCLE_RFIDS_MAX_LENGTH),
    posted_review_pr_id: uuidLower(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.rfids.length !== v.comment_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comment_ids"],
        message: `FinalizedInputV1 parity violation: rfids=${v.rfids.length} vs comment_ids=${v.comment_ids.length}`,
      });
    }
  });
export type FinalizedInputV1 = z.infer<typeof FinalizedInputV1>;

// SkippedInputV1 — input for record_delivery_skipped_activity.
// @model_validator(mode="after") _check_parity (len(rfids) == len(reasons)) → .superRefine().
export const SkippedInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    installation_id: z.string().min(1),
    run_id: uuidLower(),
    review_id: uuidLower(),
    rfids: z.array(uuidLower()).max(LIFECYCLE_RFIDS_MAX_LENGTH),
    reasons: z.array(z.string()).max(LIFECYCLE_RFIDS_MAX_LENGTH),
    posted_review_pr_id: uuidLower(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.rfids.length !== v.reasons.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasons"],
        message: `SkippedInputV1 parity violation: rfids=${v.rfids.length} vs reasons=${v.reasons.length}`,
      });
    }
  });
export type SkippedInputV1 = z.infer<typeof SkippedInputV1>;

// DegradedInputV1 — input for record_delivery_degraded_activity.
// outcome: str = Field(pattern=_DEGRADED_OUTCOME_PATTERN) → z.string().regex(DEGRADED_OUTCOME_PATTERN).
export const DegradedInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    installation_id: z.string().min(1),
    run_id: uuidLower(),
    review_id: uuidLower(),
    rfids: z.array(uuidLower()).max(LIFECYCLE_RFIDS_MAX_LENGTH),
    outcome: z.string().regex(DEGRADED_OUTCOME_PATTERN),
    posted_review_pr_id: uuidLower(),
  })
  .strict();
export type DegradedInputV1 = z.infer<typeof DegradedInputV1>;
