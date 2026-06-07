// Retrieval-trace inspector reads — 1:1 port of PostgresRetrievalTracesRepo.list_recent + get_by_id
// (codemaster/api/admin/postgres_retrieval_traces_repo.py). Two GET endpoints:
//
//   GET /api/admin/retrieval-traces            — offset-paginated list from the v_retrieval_traces_recent
//                                                 MATERIALIZED VIEW (30-day window; flattened columns).
//   GET /api/admin/retrieval-traces/{trace_id} — the full RetrievalTraceV2 JSONB by PK.
//
// Both are PLATFORM-SCOPE (no installation_id filter; role-guarded). The list's `cursor` is a stringified
// integer OFFSET (not a keyset cursor); next_cursor = String(offset + page_size) only when a full page
// returned. The matview is created WITH NO DATA — a fresh DB returns [] until something REFRESHes it.

import { type Kysely, sql } from "kysely";

import { RetrievalTraceV2 } from "#contracts/persist_retrieval_trace.v1.js";
import type { RetrievalTraceListEntryV1 } from "#contracts/admin.v1.js";

type ListEntrySqlRow = {
  trace_id: string;
  review_id: string;
  pr_id: string;
  captured_at: Date;
  taxonomy_version: string | number;
  pipeline_version: string | number;
  trace_schema_version: string | number;
  effective_labels_count: string | number;
  repo_include_attempts_filtered_count: string | number;
  starvation_observed: boolean;
  selected_chunks_count: string | number;
  dropped_chunks_count: string | number;
  budget_total: string | number;
  budget_remaining: string | number;
};

/**
 * List recent traces from the materialized view. `offset` is the parsed integer cursor; `pageSize` is
 * pre-clamped by the route to [1, 200]. Returns the rows + the next offset cursor (null on a short page).
 */
export async function listRetrievalTraces(
  db: Kysely<unknown>,
  args: { offset: number; pageSize: number; starvationOnly: boolean },
): Promise<{ rows: Array<RetrievalTraceListEntryV1>; nextCursor: string | null }> {
  // The starvation filter is a conditional WHERE fragment (1:1 with the Python string-interpolated
  // where_clause); the empty fragment is a no-op. starvation_observed = true hits the partial index.
  const whereClause = args.starvationOnly ? sql`WHERE starvation_observed = true` : sql``;
  const res = await sql<ListEntrySqlRow>`
    SELECT trace_id, review_id, pr_id, captured_at,
           taxonomy_version, pipeline_version, trace_schema_version,
           effective_labels_count, repo_include_attempts_filtered_count,
           starvation_observed, selected_chunks_count, dropped_chunks_count,
           budget_total, budget_remaining
    FROM core.v_retrieval_traces_recent
    ${whereClause}
    ORDER BY captured_at DESC
    LIMIT ${args.pageSize} OFFSET ${args.offset}
  `.execute(db);

  const rows: Array<RetrievalTraceListEntryV1> = res.rows.map((r) => ({
    schema_version: 1,
    trace_id: r.trace_id,
    review_id: r.review_id,
    pr_id: r.pr_id,
    captured_at: r.captured_at.toISOString(),
    taxonomy_version: Number(r.taxonomy_version),
    pipeline_version: Number(r.pipeline_version),
    trace_schema_version: Number(r.trace_schema_version),
    effective_labels_count: Number(r.effective_labels_count),
    repo_include_attempts_filtered_count: Number(r.repo_include_attempts_filtered_count),
    starvation_observed: r.starvation_observed,
    selected_chunks_count: Number(r.selected_chunks_count),
    dropped_chunks_count: Number(r.dropped_chunks_count),
    budget_total: Number(r.budget_total),
    budget_remaining: Number(r.budget_remaining),
  }));
  const nextCursor = rows.length === args.pageSize ? String(args.offset + args.pageSize) : null;
  return { rows, nextCursor };
}

/** Fetch the full v2 trace by id, or null if absent (→ route 404). Parses the JSONB via RetrievalTraceV2. */
export async function getRetrievalTrace(
  db: Kysely<unknown>,
  traceId: string,
): Promise<RetrievalTraceV2 | null> {
  const res = await sql<{ trace: unknown }>`
    SELECT trace FROM core.retrieval_traces WHERE trace_id = ${traceId}
  `.execute(db);
  const row = res.rows[0];
  if (row === undefined) {
    return null;
  }
  // node-pg already deserialized the JSONB; re-validate against the full contract (Python does
  // RetrievalTraceV2.model_validate(row.trace)).
  return RetrievalTraceV2.parse(row.trace);
}
