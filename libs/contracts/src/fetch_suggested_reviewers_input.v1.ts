import { z } from "zod";

// NEW typed-input envelope introduced DURING the Python→TS port — there is NO Python Pydantic
// counterpart to diff against. The frozen Python
// `FetchSuggestedReviewersActivity.fetch_suggested_reviewers`
// (vendor/codemaster-py/codemaster/activities/fetch_suggested_reviewers.py) dispatches with THREE
// positional arguments — (installation_id, repository_id, pr_id) — which violates CLAUDE.md invariant
// 11 / ADR-0047 ("every Temporal activity takes EXACTLY ONE positional argument typed as a Pydantic v2
// BaseModel"). The TS port CLOSES that violation: the activity's single positional input is this
// `FetchSuggestedReviewersInputV1` envelope (consistent with the classify_files.v1 /
// aggregate_findings.v1 envelopes that closed sibling invariant-11 dispatches).
//
// Because there is no Python contract for this envelope, there is no source-of-truth to byte-diff
// against; `.strict()` rejects unknown keys.
//
// Field mapping:
//  - installation_id: uuid.UUID → z.string().uuid(). DB-internal installation identity; used for the
//    tenancy-scoped pr_files + code_owners reads. (Suggested-reviewers does NOT call the GitHub API, so
//    unlike fetch_linked_issues there is NO separate integer installation id.)
//  - repository_id: uuid.UUID → z.string().uuid(). Tenancy-scoped FK for the CODEOWNERS-rules read.
//  - pr_id: uuid.UUID → z.string().uuid(). The PR whose changed-file paths to rank against.
//  - schema_version: int = 1 → z.number().int().default(1) (NOT z.literal(1): a literal would
//    false-reject a future schema_version=2 wire payload).

export const FetchSuggestedReviewersInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    installation_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    pr_id: z.string().uuid(),
  })
  .strict();
export type FetchSuggestedReviewersInputV1 = z.infer<typeof FetchSuggestedReviewersInputV1>;
