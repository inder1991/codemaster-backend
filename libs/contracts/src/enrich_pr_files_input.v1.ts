import { z } from "zod";

// Typed single-arg input envelope for the `enrich_pr_files_activity_v2` activity (CLAUDE.md
// invariant 11 — exactly one positional Pydantic/Zod-model argument per Temporal activity; ADR-0047).
//
// The frozen Python `EnrichPrFilesActivityV2.enrich_pr_files_v2`
// (vendor/codemaster-py/codemaster/activities/enrich_pr_files_v2.py) is a MULTI-positional activity,
// dispatched by the workflow body (vendor/codemaster-py/codemaster/workflows/review_pull_request.py
// ~L819) as:
//
//     workflow.execute_activity(
//         "enrich_pr_files_activity_v2",
//         args=[
//             typed_payload.installation_id,            # uuid.UUID  → installation_id_uuid
//             typed_payload.github_installation_id,     # int        → installation_id_int
//             typed_payload.repository_id,              # uuid.UUID
//             typed_payload.pr_id,                      # uuid.UUID
//             typed_payload.gh_owner,                   # str        → owner
//             typed_payload.gh_repo_name,               # str        → repo
//             typed_payload.pr_number,                  # int
//         ],
//         ...,
//     )
//
// pre-dating the ADR-0047 single-typed-input convention. The TS port introduces this envelope so the
// activity dispatch is positional-arg-free at the Temporal seam — consistent with the other ported
// activities (post_review_input.v1 etc.). It is NOT a parity-validated 1:1 of an existing Python
// contract (there is no Python `EnrichPrFilesInputV1`); it is the activity-input contract the port
// adds. The Workflow phase (which wires the dispatch) constructs this envelope from the seven payload
// fields above.
//
// Field shapes (read off the dispatch arg order + the frozen activity signature
// `enrich_pr_files_v2(installation_id_uuid, installation_id_int, repository_id, pr_id, owner, repo,
// pr_number)`):
//  - installation_id:        uuid.UUID  — the FK installation id (the `installation_id` column the
//                            persisted pr_files rows carry). Lowercased UUID string on the wire.
//  - github_installation_id: int (ge=0) — the NUMERIC GitHub-API installation id the GitHub client
//                            authenticates the files-fetch with. The workflow only dispatches this
//                            activity when the payload's `github_installation_id is not None`
//                            (review_pull_request.py guard), so it is REQUIRED here (not nullable).
//  - repository_id:          uuid.UUID  — the repo FK the persisted rows carry. Lowercased UUID string.
//  - pr_id:                  uuid.UUID  — the logical PR identity (posted_reviews / pr_files key).
//  - gh_owner:               str (1..200)  — GitHub owner/org login.
//  - gh_repo_name:           str (1..200)  — bare repo name (NOT "owner/name").
//  - pr_number:              int (ge=1)    — the GitHub PR number.
//
// No float fields. UUIDs spelled lowercase so a Pydantic-lowercased dump round-trips through Zod's
// pass-through. ConfigDict(extra="forbid") analogue → .strict().
export const EnrichPrFilesInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    installation_id: z.string().uuid(),
    github_installation_id: z.number().int().gte(0),
    repository_id: z.string().uuid(),
    pr_id: z.string().uuid(),
    gh_owner: z.string().min(1).max(200),
    gh_repo_name: z.string().min(1).max(200),
    pr_number: z.number().int().gte(1),
  })
  .strict();

export type EnrichPrFilesInputV1 = z.infer<typeof EnrichPrFilesInputV1>;
