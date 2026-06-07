import { z } from "zod";

// Zod port of the frozen Python `codemaster/activities/_record_review_lifecycle_inputs.py` (Phase 4
// Task 4 + BF-5 + BF-13). Parity-validated in record_review_lifecycle_inputs.v1.parity.test.ts.
//
// Four activity-input contracts for the run-state lifecycle activities:
//   - RecordReviewLifecycleEventInput → record_review_lifecycle_event_activity (emits ANALYSIS_STARTED
//     / ANALYZED granular audit.workflow_events rows; idempotent on retry).
//   - FinalizeReviewRunInput          → finalize_review_run_activity (review_runs RUNNING→COMPLETED).
//   - RecordRunFailedInput            → record_run_failed_activity (BF-5; RUNNING→FAILED).
//   - RecordRunCancelledInput         → record_run_cancelled_activity (BF-13; RUNNING→CANCELLED).
//
// Every model is `model_config = ConfigDict(extra="ignore")` → the Zod port `.strip()`s unknown keys
// (NOT `.strict()` — Pydantic IGNORES extras here rather than forbidding them). The classes are tagged
// `__contract_internal__ = True` in Python (a TS-side / contract-lint concern, not a wire concern).
//
// UUID fields (installation_id on the event input; run_id / review_id on all four) are emitted by
// Pydantic `model_dump(mode="json")` as lowercase RFC4122 strings, so the Zod port validates the string
// form and `.transform()`s to lowercase (Pydantic lowercases UUIDs on dump). NOTE: unlike the
// finding-lifecycle inputs (where installation_id is a JSON-friendly bare `str`), the event input's
// `installation_id` is a Pydantic `uuid.UUID` (BF-3 Phase B), so it is validated + lowercased here too.
//
// `schema_version` on RecordReviewLifecycleEventInput is `Literal[2] = 2` → `z.literal(2).default(2)`
// (NOT a plain int — the BF-3 Phase B shape bumped 1→2; a future bump introduces a NEW literal so an
// unexpected schema_version must reject). The other three inputs carry NO schema_version field.

// uuid.UUID → string; Pydantic model_dump(mode="json") emits lowercase canonical form.
const uuidLower = (): z.ZodEffects<z.ZodString, string, string> =>
  z
    .string()
    .uuid()
    .transform((s) => s.toLowerCase());

// RecordReviewLifecycleEventInput — input for record_review_lifecycle_event_activity.
// installation_id: uuid.UUID (required, BF-3 Phase B). provider: str = Field(default="github",
// min_length=1). event_type: str (required, no default). payload: dict[str, Any] = Field(
// default_factory=dict). schema_version: Literal[2] = 2.
export const RecordReviewLifecycleEventInput = z
  .object({
    schema_version: z.literal(2).default(2),
    installation_id: uuidLower(),
    run_id: uuidLower(),
    review_id: uuidLower(),
    provider: z.string().min(1).default("github"),
    event_type: z.string(),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strip();
export type RecordReviewLifecycleEventInput = z.infer<typeof RecordReviewLifecycleEventInput>;

// FinalizeReviewRunInput — input for finalize_review_run_activity.
// run_id / review_id: uuid.UUID (required). attempt: int = Field(default=1, ge=1).
// duration_ms: int | None = Field(default=None, ge=0). worker_id: str | None = None.
export const FinalizeReviewRunInput = z
  .object({
    run_id: uuidLower(),
    review_id: uuidLower(),
    attempt: z.number().int().min(1).default(1),
    duration_ms: z.number().int().min(0).nullable().default(null),
    worker_id: z.string().nullable().default(null),
  })
  .strip();
export type FinalizeReviewRunInput = z.infer<typeof FinalizeReviewRunInput>;

// RecordRunFailedInput — input for record_run_failed_activity (BF-5).
// run_id / review_id: uuid.UUID (required). reason: str = Field(min_length=1, max_length=500)
// (required, no default). attempt: int = Field(default=1, ge=1).
export const RecordRunFailedInput = z
  .object({
    run_id: uuidLower(),
    review_id: uuidLower(),
    reason: z.string().min(1).max(500),
    attempt: z.number().int().min(1).default(1),
  })
  .strip();
export type RecordRunFailedInput = z.infer<typeof RecordRunFailedInput>;

// RecordRunCancelledInput — input for record_run_cancelled_activity (BF-13).
// Shape identical to RecordRunFailedInput (run_id / review_id / reason min=1 max=500 / attempt ge=1).
export const RecordRunCancelledInput = z
  .object({
    run_id: uuidLower(),
    review_id: uuidLower(),
    reason: z.string().min(1).max(500),
    attempt: z.number().int().min(1).default(1),
  })
  .strip();
export type RecordRunCancelledInput = z.infer<typeof RecordRunCancelledInput>;
