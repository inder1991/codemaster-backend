import { z } from "zod";

import { PublicationOutcome } from "./posted_review.v1.js";

// Zod port of contracts/review_pull_request/payload_v1.py (frozen Python). Parity-validated in
// review_pull_request.v1.parity.test.ts.
//
// NON-STANDARD layout: the Python contract lives in a versioned FILE (payload_v1.py), not a v1/
// directory, so its module path is `contracts.review_pull_request.payload_v1` (used by the oracle).
//
// Source models / constants ported (every public one):
//  - ReviewPullRequestPayloadV1 (ConfigDict extra="forbid", frozen=True) → .strict().
//    No enums, no module-level constants, no @model_validator / @field_validator — every field is a
//    plain Pydantic Field with min/max/ge constraints, so there is NO .superRefine() needed.
//
// FIELD-PORT NOTES:
//  - schema_version: Python `Literal[2] = 2` (Phase 4 Task 7b HARD-CUT — v1 payloads rejected at the
//    boundary). NOT a bare int, so Pydantic re-emits exactly `2` → z.literal(2).default(2). A
//    schema_version of 1 (or anything != 2) is REJECTED by both sides.
//  - installation_id / repository_id / pr_id / run_id / review_id: Pydantic `uuid.UUID`. Lowercased on
//    model_dump(mode="json") → z.string().uuid() (the parity test feeds lowercase UUIDs / lowercases
//    Zod output to match the Pydantic dump, per the outbox_payloads.v1 template).
//  - pr_number: int = Field(ge=1) → z.number().int().gte(1).
//  - head_sha: exactly-40-char str (StringConstraints min_length=40, max_length=40) →
//    z.string().min(40).max(40).
//  - gh_owner / gh_repo_name: str, 1..200 → z.string().min(1).max(200).
//  - pr_title: str, max 500 (no min) → z.string().max(500).
//  - pr_description: str, max 10_000 (no min) → z.string().max(10000).
//  - delivery_id: str, 1..200 → z.string().min(1).max(200).
//  - policy_revision: int = Field(ge=0) → z.number().int().gte(0).
//  - github_installation_id: int | None = Field(default=None, ge=0) →
//    z.number().int().gte(0).nullable().default(null).
//  - author_login: str | None, max 64 → z.string().max(64).nullable().default(null).
//  - draft: bool = False → z.boolean().default(false).
//  - base_ref / head_ref: str | None, max 255 → z.string().max(255).nullable().default(null).
//  - opened_at: datetime | None = None → PLAIN datetime (no tz validator), so Pydantic accepts naive
//    OR tz-aware → z.string().datetime({ offset: true, local: true }).nullable().default(null).

export const ReviewPullRequestPayloadV1 = z
  .object({
    schema_version: z.literal(2).default(2),
    installation_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    pr_id: z.string().uuid(),
    pr_number: z.number().int().gte(1),
    head_sha: z.string().min(40).max(40),
    gh_owner: z.string().min(1).max(200),
    gh_repo_name: z.string().min(1).max(200),
    pr_title: z.string().max(500),
    pr_description: z.string().max(10000),
    delivery_id: z.string().min(1).max(200),
    policy_revision: z.number().int().gte(0),
    run_id: z.string().uuid(),
    review_id: z.string().uuid(),
    github_installation_id: z.number().int().gte(0).nullable().default(null),
    author_login: z.string().max(64).nullable().default(null),
    draft: z.boolean().default(false),
    base_ref: z.string().max(255).nullable().default(null),
    head_ref: z.string().max(255).nullable().default(null),
    opened_at: z.string().datetime({ offset: true, local: true }).nullable().default(null),
  })
  .strict();
export type ReviewPullRequestPayloadV1 = z.infer<typeof ReviewPullRequestPayloadV1>;

// ─── ReviewPullRequestResultV1 — the @workflow.run RETURN contract ────────────────────────────────
//
// Zod port of the frozen Python `ReviewPullRequestResultV1`
// (vendor/codemaster-py/codemaster/workflows/review_pull_request.py:417) — the terminal envelope the
// ReviewPullRequestWorkflow returns to its caller (start_review_for_webhook / the workflow-result
// persistence / analytics). The Python contract lives in the WORKFLOW module (not contracts/), so this is
// a port-introduced contract; its constituent `PublicationOutcome` IS parity-validated in posted_review.v1.
//
// FIELD-PORT NOTES (1:1 with the Python BaseModel(extra="forbid")):
//  - schema_version: Python `int = 1` (PLAIN int, NOT Literal) → z.number().int().default(1) (a literal
//    would false-reject a future schema_version=2). NOTE: this is the RESULT envelope's own
//    schema_version (1), distinct from the v2 PAYLOAD envelope above.
//  - status: Python `Literal[...]` over the 5 status strings → z.enum([...]). The spine happy path emits
//    "accepted"; the gate-skip statuses (skipped_busy / skipped_disabled) + the bcompat statuses
//    (closed / skipped_legacy_payload) are Stage-2/3 surfaces but stay in the enum so the contract is
//    shape-complete (a future gate-port emits them without a contract change).
//  - pr_number: int (REQUIRED, no ge — the Python field carries no Field(ge=…)) → z.number().int().
//  - review_id: str | None = None → z.string().nullable().default(null). Python stringifies the int
//    review id (`str(review_id_int)`) — the wire form is a string, NOT a UUID; left a bare str here.
//  - findings_count: int = 0 → z.number().int().default(0).
//  - mutex_id: str | None = None → z.string().nullable().default(null). Stage-2 lifecycle field; the thin
//    body never holds a mutex, so it is always null here (matches the Python `mutex_id=None` at return —
//    "already released; don't expose to caller").
//  - installation_id / pr_id: uuid.UUID | None = None → z.string().uuid().nullable().default(null)
//    (Pydantic lowercases on model_dump(mode="json"); surfaced so observers correlate the result back to
//    the DM tables). The thin body sets them from the typed payload.
//  - publication_outcome: PublicationOutcome | None = None → PublicationOutcome.nullable().default(null).
//    None when no publication actually happened (the orchestrator raised before post_review).
export const ReviewPullRequestResultV1 = z
  .object({
    schema_version: z.number().int().default(1),
    status: z.enum([
      "accepted",
      "skipped_busy",
      "skipped_disabled",
      "closed",
      "skipped_legacy_payload",
    ]),
    pr_number: z.number().int(),
    review_id: z.string().nullable().default(null),
    findings_count: z.number().int().default(0),
    mutex_id: z.string().nullable().default(null),
    installation_id: z.string().uuid().nullable().default(null),
    pr_id: z.string().uuid().nullable().default(null),
    publication_outcome: PublicationOutcome.nullable().default(null),
  })
  .strict();
export type ReviewPullRequestResultV1 = z.infer<typeof ReviewPullRequestResultV1>;
