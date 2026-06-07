// Default-corpus health — 1:1 with default_corpus_health.snapshot + postgres_default_corpus_health_repo.
// Platform-scope (confluence_chunks/retrieval_traces have no installation_id). Two reads: a corpus aggregate
// + a per-scope 24h hit-rate. scope is extracted ENTIRELY in SQL via JSONB path operators (no nested
// contract parse). captured_at is the injected clock, NOT a DB column.

import { type Kysely, sql } from "kysely";

import type { DefaultCorpusHealthV1, DefaultScopeHitRateV1 } from "#contracts/admin.v1.js";

const SCOPES = new Set<DefaultScopeHitRateV1["scope"]>([
  "universal",
  "security_only",
  "compliance_only",
  "framework_only",
  "language_only",
]);

export async function buildDefaultCorpusHealth(
  db: Kysely<unknown>,
  now: Date,
): Promise<DefaultCorpusHealthV1> {
  const agg = await sql<{
    total_default_chunks: string | number;
    stale_default_chunks: string | number;
    total_tokens: string | number;
    spaces_with_defaults: string | number;
  }>`
    SELECT COUNT(*) AS total_default_chunks,
           COUNT(*) FILTER (WHERE page_status = 'stale') AS stale_default_chunks,
           COALESCE(SUM(token_count), 0) AS total_tokens,
           COUNT(DISTINCT space_key) AS spaces_with_defaults
    FROM core.confluence_chunks
    WHERE 'default' = ANY(labels) AND deleted_at IS NULL AND quarantined = false
  `.execute(db);
  const a = agg.rows[0];

  const scopes = await sql<{
    scope: string | null;
    chunks_in_corpus: string | number;
    retrieved_24h: string | number;
  }>`
    WITH corpus AS (
      SELECT default_approval ->> 'default_scope' AS scope, COUNT(*) AS chunks_in_corpus
      FROM core.confluence_chunks
      WHERE 'default' = ANY(labels) AND deleted_at IS NULL AND quarantined = false
        AND default_approval IS NOT NULL
      GROUP BY scope
    ),
    retrieved AS (
      SELECT jsonb_array_elements(
               COALESCE(trace -> 'stage3' -> 'track_a_default' -> 'selected_chunks_detail', '[]'::jsonb)
             ) ->> 'default_scope' AS scope,
             COUNT(*) AS retrieved_24h
      FROM core.retrieval_traces
      WHERE captured_at > now() - interval '24 hours'
      GROUP BY scope
    )
    SELECT c.scope, c.chunks_in_corpus, COALESCE(r.retrieved_24h, 0) AS retrieved_24h
    FROM corpus c LEFT JOIN retrieved r ON r.scope = c.scope
  `.execute(db);

  const hitRateByScope: Array<DefaultScopeHitRateV1> = [];
  for (const row of scopes.rows) {
    if (row.scope === null || !SCOPES.has(row.scope as DefaultScopeHitRateV1["scope"])) {
      continue; // closed-vocabulary guard (1:1 with the repo's skip)
    }
    const chunks = Number(row.chunks_in_corpus);
    const retrieved = Number(row.retrieved_24h);
    const rate = chunks > 0 ? Math.min(retrieved / chunks, 1) : 0;
    hitRateByScope.push({
      schema_version: 1,
      scope: row.scope as DefaultScopeHitRateV1["scope"],
      chunks_in_corpus: chunks,
      chunks_retrieved_24h: retrieved,
      hit_rate_24h: rate,
    });
  }

  return {
    schema_version: 1,
    captured_at: now.toISOString(),
    total_default_chunks: a === undefined ? 0 : Number(a.total_default_chunks),
    stale_default_chunks: a === undefined ? 0 : Number(a.stale_default_chunks),
    total_tokens: a === undefined ? 0 : Number(a.total_tokens),
    spaces_with_defaults: a === undefined ? 0 : Number(a.spaces_with_defaults),
    hit_rate_24h_by_scope: hitRateByScope,
  };
}
