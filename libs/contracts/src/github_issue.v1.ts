import { z } from "zod";

// Zod port of contracts/github_issue/v1.py::GithubIssueV1 (frozen Python).
// One row of `core.github_issues_cache` (DM-WIRE T4 / S22.DM.16). Parity-validated in
// github_issue.v1.parity.test.ts.
//
// Source members ported (every public one in v1.py):
//  - GithubIssueV1 — ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side
//    concern, not wire). No enums/constants/helpers beyond the inline state Literal below.
//
// Field notes:
//  - schema_version: int = 1 → z.number().int().default(1) (NOT z.literal — a literal would
//    false-reject schema_version=2 on a forward-compat wire read).
//  - UUID fields (github_issue_cache_id / installation_id / repository_id) are emitted by Pydantic
//    model_dump(mode="json") as lowercase RFC4122 strings; on the wire they are strings, so the Zod
//    port validates the string form via z.string().uuid().
//  - state: Literal["open", "closed"] → z.enum (matches GitHub's /issues/{n} response).
//  - body / etag: `= None` defaults → .nullable().default(null) (Pydantic dumps absent fields as
//    explicit null, so the Zod default must inject null too).
//  - cached_at: datetime (required, non-nullable) — ISO-8601 string on the wire.

export const GithubIssueV1 = z
  .object({
    schema_version: z.number().int().default(1),
    github_issue_cache_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    // Field(ge=1, le=999_999_999).
    github_issue_number: z.number().int().gte(1).lte(999_999_999),
    // Field(min_length=0, max_length=500) — empty title permitted.
    title: z.string().min(0).max(500),
    body: z.string().nullable().default(null),
    state: z.enum(["open", "closed"]),
    // Field(default=None, max_length=64).
    etag: z.string().max(64).nullable().default(null),
    cached_at: z.string().datetime({ offset: true }),
  })
  .strict();

export type GithubIssueV1 = z.infer<typeof GithubIssueV1>;
