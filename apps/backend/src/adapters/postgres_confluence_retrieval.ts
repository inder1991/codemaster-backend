// postgres_confluence_retrieval — port of the frozen Python
//   vendor/codemaster-py/codemaster/adapters/postgres_confluence_retrieval.py::PostgresConfluenceRetrieval
//   (Sub-spec B T10 + Phase 4 T4.2A). Production impl of `ConfluenceRetrievalPort`
//   (`apps/backend/src/retrieval/confluence_source.ts`).
//
// Adapter responsibilities (spec §3.4 + §3.7 + r3 P0-2/P1 + §8):
//
//   1. pgvector cosine-similarity ANN over `core.confluence_chunks`. Returns top-K rows sorted by
//      similarity DESC. We emit `1 - distance` so callers see SIMILARITY, not raw pgvector distance.
//
//   2. EmbedderCache mode dispatch (Phase 4 T4.2A, spec §8). When an `EmbedderCache` is wired, the
//      adapter dispatches per query on `cache.getRetrievalMode()` ∈ {"fallback","generation_only"}:
//        - Phase A ("fallback", default): LEFT JOIN `core.chunk_embeddings` under the active
//          generation; `COALESCE(ce.embedding, cc.embedding)` prefers the chunk_embeddings row, falls
//          back to the legacy `cc.embedding` column.
//        - Phase C ("generation_only"): INNER JOIN `core.chunk_embeddings` filtered by
//          `generation_id = :active_generation`. Legacy column never read.
//      When `embedderCache` is null/undefined (the current TS composition — the EmbedderCache seam is
//      NOT yet ported; FOLLOW-UP-embedder-cache), the adapter falls back to the pre-v4 direct query
//      against `cc.embedding`, preserving backwards compatibility. In production composition the cache
//      WILL be wired.
//
//   3. Approval-drift safeguard (P0-2 / P1 audit fix, 2026-05-27). LEFT JOIN against
//      `core.confluence_page_approvals` with the partial `revoked_at IS NULL` predicate. Chunks tagged
//      `default` without an ACTIVE approval row are excluded at retrieval time (closes the
//      revocation→resync drift window — immediate user-facing impact).
//
//   4. Skip-hygiene filters: `superseded_at IS NULL`, `deleted_at IS NULL`, `quarantined = false`.
//      Quarantined content (injection-flag positive, sanitizer rejection) must not surface to the LLM.
//
// ── Cross-tenant access posture (PLATFORM-SHARED) ──────────────────────────────────────────────────
// `core.confluence_chunks` is a PLATFORM-SHARED corpus (migration 0063 dropped `installation_id`). The
// adapter intentionally does NOT filter on `installation_id`; every active installation sees the same
// approved Confluence content. This mirrors the Python `@privileged_path` + `cross_tenant_audit=True`
// by-design cross-tenant access (confluence_source.py:10). In the TS registry,
// `core.confluence_chunks` / `core.chunk_embeddings` / `core.confluence_page_approvals` are NOT in
// `TENANT_SCOPED_TABLES` (already de-scoped), so the raw-SQL tenancy gate does not police these
// queries — but the `// tenant:exempt` marker is retained on each `sql` site to make the by-design
// cross-tenant intent explicit (matching the frozen Python's tenancy-exemption marker).

import { type Kysely, sql } from "kysely";

import type { ConfluenceRetrievedChunk } from "#backend/retrieval/confluence_source.js";

/**
 * The EmbedderCache seam (Python `codemaster.embedder.cache.EmbedderCache`). NOT yet ported to TS
 * (FOLLOW-UP-embedder-cache). The adapter accepts it for forward-compat: when null/undefined it runs
 * the pre-v4 legacy query; when present it dispatches Phase A / Phase C.
 */
export type EmbedderCache = {
  /** "fallback" (Phase A) or "generation_only" (Phase C). */
  getRetrievalMode(): "fallback" | "generation_only";
  /** Active embedding-generation id (bound as `:active_generation`). */
  getActiveGeneration(): number | bigint;
};

/** The row shape every SELECT below materializes (snake_case = the DB column / alias names). */
type ConfluenceRow = {
  chunk_id: string;
  space_key: string;
  page_id: string;
  page_title: string;
  version: number | string;
  chunk_text: string;
  redaction_applied: boolean;
  labels: ReadonlyArray<string> | null;
  age_days: number | string | null;
  token_count: number | string | null;
  score: number | string;
};

/**
 * Format the query vector as the pgvector text literal `"[f1,f2,...]"` (1:1 with the Python `qvec`
 * bind). pg cannot encode a raw array for the `vector` column, so we bind this text + CAST AS vector.
 */
function toPgVectorLiteral(vec: ReadonlyArray<number>): string {
  return `[${vec.map((x) => String(x)).join(",")}]`;
}

/** Map a SELECT row to a ConfluenceRetrievedChunk (1:1 with the Python `_row_to_chunk`). */
function rowToChunk(row: ConfluenceRow): ConfluenceRetrievedChunk {
  const labels = row.labels === null ? [] : [...row.labels];
  return {
    chunk_id: row.chunk_id,
    space_key: row.space_key,
    page_id: row.page_id,
    page_title: row.page_title,
    version: typeof row.version === "string" ? Number.parseInt(row.version, 10) : row.version,
    chunk_text: row.chunk_text,
    redaction_applied: Boolean(row.redaction_applied),
    labels,
    age_days: row.age_days === null ? 0 : Number(row.age_days),
    token_count: row.token_count === null ? 0 : Number(row.token_count),
    score: Number(row.score),
    source: "confluence",
    // The adapter does not compute match_specificity_score (needs effective_labels from the caller).
    match_specificity_score: 0,
  };
}

export type PostgresConfluenceRetrievalOptions = {
  /** Shared single-pool tenant-scoped Kysely seam (ADR-0062). */
  db: Kysely<unknown>;
  /**
   * Optional EmbedderCache. NULL/undefined in the current TS composition (FOLLOW-UP-embedder-cache) →
   * the legacy `cc.embedding` direct query is used.
   */
  embedderCache?: EmbedderCache | null;
};

/**
 * pgvector ANN over `core.confluence_chunks` with the approval-drift LEFT JOIN safeguard + EmbedderCache
 * mode dispatch (spec §8). Constructed once at worker startup; stateless beyond the injected seams.
 */
export class PostgresConfluenceRetrieval {
  private readonly db: Kysely<unknown>;
  private readonly embedderCache: EmbedderCache | null;

  public constructor(opts: PostgresConfluenceRetrievalOptions) {
    this.db = opts.db;
    this.embedderCache = opts.embedderCache ?? null;
  }

  /**
   * Cosine-similarity search over the confluence ANN index (1:1 with the Python `search`).
   *
   * Returns up to `topK` chunks sorted by similarity DESC. The result is empty when:
   *   - `topK <= 0` (short-circuit before DB call)
   *   - `effectiveLabels` is empty (the labels-overlap predicate `cc.labels && '{}'` is false for every
   *     row, so we short-circuit before the DB call)
   *   - no chunks pass the WHERE clause (no active approval for default-labeled content, or all
   *     candidate rows quarantined / superseded / soft-deleted)
   */
  public async search(args: {
    queryEmbedding: ReadonlyArray<number>;
    topK: number;
    effectiveLabels?: ReadonlySet<string>;
  }): Promise<ReadonlyArray<ConfluenceRetrievedChunk>> {
    const effectiveLabels = args.effectiveLabels ?? new Set<string>();
    if (args.topK <= 0) {
      return [];
    }
    if (effectiveLabels.size === 0) {
      return [];
    }

    const qvec = toPgVectorLiteral(args.queryEmbedding);
    const labelsArray = [...effectiveLabels];
    // Bind a REAL pg text[] for the `&&` overlap (NOT a CSV string) — `${labelsArray}::text[]` lets
    // node-pg encode the JS array to a Postgres array literal.
    const labelsBind = sql`${labelsArray}::text[]`;

    let rows: ReadonlyArray<ConfluenceRow>;
    if (this.embedderCache === null) {
      rows = await this.runLegacy({ qvec, labelsBind, topK: args.topK });
    } else {
      const mode = this.embedderCache.getRetrievalMode();
      const activeGeneration = this.embedderCache.getActiveGeneration();
      rows =
        mode === "generation_only"
          ? await this.runPhaseC({ qvec, labelsBind, topK: args.topK, activeGeneration })
          : await this.runPhaseA({ qvec, labelsBind, topK: args.topK, activeGeneration });
    }
    return rows.map(rowToChunk);
  }

  /**
   * Pre-v4 legacy SQL (Python `_SEARCH_SQL`). Reads directly from the legacy `cc.embedding` column.
   * Used when no EmbedderCache is wired. Preserves the P0-2 approval-drift LEFT JOIN + skip-hygiene.
   */
  private async runLegacy(args: {
    qvec: string;
    labelsBind: ReturnType<typeof sql>;
    topK: number;
  }): Promise<ReadonlyArray<ConfluenceRow>> {
    // tenant:exempt reason=platform-shared-confluence-corpus-no-installation_id follow_up=PERMANENT-EXEMPTION-confluence-platform-shared
    const result = await sql<ConfluenceRow>`
      SELECT
          cc.chunk_id,
          cc.space_key,
          cc.page_id,
          cc.page_title,
          cc.version,
          cc.chunk_text,
          cc.redaction_applied,
          cc.labels,
          EXTRACT(EPOCH FROM (now() - cc.last_modified_at)) / 86400 AS age_days,
          cc.token_count,
          (1 - (cc.embedding <=> ${args.qvec}::vector)) AS score
      FROM core.confluence_chunks AS cc
      LEFT JOIN core.confluence_page_approvals AS cpa
          ON cpa.space_key = cc.space_key
         AND cpa.page_id = cc.page_id
         AND cpa.revoked_at IS NULL
      WHERE
          cc.superseded_at IS NULL
          AND cc.deleted_at IS NULL
          AND cc.quarantined = false
          AND cc.embedding IS NOT NULL
          AND cc.labels && ${args.labelsBind}
          AND (
              NOT ('default' = ANY(cc.labels))
              OR cpa.approval_id IS NOT NULL
          )
      ORDER BY cc.embedding <=> ${args.qvec}::vector
      LIMIT ${args.topK}
    `.execute(this.db);
    return result.rows;
  }

  /**
   * Phase A read-through fallback (Python `_SEARCH_SQL_PHASE_A`). LEFT JOIN `core.chunk_embeddings`
   * under the active generation; COALESCE prefers the chunk_embeddings row, legacy column fallback.
   */
  private async runPhaseA(args: {
    qvec: string;
    labelsBind: ReturnType<typeof sql>;
    topK: number;
    activeGeneration: number | bigint;
  }): Promise<ReadonlyArray<ConfluenceRow>> {
    const gen = sql`${String(args.activeGeneration)}::bigint`;
    // tenant:exempt reason=platform-shared-confluence-corpus-no-installation_id follow_up=PERMANENT-EXEMPTION-confluence-platform-shared
    const result = await sql<ConfluenceRow>`
      SELECT
          cc.chunk_id,
          cc.space_key,
          cc.page_id,
          cc.page_title,
          cc.version,
          cc.chunk_text,
          cc.redaction_applied,
          cc.labels,
          EXTRACT(EPOCH FROM (now() - cc.last_modified_at)) / 86400 AS age_days,
          cc.token_count,
          (1 - (COALESCE(ce.embedding, cc.embedding) <=> ${args.qvec}::vector)) AS score
      FROM core.confluence_chunks AS cc
      LEFT JOIN core.confluence_page_approvals AS cpa
          ON cpa.space_key = cc.space_key
         AND cpa.page_id = cc.page_id
         AND cpa.revoked_at IS NULL
      LEFT JOIN core.chunk_embeddings AS ce
          ON ce.chunk_table = 'confluence_chunks'
         AND ce.chunk_id = cc.chunk_id
         AND ce.generation_id = ${gen}
      WHERE
          cc.superseded_at IS NULL
          AND cc.deleted_at IS NULL
          AND cc.quarantined = false
          AND COALESCE(ce.embedding, cc.embedding) IS NOT NULL
          AND cc.labels && ${args.labelsBind}
          AND (
              NOT ('default' = ANY(cc.labels))
              OR cpa.approval_id IS NOT NULL
          )
      ORDER BY COALESCE(ce.embedding, cc.embedding) <=> ${args.qvec}::vector
      LIMIT ${args.topK}
    `.execute(this.db);
    return result.rows;
  }

  /**
   * Phase C generation-only (Python `_SEARCH_SQL_PHASE_C`). INNER JOIN `core.chunk_embeddings` filtered
   * by active_generation; the legacy `cc.embedding` column is never read.
   */
  private async runPhaseC(args: {
    qvec: string;
    labelsBind: ReturnType<typeof sql>;
    topK: number;
    activeGeneration: number | bigint;
  }): Promise<ReadonlyArray<ConfluenceRow>> {
    const gen = sql`${String(args.activeGeneration)}::bigint`;
    // tenant:exempt reason=platform-shared-confluence-corpus-no-installation_id follow_up=PERMANENT-EXEMPTION-confluence-platform-shared
    const result = await sql<ConfluenceRow>`
      SELECT
          cc.chunk_id,
          cc.space_key,
          cc.page_id,
          cc.page_title,
          cc.version,
          cc.chunk_text,
          cc.redaction_applied,
          cc.labels,
          EXTRACT(EPOCH FROM (now() - cc.last_modified_at)) / 86400 AS age_days,
          cc.token_count,
          (1 - (ce.embedding <=> ${args.qvec}::vector)) AS score
      FROM core.chunk_embeddings AS ce
      INNER JOIN core.confluence_chunks AS cc
          ON cc.chunk_id = ce.chunk_id
      LEFT JOIN core.confluence_page_approvals AS cpa
          ON cpa.space_key = cc.space_key
         AND cpa.page_id = cc.page_id
         AND cpa.revoked_at IS NULL
      WHERE
          ce.chunk_table = 'confluence_chunks'
          AND ce.generation_id = ${gen}
          AND cc.superseded_at IS NULL
          AND cc.deleted_at IS NULL
          AND cc.quarantined = false
          AND cc.labels && ${args.labelsBind}
          AND (
              NOT ('default' = ANY(cc.labels))
              OR cpa.approval_id IS NOT NULL
          )
      ORDER BY ce.embedding <=> ${args.qvec}::vector
      LIMIT ${args.topK}
    `.execute(this.db);
    return result.rows;
  }
}
