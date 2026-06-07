/**
 * `persistReviewWalkthrough` activity — review-detail P3. 1:1 in intent with the frozen Python
 * `@activity.defn persist_review_walkthrough_activity`
 * (`vendor/codemaster-py/codemaster/activities/persist_review_walkthrough.py`): take the single typed
 * input envelope, construct the Postgres repo, upsert the review's structured `WalkthroughV1` into
 * `core.review_walkthroughs` so the admin review-detail page can render the TL;DR + per-file table.
 *
 * Dispatched from the workflow body (NOT threaded into the sacred `post_review_results` mutation seam)
 * and fail-open at the WORKFLOW level — a walkthrough-persist failure must never fail the review. That
 * fail-open is the WORKFLOW's responsibility (the stage_outcome wrapper), exactly as in the frozen
 * Python; the activity itself simply persists or raises, matching the Python body which awaits the
 * repo upsert and returns `None`.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047
 *
 * The frozen Python activity accepts `PersistReviewWalkthroughInputV1 | dict` and re-validates the dict
 * wire form internally (`PersistReviewWalkthroughInputV1.model_validate(payload)`) — a dict-dispatch
 * fallback. This port takes the TYPED {@link PersistReviewWalkthroughInputV1} directly: the Temporal
 * DataConverter validates the payload through the Zod contract on the wire, so the activity body never
 * re-validates a raw dict. That CLOSES the dict-dispatch deviation, matching the sibling ported
 * activities (`persistReviewFindings`, `computePolicyRules`). The behavior is preserved: a malformed
 * payload is rejected at the boundary either way.
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. Real I/O (the
 * `pg.Pool` the repo opens through the ADR-0062 shared seam) is permitted here. There is NO clock /
 * random / crypto seam in this activity: `created_at` / `updated_at` default to the server-side SQL
 * `now()` and the conflict branch sets `updated_at = now()` in SQL (see the repo), so the #platform
 * clock/random seams are not needed (and the check_clock_random gate is a no-op here).
 *
 * ## DSN
 *
 * The Postgres DSN is read from `CODEMASTER_PG_CORE_DSN` (the canonical core-store env var, matching the
 * sibling `persistReviewFindings`). {@link ReviewWalkthroughsRepo.fromDsn} routes it through the
 * ADR-0062 process-shared single pool per DSN — the activity does NOT open its own pool.
 *
 * ## Idempotency + tenancy
 *
 * Idempotency is inherited verbatim from the repo's `INSERT … ON CONFLICT (review_id) DO UPDATE` — a
 * second persist for the same `review_id` UPDATEs in place (no duplicate row) and migrates
 * `installation_id` to the latest value. The write carries `installation_id` (the tenancy column on
 * `core.review_walkthroughs`).
 */

import { ReviewWalkthroughsRepo } from "#backend/domain/repos/review_walkthroughs_repo.js";

import { type PersistReviewWalkthroughInputV1 } from "#contracts/persist_review_walkthrough.v1.js";

/**
 * The activity: persist the review's structured walkthrough, returning void.
 *
 * Constructs {@link ReviewWalkthroughsRepo} over the ADR-0062 shared pool for the
 * `CODEMASTER_PG_CORE_DSN` DSN, then delegates to `upsert` with the three fields the frozen Python body
 * passes (`review_id`, `installation_id`, `walkthrough`). Returns `void` — 1:1 with the Python `-> None`.
 */
export async function persistReviewWalkthrough(
  input: PersistReviewWalkthroughInputV1,
): Promise<void> {
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; cannot construct the review-walkthroughs repo",
    );
  }

  const repo = ReviewWalkthroughsRepo.fromDsn(dsn);

  await repo.upsert({
    reviewId: input.review_id,
    installationId: input.installation_id,
    walkthrough: input.walkthrough,
  });
}
