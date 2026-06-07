import { z } from "zod";

// NEW typed-input envelope introduced DURING the Python→TS port — there is NO Python Pydantic
// counterpart to diff against. The frozen Python `FetchLinkedIssuesActivity.fetch_linked_issues`
// (vendor/codemaster-py/codemaster/activities/fetch_linked_issues.py) dispatches with SIX positional
// arguments —
//   (installation_id_uuid, installation_id_int, repository_id, pr_id, owner, repo)
// — which violates CLAUDE.md invariant 11 / ADR-0047 ("every Temporal activity takes EXACTLY ONE
// positional argument typed as a Pydantic v2 BaseModel"). The TS port CLOSES that violation: the
// activity's single positional input is this `FetchLinkedIssuesInputV1` envelope (consistent with the
// classify_files.v1 / aggregate_findings.v1 envelopes that closed sibling invariant-11 dispatches).
//
// Because there is no Python contract for this envelope, there is no source-of-truth to byte-diff
// against; `.strict()` rejects unknown keys.
//
// Field mapping:
//  - installation_id_uuid: uuid.UUID → z.string().uuid(). Our DB-internal installation identity; used
//    for tenancy-scoped repo reads/writes (pr_issue_links, github_issues_cache).
//  - installation_id_int: int → z.number().int(). The GitHub-native installation id, passed to the
//    GitHub API client (which keys its token provider on the numeric installation id). DISTINCT from
//    the UUID above — the two identity spaces are not interchangeable.
//  - repository_id: uuid.UUID → z.string().uuid(). Tenancy-scoped FK for the cache upsert.
//  - pr_id: uuid.UUID → z.string().uuid(). The PR whose links to resolve.
//  - owner / repo: str → z.string(). GitHub `owner/repo` slug parts for the issue-lookup URL.
//  - schema_version: int = 1 → z.number().int().default(1) (NOT z.literal(1): a literal would
//    false-reject a future schema_version=2 wire payload).

export const FetchLinkedIssuesInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    installation_id_uuid: z.string().uuid(),
    installation_id_int: z.number().int(),
    repository_id: z.string().uuid(),
    pr_id: z.string().uuid(),
    owner: z.string(),
    repo: z.string(),
  })
  .strict();
export type FetchLinkedIssuesInputV1 = z.infer<typeof FetchLinkedIssuesInputV1>;
