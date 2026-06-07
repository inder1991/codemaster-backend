// degradation — uniform stage-outcome reporting for the workflow body's degradation paths.
//
// 1:1 PORT of the swallow/re-raise semantics in the frozen Python
// vendor/codemaster-py/codemaster/workflows/stage_outcome.py, plus the STAGE_NAMES registry from
// vendor/codemaster-py/codemaster/observability/pipeline_metrics.py.
//
// The Python is an async context manager (`async with stage_outcome(...) as handle: ...`). TS has no
// `async with`, so the established TS shape is an async WRAPPER that takes the stage body as a callback —
// `await stageOutcome(stage, opts, async () => { ... })`. The handle's note()/skipOutcome() are exposed
// to the body via the callback's single argument.
//
// SEMANTICS PRESERVED EXACTLY:
//   * Swallow-by-default: on a caught Error, log + emit record_stage(error) + append `<stage>_failed`
//     (+ extra notes), then SWALLOW (return undefined) unless raiseAfterLog is set.
//   * raiseAfterLog: re-raise the caught error AFTER logging/emitting/appending.
//   * Cancellation is ALWAYS re-raised — unconditionally, even with raiseAfterLog=false. Temporal
//     cancellation MUST propagate so the workflow body's cancellation handler observes it (swallowing it
//     would leave the review_runs row stuck at lifecycle_state='RUNNING' forever).
//   * skipOutcome suppresses the SUCCESS-path record_stage(ok) emit only — it does NOT affect the failure
//     path.
//   * Unknown stage name raises BEFORE the body runs (caller bug, not a degradation).
//
// SANDBOX SAFETY (ADR-0065/0066): NO node:crypto, NO uuid, NO clock reads, NO RNG, NO timers. record_stage
// emits the REAL replay-safe counter via the Temporal workflow `metricMeter` (the sandbox-safe + replay-safe
// analogue of the Python `workflow.metric_meter()`; Temporal suppresses the emit on history replay so a
// worker restart never double-counts). The exporter wiring is the only deferred piece — until a MeterProvider
// is installed the `.add()` calls are no-ops (safe). The Python's traceback.format_exc() truncation + 2KB
// error-message truncation are mirrored on the log line.

import { CancelledFailure } from "@temporalio/common";
import { metricMeter, inWorkflowContext } from "@temporalio/workflow";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// STAGE_NAMES — the locked stage-name set. Transcription of pipeline_metrics.py::STAGE_NAMES, PLUS the
// TS-enhancement stages at the bottom (the #4 manifest fetch/parse wiring + the #6 carry-forward loader)
// which exceed the frozen Python and so are not in its frozenset.
// Adding a stage here is a deliberate contract change and must be paired with a workflow-body call site.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export const STAGE_NAMES = new Set<string>([
  "allocate_workspace",
  "clone",
  "classify",
  "chunk_and_redact",
  "static_analysis",
  "select_carry_forward",
  "review_chunk",
  "aggregate",
  "walkthrough",
  "post_review",
  "post_check_run",
  "update_pr_description",
  "enrich_pr_files",
  "fetch_linked_issues",
  "fetch_suggested_reviewers",
  "retrieve_knowledge",
  "embed_query",
  "persist_findings",
  "citation_validate",
  "cleanup",
  "apply_arbitration",
  "record_tool_runs",
  "post_review_placeholder",
  "delete_review_placeholder",
  "policy_compute",
  "policy_post_filter",
  "lifecycle_bookkeeping",
  "load_repo_config",
  "persist_walkthrough",
  "fix_prompt",
  // ── TS-enhancement stages (NOT in Python's STAGE_NAMES) ──
  // #4 manifest fetch→parse wiring + #6 carry-forward loader. The frozen Python passed empty manifests +
  // an empty parent set, so it never dispatched these through stage_outcome. The TS workflow body DOES
  // (review_pull_request.workflow.ts), so they MUST be registered or stageOutcome throws at runtime.
  "fetch_manifest_snapshots",
  "parse_manifest_dependencies",
  "load_parent_review_findings",
]);

/** A stage name guaranteed (at runtime) to be in STAGE_NAMES. The branded check happens in stageOutcome. */
export type StageName = string;

// Traceback truncation cap (8 KB) and error-message truncation cap (2 KB) — plan-locked in the Python.
const TRACEBACK_TRUNCATE = 8192;
const ERROR_MSG_TRUNCATE = 2048;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// record_stage — the REAL replay-safe per-stage counter (1:1 with pipeline_metrics.record_stage).
//
// Emits `codemaster_review_stage_total{stage, outcome}` via the Temporal workflow `metricMeter` (sandbox +
// replay-safe). Name copied VERBATIM from the Python `COUNTER_NAME` so the deferred name-parity gate +
// existing dashboards/alerts map unchanged. The outcome-allowlist check is preserved (the Python still
// raises on a typo'd outcome — Grafana panels filter by outcome label, so a bad value would silently drop
// the metric; a crash is the louder signal). The unknown-stage SOFT-FAIL path of the Python (warn +
// unknown-stage counter) is irrelevant here because stageOutcome validates the stage name up-front and never
// reaches record_stage with an unknown stage.
//
// The instrument is created PER-EMIT inside `recordStage` (1:1 with the Python `meter.create_counter(...)`
// per call) — NOT cached at module scope. Temporal's `metricMeter` can only be touched while a workflow
// context is active; touching it outside one throws `IllegalStateError`. So `recordStage` GUARDS on
// `inWorkflowContext()` and no-ops outside a workflow — this is faithful to the Python (whose
// `workflow.metric_meter()` likewise requires a workflow loop) AND lets the orchestrator/posting unit tests
// drive the pure pipeline directly (no sandbox) without the metric emit throwing. The Temporal
// MetricMeter.createCounter is idempotent by name, so per-call creation inside the context is cheap.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export const OUTCOMES = new Set<string>(["ok", "error", "fallback", "skipped"]);

/** Counter NAME — copied VERBATIM from the Python `COUNTER_NAME` (Grafana-query-stable; ADR to rename). */
export const REVIEW_STAGE_COUNTER_NAME = "codemaster_review_stage_total";

const REVIEW_STAGE_COUNTER_DESCRIPTION =
  "Number of review-pipeline stages completed, by stage name and outcome. Replay-safe: emitted via the " +
  "Temporal workflow metricMeter.";

export function recordStage(args: { stage: string; outcome: string }): void {
  if (!OUTCOMES.has(args.outcome)) {
    throw new Error(
      `record_stage: invalid outcome ${JSON.stringify(args.outcome)} (not in OUTCOMES); ` +
        "Grafana panels filter by outcome label — a typo'd outcome silently drops the metric.",
    );
  }
  // metricMeter is workflow-context-only; no-op outside a workflow (unit tests drive the pure pipeline
  // directly). The outcome-allowlist guard above still runs regardless (a typo'd outcome is a caller bug).
  if (!inWorkflowContext()) {
    return;
  }
  metricMeter
    .createCounter(REVIEW_STAGE_COUNTER_NAME, undefined, REVIEW_STAGE_COUNTER_DESCRIPTION)
    .add(1, { stage: args.stage, outcome: args.outcome });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// StageOutcomeHandle — body-facing handle for note(...) and skipOutcome().
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export class StageOutcomeHandle {
  /** Extra degradation notes appended on TOP of the default `<stage>_failed` (failure path) or alongside
   *  the success outcome (success path). */
  readonly extraNotes: Array<string> = [];

  /** True when the body opted out of the success-path record_stage(ok) emit. */
  suppressSuccessLog = false;

  /** Append an extra degradation note (caller keeps it short + snake-case, matching the marker convention). */
  note(msg: string): void {
    this.extraNotes.push(msg);
  }

  /** Suppress the helper's success-path record_stage(outcome='ok') emit. Failure path is unaffected. */
  skipOutcome(): void {
    this.suppressSuccessLog = true;
  }
}

/** Anything satisfying `.warning(msg)` — the Temporal workflow logger + a plain console both qualify.
 *  Kept minimal (no `extra` second arg) so the Stage-0 shim can log to any sink; the Python's structured
 *  `extra` dict is folded into the message string (as the Python itself does for plain-stdout consumers). */
export type StageLogger = {
  warning(msg: string): void;
};

export type StageOutcomeOptions = {
  /** The logger to emit the WARN line on. */
  logger: StageLogger;
  /** Optional collector to append the `<stage>_failed` marker (+ extra notes) to on failure. The Python
   *  accepts `None`; here, undefined means "log-only, touch no list". A DegradationCollector or a plain
   *  string array both qualify (both expose a compatible `add` / `push`). We accept the mutable-list shape
   *  the Python uses (`list[str]`) — a thin adapter the callers pass. */
  degradationNotes?: { push(note: string): void };
  /** Optional head SHA threaded into the WARN line (operator pivot to the offending review). */
  headSha?: string | null;
  /** Optional run id threaded into the WARN line. */
  runId?: string | null;
  /** When true, re-raise the caught error AFTER logging/emitting/appending. Default false (swallow). */
  raiseAfterLog?: boolean;
};

/**
 * Wrap a workflow-stage execution with uniform observability + degradation-note handling.
 *
 * On success: emits record_stage(stage, 'ok') (unless the body called handle.skipOutcome()) and appends
 * any handle.note(...) extras to degradationNotes (when provided).
 *
 * On a caught error: logs a WARN line (error_class + truncated error_msg + truncated stack + head_sha +
 * run_id), emits record_stage(stage, 'error'), appends `<stage>_failed` (+ handle extras) to
 * degradationNotes (when provided), then SWALLOWS (returns undefined) unless raiseAfterLog is set.
 *
 * Cancellation: a Temporal CancelledFailure (or a JS abort-shaped cancel) is re-raised UNCONDITIONALLY —
 * even with raiseAfterLog=false — with NO log / NO counter / NO degradation-notes append.
 *
 * Throws synchronously (before running the body) if `stage` is not in STAGE_NAMES — a caller bug.
 *
 * @returns the body's result on success; `undefined` on a swallowed failure.
 */
export async function stageOutcome<T>(
  stage: StageName,
  options: StageOutcomeOptions,
  body: (handle: StageOutcomeHandle) => Promise<T>,
): Promise<T | undefined> {
  if (!STAGE_NAMES.has(stage)) {
    throw new Error(
      `stageOutcome called with unknown stage=${JSON.stringify(stage)}; ` +
        "add to STAGE_NAMES (mirror pipeline_metrics.py::STAGE_NAMES).",
    );
  }
  const handle = new StageOutcomeHandle();
  let result: T;
  try {
    result = await body(handle);
  } catch (exc) {
    // Cancellation paths NEVER get swallowed. Re-raise immediately — no log, no counter, no notes append.
    if (isCancellation(exc)) {
      throw exc;
    }
    const errorClass = exc instanceof Error ? exc.constructor.name : typeof exc;
    const errorMsg = (exc instanceof Error ? exc.message : String(exc)).slice(0, ERROR_MSG_TRUNCATE);
    const stack = (exc instanceof Error && exc.stack ? exc.stack : "").slice(0, TRACEBACK_TRUNCATE);
    options.logger.warning(
      `stage_outcome: ${stage} failed; review continues ` +
        `error_class=${errorClass} ` +
        `error_msg=${JSON.stringify(errorMsg)} ` +
        `head_sha=${options.headSha ?? null} run_id=${options.runId ?? null}\n` +
        `traceback:\n${stack}`,
    );
    recordStage({ stage, outcome: "error" });
    if (options.degradationNotes !== undefined) {
      options.degradationNotes.push(`${stage}_failed`);
      for (const extraNote of handle.extraNotes) {
        options.degradationNotes.push(extraNote);
      }
    }
    if (options.raiseAfterLog === true) {
      throw exc;
    }
    return undefined;
  }
  // Success path — only reached when the body exits cleanly.
  if (!handle.suppressSuccessLog) {
    recordStage({ stage, outcome: "ok" });
  }
  if (options.degradationNotes !== undefined) {
    for (const extraNote of handle.extraNotes) {
      options.degradationNotes.push(extraNote);
    }
  }
  return result;
}

/** True iff `exc` is a Temporal cancellation that MUST propagate (analogue of Python's
 *  asyncio.CancelledError / KeyboardInterrupt). Temporal TS surfaces workflow cancellation as a
 *  CancelledFailure; we also treat a DOM-style AbortError as cancellation (belt-and-suspenders for the
 *  test harness, which raises an abort-shaped error). */
function isCancellation(exc: unknown): boolean {
  if (exc instanceof CancelledFailure) {
    return true;
  }
  if (exc instanceof Error && exc.name === "AbortError") {
    return true;
  }
  return false;
}
