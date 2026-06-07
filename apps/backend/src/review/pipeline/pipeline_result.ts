// pipeline_result — the orchestrator's return envelope.
//
// 1:1 PORT of the frozen Python dataclass ReviewPipelineResult
// (vendor/codemaster-py/codemaster/workflows/review_pipeline_orchestrator.py:245).
//
//   @dataclass(frozen=True, slots=True)
//   class ReviewPipelineResult:
//       status: str
//       head_sha: str
//       findings_count: int
//       walkthrough: WalkthroughV1 | None
//       aggregated: AggregatedFindingsV1 | None
//       file_routing: FileRoutingV1 | None
//       static_analysis: StaticAnalysisResultV1 | None
//       carry_forward: CarryForwardSelectionV1 | None
//       classifier_failure_ratio: float
//       degradation_notes: tuple[str, ...]
//       review_finding_ids: tuple[uuid.UUID, ...] = ()
//       arbitration_intents: tuple[ArbitrationIntentV1, ...] = ()
//       arbitration_result: ArbitrationResult | None = None
//
// INTERNAL workflow-sandbox type (finding-port of the orchestrate() return value), NOT a wire contract
// crossing an activity boundary — so a plain TS type is the right shape here (no zod schema, no
// schema_version). The Python orchestrate_review_pipeline returns this to the workflow body, which reads
// its fields to drive post-review / persist / lifecycle dispatch; it is never JSON-serialised across an
// activity seam.
//
// SANDBOX SAFETY (ADR-0065 / ADR-0066 / check_clock_random + check_workflow_bundle): this module runs in
// the Temporal workflow sandbox. It is a pure type module — NO node:crypto, NO uuid mint, NO clock read,
// NO RNG, NO fetch/http/DB. classifier_failure_ratio stays a BARE number (Python `float`): it never
// crosses a JSON activity boundary through this type, so the canonical-JSON float-string discipline that
// applies to wire contracts does NOT apply here. review_finding_ids is the string wire form of the Python
// tuple[uuid.UUID, ...] — the UUIDs are minted in an activity (the sandbox has no uuid oracle), so the
// envelope only ever holds their already-stringified form.
//
// Lint discipline: type-alias (not interface); ReadonlyArray<T> generic form; no `any`;
// exactOptionalPropertyTypes honoured — every field is always present (the three Python-defaulted fields map
// to explicit []/null in the factory, never `undefined`/absent).

import type { WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import type { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import type { FileRoutingV1 } from "#contracts/file_routing.v1.js";
import type { StaticAnalysisResultV1 } from "#contracts/static_analysis_result.v1.js";
import type { CarryForwardSelectionV1 } from "#contracts/carry_forward.v1.js";
import type { ArbitrationIntentV1 } from "#contracts/arbitration_intent.v1.js";
import type { ArbitrationResultV1 } from "#contracts/arbitration_result.v1.js";

/**
 * The Python `ArbitrationResult` envelope (vendor/codemaster-py/codemaster/review/arbitration_layer.py:108
 * — frozen dataclass with `decisions: tuple[ArbitrationDecisionV1, ...]` + `rejected_intents:
 * tuple[RejectedIntent, ...]`). Stage 5 ported it as the {@link ArbitrationResultV1} Zod contract (it
 * crosses the Temporal boundary as the apply_arbitration activity's return value), so the alias tightens
 * from the placeholder `unknown` to the real type. The orchestrator stashes it through to the workflow
 * body's walkthrough-footer renderer, which treats `null` as equivalent to an empty result.
 */
export type ArbitrationResult = ArbitrationResultV1;

/**
 * Outcome of one full review-pipeline pass — the orchestrate() return envelope.
 *
 * Python field-shape mapping:
 *   status: str                                              → string  (accepted / failed / skipped_*)
 *   head_sha: str                                            → string
 *   findings_count: int                                      → number
 *   walkthrough: WalkthroughV1 | None                        → WalkthroughV1 | null
 *   aggregated: AggregatedFindingsV1 | None                  → AggregatedFindingsV1 | null
 *   file_routing: FileRoutingV1 | None                       → FileRoutingV1 | null
 *   static_analysis: StaticAnalysisResultV1 | None           → StaticAnalysisResultV1 | null
 *   carry_forward: CarryForwardSelectionV1 | None            → CarryForwardSelectionV1 | null
 *   classifier_failure_ratio: float                          → number  (bare; sandbox-safe — see header)
 *   degradation_notes: tuple[str, ...]                       → ReadonlyArray<string>
 *   review_finding_ids: tuple[uuid.UUID, ...] = ()           → ReadonlyArray<string>  (UUID wire form)
 *   arbitration_intents: tuple[ArbitrationIntentV1, ...] = ()→ ReadonlyArray<ArbitrationIntentV1>
 *   arbitration_result: ArbitrationResult | None = None      → ArbitrationResult | null
 */
export type ReviewPipelineResult = {
  status: string;
  headSha: string;
  findingsCount: number;
  walkthrough: WalkthroughV1 | null;
  aggregated: AggregatedFindingsV1 | null;
  fileRouting: FileRoutingV1 | null;
  staticAnalysis: StaticAnalysisResultV1 | null;
  carryForward: CarryForwardSelectionV1 | null;
  classifierFailureRatio: number;
  degradationNotes: ReadonlyArray<string>;
  reviewFindingIds: ReadonlyArray<string>;
  arbitrationIntents: ReadonlyArray<ArbitrationIntentV1>;
  arbitrationResult: ArbitrationResult | null;
};

/**
 * The 11 required fields of ReviewPipelineResult — the Python positional/non-defaulted fields (everything
 * up to and including degradation_notes). The factory supplies the three Python-defaulted fields
 * (review_finding_ids=(), arbitration_intents=(), arbitration_result=None) so callers only pass what the
 * Python constructor required positionally.
 */
export type ReviewPipelineResultRequired = Pick<
  ReviewPipelineResult,
  | "status"
  | "headSha"
  | "findingsCount"
  | "walkthrough"
  | "aggregated"
  | "fileRouting"
  | "staticAnalysis"
  | "carryForward"
  | "classifierFailureRatio"
  | "degradationNotes"
>;

/**
 * Construct a ReviewPipelineResult, applying the Python dataclass defaults for the three trailing
 * defaulted fields exactly as the frozen dataclass does:
 *   review_finding_ids: tuple[uuid.UUID, ...] = ()  → []
 *   arbitration_intents: tuple[ArbitrationIntentV1, ...] = ()  → []
 *   arbitration_result: ArbitrationResult | None = None  → null
 *
 * Any of the three defaulted fields can be overridden via the optional second argument (mirroring passing
 * them by keyword to the Python constructor). Every field on the returned object is always present (no
 * `undefined`) — honouring exactOptionalPropertyTypes and the frozen-dataclass "always constructed"
 * semantics the workflow body relies on.
 */
export function makeReviewPipelineResult(
  required: ReviewPipelineResultRequired,
  overrides?: {
    reviewFindingIds?: ReadonlyArray<string>;
    arbitrationIntents?: ReadonlyArray<ArbitrationIntentV1>;
    arbitrationResult?: ArbitrationResult | null;
  },
): ReviewPipelineResult {
  return {
    status: required.status,
    headSha: required.headSha,
    findingsCount: required.findingsCount,
    walkthrough: required.walkthrough,
    aggregated: required.aggregated,
    fileRouting: required.fileRouting,
    staticAnalysis: required.staticAnalysis,
    carryForward: required.carryForward,
    classifierFailureRatio: required.classifierFailureRatio,
    degradationNotes: required.degradationNotes,
    reviewFindingIds: overrides?.reviewFindingIds ?? [],
    arbitrationIntents: overrides?.arbitrationIntents ?? [],
    arbitrationResult: overrides?.arbitrationResult ?? null,
  };
}
