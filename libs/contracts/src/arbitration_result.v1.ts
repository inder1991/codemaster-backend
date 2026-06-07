import { z } from "zod";

import { ArbitrationDecisionV1 } from "./finding_arbitration.v1.js";

// Zod port of the `ArbitrationResult` + `RejectedIntent` + `RejectionReason` types from the frozen Python
// arbitration LAYER (`vendor/codemaster-py/codemaster/review/arbitration_layer.py`). In the Python these
// are `@dataclass(frozen=True, slots=True)` value objects (NOT Pydantic / NOT `contracts/` models) — they
// are the in-memory output of the pure `arbitrate()` function. We re-author them as `#contracts` Zod
// schemas here because the activity returns the result over the Temporal boundary (so it IS a cross-process
// data interface) and the workflow-body footer renderer + `pipeline_result.ts` consume it. Parity-validated
// in apply_arbitration.parity.test.ts (the result wire shape is diffed against the frozen `arbitrate`).
//
// ── Wire-shape notes (how the Python dataclasses serialize) ──
//
// `ArbitrationResult.decisions` is `tuple[ArbitrationDecisionV1, ...]` — each is a Pydantic model that
// dumps via model_dump(mode="json") (string suppression_confidence, RFC3339 suppressed_at). We reuse the
// already-ported {@link ArbitrationDecisionV1} contract verbatim (it carries its own metadata-invariant
// superRefine).
//
// `ArbitrationResult.rejected_intents` is `tuple[RejectedIntent, ...]`. `RejectedIntent` is a plain
// dataclass: `target_finding_id: uuid.UUID`, `reason_rejected: RejectionReason`,
// `intent_confidence: Decimal | None = None`, `intent_reason: str | None = None`. A dataclass has NO
// model_dump — the parity driver encodes it by hand (UUID→lowercase string, Decimal→string, None→null),
// matching what the persistence path binds. We model `intent_confidence` as a canonical-decimal STRING
// (mirroring arbitration_intent.v1 / finding_arbitration.v1) so the wire shape is byte-identical to the
// Decimal's textual form; nullable because the duplicate_intent_loser / target_not_found paths still carry
// the intent's confidence but the keep/reject paths populate it from the intent.

// RejectionReason = Literal["target_not_found", "below_min_confidence", "policy_forbids",
// "duplicate_intent_loser"]. Matches the migration-0086 CHECK ck_arbitration_rejections_reason exactly.
export const RejectionReason = z.enum([
  "target_not_found",
  "below_min_confidence",
  "policy_forbids",
  "duplicate_intent_loser",
]);
export type RejectionReason = z.infer<typeof RejectionReason>;

// Canonical decimal text in [0, 1]: a non-negative number with optional fractional digits — same idiom as
// finding_arbitration.v1's suppression_confidence (the underlying Decimal carries no decimal_places cap).
// eslint-disable-next-line security/detect-unsafe-regex -- bounded + anchored, no nested/ambiguous quantifiers (no ReDoS); mirrors the frozen Pydantic contract pattern
const CONFIDENCE_TEXT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

const confidenceField = z
  .string()
  .regex(CONFIDENCE_TEXT, "intent_confidence must be a canonical non-negative decimal string")
  .superRefine((value, ctx) => {
    const n = Number(value);
    if (!(n >= 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "intent_confidence must be >= 0" });
    if (!(n <= 1)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "intent_confidence must be <= 1" });
  });

// RejectedIntent — the observability side-channel value object. The pattern is a dataclass on the Python
// side; we re-author it as a .strict() Zod object (extra keys rejected, mirroring the frozen slots=True
// dataclass's fixed field set).
export const RejectedIntent = z
  .object({
    target_finding_id: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    reason_rejected: RejectionReason,
    // Decimal | None = None — canonical-decimal string or null.
    intent_confidence: confidenceField.nullable().default(null),
    intent_reason: z.string().nullable().default(null),
  })
  .strict();
export type RejectedIntent = z.infer<typeof RejectedIntent>;

// ArbitrationResult — the output envelope of the pure arbitrate(): the final decisions + the rejected-intent
// observability side-channel. .strict() mirrors the frozen dataclass's fixed two-field shape.
export const ArbitrationResultV1 = z
  .object({
    decisions: z.array(ArbitrationDecisionV1),
    rejected_intents: z.array(RejectedIntent),
  })
  .strict();
export type ArbitrationResultV1 = z.infer<typeof ArbitrationResultV1>;
