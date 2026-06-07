import { z } from "zod";

// Zod port of the `IssueLink` frozen dataclass from
// `vendor/codemaster-py/codemaster/ingest/issue_link_parser.py` (Sprint 21 / S21.DM.10).
//
// `IssueLink` is the parser's output type and the row shape of `core.pr_issue_links`. It is the
// INPUT to `assemble_linked_issues` (the walkthrough assembler), and the row type returned by the
// `list_links_for_pr` repo read. The Python source is a `@dataclass(frozen=True, slots=True)`, not a
// Pydantic model — but the TS port models it as a Zod schema for the read-path's row validation and
// to give the assembler a single source-of-truth type.
//
// Field mapping (1:1 with the Python dataclass + the `LinkageKind` / `LinkageSource` Literals):
//  - github_issue_number: int                       → z.number().int() (CHECK >= 1 lives in the DB).
//  - linkage_kind: Literal["closes","fixes","resolves","mentioned"] → z.enum.
//  - source: Literal["description","title","branch_name","commit_message"] → z.enum.
//
// There is NO schema_version: the dataclass has none (it is an in-process / DB-row shape, not a
// versioned wire envelope). `.strict()` rejects unknown keys for defence-in-depth on the read path.

export const LinkageKind = z.enum(["closes", "fixes", "resolves", "mentioned"]);
export type LinkageKind = z.infer<typeof LinkageKind>;

export const LinkageSource = z.enum(["description", "title", "branch_name", "commit_message"]);
export type LinkageSource = z.infer<typeof LinkageSource>;

export const IssueLink = z
  .object({
    github_issue_number: z.number().int(),
    linkage_kind: LinkageKind,
    source: LinkageSource,
  })
  .strict();

export type IssueLink = z.infer<typeof IssueLink>;
