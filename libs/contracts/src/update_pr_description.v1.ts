import { z } from "zod";

import { AggregatedFindingsV1 } from "./aggregated_findings.v1.js";

// ─── UpdatePrDescriptionInputV1 — the NEW typed-input envelope (CLAUDE.md invariant 11 / ADR-0047) ──
//
// The frozen Python `UpdatePrDescriptionSummaryActivity.update_pr_description_summary` dispatches with
// FOUR positional arguments — `update_pr_description_summary(owner, repo, pr_number, aggregated)` (see
// vendor/codemaster-py/codemaster/activities/update_pr_description_summary.py + the workflow-body
// `workflow.execute_activity("update_pr_description_summary", args=[owner, repo, pr_number, aggregated])`
// dispatch at review_pull_request.py). That violates CLAUDE.md invariant 11 / ADR-0047 ("every Temporal
// activity takes EXACTLY ONE positional argument typed as a Pydantic v2 BaseModel"). The TS port CLOSES
// that violation: the activity's single positional input is this `UpdatePrDescriptionInputV1` envelope
// (consistent with the post_check_run.v1 / persist_review_findings.v1 envelopes that closed the other
// known live invariant-11 dispatches).
//
// There is NO Python Pydantic counterpart to byte-diff against — the envelope is introduced DURING the
// port — so the parity test covers round-trip / validation only.
//
// Field mapping (mirrors the 4 positional args 1:1):
//   - `owner: str`      → z.string().  The repository owner login.
//   - `repo: str`       → z.string().  The repository name. (The frozen activity threads it through to
//     the GitHub PR endpoint `/repos/{owner}/{repo}/pulls/{pr_number}` unchanged.)
//   - `pr_number: int`  → z.number().int().  The PR number.
//   - `aggregated: AggregatedFindingsV1`  → the already-ported AggregatedFindingsV1 contract. Carries
//     the deduped/ranked findings tuple the summary block is rendered from.
//   - `schema_version: int = 1` → z.number().int().default(1) (NOT z.literal(1): a literal would
//     false-reject a future schema_version=2 wire payload; mirrors the PostCheckRunInputV1 reasoning).
//
// NOTE on nested `confidence`: the embedded AggregatedFindingsV1.findings[*] is a ReviewFindingV1, which
// carries a bare Python `float` (`confidence`). model_dump(mode="json") emits `1.0` while a JS number `1`
// emits `1`, so a byte-level canonicalizer cannot match that one nested column — but THIS contract's
// parity test only covers round-trip / validation (no Python envelope exists to byte-diff), so the
// confidence quirk does not surface here. The summary RENDER (build_summary_markdown) reads only
// `finding.category`, never `confidence`, so the render parity is unaffected.
//
// `.strict()` mirrors the (would-be) Pydantic ConfigDict(extra="forbid") shape; the additive
// `schema_version` default keeps a bare `{owner, repo, pr_number, aggregated}` payload valid.

export const UpdatePrDescriptionInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    owner: z.string(),
    repo: z.string(),
    pr_number: z.number().int(),
    aggregated: AggregatedFindingsV1,
  })
  .strict();
export type UpdatePrDescriptionInputV1 = z.infer<typeof UpdatePrDescriptionInputV1>;
