// test/integration/runner/_fixtures.ts
import { randomUUID } from "node:crypto"; // test/ is OUT of the clock/random gate's scope
import { Kysely, sql } from "kysely";

/**
 * Seed a real review chain (pull_request_reviews → review_runs) so review_jobs.run_id FK holds.
 * Column sets + UNIQUE indexes verified against :5434/codemaster:
 *  - core.pull_request_reviews NOT NULL: review_id, provider, repo_id(bigint), pr_number, provider_pr_id,
 *    status(CHECK ∈ open|closed|merged), created_at. (repo_id is a GitHub bigint, NOT a hard FK — orphans allowed.)
 *    UNIQUE (provider, provider_pr_id) AND UNIQUE (provider, repo_id, pr_number) — the fixture ties BOTH to the
 *    globally-unique reviewId so parallel/repeated seeds cannot collide (v4 #5).
 *  - core.review_runs NOT NULL: run_id, review_id(FK→pull_request_reviews.review_id), trigger_type
 *    (CHECK ∈ pr_opened|pr_synchronize|manual_rerun|comment_trigger|retry|scheduled), attempt_number(≥1),
 *    lifecycle_state(CHECK ∈ PENDING|RUNNING|WAITING_RETRY|COMPLETED|FAILED|CANCELLED|PARTIAL), is_ephemeral,
 *    started_at, created_at.
 */
export async function seedRun(db: Kysely<unknown>): Promise<{ runId: string; reviewId: string; installationId: string }> {
  const runId = randomUUID(), reviewId = randomUUID(), installationId = randomUUID();
  // Derive uniqueness from the globally-unique reviewId so NEITHER unique index can flake:
  //   provider_pr_id carries the full reviewId  → UNIQUE (provider, provider_pr_id) holds.
  //   repo_id = 48 bits of the reviewId         → UNIQUE (provider, repo_id, pr_number) holds (collision-proof for tests;
  //   48-bit birthday bound ≈ 16M rows, exact as a JS integer < 2^53, fits the bigint column). pr_number is fixed at 1.
  const repoId = parseInt(reviewId.replace(/-/g, "").slice(0, 12), 16);
  await sql`INSERT INTO core.pull_request_reviews
      (review_id, provider, repo_id, pr_number, provider_pr_id, status, created_at)
    VALUES (${reviewId}, 'github', ${repoId}, 1, ${`gh-${reviewId}`}, 'open', now())`.execute(db);
  await sql`INSERT INTO core.review_runs
      (run_id, review_id, trigger_type, attempt_number, lifecycle_state, is_ephemeral, started_at, created_at)
    VALUES (${runId}, ${reviewId}, 'pr_opened', 1, 'PENDING', false, now(), now())`.execute(db);
  return { runId, reviewId, installationId };
}
