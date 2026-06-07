// GitHub webhook PERSISTENCE — the producer that turns an authenticated webhook into durable state +
// (for review-triggering pull_request actions) one temporal_workflow_start outbox row the
// OutboxDispatcherWorkflow drains. 1:1 in intent with codemaster/ingest/github_webhook_persistence.py;
// Stage 1 = the core review-dispatch spine. PR-metadata persistence (Stage 3), the pr.closed forensic
// audit (Stage 3), the repair-drift dispatcher (Stage 2), and the reconcile/sync emitters (Stage 4) are
// documented stubs below.
//
// Transaction model: the whole webhook runs in ONE Kysely transaction (db.transaction().execute) so the
// audit row + idempotency row + run allocation + outbox row commit (or roll back) atomically. The audit +
// idempotency writes are Kysely `sql` on the tx; the allocator primitives + emitWorkflowEvent +
// appendReviewDispatch all run on the same tx.

import { type Kysely, sql } from "kysely";

import { OUTBOX_PAYLOAD_SCHEMA_VERSION, PostgresOutboxRepo } from "#backend/domain/repos/outbox_repo.js";
import { derivePrId } from "#backend/ingest/_pr_id.js";
import { allocateRun, type AllocationOutcome } from "#backend/ingest/_review_run_allocator.js";
import { upsertReview } from "#backend/ingest/_reviews_repository.js";
import {
  extractInstallationId,
  extractPrMetadata,
  extractPrNodeId,
  extractSenderLogin,
  type PrMetadata,
} from "#backend/ingest/_webhook_extractors.js";
import {
  resolveInternalInstallationId,
  resolveInternalRepositoryId,
} from "#backend/ingest/_webhook_resolvers.js";

import { type Clock } from "#platform/clock.js";
import { uuid4 } from "#platform/randomness.js";

// ─── constants (1:1 with the Python module, except the R1 workflow-type rename) ──────────────────────

/**
 * The review workflow TYPE the dispatched outbox row carries. DELIBERATE RENAME vs the Python
 * `_REVIEW_WORKFLOW_TYPE = "ReviewPullRequestWorkflow"`: Temporal starts a workflow by its REGISTERED type
 * name, which in the TS worker is the exported function name `reviewPullRequest`. A payload carrying the
 * Python string would dead-letter ("workflow type not registered"). See the staged-plan R1 resolution.
 */
const REVIEW_WORKFLOW_TYPE = "reviewPullRequest";
const REVIEW_TASK_QUEUE = "review-default";
/** Fix D1 — explicit 1800s execution+run timeout (overrides the 900s payload default) so hung reviews
 *  terminate before the reaper threshold. */
const REVIEW_TIMEOUT_SECONDS = 1800;

/** PR actions that trigger a review enqueue (1:1 with `_OUTBOX_TRIGGER_ACTIONS`). */
const OUTBOX_TRIGGER_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
]);

/** PR action → review-run trigger_type (1:1 with `_ACTION_TO_TRIGGER_TYPE`). */
const ACTION_TO_TRIGGER_TYPE: Readonly<Record<string, string>> = {
  opened: "pr_opened",
  reopened: "pr_opened",
  synchronize: "pr_synchronize",
  ready_for_review: "pr_synchronize",
};

/** In-process result of {@link persistWebhook} (1:1 with `WebhookPersistResultV1`). NOT a wire contract. */
export type WebhookPersistResultV1 = {
  schemaVersion: number;
  deduped: boolean;
  webhookEventId: string;
  installationId: string | null;
  deliveryId: string;
};

// ─── the v2 review payload + the outer temporal-start payload ─────────────────────────────────────────

/** Build the inner ReviewPullRequestPayloadV1 (v2) the review workflow consumes. */
function buildReviewPayload(args: {
  prMeta: PrMetadata;
  internalIid: string;
  internalRepoId: string;
  prId: string;
  outcome: AllocationOutcome;
  reviewId: string;
  githubIid: number | null;
  deliveryId: string;
}): Record<string, unknown> {
  const { prMeta } = args;
  return {
    schema_version: 2,
    installation_id: args.internalIid,
    repository_id: args.internalRepoId,
    pr_id: args.prId,
    pr_number: prMeta.prNumber,
    head_sha: prMeta.headSha,
    gh_owner: prMeta.ghOwner,
    gh_repo_name: prMeta.ghRepoName,
    pr_title: prMeta.prTitle,
    pr_description: prMeta.prDescription,
    delivery_id: args.deliveryId,
    policy_revision: 0, // ADR-0060 A: model selection moved to purpose→model; field retained at 0.
    run_id: args.outcome.newRunId,
    review_id: args.reviewId,
    github_installation_id: args.githubIid, // numeric GitHub-API id (NOT the internal UUID)
    author_login: prMeta.authorLogin,
    draft: prMeta.draft,
    base_ref: prMeta.baseRef ? prMeta.baseRef.slice(0, 255) : null,
    head_ref: prMeta.headRef ? prMeta.headRef.slice(0, 255) : null,
    opened_at: prMeta.openedAt, // already an ISO-8601 string | null
  };
}

/** Build the outer TemporalWorkflowStartPayloadV1 (the outbox row's payload). */
function buildOuterPayload(args: {
  internalIid: string;
  internalRepoId: string;
  prMeta: PrMetadata;
  reviewPayload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    workflow_type: REVIEW_WORKFLOW_TYPE,
    workflow_id: `review/${args.internalIid}/${args.internalRepoId}/${args.prMeta.prNumber}`,
    task_queue: REVIEW_TASK_QUEUE,
    args: [args.reviewPayload],
    id_reuse_policy: "ALLOW_DUPLICATE",
    id_conflict_policy: "USE_EXISTING",
    execution_timeout_seconds: REVIEW_TIMEOUT_SECONDS,
    run_timeout_seconds: REVIEW_TIMEOUT_SECONDS,
  };
}

// ─── the SERIAL+SUPERSEDE allocator wrapper for the PR-webhook path ───────────────────────────────────

/** Compose upsertReview → allocateRun → backfill audit.webhook_events.run_id (1:1 with
 *  `_allocate_run_for_pr_webhook`). Returns the allocation outcome + the (stable) review_id. */
async function allocateRunForPrWebhook(
  tx: Kysely<unknown>,
  args: {
    body: Uint8Array;
    prMeta: PrMetadata;
    deliveryId: string;
    webhookEventId: string;
    internalIid: string;
    clock: Clock;
  },
): Promise<{ outcome: AllocationOutcome; reviewId: string }> {
  const nodeId = extractPrNodeId(args.body);
  // provider_pr_id is NOT NULL: prefer node_id; else synthesize a stable fallback.
  const providerPrId =
    nodeId ??
    (args.prMeta.githubPullRequestId !== null
      ? `gh-pr-${args.prMeta.githubPullRequestId}`
      : `gh-pr-${args.prMeta.githubRepoId}-${args.prMeta.prNumber}`);
  const triggeredBy = extractSenderLogin(args.body);
  const triggerType = ACTION_TO_TRIGGER_TYPE[args.prMeta.action]!;

  const reviewId = await upsertReview(tx, {
    provider: "github",
    repoId: args.prMeta.githubRepoId,
    prNumber: args.prMeta.prNumber,
    providerPrId,
    prNodeId: nodeId,
    branch: args.prMeta.headRef || null,
  });

  const outcome = await allocateRun(tx, {
    reviewId,
    installationId: args.internalIid,
    triggerType,
    triggeredBy,
    provider: "github",
    deliveryId: args.deliveryId,
    clock: args.clock,
    parentRunId: null,
  });

  // Backfill the audit row's run_id now that it's allocated.
  await sql`UPDATE audit.webhook_events SET run_id = ${outcome.newRunId} WHERE webhook_event_id = ${args.webhookEventId}`.execute(
    tx,
  );

  return { outcome, reviewId };
}

// ─── the public entry ─────────────────────────────────────────────────────────────────────────────────

/**
 * Persist a (HMAC-verified-or-not) GitHub webhook. ALWAYS writes the audit row (forensics > performance,
 * even for spoofed deliveries). On a VALID signature: dedups via cache.cache_idempotency, and for a
 * review-triggering pull_request action allocates the run (SERIAL+SUPERSEDE) and appends the review
 * dispatch outbox row. Returns the result envelope (used for logging + the route's response mapping).
 */
export async function persistWebhook(args: {
  db: Kysely<unknown>;
  body: Uint8Array;
  headers: Record<string, string>;
  signatureValid: boolean;
  clock: Clock;
}): Promise<WebhookPersistResultV1> {
  const deliveryId = args.headers["x-github-delivery"] ?? "";
  const eventType = args.headers["x-github-event"] ?? "";
  if (!deliveryId || !eventType) {
    throw new Error(
      "persistWebhook: missing x-github-delivery / x-github-event (the receiver should have refused this earlier)",
    );
  }

  return args.db.transaction().execute(async (tx) => {
    const githubIid = extractInstallationId(args.body);
    const internalIid = await resolveInternalInstallationId(tx, githubIid);
    const webhookEventId = uuid4();

    // Audit row is ALWAYS written (forensics-first; even spoofed / deduped deliveries). raw_body is the
    // plaintext bytes — the Python persist path stores plaintext here (the EncryptedBytes TypeDecorator
    // does not fire on raw text() binds); see staged-plan R5.
    await sql`
      INSERT INTO audit.webhook_events
        (webhook_event_id, installation_id, delivery_id, event_type, received_at, signature_valid, raw_body)
      VALUES (${webhookEventId}, ${internalIid}, ${deliveryId}, ${eventType}, ${args.clock.now()},
              ${args.signatureValid}, ${Buffer.from(args.body)})
    `.execute(tx);

    let deduped = false;
    if (args.signatureValid) {
      // Atomic idempotency: a returning row means we're the first writer; zero rows = a concurrent /
      // prior delivery already claimed this key (no SELECT-before-INSERT — closes the race). value = the
      // UTF-8 bytes of the webhook_event_id UUID string; 24h TTL computed in SQL (no new Date()).
      // Mirror Python's `{github_iid or 'unknown'}` truthiness: installation.id 0 (falsy in Python)
      // also falls back to "unknown" — `??` alone would keep the literal "0" and diverge.
      const iidPart = githubIid ? String(githubIid) : "unknown";
      const cacheKey = `github-webhook:${iidPart}:${deliveryId}`;
      const ins = await sql<{ cache_key: string }>`
        INSERT INTO cache.cache_idempotency (cache_key, value, expires_at, created_at)
        VALUES (${cacheKey}, ${Buffer.from(webhookEventId, "utf-8")},
                ${args.clock.now()}::timestamptz + interval '24 hours', ${args.clock.now()})
        ON CONFLICT (cache_key) DO NOTHING
        RETURNING cache_key
      `.execute(tx);
      deduped = ins.rows.length === 0;

      if (!deduped && eventType === "pull_request") {
        const prMeta = extractPrMetadata(args.body);
        if (prMeta !== null) {
          const internalRepoId = await resolveInternalRepositoryId(tx, prMeta.githubRepoId, internalIid);
          if (internalRepoId === null || internalIid === null) {
            // Drift: known installation, unknown repo. STAGE-1 STUB for maybeEnqueueRepair (Stage 2 wires
            // RepairInstallationRepositoriesWorkflow via the shared dispatcher; ADR-0054 / invariant 16
            // forbid mutating core.repositories inline). The PR is "lost" for review (fail-open).
            console.warn(
              JSON.stringify({
                event: "webhook.pr_repo_unresolved_drift",
                delivery_id: deliveryId,
                github_repo_id: prMeta.githubRepoId,
              }),
            );
          } else if (prMeta.action === "closed") {
            // STAGE-1 STUB: the pr.closed forensic audit (emitAuditEvent on the encrypted audit_events
            // table) wires in Stage 3 — it needs the pg-client AuditQueryClient seam, deferred under the
            // Kysely-native transaction model. No enqueue for closed PRs (correct).
          } else if (OUTBOX_TRIGGER_ACTIONS.has(prMeta.action)) {
            const { outcome, reviewId } = await allocateRunForPrWebhook(tx, {
              body: args.body,
              prMeta,
              deliveryId,
              webhookEventId,
              internalIid,
              clock: args.clock,
            });
            const prId = derivePrId({
              installationId: internalIid,
              repositoryId: internalRepoId,
              prNumber: prMeta.prNumber,
            });
            const reviewPayload = buildReviewPayload({
              prMeta,
              internalIid,
              internalRepoId,
              prId,
              outcome,
              reviewId,
              githubIid,
              deliveryId,
            });
            const payload = buildOuterPayload({ internalIid, internalRepoId, prMeta, reviewPayload });
            await new PostgresOutboxRepo().appendReviewDispatch({
              db: tx,
              runId: outcome.newRunId,
              payload,
              schemaVersion: OUTBOX_PAYLOAD_SCHEMA_VERSION,
              installationId: internalIid,
              deliveryId,
              traceContext: null, // OTel trace-capture deferred (consistent with the dispatcher's §E seam)
            });
          }
          // edited / converted_to_draft: not review-triggering + not closed → no enqueue (correct).
        }
      }
      // STAGE-4 STUB: installation_reconcile / sync_code_owners / refresh_semantic_docs emitters (their
      // downstream workflows are not yet registered in TS — faithful-but-dormant; deferred).
    }

    return { schemaVersion: 1, deduped, webhookEventId, installationId: internalIid, deliveryId };
  });
}
