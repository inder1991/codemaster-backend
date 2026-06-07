// Retrieval-trace aggregates — 1:1 port of retrieval_aggregate.py (pure aggregate() fold) +
// postgres_retrieval_aggregate_repo.py (atomic CTE + cross-validation + row-level isolation).
//
//   GET /api/admin/retrieval-aggregates/reviews/{review_id}        — per-review historical rollup
//   GET /api/admin/retrieval-aggregates/pull-requests/{pr_id}      — every review with traces for a PR
//
// Both PLATFORM-SCOPE (keyed only on review_id / pr_id; role-guarded). Each runs ONE atomic CTE so the
// metadata snapshot + trace rows agree, then folds in app code. Two failure classes:
//   * TraceNotFound  → 404  (no traces for the key)
//   * DataIntegrity  → 500  (structural drift: multiple pr_ids per review, missing PR row, pgr chain
//                            mismatch) — distinct from per-row ValidationError, which is silently counted.
//
// The aggregate() fold is SINGLE-PASS (accumulators grow O(distinct values)); a single malformed trace is
// counted into invalid_trace_count and skipped, never aborting the request.

import { type Kysely, sql } from "kysely";

import { RetrievalTraceV2 } from "#contracts/persist_retrieval_trace.v1.js";
import type {
  RetrievalAggregatePRListV1,
  RetrievalAggregatePRReviewSummaryV1,
  RetrievalAggregateV1,
} from "#contracts/admin.v1.js";

const TOP_N = 5;

/** No traces for the review_id / pr_id. Route maps to 404. */
export class RetrievalAggregateTraceNotFoundError extends Error {
  public constructor(key: string) {
    super(key);
    this.name = "RetrievalAggregateTraceNotFoundError";
  }
}

/** A structural cross-validation invariant failed. Route maps to 500 with {code,kind,details}. */
export class RetrievalAggregateDataIntegrityError extends Error {
  public readonly kind: string;
  public readonly details: Record<string, unknown>;
  public constructor(kind: string, details: Record<string, unknown> = {}) {
    super(kind);
    this.name = "RetrievalAggregateDataIntegrityError";
    this.kind = kind;
    this.details = details;
  }
}

type ReviewMeta = {
  metadata_as_of: string;
  review_id: string;
  pr_id: string;
  pr_number: number;
  installation_id: string;
  repository_id: string;
  repo_full_name: string;
  pr_current_head_sha: string;
  latest_run_id: string | null;
  latest_run_lifecycle_state: string | null;
  latest_run_cancel_reason: string | null;
  superseded_run_count: number;
};

type TraceCounts = {
  total_trace_count: number;
  returned_trace_count: number;
  parsed_trace_count: number;
  invalid_trace_count: number;
};

function buildLineageWarning(supersededRunCount: number): string | null {
  if (supersededRunCount <= 0) {
    return null;
  }
  return (
    `Aggregate combines traces from a review with ${supersededRunCount} ` +
    "superseded run(s). Per-trace detail view shows individual run " +
    "data. Lineage confidence will become EXACT once retrieval-trace " +
    "V3 ships."
  );
}

function deriveTerminalReason(lifecycleState: string | null, cancelReason: string | null): string | null {
  // Only CANCELLED + non-empty cancel_reason yields a non-null value in v1.
  return lifecycleState === "CANCELLED" && cancelReason ? cancelReason : null;
}

/** Top N by count DESC, tiebreak by key alphabetical ASC. Deterministic. */
function topNWithTiebreak(counter: Map<string, number>, n: number): Array<string> {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
    .map(([key]) => key);
}

/** Pure single-pass fold of parsed traces + metadata into the per-review aggregate. */
export function aggregate(args: {
  parsedTraces: ReadonlyArray<RetrievalTraceV2>;
  meta: ReviewMeta;
  counts: TraceCounts;
}): RetrievalAggregateV1 {
  const { parsedTraces, meta, counts } = args;
  let starvationCount = 0;
  const labelsSet = new Set<string>();
  const pipelineVersions = new Set<number>();
  const taxonomyVersions = new Set<number>();
  let earliestMs: number | null = null;
  let latestMs: number | null = null;
  let earliestStr: string | null = null;
  let latestStr: string | null = null;
  const spaceCounter = new Map<string, number>();
  const labelCounter = new Map<string, number>();

  for (const trace of parsedTraces) {
    if (trace.stage3.starvation_observed) {
      starvationCount += 1;
    }
    for (const label of trace.effective_labels) {
      labelsSet.add(label);
    }
    pipelineVersions.add(trace.pipeline_version);
    taxonomyVersions.add(trace.taxonomy_version);
    const ms = new Date(trace.captured_at).getTime();
    if (earliestMs === null || ms < earliestMs) {
      earliestMs = ms;
      earliestStr = trace.captured_at;
    }
    if (latestMs === null || ms > latestMs) {
      latestMs = ms;
      latestStr = trace.captured_at;
    }
    for (const track of [trace.stage3.track_a_default, trace.stage3.track_b_non_default]) {
      for (const decision of track.selected_chunks_detail) {
        if (decision.default_scope !== null) {
          spaceCounter.set(decision.default_scope, (spaceCounter.get(decision.default_scope) ?? 0) + 1);
        }
        for (const matchedLabel of decision.matched_labels) {
          labelCounter.set(matchedLabel, (labelCounter.get(matchedLabel) ?? 0) + 1);
        }
      }
    }
  }

  const pipelineVersionsSeen = [...pipelineVersions].sort((a, b) => a - b);
  const taxonomyVersionsSeen = [...taxonomyVersions].sort((a, b) => a - b);
  const versionDrift = pipelineVersionsSeen.length > 1 || taxonomyVersionsSeen.length > 1;

  return {
    schema_version: 1,
    aggregate_snapshot_kind: "historical_review_scoped",
    metadata_as_of: meta.metadata_as_of,
    aggregation_scope: "review_scoped",
    lineage_confidence: "mixed_run_possible",
    lineage_warning: buildLineageWarning(meta.superseded_run_count),
    review_id: meta.review_id,
    pr_id: meta.pr_id,
    pr_number: meta.pr_number,
    installation_id: meta.installation_id,
    repository_id: meta.repository_id,
    repo_full_name: meta.repo_full_name,
    latest_run_id: meta.latest_run_id,
    latest_run_lifecycle_state: meta.latest_run_lifecycle_state,
    latest_run_terminal_reason: deriveTerminalReason(
      meta.latest_run_lifecycle_state,
      meta.latest_run_cancel_reason,
    ),
    superseded_run_count: meta.superseded_run_count,
    pr_current_head_sha: meta.pr_current_head_sha,
    total_trace_count: counts.total_trace_count,
    returned_trace_count: counts.returned_trace_count,
    parsed_trace_count: counts.parsed_trace_count,
    invalid_trace_count: counts.invalid_trace_count,
    trace_count_truncated: counts.returned_trace_count < counts.total_trace_count,
    earliest_captured_at: earliestStr,
    latest_captured_at: latestStr,
    starvation_any: starvationCount > 0,
    starvation_trace_count: starvationCount,
    effective_labels_union: [...labelsSet].sort(),
    pipeline_versions_seen: pipelineVersionsSeen,
    taxonomy_versions_seen: taxonomyVersionsSeen,
    version_drift_detected: versionDrift,
    top_spaces_retrieved: topNWithTiebreak(spaceCounter, TOP_N),
    top_labels_retrieved: topNWithTiebreak(labelCounter, TOP_N),
  };
}

// node-pg parses json/jsonb columns to JS values; these mirror the row_to_json / json_agg shapes.
type AnchorJson = { pr_id: string };
type MetaJson = {
  metadata_as_of: string;
  pr_id: string;
  pr_number: number;
  installation_id: string;
  repository_id: string;
  pr_current_head_sha: string;
  repo_full_name: string;
  expected_repo_id: number | null;
  pgr_review_id: string | null;
  observed_pgr_repo_id: number | null;
  observed_pgr_pr_number: number | null;
  latest_run_id: string | null;
  latest_run_lifecycle_state: string | null;
  latest_run_cancel_reason: string | null;
  superseded_run_count: number;
};

function buildAggregateFromQueryResult(args: {
  reviewId: string;
  anchorsJson: Array<AnchorJson> | null;
  totalTraceCount: number | null;
  metaJson: MetaJson | null;
  tracesJson: Array<unknown> | null;
}): RetrievalAggregateV1 {
  const total = args.totalTraceCount ?? 0;
  if (total === 0) {
    throw new RetrievalAggregateTraceNotFoundError(args.reviewId);
  }
  const anchors = args.anchorsJson ?? [];
  if (anchors.length > 1) {
    const prIds = [...new Set(anchors.map((a) => String(a.pr_id)))].sort();
    throw new RetrievalAggregateDataIntegrityError("review_spans_multiple_pr_ids", { pr_ids: prIds });
  }
  if (args.metaJson === null) {
    const anchorPrId = anchors.length > 0 ? String(anchors[0]!.pr_id) : null;
    throw new RetrievalAggregateDataIntegrityError("trace_pr_id_unknown", { pr_id: anchorPrId });
  }
  const m = args.metaJson;
  // pgr_review_id is non-null only when pull_request_reviews has a row; if so, the trace-anchored chain
  // (expected repo/pr from pull_requests) must equal the observed pull_request_reviews chain.
  if (m.pgr_review_id !== null) {
    if (m.observed_pgr_repo_id !== m.expected_repo_id || m.observed_pgr_pr_number !== m.pr_number) {
      throw new RetrievalAggregateDataIntegrityError("pgr_chain_mismatch", {
        expected_repo_id: m.expected_repo_id,
        observed_pgr_repo_id: m.observed_pgr_repo_id,
        expected_pr_number: m.pr_number,
        observed_pgr_pr_number: m.observed_pgr_pr_number,
      });
    }
  }

  const meta: ReviewMeta = {
    metadata_as_of: m.metadata_as_of,
    review_id: args.reviewId,
    pr_id: String(m.pr_id),
    pr_number: Number(m.pr_number),
    installation_id: String(m.installation_id),
    repository_id: String(m.repository_id),
    repo_full_name: m.repo_full_name,
    pr_current_head_sha: m.pr_current_head_sha,
    latest_run_id: m.latest_run_id === null ? null : String(m.latest_run_id),
    latest_run_lifecycle_state: m.latest_run_lifecycle_state,
    latest_run_cancel_reason: m.latest_run_cancel_reason,
    superseded_run_count: Number(m.superseded_run_count ?? 0),
  };

  const rawTraces = args.tracesJson ?? [];
  const parsedTraces: Array<RetrievalTraceV2> = [];
  let invalidCount = 0;
  for (const raw of rawTraces) {
    const parsed = RetrievalTraceV2.safeParse(raw);
    if (parsed.success) {
      parsedTraces.push(parsed.data);
    } else {
      invalidCount += 1; // row-level isolation: one bad trace is counted, never aborts the request
    }
  }
  return aggregate({
    parsedTraces,
    meta,
    counts: {
      total_trace_count: total,
      returned_trace_count: rawTraces.length,
      parsed_trace_count: parsedTraces.length,
      invalid_trace_count: invalidCount,
    },
  });
}

/** GET /api/admin/retrieval-aggregates/reviews/{review_id}. */
export async function getByReview(db: Kysely<unknown>, reviewId: string): Promise<RetrievalAggregateV1> {
  const res = await sql<{
    anchors_json: Array<AnchorJson> | null;
    total_trace_count: number | null;
    meta_json: MetaJson | null;
    traces_json: Array<unknown> | null;
  }>`
    WITH
      trace_anchor AS (
        SELECT DISTINCT pr_id FROM core.retrieval_traces WHERE review_id = ${reviewId}
      ),
      trace_total AS (
        SELECT COUNT(*)::int AS total FROM core.retrieval_traces WHERE review_id = ${reviewId}
      ),
      meta AS (
        SELECT
          CURRENT_TIMESTAMP AT TIME ZONE 'UTC'  AS metadata_as_of,
          pr.pr_id, pr.pr_number, pr.installation_id, pr.repository_id,
          pr.head_sha            AS pr_current_head_sha,
          r.full_name            AS repo_full_name,
          r.github_repo_id       AS expected_repo_id,
          pgr.review_id          AS pgr_review_id,
          pgr.repo_id            AS observed_pgr_repo_id,
          pgr.pr_number          AS observed_pgr_pr_number,
          pgr.current_run_id     AS latest_run_id,
          rr.lifecycle_state     AS latest_run_lifecycle_state,
          rr.cancel_reason       AS latest_run_cancel_reason,
          COALESCE(
            (SELECT COUNT(*)::int FROM core.review_runs
             WHERE review_id = ${reviewId} AND superseded_by_run_id IS NOT NULL), 0
          )                      AS superseded_run_count
        FROM trace_anchor ta
        JOIN core.pull_requests pr ON pr.pr_id = ta.pr_id
        JOIN core.repositories r   ON r.repository_id = pr.repository_id
        LEFT JOIN core.pull_request_reviews pgr ON pgr.review_id = ${reviewId}
        LEFT JOIN core.review_runs rr           ON rr.run_id = pgr.current_run_id
      ),
      traces AS (
        SELECT trace FROM core.retrieval_traces WHERE review_id = ${reviewId}
        ORDER BY captured_at ASC, trace_id ASC LIMIT 500
      )
    SELECT
      (SELECT json_agg(row_to_json(trace_anchor)) FROM trace_anchor) AS anchors_json,
      (SELECT total FROM trace_total)                                AS total_trace_count,
      (SELECT row_to_json(meta) FROM meta)                           AS meta_json,
      (SELECT json_agg(trace) FROM traces)                           AS traces_json
  `.execute(db);

  const row = res.rows[0];
  if (row === undefined) {
    throw new RetrievalAggregateDataIntegrityError("query_returned_no_rows", { review_id: reviewId });
  }
  return buildAggregateFromQueryResult({
    reviewId,
    anchorsJson: row.anchors_json,
    totalTraceCount: row.total_trace_count,
    metaJson: row.meta_json,
    tracesJson: row.traces_json,
  });
}

type PrMetaJson = {
  metadata_as_of: string;
  pr_id: string;
  pr_number: number;
  installation_id: string;
  repository_id: string;
  pr_current_head_sha: string;
  repo_full_name: string;
};
type PrReviewJson = {
  review_id: string;
  earliest_captured_at: string | null;
  latest_captured_at: string | null;
  trace_count: number;
  starvation_any: boolean;
  starvation_trace_count: number;
  latest_run_id: string | null;
  latest_run_lifecycle_state: string | null;
  superseded_run_count: number | null;
};

function buildPrListFromQueryResult(args: {
  prId: string;
  totalReviewCount: number | null;
  metaJson: PrMetaJson | null;
  reviewsJson: Array<PrReviewJson> | null;
}): RetrievalAggregatePRListV1 {
  const total = args.totalReviewCount ?? 0;
  if (total === 0 || args.reviewsJson === null || args.reviewsJson.length === 0) {
    throw new RetrievalAggregateTraceNotFoundError(args.prId);
  }
  if (args.metaJson === null) {
    throw new RetrievalAggregateDataIntegrityError("pr_traces_pr_id_unknown", { pr_id: args.prId });
  }

  // Preserve the SQL ordering (latest_captured_at DESC NULLS LAST, review_id ASC) — do NOT re-sort.
  const summaries: Array<RetrievalAggregatePRReviewSummaryV1> = args.reviewsJson.map((row) => ({
    schema_version: 1,
    review_id: String(row.review_id),
    earliest_captured_at: row.earliest_captured_at,
    latest_captured_at: row.latest_captured_at,
    trace_count: Number(row.trace_count),
    starvation_any: Boolean(row.starvation_any),
    starvation_trace_count: Number(row.starvation_trace_count),
    latest_run_id: row.latest_run_id === null ? null : String(row.latest_run_id),
    latest_run_lifecycle_state: row.latest_run_lifecycle_state,
    superseded_run_count: Number(row.superseded_run_count ?? 0),
  }));

  const m = args.metaJson;
  return {
    schema_version: 1,
    pr_id: String(m.pr_id),
    pr_number: Number(m.pr_number),
    installation_id: String(m.installation_id),
    repository_id: String(m.repository_id),
    repo_full_name: m.repo_full_name,
    pr_current_head_sha: m.pr_current_head_sha,
    metadata_as_of: m.metadata_as_of,
    reviews: summaries,
    total_review_count: total,
    returned_review_count: summaries.length,
    review_count_truncated: summaries.length < total,
  };
}

/** GET /api/admin/retrieval-aggregates/pull-requests/{pr_id}. */
export async function listByPr(db: Kysely<unknown>, prId: string): Promise<RetrievalAggregatePRListV1> {
  const res = await sql<{
    total_review_count: number | null;
    meta_json: PrMetaJson | null;
    reviews_json: Array<PrReviewJson> | null;
  }>`
    WITH
      pr_traces AS (
        SELECT
          review_id,
          COUNT(*)::int                                               AS trace_count,
          MIN(captured_at)                                            AS earliest_captured_at,
          MAX(captured_at)                                            AS latest_captured_at,
          COALESCE(SUM(((trace->'stage3'->>'starvation_observed')::boolean)::int), 0)::int
                                                                      AS starvation_trace_count,
          COALESCE(BOOL_OR((trace->'stage3'->>'starvation_observed')::boolean), false)
                                                                      AS starvation_any
        FROM core.retrieval_traces WHERE pr_id = ${prId} GROUP BY review_id
      ),
      pr_meta AS (
        SELECT
          CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS metadata_as_of,
          pr.pr_id, pr.pr_number, pr.installation_id, pr.repository_id,
          pr.head_sha AS pr_current_head_sha, r.full_name AS repo_full_name
        FROM core.pull_requests pr
        JOIN core.repositories r ON r.repository_id = pr.repository_id
        WHERE pr.pr_id = ${prId}
      ),
      review_meta AS (
        SELECT
          pgr.review_id, pgr.current_run_id AS latest_run_id,
          rr.lifecycle_state AS latest_run_lifecycle_state,
          COALESCE(
            (SELECT COUNT(*)::int FROM core.review_runs
             WHERE review_id = pgr.review_id AND superseded_by_run_id IS NOT NULL), 0
          ) AS superseded_run_count
        FROM core.pull_request_reviews pgr
        LEFT JOIN core.review_runs rr ON rr.run_id = pgr.current_run_id
        WHERE pgr.review_id IN (SELECT review_id FROM pr_traces)
      ),
      total_reviews AS (SELECT COUNT(*)::int AS total FROM pr_traces),
      reviews AS (
        SELECT
          pt.review_id, pt.earliest_captured_at, pt.latest_captured_at, pt.trace_count,
          pt.starvation_any, pt.starvation_trace_count,
          rm.latest_run_id, rm.latest_run_lifecycle_state,
          COALESCE(rm.superseded_run_count, 0) AS superseded_run_count
        FROM pr_traces pt
        LEFT JOIN review_meta rm ON rm.review_id = pt.review_id
        ORDER BY pt.latest_captured_at DESC NULLS LAST, pt.review_id ASC LIMIT 500
      )
    SELECT
      (SELECT total FROM total_reviews)                    AS total_review_count,
      (SELECT row_to_json(pr_meta) FROM pr_meta)           AS meta_json,
      (SELECT json_agg(row_to_json(reviews)) FROM reviews) AS reviews_json
  `.execute(db);

  const row = res.rows[0];
  if (row === undefined) {
    throw new RetrievalAggregateDataIntegrityError("query_returned_no_rows", { pr_id: prId });
  }
  return buildPrListFromQueryResult({
    prId,
    totalReviewCount: row.total_review_count,
    metaJson: row.meta_json,
    reviewsJson: row.reviews_json,
  });
}
