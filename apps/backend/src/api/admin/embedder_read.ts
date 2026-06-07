// Embedder admin reads — 1:1 port of the READ paths in codemaster/api/admin/embedder.py
// (_to_generation_v1 + _coerce_email_or_none) over EmbedderRuntimeStateRepo / EmbeddingGenerationsRepo /
// EmbedderGenerationService.get_coverage. Three GET endpoints: /state, /coverage, /reembed/status.
//
// All three are PLATFORM-SCOPE reads — embedder_runtime_state + embedding_generations have no
// installation_id; the coverage anti-join over knowledge_chunks is a DELIBERATE cross-tenant aggregate
// (platform-wide coverage gate), so it must NOT be installation-filtered.
//
// created_by_email / updated_by_email are PLAIN TEXT (NOT field-encrypted); the DB carries a
// 'migration-seed' sentinel that isn't a valid email, so the API coerces any non-email string to null
// (coerceEmailOrNone) before it reaches the EmailStr-constrained contract.
//
// validation_report_json (JSONB) is parsed into ValidationReportV1; a malformed payload yields null +
// an optional onWarn emit (mirrors the Python ValidationError catch + _LOG.warning) — never throws.

import { type Kysely, sql } from "kysely";

import type {
  EmbedderCoverageV1,
  EmbedderStateV1,
  EmbeddingGenerationV1,
} from "#contracts/admin.v1.js";
import { ValidationReportV1 } from "#contracts/admin.v1.js";

/** Optional structured-warning sink (mirrors the Python `_LOG.warning("malformed_validation_report_json")`). */
export type GenerationWarn = (e: { generationId: number; error: string }) => void;

/** Raised when the embedder_runtime_state singleton is absent (Python `.mappings().one()` throws). → 500. */
export class EmbedderStateMissingError extends Error {
  public constructor() {
    super("core.embedder_runtime_state singleton row is missing");
    this.name = "EmbedderStateMissingError";
  }
}

/** Return `value` only if it parses as an email (has '@'); else null. Suppresses the 'migration-seed'
 *  sentinel and any other unparseable string so the EmailStr contract field doesn't reject. */
function coerceEmailOrNone(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.includes("@") ? value : null;
}

/** A timestamptz column is parsed to a JS Date by node-pg; `null` survives. */
function isoOrNull(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

// The full embedding_generations column projection — shared by list_recent (/state) and get (/reembed/status).
const GENERATION_COLUMNS = sql`
  generation_id, state, generation_label, generation_reason,
  provider_name, provider_version, model_name, embedding_dimension,
  created_from_generation, chunker_version, preprocessing_version, normalization_version,
  created_at, created_by_email,
  backfill_started_at, backfill_completed_at,
  validation_started_at, validation_completed_at, validation_report_json, validation_passed,
  activated_at, retired_at, retire_reason, gc_started_at, gc_completed_at,
  total_chunks, chunks_backfilled, chunks_failed, last_error
`;

type GenerationSqlRow = {
  generation_id: string | number;
  state: string;
  generation_label: string | null;
  generation_reason: string | null;
  provider_name: string;
  provider_version: string | null;
  model_name: string;
  embedding_dimension: number;
  created_from_generation: string | number | null;
  chunker_version: string;
  preprocessing_version: string;
  normalization_version: string;
  created_at: Date;
  created_by_email: string | null;
  backfill_started_at: Date | null;
  backfill_completed_at: Date | null;
  validation_started_at: Date | null;
  validation_completed_at: Date | null;
  validation_report_json: unknown;
  validation_passed: boolean | null;
  activated_at: Date | null;
  retired_at: Date | null;
  retire_reason: string | null;
  gc_started_at: Date | null;
  gc_completed_at: Date | null;
  total_chunks: number;
  chunks_backfilled: number;
  chunks_failed: number;
  last_error: string | null;
};

function toGenerationV1(row: GenerationSqlRow, onWarn?: GenerationWarn): EmbeddingGenerationV1 {
  let validationReport: ValidationReportV1 | null = null;
  if (row.validation_report_json !== null && row.validation_report_json !== undefined) {
    // node-pg already deserialized the JSONB column to a JS object — validate it directly.
    const parsed = ValidationReportV1.safeParse(row.validation_report_json);
    if (parsed.success) {
      validationReport = parsed.data;
    } else {
      onWarn?.({ generationId: Number(row.generation_id), error: parsed.error.message.slice(0, 512) });
    }
  }
  return {
    schema_version: 1,
    generation_id: Number(row.generation_id),
    state: row.state as EmbeddingGenerationV1["state"],
    generation_label: row.generation_label,
    generation_reason: row.generation_reason,
    provider_name: row.provider_name,
    provider_version: row.provider_version,
    model_name: row.model_name,
    embedding_dimension: Number(row.embedding_dimension),
    created_from_generation:
      row.created_from_generation === null ? null : Number(row.created_from_generation),
    chunker_version: row.chunker_version,
    preprocessing_version: row.preprocessing_version,
    normalization_version: row.normalization_version,
    created_at: row.created_at.toISOString(),
    created_by_email: coerceEmailOrNone(row.created_by_email),
    backfill_started_at: isoOrNull(row.backfill_started_at),
    backfill_completed_at: isoOrNull(row.backfill_completed_at),
    validation_started_at: isoOrNull(row.validation_started_at),
    validation_completed_at: isoOrNull(row.validation_completed_at),
    validation_passed: row.validation_passed,
    validation_report: validationReport,
    activated_at: isoOrNull(row.activated_at),
    retired_at: isoOrNull(row.retired_at),
    retire_reason: row.retire_reason as EmbeddingGenerationV1["retire_reason"],
    gc_started_at: isoOrNull(row.gc_started_at),
    gc_completed_at: isoOrNull(row.gc_completed_at),
    total_chunks: Number(row.total_chunks),
    chunks_backfilled: Number(row.chunks_backfilled),
    chunks_failed: Number(row.chunks_failed),
    last_error: row.last_error,
  };
}

type RuntimeStateSqlRow = {
  active_generation: string | number;
  active_model_name: string;
  pending_generation: string | number | null;
  pending_model_name: string | null;
  config_version: string | number;
  retrieval_mode: string;
  updated_at: Date;
  updated_by_email: string | null;
};

/** GET /api/admin/embedder/state — the runtime-state singleton + the 20 newest generations. */
export async function buildEmbedderState(
  db: Kysely<unknown>,
  onWarn?: GenerationWarn,
): Promise<EmbedderStateV1> {
  const stateRes = await sql<RuntimeStateSqlRow>`
    SELECT active_generation, active_model_name, pending_generation, pending_model_name,
           config_version, retrieval_mode, updated_at, updated_by_email
    FROM core.embedder_runtime_state WHERE singleton = true
  `.execute(db);
  const s = stateRes.rows[0];
  if (s === undefined) {
    throw new EmbedderStateMissingError();
  }
  const gensRes = await sql<GenerationSqlRow>`
    SELECT ${GENERATION_COLUMNS} FROM core.embedding_generations ORDER BY generation_id DESC LIMIT 20
  `.execute(db);
  return {
    schema_version: 1,
    active_generation: Number(s.active_generation),
    active_model_name: s.active_model_name,
    pending_generation: s.pending_generation === null ? null : Number(s.pending_generation),
    pending_model_name: s.pending_model_name,
    config_version: Number(s.config_version),
    retrieval_mode: s.retrieval_mode as EmbedderStateV1["retrieval_mode"],
    updated_at: s.updated_at.toISOString(),
    updated_by_email: coerceEmailOrNone(s.updated_by_email),
    generations: gensRes.rows.map((r) => toGenerationV1(r, onWarn)),
  };
}

/** GET /api/admin/embedder/coverage — active_generation + the two anti-join missing-counts. */
export async function buildEmbedderCoverage(db: Kysely<unknown>): Promise<EmbedderCoverageV1> {
  const stateRes = await sql<{ active_generation: string | number }>`
    SELECT active_generation FROM core.embedder_runtime_state WHERE singleton = true
  `.execute(db);
  const s = stateRes.rows[0];
  if (s === undefined) {
    throw new EmbedderStateMissingError();
  }
  const g = Number(s.active_generation);

  // Anti-join: canonical chunks with NO chunk_embeddings row under the active generation. The
  // generation_id predicate MUST stay in the ON clause (not WHERE) to preserve the LEFT-JOIN-IS-NULL
  // "missing for THIS generation" semantics. chunk_table is the discriminator literal.
  const confRes = await sql<{ count: string | number }>`
    SELECT COUNT(*) AS count
    FROM core.confluence_chunks c
    LEFT JOIN core.chunk_embeddings ce
      ON ce.chunk_table = 'confluence_chunks' AND ce.chunk_id = c.chunk_id AND ce.generation_id = ${g}
    WHERE c.deleted_at IS NULL AND c.superseded_at IS NULL AND ce.chunk_id IS NULL
  `.execute(db);
  const knowRes = await sql<{ count: string | number }>`
    SELECT COUNT(*) AS count
    FROM core.knowledge_chunks c
    LEFT JOIN core.chunk_embeddings ce
      ON ce.chunk_table = 'knowledge_chunks' AND ce.chunk_id = c.chunk_id AND ce.generation_id = ${g}
    WHERE c.doc_status = 'active' AND ce.chunk_id IS NULL
  `.execute(db);

  const confluenceMissing = Number(confRes.rows[0]?.count ?? 0);
  const knowledgeMissing = Number(knowRes.rows[0]?.count ?? 0);
  return {
    schema_version: 1,
    confluence_missing: confluenceMissing,
    knowledge_missing: knowledgeMissing,
    total_missing: confluenceMissing + knowledgeMissing, // computed in app code (1:1 with the Python service)
    active_generation: g,
  };
}

/** GET /api/admin/embedder/reembed/status — a single generation by id, or null if absent (→ route 404). */
export async function getGeneration(
  db: Kysely<unknown>,
  generationId: number,
  onWarn?: GenerationWarn,
): Promise<EmbeddingGenerationV1 | null> {
  const r = await sql<GenerationSqlRow>`
    SELECT ${GENERATION_COLUMNS} FROM core.embedding_generations WHERE generation_id = ${generationId}
  `.execute(db);
  const row = r.rows[0];
  return row === undefined ? null : toGenerationV1(row, onWarn);
}
