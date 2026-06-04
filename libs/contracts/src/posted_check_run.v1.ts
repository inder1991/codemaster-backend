import { z } from "zod";

import { PrMetaV1 } from "./walkthrough.v1.js";

// ─── PostedCheckRunV1 — the activity RETURN contract ───────────────────────────────────────────
//
// The frozen Python `PostedCheckRunV1` (vendor/codemaster-py/codemaster/activities/post_check_run.py)
// is a `@dataclass(frozen=True, slots=True)` with exactly two fields — `check_run_id: int` +
// `was_update: bool` — and NO `schema_version` (dataclasses carry none). It is NOT a Pydantic contract.
//
// But it CROSSES the Temporal activity boundary (it is the `post_check_run` activity's return value), so
// codemaster's data-contract policy requires a VERSIONED contract here. The port therefore promotes the
// bare dataclass to a Zod contract and ADDS a `schema_version: int = 1` field (consistent with every
// other ported activity-boundary contract). The two load-bearing fields are byte-identical to the Python
// dataclass:
//   - `check_run_id: int`  → z.number().int(). GitHub check-run ids are int64 server-side; the Python
//     impl `int(resp.json()["id"])` coerces the JSON number to int, so the wire value is always an
//     integer. (No safe-integer bound is imposed here — that is a producer concern; the contract mirrors
//     the Python `int` exactly.)
//   - `was_update: bool`   → z.boolean(). TRUE on the update path (an existing run at head_sha was
//     PATCHed), FALSE on the create path (a new run was POSTed).
//
// `.strict()` mirrors the dataclass's fixed 2-field shape (no extra attributes); the additive
// `schema_version` default keeps a bare `{check_run_id, was_update}` payload valid.

export const PostedCheckRunV1 = z
  .object({
    schema_version: z.number().int().default(1),
    check_run_id: z.number().int(),
    was_update: z.boolean(),
  })
  .strict();
export type PostedCheckRunV1 = z.infer<typeof PostedCheckRunV1>;

// ─── PostCheckRunInputV1 — the NEW typed-input envelope (CLAUDE.md invariant 11 / ADR-0047 closure) ──
//
// The frozen Python `PostCheckRunActivity.post_check_run` dispatches with FIVE positional arguments —
// `post_check_run(pr_meta, head_sha, summary, owner, repo_name)` — which violates CLAUDE.md invariant 11
// / ADR-0047 ("every Temporal activity takes EXACTLY ONE positional argument typed as a Pydantic v2
// BaseModel"). The TS port CLOSES that violation: the activity's single positional input is this
// `PostCheckRunInputV1` envelope (consistent with the classify_files.v1 / aggregate_findings.v1 envelopes
// that closed the other known live invariant-11 dispatches).
//
// There is NO Python Pydantic counterpart to byte-diff against — the envelope is introduced DURING the
// port — so the parity test covers round-trip / validation only.
//
// Field mapping (mirrors the 5 positional args 1:1):
//   - `pr_meta: PrMetaV1`  → the already-ported PrMetaV1 contract (carries `installation_id`). The Python
//     activity threads `pr_meta` through `_do_post_check_run` unchanged; the byte-significant logic does
//     not read it (the check-run targets owner/repo/head_sha directly), but it is carried for the
//     workflow-body dispatch shape + future per-call installation resolution.
//   - `head_sha: str`      → z.string(). `_do_post_check_run` raises on empty; the contract leaves it a
//     loose str so the EMPTINESS check stays in the activity (parity-significant — the Python raises a
//     ValueError, not a validation error).
//   - `summary: str`       → z.string(). Same: emptiness is checked in `_do_post_check_run`, not here.
//   - `owner: str`         → z.string().
//   - `repo_name: str`     → z.string(). (The Python parameter is `repo_name`; the GhCheckRunClient
//     methods receive it as `repo`.)
//   - `schema_version: int = 1` → z.number().int().default(1) (NOT z.literal(1): a literal would
//     false-reject a future schema_version=2 wire payload).

export const PostCheckRunInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    pr_meta: PrMetaV1,
    head_sha: z.string(),
    summary: z.string(),
    owner: z.string(),
    repo_name: z.string(),
  })
  .strict();
export type PostCheckRunInputV1 = z.infer<typeof PostCheckRunInputV1>;
