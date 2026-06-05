import { z } from "zod";

import { PolicyCitationContextV1 } from "./policy_citation.v1.js";
import { ReviewFindingV1 } from "./review_findings.v1.js";

// citation_validate_input.v1 — the typed single-positional envelope for the `citationValidate` activity
// (the Temporal-activity port of the frozen Python `CitationValidateActivity.citation_validate`,
// vendor/codemaster-py/codemaster/activities/citation_validate_activity.py).
//
// ── Why this is an ACTIVITY (the sandbox boundary) ──
// CitationValidator._repo_path_exists() calls pathlib.Path.resolve/.exists/.is_file — filesystem
// syscalls that are RESTRICTED inside the Temporal workflow V8-isolate sandbox (which is deterministic +
// I/O-free to preserve replay). Wrapping validate() in an activity moves the fs-touching work to the
// NORMAL Node activity runtime where those APIs are unrestricted. The workflow body DISPATCHES this
// activity instead of touching the workspace filesystem inline.
//
// ── NEW typed-input envelope introduced DURING the port (CLAUDE.md invariant 11 / ADR-0047) ──
// The frozen Python `CitationValidateActivity.citation_validate` takes FOUR positional arguments
// (`workspace_path: str`, `findings: tuple[ReviewFindingV1, ...]`,
// `knowledge_chunk_ids: frozenset[str] | None`,
// `policy_citation: PolicyCitationContextV1 | dict | None = None`) — Temporal activities are positional,
// which violates the single-typed-input invariant. The TS port CLOSES that violation: the activity's
// single positional input is this `CitationValidateInputV1` envelope (consistent with the sibling
// dedup_findings.v1 / static_analysis_input.v1 / aggregate_findings.v1 envelopes that closed the other
// known multi-positional dispatches). There is therefore NO Python contract for the ENVELOPE itself to
// byte-diff against; its parity coverage is round-trip + validation only. The validator CORE behaviour
// (surviving/dropped partition) IS byte-diffed against the frozen Python in the parity test.
//
// Field mapping (Python positional → envelope field):
//  - `workspace_path: str` → `workspace_path: z.string()`. The Python wraps it in `Path(workspace_path)`;
//    the activity treats it as an opaque string (no min-length bound — the Python str is loose). The
//    validator joins it with each repo_path locator and resolves the result against the cloned workspace.
//  - `findings: tuple[ReviewFindingV1, ...]` → `findings: z.array(ReviewFindingV1).default([])`. Tuples
//    serialize to JSON arrays. INPUT ORDER is preserved in the surviving/dropped partition (the Python
//    iterates `for f in findings` in order). Reuses the already-ported ReviewFindingV1 (NOT redefined).
//  - `knowledge_chunk_ids: frozenset[str] | None` → `knowledge_chunk_ids: z.array(z.string()).nullable()
//    .default(null)`. The Python tri-states this: `None` = SKIP-MODE (knowledge_chunk citations accepted
//    as-is — production retrieval-tracking not yet wired, per S17.X-citation-wiring); `frozenset(...)` =
//    STRICT membership check (locator must be in the set). A frozenset has no wire form, so it travels as
//    a JSON array; the validator converts it to a Set for O(1) membership. The null/array distinction is
//    SEMANTICALLY LOAD-BEARING (null disables the check; [] forbids ALL knowledge_chunk citations under
//    strict mode), so it is NOT collapsed to a default-[] — null is preserved on the wire.
//  - `policy_citation: PolicyCitationContextV1 | dict | None = None` → `policy_citation:
//    PolicyCitationContextV1.nullable().default(null)`. The Python accepts a typed contract OR a raw dict
//    (Temporal's default JSON converter delivered the wire form as a dict, re-validated on receipt). The
//    TS DataConverter validates the envelope at the dispatch boundary, so the activity body receives the
//    already-typed PolicyCitationContextV1 (or null = SKIP-MODE for policy_rule citations, the
//    Sprint-10..S24 back-compat default). Reuses the already-ported PolicyCitationContextV1.
//  - `schema_version: int = 1` → z.number().int().default(1) (NOT z.literal(1): a literal would
//    false-reject a future schema_version=2 wire payload). Mirrors the sibling envelopes.

export const CitationValidateInputV1 = z
  .object({
    schema_version: z.number().int().default(1),
    workspace_path: z.string(),
    findings: z.array(ReviewFindingV1).default([]),
    // null = skip-mode (accept knowledge_chunk citations as-is); array = strict membership set.
    knowledge_chunk_ids: z.array(z.string()).nullable().default(null),
    // null = skip-mode (accept policy_rule citations as-is); a context selects observe/enforce.
    policy_citation: PolicyCitationContextV1.nullable().default(null),
  })
  .strict();
export type CitationValidateInputV1 = z.infer<typeof CitationValidateInputV1>;
