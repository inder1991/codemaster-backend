// ReviewWorkflowState — the typed replacement for the Python workflow body's mutable closure boxes
// (finding 4 of docs/superpowers/plans/2026-06-05-review-orchestrator-full-port.md).
//
// 1:1 PORT of the closure boxes + capture dataclasses in the frozen Python
// vendor/codemaster-py/codemaster/workflows/review_pull_request.py:
//   * policy_bundles            (~1165)  dict[str, ResolvedGuidanceBundleV1]
//   * repo_config_box           (~1173)  list[CodemasterConfigV1] (1-element box)
//   * query_vector_cache        (~1189)  dict[str, tuple[float, ...]]  (keyed by chunk path — finding 10)
//   * inline_post_filter_metadata (~1199) list[tuple[dict, ...]]
//   * posted_review_capture     (~2340)  _PostReviewCapture()  (dataclass ~127)
//   * arbitration_capture       (~2341)  _ArbitrationCapture() (dataclass ~350)
//   * _persisted_review_finding_ids (~2892) list[uuid.UUID]
//
// The Python body boxes these so closures (_review_chunk / _aggregate / _post_review / _persist_findings)
// can mutate them via lexical capture. In TS the workflow body delegates to a deterministic orchestrate()
// helper (finding 1), so the boxes become ONE typed state object with explicit, testable fields.
//
// SANDBOX SAFETY (ADR-0065 / ADR-0066 / check_clock_random + check_workflow_bundle): this module runs in
// the Temporal workflow sandbox (Stage 1 imports it). It contains NO node:crypto, NO uuid, NO clock reads,
// NO RNG, NO timers. All minting/hashing/uuid/clock work lives in activities. Contracts are imported
// type-only where they would otherwise transitively pull crypto into the bundle.

import type { ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";
import type { CodemasterConfigV1 } from "#contracts/codemaster_config.v1.js";
import { CodemasterConfigV1 as CodemasterConfigV1Schema } from "#contracts/codemaster_config.v1.js";
import type { DroppedClassificationV1 } from "#contracts/dropped_classification.v1.js";
import type { PublicationOutcome } from "#contracts/posted_review.v1.js";
import type { ArbitrationResultV1 } from "#contracts/arbitration_result.v1.js";
import type { ToolStatusV1 } from "#contracts/tool_status.v1.js";
import type { FindingPolicyMetadata } from "#backend/policy/trust_filter.js";

import { composeOrchestratorDegradationNote } from "./helpers.js";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DegradationCollector — wraps the deduped degradation-note list + the
// _compose_orchestrator_degradation_note logic (review_pull_request.py:356).
//
// The Python orchestrator accumulates fail-soft stage markers (persist_findings_failed,
// apply_arbitration_failed, retrieval_degraded, …) into a degradation_notes list that the workflow body
// later folds into WalkthroughV1.degradation_note for the renderer. The list is DEDUPED on insert and the
// compose step prefixes with "pipeline degraded: " and chains onto a prior note. This type unifies both.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export class DegradationCollector {
  /** Insertion-ordered, deduplicated degradation markers (machine-keys + human-readable strings). */
  private readonly _notes: Array<string> = [];

  /** Append a note, skipping a value already present (dedup-on-insert, mirroring the stage_outcome
   *  helper's degradation_notes append discipline + the compose step's seen-set dedup). */
  add(note: string): void {
    if (!this._notes.includes(note)) {
      this._notes.push(note);
    }
  }

  /** The accumulated notes, in insertion order. Read-only snapshot (a copy, so callers can't mutate the
   *  internal list — the Python tuple snapshot the compose step consumes is likewise immutable). */
  get notes(): ReadonlyArray<string> {
    return [...this._notes];
  }

  /** Compose a single WalkthroughV1.degradation_note string from the accumulated notes, optionally
   *  chained onto a prior note. Delegates to the pure helper (the parity-tested 1:1 port of
   *  _compose_orchestrator_degradation_note) so both the collector and direct callers share one
   *  implementation. Empty notes → returns priorNote unchanged. */
  compose(priorNote?: string | null): string | null {
    return composeOrchestratorDegradationNote({
      notes: this._notes,
      priorNote: priorNote ?? null,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Capture types — typed replacements for the Python dataclasses _PostReviewCapture (~127) and
// _ArbitrationCapture (~350). Each is the slot a closure used to write its result into so the workflow
// body could read it AFTER orchestrate_review_pipeline returned.
//
// type-aliases (eslint consistent-type-definitions: "type"), readonly arrays via Array<T>/ReadonlyArray<T>
// (eslint array-type: generic). Optional fields modelled to honour exactOptionalPropertyTypes — every
// field has an explicit default-shaped value (None → null, () → [], so no "absent vs present" ambiguity).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Port of _PostReviewCapture (review_pull_request.py:127). The orchestrator's PostReviewFn returns None,
 * so the activity's PostedReviewV1 details are read from this slot after orchestrate() completes. The
 * three finding-delivery lifecycle setters consume comment_ids / kept_finding_indices / posted_review_pr_id
 * (Stage 3); publication_outcome + degradation_notes surface the v7-A publication fields to the ANALYZED
 * emit; dropped_classifications carry the per-finding drop reasons for the index → rfid lifecycle dispatch.
 *
 * Python field-shape mapping:
 *   review_id: int | None = None                          → number | null
 *   comment_ids: tuple[int, ...] = ()                      → ReadonlyArray<number>
 *   posted_review_pr_id: uuid.UUID | None = None           → string | null   (UUID is a sandbox-foreign
 *     mint; the wire form is a string. NO uuid import in the sandbox — the activity produces it.)
 *   kept_finding_indices: tuple[int, ...] = ()            → ReadonlyArray<number>
 *   publication_outcome: PublicationOutcome | None = None  → PublicationOutcome | null
 *   degradation_notes: tuple[str, ...] = ()               → ReadonlyArray<string>
 *   dropped_classifications: tuple[DroppedClassificationV1, ...] = () → ReadonlyArray<DroppedClassificationV1>
 */
export type PostReviewCapture = {
  reviewId: number | null;
  commentIds: ReadonlyArray<number>;
  postedReviewPrId: string | null;
  keptFindingIndices: ReadonlyArray<number>;
  publicationOutcome: PublicationOutcome | null;
  degradationNotes: ReadonlyArray<string>;
  droppedClassifications: ReadonlyArray<DroppedClassificationV1>;
};

/** A fresh _PostReviewCapture() with the Python dataclass defaults (None/() → null/[]). Mirrors the
 *  "no publication actually happened" detectable-without-sentinels default the Python docstring calls out. */
export function makePostReviewCapture(): PostReviewCapture {
  return {
    reviewId: null,
    commentIds: [],
    postedReviewPrId: null,
    keptFindingIndices: [],
    publicationOutcome: null,
    degradationNotes: [],
    droppedClassifications: [],
  };
}

/**
 * Port of _ArbitrationCapture (review_pull_request.py:350). Populated by the Step 7.7 arbitration bridge.
 * When unset (the arbitration step did not run / sa was null), the footer renderer produces "" so the
 * walkthrough body is unchanged.
 *
 * Python field-shape mapping:
 *   result: object | None = None  (ArbitrationResult; the arbitration-layer value object) → ArbitrationResultV1 | null
 *   tool_statuses: tuple = ()      (tuple[ToolStatusV1, ...])                              → ReadonlyArray<ToolStatusV1>
 *
 * Stage 5 tightened the element types from the placeholder `unknown` to the real ported contracts
 * (ArbitrationResultV1 / ToolStatusV1), so renderWalkthroughForPost consumes the capture type-safely.
 */
export type ArbitrationCapture = {
  result: ArbitrationResultV1 | null;
  toolStatuses: ReadonlyArray<ToolStatusV1>;
};

/** A fresh _ArbitrationCapture() with the Python dataclass defaults (None/() → null/[]). */
export function makeArbitrationCapture(): ArbitrationCapture {
  return { result: null, toolStatuses: [] };
}

/**
 * Port of the inline_post_filter_metadata box (review_pull_request.py:1199). R-23: when the policy
 * post-filter runs inline at Step 7.2, it captures the per-finding metadata from
 * postFilterFindingsWithMetadata; the persist step reads it here as `precomputed_metadata` so the persisted
 * `core.review_findings.policy_metadata` reflects the SAME filter the walkthrough + GitHub comment saw
 * (closing the persist/render divergence flagged in the 2026-05-21 head-of-eng review).
 *
 * Python type: list[tuple[dict, ...]] — a 1-element box holding the per-finding metadata tuple. The TS state
 * holds the per-finding metadata array DIRECTLY (the box semantics are subsumed into the optional field:
 * undefined = "post-filter did not run / no invariant fired", populated = the index-aligned per-finding rows
 * the persist step threads as precomputed_metadata). Each row is the real {@link FindingPolicyMetadata}.
 */
export type InlinePostFilterMetadata = ReadonlyArray<FindingPolicyMetadata>;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// ReviewWorkflowState — the single typed state object (finding 4). Replaces the seven closure boxes with
// explicit, testable fields + transitions. Mutated from a single point (orchestrate()); replay-deterministic
// because every write is downstream of an activity completion Temporal serializes into workflow history.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export class ReviewWorkflowState {
  /** policy_bundles (~1165): per-changed-path resolved guidance, keyed by chunk path. _review_chunk reads
   *  policy_bundles.get(chunk.path) per chunk. Map preserves the dict semantics. */
  readonly policyBundles = new Map<string, ResolvedGuidanceBundleV1>();

  /** query_vector_cache (~1189) — finding 10: per-PR cache of Qwen3 query embeddings keyed by chunk path.
   *  First chunk per unique path embeds; subsequent chunks reuse the cached vector. ReadonlyArray<number>
   *  is the JSON wire form of the Python tuple[float, ...] (bare floats live only inside the vector, never
   *  surfaced through a canonical-JSON compare). */
  readonly queryVectorCache = new Map<string, ReadonlyArray<number>>();

  /**
   * Union of retrieved knowledge chunk IDs across ALL chunks, accumulated as each chunk's
   * retrieve_knowledge result resolves during the fan-out. Passed to citationValidate as the allowed
   * knowledge-citation set (strict membership) — a finding citing a knowledge_chunk NOT in this set is
   * dropped. Empty → citationValidate runs in skip mode (knowledge_chunk_ids=null). ENHANCEMENT beyond the
   * frozen Python, which hardcodes skip mode (review_pipeline_orchestrator.py:807) — the Python workflow
   * body already threads a `frozenset[str] | None` param, so this populates what Python left empty.
   *
   * A Set (membership-only; iteration order never observed without a sort) — the citationValidate dispatch
   * sorts before sending so the activity input is replay-deterministic regardless of fan-out completion
   * order. Mutated only from the single-threaded workflow event loop (no true-parallel write race).
   */
  readonly retrievedKnowledgeChunkIds = new Set<string>();

  /** The deduped degradation collector — wraps the notes list + compose logic. */
  readonly degradation = new DegradationCollector();

  /** repo_config_box (~1173) → a plain field (the box existed only because a frozen model can't .update();
   *  a TS field assignment replaces it cleanly). Starts at CodemasterConfigV1 defaults, exactly as the
   *  Python `[CodemasterConfigV1()]` 1-element box. */
  repoConfig: CodemasterConfigV1 = CodemasterConfigV1Schema.parse({});

  /** inline_post_filter_metadata (~1199) — R-23 precomputed per-finding policy metadata. Undefined until
   *  the relocated post-filter populates it (Stage 5); kept optional to honour exactOptionalPropertyTypes. */
  inlinePostFilterMetadata?: InlinePostFilterMetadata;

  /** posted_review_capture (~2340) — initialised to the dataclass defaults, exactly as Python's
   *  `_PostReviewCapture()` (NOT optional/undefined — the Python slot is always a constructed instance). */
  postedReview: PostReviewCapture = makePostReviewCapture();

  /** arbitration_capture (~2341) — initialised to the dataclass defaults, exactly as `_ArbitrationCapture()`. */
  arbitration: ArbitrationCapture = makeArbitrationCapture();

  /** _persisted_review_finding_ids (~2892) — the ordered rfids _persist_findings wrote, for the index → rfid
   *  inline-skip dispatch. Wire form of list[uuid.UUID] is a string array (no uuid mint in the sandbox). */
  persistedFindingIds: ReadonlyArray<string> = [];
}
