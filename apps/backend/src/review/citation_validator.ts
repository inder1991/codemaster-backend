/**
 * Citation validator — 1:1 port of the frozen Python `codemaster/review/citation_validator.py`
 * (Sprint 10 / S10.1.2).
 *
 * Drops findings whose `sources[]` cannot be verified against the cloned workspace + the retriever's
 * chunk-id set for THIS review. Hallucinated citations are worse than no citation: they look
 * authoritative but lead nowhere; dropping them keeps the bot's credibility intact.
 *
 * ## Resolution rules per citation kind (ported EXACTLY)
 *  - `repo_path`      — locator must exist as a FILE under `workspace`.
 *  - `knowledge_chunk`— locator must be in `knowledgeChunkIds` (the chunk_ids the retriever returned for
 *                       THIS review). `null` = SKIP-MODE (production retrieval-tracking not yet wired,
 *                       per S17.X-citation-wiring) — knowledge_chunk citations accepted as-is, repo_path
 *                       checks still run. A Set (even empty) = STRICT membership check.
 *  - `linter_rule`    — NO validation (rule IDs are open-ended; existence is implicit in the tool output).
 *  - `policy_rule`    — locator must be in `policyCitation.valid_rule_ids` (Sprint 25 / A-5-wire-a).
 *                       `null` context = SKIP-MODE (Sprint-10..S24 back-compat). With a context,
 *                       `context.enforcement` selects:
 *                         * `observe` (default) — log mismatch via the WARN sink, ACCEPT the finding
 *                           anyway (gathers LLM citation-drift data during rollout).
 *                         * `enforce` — DROP the finding on mismatch (locked one-bad-citation-poisons-
 *                           the-finding rule). Either way, the invalid-citation counter fires.
 *
 * ## Drop policy (ported EXACTLY)
 * A finding with ANY unresolvable source is dropped IN FULL (one bad citation poisons the finding):
 * a finding with even one fabricated source has demonstrably wrong provenance reasoning. Findings with
 * `sources=[]` SURVIVE — citation is *required* only when claiming team practice (enforced separately by
 * the OutputSafetyValidator). Iteration ORDER is preserved in the surviving/dropped partition.
 *
 * ## Why a TS module driven by an ACTIVITY (the sandbox boundary)
 * `repoPathExists` does REAL filesystem syscalls (the Node analogue of Python `Path.resolve/.exists/
 * .is_file`), which are RESTRICTED inside the Temporal workflow V8-isolate sandbox (deterministic + I/O-
 * free for replay). So `validate` is invoked from the `citationValidate` activity (citation_validate.
 * activity.ts), which runs in the NORMAL Node activity runtime. This module is the pure-ish core the
 * activity holds; the activity is the registered Temporal entry point.
 *
 * The WARN logs the Python emits via `_LOG.warning(...)` are surfaced here as an OPTIONAL `onWarn` sink
 * (mirroring how chunk_response_parser.ts threads `onMalformedSkip`) — the core stays decoupled from any
 * concrete logger; the activity wrapper / workflow body owns structured observability.
 *
 * DO NOT move this logic back into the workflow body without re-instating an activity boundary somewhere
 * — the filesystem calls would trip the sandbox again.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

import { recordInvalidCitation } from "#backend/policy/policy_metrics.js";

import type {
  CitationValidationResultV1,
  DroppedFindingV1,
} from "#contracts/citation_validation.v1.js";
import type { PolicyCitationContextV1 } from "#contracts/policy_citation.v1.js";
import type { CitationV1, ReviewFindingV1 } from "#contracts/review_findings.v1.js";

/** A WARN-log event the validator would emit. Optional sink — the core stays logger-decoupled. */
export type CitationValidatorWarning =
  | {
      readonly kind: "drop";
      readonly file: string;
      readonly title: string;
      readonly reason: string;
    }
  | {
      readonly kind: "policy_observe_mismatch";
      readonly locator: string;
      readonly valid_rule_ids_count: number;
      readonly enforcement: string;
    };

/**
 * Resolve citations against the workspace + retrieved-chunk-id set.
 *
 * `knowledgeChunkIds=null` is the transitional SKIP-MODE (S17.X-citation-wiring): production retrieval-
 * tracking that exposes the chunk-id set across the pipeline lands separately; until then the
 * orchestrator constructs the validator with `null` so `repo_path` citations are still enforced but
 * `knowledge_chunk` citations are accepted as-is. Pre-S17 callers (tests + adversarial corpora) keep
 * using an EMPTY Set for the strict empty-set check.
 */
export class CitationValidator {
  private readonly workspace: string;
  private readonly knowledgeChunkIds: ReadonlySet<string> | null;
  private readonly policyCitation: PolicyCitationContextV1 | null;
  // Pre-convert valid_rule_ids to a Set for O(1) membership lookup. null when no context supplied.
  private readonly policyRuleIds: ReadonlySet<string> | null;
  private readonly onWarn: ((w: CitationValidatorWarning) => void) | undefined;

  public constructor(args: {
    readonly workspace: string;
    readonly knowledgeChunkIds: ReadonlySet<string> | null;
    readonly policyCitation?: PolicyCitationContextV1 | null;
    readonly onWarn?: (w: CitationValidatorWarning) => void;
  }) {
    this.workspace = args.workspace;
    this.knowledgeChunkIds = args.knowledgeChunkIds;
    this.policyCitation = args.policyCitation ?? null;
    this.policyRuleIds =
      this.policyCitation !== null ? new Set(this.policyCitation.valid_rule_ids) : null;
    this.onWarn = args.onWarn;
  }

  public validate(findings: ReadonlyArray<ReviewFindingV1>): CitationValidationResultV1 {
    // Python `if not findings: return CitationValidationResultV1(surviving=(), dropped=())`.
    if (findings.length === 0) {
      return { schema_version: 1, surviving: [], dropped: [] };
    }

    const surviving: Array<ReviewFindingV1> = [];
    const dropped: Array<DroppedFindingV1> = [];

    for (const f of findings) {
      // Python `if not f.sources:` — no citations at all → survives (citation-required check is the
      // OutputSafetyValidator's job, S10.1.4).
      if (f.sources.length === 0) {
        surviving.push(f);
        continue;
      }
      const reason = this.firstUnresolvableReason(f.sources);
      if (reason === null) {
        surviving.push(f);
      } else {
        // Mirrors the Python `_LOG.warning("...dropping finding with unresolvable source", extra=...)`.
        this.onWarn?.({ kind: "drop", file: f.file, title: f.title, reason });
        dropped.push({ finding: f, reason });
      }
    }

    return { schema_version: 1, surviving, dropped };
  }

  /** Return the first failure reason, or null if all sources resolve. 1:1 with `_first_unresolvable_reason`. */
  private firstUnresolvableReason(sources: ReadonlyArray<CitationV1>): string | null {
    for (const s of sources) {
      if (s.kind === "repo_path") {
        if (!this.repoPathExists(s.locator)) {
          return `repo_path '${s.locator}' does not exist in workspace`;
        }
      } else if (s.kind === "knowledge_chunk") {
        // S17.X-citation-wiring: skip mode — when chunkIds=null, accept knowledge_chunk citations as-is.
        if (this.knowledgeChunkIds === null) {
          continue;
        }
        if (!this.knowledgeChunkIds.has(s.locator)) {
          return `knowledge_chunk '${s.locator}' not in this review's retrieved set`;
        }
      } else if (s.kind === "linter_rule") {
        // No resolution check; rule IDs are open-ended.
        continue;
      } else if (s.kind === "policy_rule") {
        // Sprint 25 / A-5-wire-a. Skip-mode (no context) preserves Sprint-10..S24 behaviour.
        const ctx = this.policyCitation;
        const ruleIds = this.policyRuleIds;
        if (ctx === null || ruleIds === null) {
          continue;
        }
        if (!ruleIds.has(s.locator)) {
          // T-3: counter emit (OTel meter; activity context).
          recordInvalidCitation(ctx.enforcement);
          if (ctx.enforcement === "enforce") {
            return `policy_rule '${s.locator}' not in this review's resolved policy bundle`;
          }
          // observe-mode: log + accept.
          this.onWarn?.({
            kind: "policy_observe_mismatch",
            locator: s.locator,
            valid_rule_ids_count: ruleIds.size,
            enforcement: ctx.enforcement,
          });
          continue;
        }
      }
    }
    return null;
  }

  /**
   * Conservative existence check — 1:1 with the Python `_repo_path_exists`. Symlinks resolved; absolute
   * paths rejected (locator must be relative to the workspace).
   *
   * Faithful to the Python's prefix check, including its known sharp edge: the workspace-containment
   * guard is a RAW STRING `startsWith` on the resolved paths (the Python `str(target).startswith(
   * str(workspace_resolved))`), NOT a path-segment containment check. A sibling directory whose name
   * SHARES the workspace's resolved prefix (e.g. `<root>/ws` vs `<root>/ws-evil`) therefore passes the
   * guard — the port preserves this verbatim (1:1 fidelity to the frozen source, not a "fix").
   */
  private repoPathExists(locator: string): boolean {
    // Python `if not locator or locator.startswith("/"): return False`.
    if (!locator || locator.startsWith("/")) {
      return false;
    }
    try {
      // Python `target = (self._workspace / locator).resolve()` — strict=False (resolves the existing
      // prefix incl. symlinks, collapses `..`, leaves a non-existent tail lexical).
      const target = resolveNonStrict(path.join(this.workspace, locator));
      // Python `workspace_resolved = self._workspace.resolve()`.
      const workspaceResolved = resolveNonStrict(this.workspace);
      // Python `if not str(target).startswith(str(workspace_resolved)): return False` — RAW prefix check.
      if (!target.startsWith(workspaceResolved)) {
        return false;
      }
      // Python `return target.exists() and target.is_file()`.
      return existsSync(target) && statSync(target).isFile();
    } catch {
      // Python `except OSError: return False`.
      return false;
    }
  }
}

/**
 * The Node analogue of Python `Path.resolve(strict=False)`: make absolute, then `realpath` the deepest
 * EXISTING ancestor (following symlinks + collapsing `..` on the existing prefix) and lexically rejoin
 * the trailing components that do not yet (or no longer) exist. Mirrors the resolver the frozen Python
 * relies on — and the sibling `release_workspace.activity.ts::resolveNonStrict` (kept private there;
 * re-authored here so this module owns no cross-activity import).
 *
 * Synchronous (the Python `_repo_path_exists` is sync); `realpathSync` throws on a non-existent prefix,
 * which the loop treats as "try a shorter prefix" — never propagated. A path with no resolvable prefix
 * (not even the fs root) falls back to the lexical absolute path.
 */
function resolveNonStrict(candidate: string): string {
  const absolute = path.resolve(candidate);
  const parts = absolute.split(path.sep);
  for (let depth = parts.length; depth >= 1; depth--) {
    const prefix = parts.slice(0, depth).join(path.sep) || path.sep;
    try {
      const realPrefix = realpathSync(prefix);
      const remainder = parts.slice(depth);
      return remainder.length === 0 ? realPrefix : path.join(realPrefix, ...remainder);
    } catch {
      // This prefix does not exist (or is a dangling symlink) — try a shorter one.
      continue;
    }
  }
  // No prefix resolved (not even the fs root) — fall back to the lexical absolute path.
  return absolute;
}
