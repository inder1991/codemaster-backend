/**
 * `recordToolRuns` activity — 1:1 in intent with the frozen Python
 * `@activity.defn record_tool_runs_activity`
 * (`vendor/codemaster-py/codemaster/review/arbitration_apply_activity.py::ArbitrationApplyActivity.record_tool_runs_activity`).
 *
 * Persists one `core.review_tool_runs` row per {@link ToolStatusV1} in the input, by delegating each to
 * {@link ReviewToolRunsRepo.insertToolRun}. The body is the faithful port of the Python free function
 * `codemaster.review.arbitration_apply.record_tool_runs` (a straight `for status in tool_statuses:`
 * loop over `insert_tool_run`) — inlined here because this activity is the ONLY caller in this slice
 * (the broader `apply_arbitration` orchestration is out of scope for this task).
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Runs in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. Real I/O (the `pg.Pool` the
 * repo opens through the ADR-0062 shared seam) is available here. The crypto/clock/RNG sandbox boundary
 * constrains the WORKFLOW body, never the activity layer.
 *
 * ## Inputs (CLAUDE.md invariant 11 — single typed positional input)
 *
 * The single positional input is a {@link RecordToolRunsInputV1}. We pull:
 *   - `installation_id` / `run_id` / `review_id` — the three UUID strings every row carries (tenancy +
 *     forensic keys).
 *   - `tool_statuses` — the {@link ToolStatusV1} tuple; each becomes exactly one row.
 *
 * ## Idempotency
 *
 * Inherited from the repo's `ON CONFLICT (run_id, tool_name) DO NOTHING` (UNIQUE `(run_id, tool_name)`):
 * a Temporal retry that re-fires this activity produces ZERO row drift — the original rows win. The
 * activity adds no idempotency of its own; it is a thin composition over the repo.
 *
 * ## Datetime conversion
 *
 * The wire contract carries `started_at` / `finished_at` as ISO-8601 strings (Pydantic
 * `model_dump(mode="json")`). The repo's `insertToolRun` takes `Date` (the `timestamptz` column binds a
 * JS `Date`), so each ISO string is parsed to a `Date` here. `finished_at` is required-but-nullable
 * (`datetime | None`), so `null` passes through as `null`. Parsing a KNOWN instant (not a wall-clock
 * read) is outside the clock/random gate's scope.
 *
 * ## DSN
 *
 * The Postgres DSN is read from `CODEMASTER_PG_CORE_DSN` (the canonical core-store env var). The repo's
 * `fromDsn` routes it through the ADR-0062 process-shared single pool per DSN — the activity does NOT
 * open its own pool. Mirrors `persist_review_walkthrough.activity.ts`.
 */

import { ReviewToolRunsRepo } from "#backend/domain/repos/review_tool_runs_repo.js";

import type { RecordToolRunsInputV1 } from "#contracts/record_tool_runs_input.v1.js";

/**
 * Persist one `core.review_tool_runs` row per ToolStatusV1 in `input`. Returns `void` (the Python
 * `record_tool_runs_activity` returns `None`).
 *
 * Constructs {@link ReviewToolRunsRepo} over the ADR-0062 shared pool for the `CODEMASTER_PG_CORE_DSN`
 * DSN, then runs the per-status `insertToolRun` loop in order. The inserts run sequentially (mirroring
 * the frozen-Python `for ... await` loop) so the row order + any per-row failure surfaces deterministically.
 */
export async function recordToolRuns(input: RecordToolRunsInputV1): Promise<void> {
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error("CODEMASTER_PG_CORE_DSN is not set; cannot construct the review-tool-runs repo");
  }

  const repo = ReviewToolRunsRepo.fromDsn(dsn);

  for (const status of input.tool_statuses) {
    await repo.insertToolRun({
      installationId: input.installation_id,
      runId: input.run_id,
      reviewId: input.review_id,
      toolName: status.tool_name,
      status: status.status,
      filesScanned: status.files_scanned,
      filesTotal: status.files_total,
      startedAt: new Date(status.started_at),
      finishedAt: status.finished_at === null ? null : new Date(status.finished_at),
      durationMs: status.duration_ms,
      findingsProduced: status.findings_produced,
      errorClass: status.error_class,
      errorMessage: status.error_message,
    });
  }
}
