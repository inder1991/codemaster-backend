// EmbedderGenerationService — 1:1 TypeScript port of vendor/codemaster-py/codemaster/embedder/service.py.
//
// Sole owner of embedder lifecycle transitions (spec §5 + v4 §5.0). Every admin write endpoint, workflow,
// and activity calls this service rather than mutating embedding_generations / embedder_runtime_state
// directly. Preconditions are validated HERE; the repos (PostgresEmbeddingGenerationsRepo /
// PostgresEmbedderRuntimeStateRepo) perform pure I/O whose SQL satisfies the on-disk biconditional CHECKs.
//
// State machine (allowed transitions only):
//   backfilling --(transitionToReady)--> ready
//   backfilling --(cancelPending)------> retired (retire_reason='cancelled')
//   ready ------(activate)-------------> active (demotes previous active)
//   ready ------(manualRetire)---------> retired (retire_reason='manual_retire')
//   retired ----(rollback/activate)----> active (if NOT gc_completed AND chunks exist)
//   retired ----(gc, after retention)--> state stays 'retired'; gc_started_at set
//
// Forbidden transitions raise typed exceptions; the API layer maps each to its HTTP status (see embedder.py).

import type { PostgresEmbeddingGenerationsRepo } from "#backend/domain/repos/embedding_generations_repo.js";
import type { PostgresEmbedderRuntimeStateRepo } from "#backend/domain/repos/embedder_runtime_state_repo.js";
import type { EmbeddingGenerationRowV1 } from "#contracts/embedding_generation.v1.js";

// ─── Errors — 1:1 with the Python service exceptions ─────────────────────────────────────────────────
export class GenerationServiceError extends Error {}

export class PendingGenerationInFlightError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "PendingGenerationInFlightError";
  }
}
export class GenerationNotFoundError extends GenerationServiceError {
  public constructor(generationId: number) {
    super(`generation_id=${generationId} does not exist`);
    this.name = "GenerationNotFoundError";
  }
}
export class InvalidStateTransitionError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidStateTransitionError";
  }
}
export class GenerationDataAlreadyCollectedError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "GenerationDataAlreadyCollectedError";
  }
}
export class GCRetentionNotElapsedError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "GCRetentionNotElapsedError";
  }
}
export class ValidationNotPassedError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "ValidationNotPassedError";
  }
}
export class CoverageGapPresentError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "CoverageGapPresentError";
  }
}
export class EmbeddingDimensionInvariantError extends GenerationServiceError {
  public constructor(message: string) {
    super(message);
    this.name = "EmbeddingDimensionInvariantError";
  }
}

const PLATFORM_EMBEDDING_DIMENSION = 1024;
const DEFAULT_GC_RETENTION_DAYS = 30;

/** Coverage-gap report for the active generation (v4 §8 Phase B). */
export type CoverageResult = {
  confluenceMissing: number;
  knowledgeMissing: number;
  totalMissing: number;
  activeGeneration: number;
};

export class EmbedderGenerationService {
  private readonly gensRepo: PostgresEmbeddingGenerationsRepo;
  private readonly stateRepo: PostgresEmbedderRuntimeStateRepo;
  private readonly gcRetentionMs: number;
  private readonly gcRetentionDays: number;

  public constructor({
    gensRepo,
    stateRepo,
    gcRetentionDays = DEFAULT_GC_RETENTION_DAYS,
  }: {
    gensRepo: PostgresEmbeddingGenerationsRepo;
    stateRepo: PostgresEmbedderRuntimeStateRepo;
    gcRetentionDays?: number;
  }) {
    this.gensRepo = gensRepo;
    this.stateRepo = stateRepo;
    this.gcRetentionDays = gcRetentionDays;
    this.gcRetentionMs = gcRetentionDays * 24 * 60 * 60 * 1000;
  }

  /** START — INSERT backfilling generation, set pending, bump config_version. */
  public async startGeneration(args: {
    targetModelName: string;
    generationLabel: string | null;
    generationReason: string | null;
    triggeredByEmail: string;
    sourceGenerationId: number | null;
    embeddingDimension?: number;
    chunkerVersion?: string;
    preprocessingVersion?: string;
    normalizationVersion?: string;
  }): Promise<EmbeddingGenerationRowV1> {
    const dim = args.embeddingDimension ?? PLATFORM_EMBEDDING_DIMENSION;
    if (dim !== PLATFORM_EMBEDDING_DIMENSION) {
      throw new EmbeddingDimensionInvariantError(
        `embedding_dimension=${dim}; only ${PLATFORM_EMBEDDING_DIMENSION} is supported on this platform. ` +
          "See FOLLOW-UP-embedder-multi-dimension-support.",
      );
    }
    const state = await this.stateRepo.get();
    if (state.pending_generation !== null) {
      throw new PendingGenerationInFlightError(
        `pending_generation=${state.pending_generation} already in flight`,
      );
    }
    const sourceId = args.sourceGenerationId ?? state.active_generation;
    const gen = await this.gensRepo.insertNew({
      modelName: args.targetModelName,
      embeddingDimension: dim,
      generationLabel: args.generationLabel,
      generationReason: args.generationReason,
      createdByEmail: args.triggeredByEmail,
      createdFromGeneration: sourceId,
      chunkerVersion: args.chunkerVersion ?? "1",
      preprocessingVersion: args.preprocessingVersion ?? "1",
      normalizationVersion: args.normalizationVersion ?? "1",
    });
    await this.stateRepo.setPending({
      generationId: gen.generation_id,
      modelName: args.targetModelName,
      updatedByEmail: args.triggeredByEmail,
    });
    return gen;
  }

  /** CANCEL — retire the pending (backfilling) generation + clear pending. */
  public async cancelPending(args: {
    generationId: number;
    triggeredByEmail: string;
  }): Promise<EmbeddingGenerationRowV1> {
    const gen = await this.gensRepo.get(args.generationId);
    if (gen === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    if (gen.state !== "backfilling") {
      throw new InvalidStateTransitionError(
        `cancel_pending: gen ${args.generationId} state='${gen.state}'`,
      );
    }
    await this.gensRepo.transitionToRetired(args.generationId, "cancelled");
    await this.stateRepo.clearPending({ updatedByEmail: args.triggeredByEmail });
    const updated = await this.gensRepo.get(args.generationId);
    if (updated === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    return updated;
  }

  /** MANUAL-RETIRE — retire a never-activated 'ready' generation. */
  public async manualRetire(args: {
    generationId: number;
    triggeredByEmail: string;
  }): Promise<EmbeddingGenerationRowV1> {
    const gen = await this.gensRepo.get(args.generationId);
    if (gen === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    if (gen.state !== "ready") {
      throw new InvalidStateTransitionError(
        `manual_retire: gen ${args.generationId} state='${gen.state}'; need 'ready'`,
      );
    }
    await this.gensRepo.transitionToRetired(args.generationId, "manual_retire");
    const updated = await this.gensRepo.get(args.generationId);
    if (updated === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    return updated;
  }

  /** ACTIVATE — atomically promote target & demote current active. Preconditions: state ∈ {ready,retired},
   *  validation_passed≠false, gc_completed_at null, chunk_embeddings>0. */
  public async activate(args: {
    generationId: number;
    triggeredByEmail: string;
  }): Promise<EmbeddingGenerationRowV1> {
    const gen = await this.gensRepo.get(args.generationId);
    if (gen === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    if (gen.state !== "ready" && gen.state !== "retired") {
      throw new InvalidStateTransitionError(
        `activate: gen ${args.generationId} state='${gen.state}'; need 'ready' or 'retired'`,
      );
    }
    if (gen.gc_completed_at !== null) {
      throw new GenerationDataAlreadyCollectedError(
        `gen ${args.generationId} has gc_completed_at set`,
      );
    }
    if (gen.validation_passed === false) {
      throw new ValidationNotPassedError(
        `activate: gen ${args.generationId} validation_passed=false. Re-validate before activating, ` +
          "or wait for FOLLOW-UP-embedder-validation-override.",
      );
    }
    const ceCount = await this.gensRepo.countChunkEmbeddings(args.generationId);
    if (ceCount === 0) {
      throw new GenerationDataAlreadyCollectedError(
        `gen ${args.generationId} has zero chunk_embeddings rows`,
      );
    }
    await this.gensRepo.transitionToActive(args.generationId);
    await this.stateRepo.activate({
      generationId: args.generationId,
      modelName: gen.model_name,
      updatedByEmail: args.triggeredByEmail,
    });
    const updated = await this.gensRepo.get(args.generationId);
    if (updated === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    return updated;
  }

  /** ROLLBACK — alias for activate (allows from retired); the audit-event name differs at the API layer. */
  public async rollback(args: {
    targetGenerationId: number;
    triggeredByEmail: string;
  }): Promise<EmbeddingGenerationRowV1> {
    return this.activate({
      generationId: args.targetGenerationId,
      triggeredByEmail: args.triggeredByEmail,
    });
  }

  /** GC — record gc_started_at after checking the retention window. The actual deletion runs in the
   *  GarbageCollectGenerationWorkflow; only dispatch that workflow when this call succeeds. */
  public async gc(args: {
    generationId: number;
    triggeredByEmail: string;
    now?: Date;
  }): Promise<EmbeddingGenerationRowV1> {
    const gen = await this.gensRepo.get(args.generationId);
    if (gen === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    if (gen.state !== "retired") {
      throw new InvalidStateTransitionError(
        `gc: gen ${args.generationId} state='${gen.state}'; need 'retired'`,
      );
    }
    if (gen.retired_at === null) {
      throw new InvalidStateTransitionError(`gc: gen ${args.generationId} retired_at is NULL`);
    }
    const now = args.now ?? new Date();
    const ageMs = now.getTime() - gen.retired_at.getTime();
    if (ageMs < this.gcRetentionMs) {
      throw new GCRetentionNotElapsedError(
        `gen ${args.generationId} retired_at=${gen.retired_at.toISOString()} ` +
          `has not aged past the ${this.gcRetentionDays}d retention window`,
      );
    }
    await this.gensRepo.recordGcStarted(args.generationId);
    const updated = await this.gensRepo.get(args.generationId);
    if (updated === null) {
      throw new GenerationNotFoundError(args.generationId);
    }
    return updated;
  }

  /** COVERAGE — count canonical chunks with no chunk_embeddings row under the active generation. */
  public async getCoverage(): Promise<CoverageResult> {
    const state = await this.stateRepo.get();
    const [confluenceMissing, knowledgeMissing] = await this.gensRepo.countCoverageGap({
      activeGeneration: state.active_generation,
    });
    return {
      confluenceMissing,
      knowledgeMissing,
      totalMissing: confluenceMissing + knowledgeMissing,
      activeGeneration: state.active_generation,
    };
  }

  /** SET-RETRIEVAL-MODE — flip retrieval_mode; validate the coverage gate when flipping to generation_only. */
  public async setRetrievalMode(args: {
    mode: "fallback" | "generation_only";
    triggeredByEmail: string;
  }): Promise<void> {
    if (args.mode === "generation_only") {
      const coverage = await this.getCoverage();
      if (coverage.totalMissing > 0) {
        throw new CoverageGapPresentError(
          `coverage gap present: confluence_missing=${coverage.confluenceMissing}, ` +
            `knowledge_missing=${coverage.knowledgeMissing}. ` +
            "Re-run backfill before flipping to generation_only.",
        );
      }
    }
    await this.stateRepo.setRetrievalMode({
      mode: args.mode,
      updatedByEmail: args.triggeredByEmail,
    });
  }
}
