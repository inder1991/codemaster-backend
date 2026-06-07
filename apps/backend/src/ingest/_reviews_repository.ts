// core.pull_request_reviews repository — upsertReview + flipCurrentRun (1:1 with the frozen Python
// codemaster/ingest/_reviews_repository.py). Both take a Kysely executor; flipCurrentRun requires an open
// Transaction (its FOR UPDATE lock is only effective inside one).

import { type Kysely, sql } from "kysely";

import { assertOpenTransaction } from "#backend/domain/tx_guard.js";
import { CrossInstallationViolation } from "#backend/workspace/errors.js";

import { uuid4 } from "#platform/randomness.js";

/** Raised when flipCurrentRun's optimistic `oldRunIdExpected` guard does not match the row's actual
 *  current_run_id — the linearizability fence (1:1 with the Python `CurrentRunMismatch`). The caller's
 *  transaction must roll back + re-resolve. */
export class CurrentRunMismatch extends Error {
  public readonly reviewId: string;
  public readonly expected: string | null;
  public readonly actual: string | null;
  public constructor(args: { reviewId: string; expected: string | null; actual: string | null }) {
    super(
      `current_run mismatch for review_id=${args.reviewId}: expected ${String(args.expected)}, ` +
        `got ${String(args.actual)}`,
    );
    this.name = "CurrentRunMismatch";
    this.reviewId = args.reviewId;
    this.expected = args.expected;
    this.actual = args.actual;
  }
}

/**
 * Get-or-create the core.pull_request_reviews row for this PR via `INSERT ... ON CONFLICT (provider,
 * repo_id, pr_number) DO UPDATE`, returning the stable review_id (a fresh uuid4 on insert, the existing id
 * on conflict). The conflict branch refreshes provider_pr_id / pr_node_id / branch; `status` is omitted
 * (DB default 'open').
 */
export async function upsertReview(
  db: Kysely<unknown>,
  args: {
    provider: string;
    repoId: number;
    prNumber: number;
    providerPrId: string;
    prNodeId: string | null;
    branch: string | null;
  },
): Promise<string> {
  const r = await sql<{ review_id: string }>`
    INSERT INTO core.pull_request_reviews
      (review_id, provider, repo_id, pr_number, provider_pr_id, pr_node_id, branch)
    VALUES (${uuid4()}, ${args.provider}, ${args.repoId}, ${args.prNumber},
            ${args.providerPrId}, ${args.prNodeId}, ${args.branch})
    ON CONFLICT (provider, repo_id, pr_number) DO UPDATE SET
      provider_pr_id = EXCLUDED.provider_pr_id,
      pr_node_id = EXCLUDED.pr_node_id,
      branch = EXCLUDED.branch
    RETURNING review_id
  `.execute(db);
  const row = r.rows[0];
  if (row === undefined) {
    throw new Error("upsertReview: ON CONFLICT ... RETURNING returned no row (Postgres protocol invariant)");
  }
  return row.review_id;
}

/**
 * Atomically flip pull_request_reviews.current_run_id to newRunId and return the previous value (the AD-4
 * step). A single CTE SELECTs the current value FOR UPDATE, UPDATEs to newRunId, and RETURNs the
 * pre-update value. `oldRunIdExpected` (when non-null) is the optimistic linearizability guard → throws
 * CurrentRunMismatch on mismatch. `expectedInstallationId` (when provided) is the BF-9 cross-installation
 * guard; undefined is the Phase-B grace period (WARN + skip the verification SELECT).
 */
export async function flipCurrentRun(
  db: Kysely<unknown>,
  args: {
    reviewId: string;
    newRunId: string;
    oldRunIdExpected?: string | null;
    expectedInstallationId?: string;
  },
): Promise<string | null> {
  assertOpenTransaction(db, "flipCurrentRun");

  // BF-9 cross-installation guard (only when expectedInstallationId provided; else Phase-B grace WARN).
  if (args.expectedInstallationId === undefined) {
    console.warn(
      JSON.stringify({ event: "cross_installation.flip_current_run_without_expected", review_id: args.reviewId }),
    );
  } else {
    const v = await sql<{ installation_id: string | null }>`
      SELECT r.installation_id FROM core.pull_request_reviews prr
        JOIN core.repositories r ON r.github_repo_id = prr.repo_id
       WHERE prr.review_id = ${args.reviewId}
         FOR UPDATE OF prr
    `.execute(db);
    const actual = v.rows[0]?.installation_id ?? null;
    if (actual !== args.expectedInstallationId) {
      throw new CrossInstallationViolation({
        primitive: "flip_current_run",
        keyKind: "review_id",
        keyValue: args.reviewId,
        expectedInstallationId: args.expectedInstallationId,
        actualInstallationId: actual,
      });
    }
  }

  const r = await sql<{ old_run_id: string | null }>`
    WITH prev AS (
      SELECT current_run_id AS old_run_id FROM core.pull_request_reviews
       WHERE review_id = ${args.reviewId} FOR UPDATE
    )
    UPDATE core.pull_request_reviews prr SET current_run_id = ${args.newRunId}
      FROM prev WHERE prr.review_id = ${args.reviewId}
    RETURNING prev.old_run_id
  `.execute(db);
  const row = r.rows[0];
  if (row === undefined) {
    throw new Error(`flipCurrentRun: review_id=${args.reviewId} not found in core.pull_request_reviews`);
  }
  const oldRunId = row.old_run_id;

  // Optimistic guard: raise BEFORE commit so the outer tx rolls back the (in-txn) UPDATE.
  if (args.oldRunIdExpected != null && oldRunId !== args.oldRunIdExpected) {
    throw new CurrentRunMismatch({
      reviewId: args.reviewId,
      expected: args.oldRunIdExpected,
      actual: oldRunId,
    });
  }
  return oldRunId;
}
