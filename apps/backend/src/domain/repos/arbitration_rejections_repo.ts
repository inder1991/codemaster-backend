/**
 * ArbitrationRejectionsRepo — 1:1 TypeScript/Kysely port of the frozen Python repo
 * `vendor/codemaster-py/codemaster/domain/repos/arbitration_rejections_repo.py`
 * (`PostgresArbitrationRejectionsRepo`, 2026-05-19 Phase D observability-gap fix).
 *
 * One row per {@link RejectedIntent} emitted by the arbitration layer, over `core.arbitration_rejections`
 * (migration 0086). Closes the observability gap surfaced by smoke-#18 — before this the rejection signal
 * was computed and thrown away.
 *
 * Faithful to the Python source:
 *
 *  - **Single public method `insertRejection`** — exactly the method set of the Python port
 *    (`insert_rejection`).
 *
 *  - **Idempotency via `ON CONFLICT (run_id, target_finding_id, reason_rejected) DO NOTHING`.** The UNIQUE
 *    `(run_id, target_finding_id, reason_rejected)` constraint (`uq_arbitration_rejections_run_target_reason`)
 *    absorbs Temporal retries of the same `apply_arbitration` activity invocation — the same workflow replay
 *    re-firing the activity produces ZERO row drift.
 *
 *  - **Tenancy.** `installation_id` is in the INSERT column/VALUES list directly, exactly as the Python SQL.
 *    INSERT carries no WHERE clause, so the {@link TenancyPlugin} (which gates only SELECT/UPDATE/DELETE) does
 *    not fire on the write; the plugin is nonetheless installed centrally by {@link tenantKysely}.
 *
 *  - **`intent_confidence` is bound as the canonical-decimal STRING** (or null) the arbitration layer carries
 *    — the `numeric` column ingests the string losslessly (no float round-trip), mirroring the Python
 *    `Decimal | None` bind.
 *
 * ADR-0062 (Postgres connection-pool lifecycle): this repo owns NO `pg.Pool`, constructs no `new Kysely(...)`,
 * memoizes neither. It is handed a `Kysely<ArbitrationRejectionsDB>` over the process-wide single pool from
 * {@link tenantKysely}; {@link ArbitrationRejectionsRepo.fromDsn} is the default entry point. Pool teardown
 * is the shared `disposeAllPools` / `disposePool` seam — a Kysely from {@link tenantKysely} must NOT be
 * `destroy()`-ed by a repo.
 */

import { type Generated, type Kysely } from "kysely";

import { tenantKysely } from "#platform/db/database.js";

// ── Kysely table typing for core.arbitration_rejections (confirmed against the live disposable DB) ──

/**
 * Column types for `core.arbitration_rejections`. `rejection_id` / `created_at` are DB-defaulted
 * (`gen_random_uuid()` / `now()`) — {@link Generated} so they need not be supplied on insert.
 * `intent_confidence` is `numeric` — bound as a STRING (or null) to preserve the Decimal's exact textual form.
 */
type ArbitrationRejectionsTable = {
  rejection_id: Generated<string>;
  installation_id: string;
  run_id: string;
  review_id: string;
  target_finding_id: string;
  reason_rejected: string;
  intent_confidence: string | null;
  intent_reason: string | null;
  suppression_model: string | null;
  suppression_prompt_version: string | null;
  created_at: Generated<Date>;
};

/** The Kysely schema for this repo — schema-qualified table key so the TenancyPlugin can resolve it. */
type ArbitrationRejectionsDB = {
  "core.arbitration_rejections": ArbitrationRejectionsTable;
};

// ── Public input shape (mirrors the Python keyword-only signature) ──

/**
 * Arguments to {@link ArbitrationRejectionsRepo.insertRejection}, mirroring the Python `insert_rejection`
 * keyword-only signature 1:1. `intentConfidence` is the canonical-decimal string (or null) — NOT a number,
 * to preserve the Decimal's textual form into the `numeric` column.
 */
export type InsertRejectionInput = {
  installationId: string;
  runId: string;
  reviewId: string;
  targetFindingId: string;
  reasonRejected: string;
  intentConfidence: string | null;
  intentReason: string | null;
  suppressionModel: string | null;
  suppressionPromptVersion: string | null;
};

/** Repo port consumed by the Phase D arbitration-apply path (analogue of `ArbitrationRejectionsRepoPort`). */
export type ArbitrationRejectionsRepoPort = {
  /**
   * Insert one `core.arbitration_rejections` row. Idempotent via `ON CONFLICT (run_id, target_finding_id,
   * reason_rejected) DO NOTHING` — Temporal retries of the same activity invocation are absorbed without row
   * duplication.
   */
  insertRejection(input: InsertRejectionInput): Promise<void>;
};

/**
 * Implements {@link ArbitrationRejectionsRepoPort} against `core.arbitration_rejections` via Kysely.
 *
 * ADR-0062: the injected `Kysely<ArbitrationRejectionsDB>` is the tenant-scoped, shared-pool instance from
 * {@link tenantKysely}. This repo owns NO pool and NO Kysely cache. The {@link TenancyPlugin} is already
 * installed by {@link tenantKysely}; do NOT re-install it here.
 */
export class ArbitrationRejectionsRepo implements ArbitrationRejectionsRepoPort {
  // The injected, shared-pool Kysely (ADR-0062). NOT owned by this repo — never `destroy()`-ed here.
  readonly #db: Kysely<ArbitrationRejectionsDB>;

  /**
   * Construct from an injected `Kysely<ArbitrationRejectionsDB>` — the tenant-scoped, shared-pool instance
   * from {@link tenantKysely}. Tests / composition roots that already hold a `Kysely` inject it here.
   */
  constructor(args: { db: Kysely<ArbitrationRejectionsDB> }) {
    this.#db = args.db;
  }

  /**
   * Default entry point (ADR-0062): build a repo over the process-wide single pool for `dsn` via
   * {@link tenantKysely}. Every repo over the same DSN shares ONE pool — no per-repo pool cache.
   */
  static fromDsn(dsn: string): ArbitrationRejectionsRepo {
    return new ArbitrationRejectionsRepo({ db: tenantKysely<ArbitrationRejectionsDB>(dsn) });
  }

  async insertRejection(input: InsertRejectionInput): Promise<void> {
    // 1:1 with the Python INSERT: same 9 columns, ON CONFLICT (run_id, target_finding_id, reason_rejected)
    // DO NOTHING. installation_id is in the VALUES list (tenancy satisfied at the literal-SQL level).
    await this.#db
      .insertInto("core.arbitration_rejections")
      .values({
        installation_id: input.installationId,
        run_id: input.runId,
        review_id: input.reviewId,
        target_finding_id: input.targetFindingId,
        reason_rejected: input.reasonRejected,
        intent_confidence: input.intentConfidence,
        intent_reason: input.intentReason,
        suppression_model: input.suppressionModel,
        suppression_prompt_version: input.suppressionPromptVersion,
      })
      .onConflict((oc) =>
        oc.columns(["run_id", "target_finding_id", "reason_rejected"]).doNothing(),
      )
      .execute();
  }
}
