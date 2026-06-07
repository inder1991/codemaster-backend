import { z } from "zod";

// Zod port of the 4 OutboxDispatcherWorkflow activity-input contracts from the frozen Python
// `codemaster/activities/outbox.py` (ClaimPendingRowsInput / DispatchRowInput / MarkDispatchedInput /
// MarkAttemptFailedInput). Parity-validated against the live Pydantic oracle in
// outbox_dispatch.v1.parity.test.ts.
//
// EXTRA-FIELD HANDLING: all four Python models use `ConfigDict(extra="ignore")`, NOT extra="forbid".
// Pydantic drops unknown keys silently; Zod's DEFAULT `.object()` also strips unknown keys (`.strip()`),
// so the two agree by construction. We therefore do NOT call `.strict()` here — this is a deliberate,
// faithful divergence from the spine-activity `.strict()` convention; do not "fix" it to `.strict()`.
//
// JSON-safe activity-input gate (CLAUDE.md invariant 11): every dict is `z.record(z.string())` /
// `z.record(z.unknown())` — string keys only. UUID fields are `z.string().uuid()` (string on the wire),
// never UUID-keyed dicts. Structurally satisfies check_temporal_activity_input_json_safe.

/** Input for the `claimPendingRows` activity. */
export const ClaimPendingRowsInputV1 = z.object({
  batch_size: z.number().int().min(1).max(1000).default(100),
  lease_seconds: z.number().int().min(10).max(300).default(60),
});
export type ClaimPendingRowsInputV1 = z.infer<typeof ClaimPendingRowsInputV1>;

/**
 * Input for the `dispatchRow` activity. BF-3 Phase B: the contract carries `installation_id` plus a tagged
 * `orphan_reason` marker so the INGESTED emit always carries the tenant column. The pair is a TAGGED UNION
 * (`installation_id` is null IFF `orphan_reason` is set) enforced by `.superRefine` below — makes a
 * "legitimate None" (bootstrap-sink row) syntactically distinct from a propagation bug. `schema_version`
 * is Literal[2] (the post-Phase-B shape); the pre-Phase-B shape is implicit v1.
 */
export const DispatchRowInputV1 = z
  .object({
    schema_version: z.literal(2).default(2),
    row_id: z.string().uuid(),
    sink: z.string(),
    payload: z.record(z.unknown()),
    trace_context: z.record(z.string()).default({}),
    run_id: z.string().uuid().nullable().default(null),
    review_id: z.string().uuid().nullable().default(null),
    provider: z.string().nullable().default(null),
    installation_id: z.string().uuid().nullable().default(null),
    orphan_reason: z.literal("bootstrap_sink").nullable().default(null),
  })
  .superRefine((v, ctx) => {
    // Tagged-union invariant: installation_id is None IFF orphan_reason is set (BF-3 Phase B lock #7).
    if (v.installation_id === null && v.orphan_reason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "DispatchRowInput: installation_id is None but no orphan_reason set — this is a propagation " +
          "bug, not a legitimate orphan emit. Set orphan_reason explicitly OR resolve installation_id.",
      });
    }
    if (v.installation_id !== null && v.orphan_reason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "DispatchRowInput: cannot set BOTH installation_id and orphan_reason — they're mutually exclusive.",
      });
    }
  });
export type DispatchRowInputV1 = z.infer<typeof DispatchRowInputV1>;

/** Input for the `markDispatched` activity. */
export const MarkDispatchedInputV1 = z.object({
  row_id: z.string().uuid(),
});
export type MarkDispatchedInputV1 = z.infer<typeof MarkDispatchedInputV1>;

/**
 * Input for the `markAttemptFailed` activity. `expected_attempts` (R-6) is the pre-attempt count projected
 * from `claimPendingRows`; the repo UPDATE guards on `attempts = expected_attempts` so a Temporal redrive
 * becomes a rowcount=0 no-op rather than double-incrementing → spurious dead-letter.
 */
export const MarkAttemptFailedInputV1 = z.object({
  row_id: z.string().uuid(),
  error: z.string().max(1024),
  expected_attempts: z.number().int().min(0).default(0),
});
export type MarkAttemptFailedInputV1 = z.infer<typeof MarkAttemptFailedInputV1>;
