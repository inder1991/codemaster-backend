// Embedder admin WRITE handlers (Batch 4) — 1:1 port of the WRITE paths in
// codemaster/api/admin/embedder.py over EmbedderGenerationService. The route layer (admin_routes.ts) owns
// authz, body parse, the EmbeddingGenerationV1/EmbedderStateV1 serialization, the Temporal dispatch/signal,
// and the audit emit; these thin wrappers delegate to the service so the typed errors propagate unchanged.
//
// toEmbeddingGenerationV1 mirrors embedder_read.ts::toGenerationV1: it maps an EmbeddingGenerationRowV1
// (repo dataclass) to the wire EmbeddingGenerationV1 (ISO timestamps + the migration-seed email coercion).
// The repo already parses validation_report_json to canonical JSON TEXT, so we re-parse it here through the
// same ValidationReportV1 contract used by the read path.

import {
  type CoverageResult,
  type EmbedderGenerationService,
  CoverageGapPresentError,
} from "#backend/domain/services/embedder_generation_service.js";
import type { EmbeddingGenerationRowV1 } from "#contracts/embedding_generation.v1.js";
import type {
  EmbeddingGenerationV1,
  RetrievalModeRequestV1,
  StartReembedRequestV1,
} from "#contracts/admin.v1.js";
import { ValidationReportV1 } from "#contracts/admin.v1.js";

/** ISO-8601 or null for a nullable timestamp column already parsed to a JS Date by node-pg. */
function isoOrNull(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

/** Suppress the 'migration-seed' sentinel (and any other non-email string) so the EmailStr field doesn't reject. */
function coerceEmailOrNone(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.includes("@") ? value : null;
}

/** Map the repo dataclass row to the wire EmbeddingGenerationV1 (1:1 with embedder.py::_to_generation_v1). */
export function toEmbeddingGenerationV1(row: EmbeddingGenerationRowV1): EmbeddingGenerationV1 {
  let validationReport: ValidationReportV1 | null = null;
  if (row.validation_report_json !== null) {
    try {
      const parsed = ValidationReportV1.safeParse(JSON.parse(row.validation_report_json));
      if (parsed.success) {
        validationReport = parsed.data;
      }
    } catch {
      // Malformed JSON → null report (operators read the raw row via DB), never throws.
    }
  }
  return {
    schema_version: 1,
    generation_id: row.generation_id,
    state: row.state,
    generation_label: row.generation_label,
    generation_reason: row.generation_reason,
    provider_name: row.provider_name,
    provider_version: row.provider_version,
    model_name: row.model_name,
    embedding_dimension: row.embedding_dimension,
    created_from_generation: row.created_from_generation,
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
    retire_reason: row.retire_reason,
    gc_started_at: isoOrNull(row.gc_started_at),
    gc_completed_at: isoOrNull(row.gc_completed_at),
    total_chunks: row.total_chunks,
    chunks_backfilled: row.chunks_backfilled,
    chunks_failed: row.chunks_failed,
    last_error: row.last_error,
  };
}

/** SET-RETRIEVAL-MODE — delegate to the service (which validates the coverage gate). CoverageGapPresentError
 *  surfaces unchanged for the route to map to 422. */
export async function setRetrievalMode(
  service: EmbedderGenerationService,
  request: RetrievalModeRequestV1,
  triggeredByEmail: string,
): Promise<void> {
  await service.setRetrievalMode({ mode: request.mode, triggeredByEmail });
}

/** START — create backfilling generation + set pending. */
export async function startReembedGeneration(
  service: EmbedderGenerationService,
  request: StartReembedRequestV1,
  triggeredByEmail: string,
): Promise<EmbeddingGenerationRowV1> {
  return service.startGeneration({
    targetModelName: request.target_model_name,
    generationLabel: request.generation_label,
    generationReason: request.generation_reason,
    sourceGenerationId: request.created_from_generation,
    triggeredByEmail,
  });
}

/** CANCEL — retire the backfilling generation + clear pending. */
export async function cancelReembedGeneration(
  service: EmbedderGenerationService,
  generationId: number,
  triggeredByEmail: string,
): Promise<EmbeddingGenerationRowV1> {
  return service.cancelPending({ generationId, triggeredByEmail });
}

/** ACTIVATE — promote target to active, demote current active to ready. */
export async function activateReembedGeneration(
  service: EmbedderGenerationService,
  generationId: number,
  triggeredByEmail: string,
): Promise<EmbeddingGenerationRowV1> {
  return service.activate({ generationId, triggeredByEmail });
}

/** ROLLBACK — alias for activate (allows from retired). */
export async function rollbackReembedGeneration(
  service: EmbedderGenerationService,
  targetGenerationId: number,
  triggeredByEmail: string,
): Promise<EmbeddingGenerationRowV1> {
  return service.rollback({ targetGenerationId, triggeredByEmail });
}

/** MANUAL-RETIRE — retire a 'ready' generation. */
export async function manualRetireReembedGeneration(
  service: EmbedderGenerationService,
  generationId: number,
  triggeredByEmail: string,
): Promise<EmbeddingGenerationRowV1> {
  return service.manualRetire({ generationId, triggeredByEmail });
}

/** GC — record gc_started_at (retention gate). The route dispatches the GC workflow only on success. */
export async function gcReembedGeneration(
  service: EmbedderGenerationService,
  generationId: number,
  triggeredByEmail: string,
  now: Date,
): Promise<EmbeddingGenerationRowV1> {
  return service.gc({ generationId, triggeredByEmail, now });
}

export { CoverageGapPresentError };
export type { CoverageResult };
