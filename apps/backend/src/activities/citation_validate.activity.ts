/**
 * `citationValidate` activity — 1:1 port of the frozen Python
 * `CitationValidateActivity.citation_validate`
 * (vendor/codemaster-py/codemaster/activities/citation_validate_activity.py).
 *
 * ## Why this is an ACTIVITY (the sandbox boundary)
 *
 * The activity is a THIN wrapper around {@link CitationValidator}`.validate()`. The validator's
 * `repoPathExists` helper does REAL filesystem syscalls (the Node analogue of Python
 * `Path.resolve/.exists/.is_file`), which are RESTRICTED inside the Temporal workflow V8-isolate sandbox
 * (deterministic + I/O-free for replay). Wrapping the call in an activity moves the fs-touching work to
 * the NORMAL Node activity-task-queue runtime, where those APIs are unrestricted. The orchestrator
 * DISPATCHES this activity rather than constructing the validator inline in the workflow body.
 *
 * The Python activity is intentionally thin — it constructs a CitationValidator per call and forwards to
 * its validate() method, with NO persistent state. This port keeps that exactly: a stateless function
 * that builds a fresh validator scoped to `input.workspace_path` on every call (NOT a shared instance).
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The frozen Python activity takes FOUR positional arguments (`workspace_path`, `findings`,
 * `knowledge_chunk_ids`, `policy_citation`) — Temporal activities are positional, which violates the
 * single-typed-input invariant. This port CLOSES it: the single positional input is the
 * {@link CitationValidateInputV1} envelope. The tri-stated `knowledge_chunk_ids` (`null` = skip-mode,
 * array = strict membership) and `policy_citation` (`null` = skip-mode, context = observe/enforce) travel
 * as the envelope's nullable fields, re-hydrated to a Set / typed context inside the validator. The
 * Python's "accept a dict OR a typed PolicyCitationContextV1" re-validation is unnecessary here: the
 * Temporal DataConverter validates the envelope at the dispatch boundary, so the activity body receives
 * the already-typed `PolicyCitationContextV1 | null` directly.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. The validator reads
 * the cloned workspace filesystem via `node:fs` (`existsSync`/`statSync`/`realpathSync`); all permitted
 * in an activity (the clock/random gate scopes to clock/RNG, not fs). No clock, no random, no DB, no
 * network — the validator is pure modulo the workspace fs reads.
 *
 * ## Timeout sizing (inherited from the Python H2 architect-review note)
 *
 * `start_to_close_timeout` (set at the workflow body's execute_activity call site, NOT here) was sized
 * at 30s for the M-A3 cap of 300 findings x ~4 syscalls per repo_path source (resolve x2 + exists +
 * isFile). On a healthy filesystem this completes in <2s; the 30s budget absorbs cold-cache / kind-
 * cluster IO contention. The Workflow phase owns that call site.
 *
 * ## Workflow-phase wiring boundary
 *
 * FOLLOW-UP-citation-validate-orchestrator-wiring: the worker registry / build_activities / activity_ports
 * / orchestrator are OWNED by the Workflow phase and are NOT touched here. This module exports the
 * registered activity function only; that phase binds it into the `activities` map under the existing
 * `citation_validate_activity` Temporal name and dispatches it between aggregate and post.
 */
import { CitationValidator } from "#backend/review/citation_validator.js";

import type { CitationValidateInputV1 } from "#contracts/citation_validate_input.v1.js";
import type { CitationValidationResultV1 } from "#contracts/citation_validation.v1.js";

/**
 * The registered activity: validate citations on each finding against `input.workspace_path` + the
 * tri-stated chunk-id / policy contexts, returning the {@link CitationValidationResultV1} (surviving +
 * dropped) envelope.
 *
 * Builds a FRESH {@link CitationValidator} per call (no shared state), 1:1 with the Python. The
 * `knowledge_chunk_ids` array (or `null`) becomes a Set (or `null` skip-mode); the `policy_citation`
 * context (or `null`) is threaded straight through. No `onWarn` sink is attached at the activity boundary
 * — the Python's `_LOG.warning(...)` drop logging is a pure side effect that does NOT alter the
 * surviving/dropped partition (the structural observability the workflow body records is the
 * stage-outcome surface), and the policy-mismatch counter still fires inside the validator regardless.
 */
export async function citationValidate(
  input: CitationValidateInputV1,
): Promise<CitationValidationResultV1> {
  const validator = new CitationValidator({
    workspace: input.workspace_path,
    knowledgeChunkIds: input.knowledge_chunk_ids === null ? null : new Set(input.knowledge_chunk_ids),
    policyCitation: input.policy_citation,
  });
  return validator.validate(input.findings);
}
