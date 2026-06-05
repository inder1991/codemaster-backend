/**
 * `startReviewForWebhook` activity — the decision + mutex-aware GATE for the review chain. 1:1 in intent
 * with the frozen Python `@activity.defn start_review_for_webhook_activity`
 * (`vendor/codemaster-py/codemaster/activities/start_review_for_webhook.py`): a thin tenancy re-check +
 * per-PR mutex acquire over the typed `ReviewPullRequestPayloadV1` envelope.
 *
 * ## Behaviour (the gate's status surface)
 *
 * The single positional input is the RAW `ReviewPullRequestPayloadV1`-shaped dict (CLAUDE.md invariant 11
 * — one positional arg). The activity re-validates it INDEPENDENTLY (it does not trust the dispatcher),
 * and carries the v1-tolerance shim, exactly like the Python gate:
 *
 *   1. **v1-tolerance shim.** A legacy (pre-S19.SMOKE.2) outbox payload has 5 fields and NO `pr_id`. The
 *      gate detects this by the missing `pr_id` BEFORE parsing against the v2 contract and returns
 *      `status='skipped_legacy_payload'` (`pr_number = max(1, pr_number)`), so an operator can drain the
 *      stale rows. No mutex is touched.
 *   2. **Tenancy re-check (default-deny).** `SELECT enabled FROM core.repositories` for the
 *      (installation_id, repository_id) pair. This is the race-window last line of defence: the webhook
 *      handler skipped enqueue when `enabled=false`, but the flag could have flipped between then and now.
 *        - row missing → RAISE (`RuntimeError`-analogue): a reconcile race; Temporal retries / dead-letters.
 *        - `enabled=false` → `status='skipped_disabled'` (no mutex acquired).
 *   3. **Mutex acquire.** `acquirePrReviewMutex(installation_id, repository_id, pr_number, holder)`. On
 *      success → `status='accepted'` with `mutex_id = acquired.mutexId`. When another live lease holds the
 *      PR → `status='skipped_busy'` (`mutex_id` null).
 *
 * The `closed` status stays in the result contract enum (a future surface) but this gate never produces
 * it — closed PRs don't reach the gate; the webhook handler emits the audit upstream. (1:1 with the
 * Python docstring: "`closed` is no longer produced".)
 *
 * ## Transaction / connection contract
 *
 * The Python wraps the tenancy SELECT + the mutex acquire in ONE `session.begin()` transaction (so the
 * re-check and the acquire are atomic against the race window). The TS mutex helper requires its advisory
 * xact-lock + `FOR UPDATE` + INSERT to run on ONE client in ONE transaction; we run the tenancy SELECT on
 * that SAME client inside {@link withMutexTransaction}, preserving the atomicity. The pool is the shared
 * ADR-0062 single pool for the `CODEMASTER_PG_CORE_DSN` DSN (via {@link getPool}) — the activity does NOT
 * open its own pool.
 *
 * ## Runtime context
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox — so raw I/O (the
 * `pg.Pool`) and `node:crypto` (the mutex's advisory-key hashing) are available here. The injected
 * {@link WallClock} is the seam the mutex helper carries for call-site stability (the DB `now()` is the
 * authoritative lease clock).
 *
 * ## Encrypted audit emit (Stage-3 wire — was FOLLOW-UP-stage3-gate-audit-emit)
 *
 * The gate writes an `audit.audit_events` row on every branch (`pr.accepted`, `pr.skipped_disabled`,
 * `pr.skipped_busy`, `pr.skipped_legacy_payload`) via the encrypted (AES-256-GCM, per-column AAD)
 * {@link emitAuditEvent} / {@link bindAuditContext} helpers — the TS port of the frozen-Python
 * `codemaster/audit/emit.py`. The emit runs on the SAME transaction client as the tenancy re-check + the
 * mutex acquire, so the audit row commits atomically with the gate's decision (1:1 with the Python
 * `session.begin()` wrapping both). The `after` payloads are byte-for-byte the Python shapes:
 *   - `pr.accepted`              → `{ head_sha }` (the I3 fix: the SHA, not the repo full_name).
 *   - `pr.skipped_disabled`      → `{ reason: "repository.enabled=false" }`.
 *   - `pr.skipped_busy`          → `{ holder_workflow_id }` (the live lease's holder).
 *   - `pr.skipped_legacy_payload`→ `{ schema_version_received, delivery_id }`.
 * The encryption key comes from the audit field-encryption registry seam (populated at startup by the
 * dev env loader or the Vault loader — FOLLOW-UP-audit-vault-key-loader); encrypt fails closed if no key
 * is installed.
 */

import { type Pool } from "pg";

import {
  acquirePrReviewMutex,
  withMutexTransaction,
} from "#backend/concurrency/pr_mutex.js";

import { bindAuditContext, emitAuditEvent } from "#backend/audit/emit.js";

import { getPool } from "#platform/db/database.js";
import { WallClock, type Clock } from "#platform/clock.js";

import { ReviewPullRequestPayloadV1, ReviewPullRequestResultV1 } from "#contracts/review_pull_request.v1.js";

/**
 * Detect a v1 (pre-S19.SMOKE.2) outbox payload — 5 fields, no `pr_id`. The v2 envelope always has
 * `pr_id`. 1:1 with the Python `_is_legacy_v1_payload`.
 */
function isLegacyV1Payload(payloadDict: Record<string, unknown>): boolean {
  return !("pr_id" in payloadDict);
}

/** Canonical RFC4122 UUID syntax (case-insensitive) — the gate's tolerant installation_id parse. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The V1-tolerance shim — rolling-deploy window. Emits a `pr.skipped_legacy_payload` audit row (so an
 * operator can drain the v1 rows) and returns the clear `skipped_legacy_payload` signal. 1:1 with the
 * Python `_handle_legacy_v1_payload`, INCLUDING the installation_id-parse tolerance: the audit row is
 * only emitted when the legacy payload's `installation_id` parses as a UUID (the audit tenancy context
 * cannot bind otherwise); a non-parseable id still returns the signal, just without the audit row.
 *
 * The emit runs in its OWN short transaction on a fresh client (the Python opens a separate
 * `session.begin()` here — the legacy path never touches the mutex, so it does not share the
 * withMutexTransaction client).
 */
async function handleLegacyV1Payload(
  payloadDict: Record<string, unknown>,
  pool: Pool,
  clock: Clock,
): Promise<ReviewPullRequestResultV1> {
  // Python: `int(payload_dict.get("pr_number", -1))` with a try/except → -1 on a non-coercible value,
  // then `max(1, pr_number)` on return.
  const rawPrNumber = payloadDict["pr_number"];
  let prNumber = -1;
  if (typeof rawPrNumber === "number" && Number.isInteger(rawPrNumber)) {
    prNumber = rawPrNumber;
  } else if (typeof rawPrNumber === "string") {
    const parsed = Number.parseInt(rawPrNumber, 10);
    if (!Number.isNaN(parsed)) prNumber = parsed;
  }

  // Tolerant installation_id parse — bind + emit only when it is a syntactically-valid UUID (mirrors the
  // Python `uuid.UUID(install_uuid_str)` try/except → None on failure → skip the bind).
  const rawIid = payloadDict["installation_id"];
  const installationId = typeof rawIid === "string" && UUID_RE.test(rawIid) ? rawIid : null;

  if (installationId !== null) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      bindAuditContext(client, { installationId });
      await emitAuditEvent({
        client,
        actorKind: "system",
        actorId: null,
        action: "pr.skipped_legacy_payload",
        targetKind: "pull_request",
        targetId: String(prNumber),
        before: null,
        after: {
          // The RAW received values (could be any JSON type) — 1:1 with the Python
          // `payload_dict.get("schema_version")` / `.get("delivery_id")` (→ null when absent).
          schema_version_received: (payloadDict["schema_version"] ?? null) as unknown,
          delivery_id: (payloadDict["delivery_id"] ?? null) as unknown,
        },
        clock,
      });
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // best-effort rollback; surface the original error
      }
      throw err;
    } finally {
      client.release();
    }
  }

  return ReviewPullRequestResultV1.parse({
    status: "skipped_legacy_payload",
    pr_number: Math.max(1, prNumber),
  });
}

/**
 * Tenancy gate + mutex-acquire for the review chain. Returns one of: `accepted`, `skipped_busy`,
 * `skipped_disabled`, `skipped_legacy_payload`. Raises on a reconcile race (repository row missing).
 *
 * The single positional input is the RAW payload dict (typed `unknown` — the activity re-validates it
 * independently, mirroring the Python `dict[str, Any]` + `ReviewPullRequestPayloadV1.model_validate`).
 */
export async function startReviewForWebhook(
  payloadDict: unknown,
): Promise<ReviewPullRequestResultV1> {
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error("CODEMASTER_PG_CORE_DSN is not set; cannot run the start-review gate");
  }
  const pool = getPool(dsn);
  const clock = new WallClock();

  // The legacy-v1 shim keys off field PRESENCE (missing `pr_id`), so it needs an object to inspect. A
  // non-object input is a hard contract violation — fall straight through to the v2 Zod parse below,
  // which raises the precise validation error (Temporal's payload converter only ever hands us the
  // decoded dict, so this guard is belt-and-suspenders for the `unknown` activity-input type).
  if (typeof payloadDict === "object" && payloadDict !== null) {
    const rawDict = payloadDict as Record<string, unknown>;
    if (isLegacyV1Payload(rawDict)) {
      return handleLegacyV1Payload(rawDict, pool, clock);
    }
  }

  // v2 path: re-validate INDEPENDENTLY (don't trust the dispatcher). 1:1 with
  // `ReviewPullRequestPayloadV1.model_validate(payload_dict)`.
  const payload = ReviewPullRequestPayloadV1.parse(payloadDict);

  // ONE transaction on ONE client: the tenancy re-check SELECT + the mutex acquire (advisory xact lock +
  // FOR UPDATE + INSERT) + the audit emit are atomic against the race window, mirroring the Python
  // `session.begin()`. Bind the audit tenancy context on this client so emitAuditEvent attributes rows.
  return withMutexTransaction(pool, async (client) => {
    bindAuditContext(client, { installationId: payload.installation_id });

    // Race-window re-check: the webhook handler skipped enqueue if enabled=false, but the flag could
    // have flipped between then and now. Last line of defence (CLAUDE.md "default deny"). Tenant-
    // filtered: installation_id is in the WHERE clause.
    const enabledRes = await client.query<{ enabled: boolean }>(
      "SELECT enabled FROM core.repositories " +
        "WHERE repository_id = $1 AND installation_id = $2",
      [payload.repository_id, payload.installation_id],
    );
    const enabledRow = enabledRes.rows[0];
    if (enabledRow === undefined) {
      // Repository row deleted between webhook enqueue and gate execution — a reconcile race. Raise so
      // Temporal retries; subsequent retries will likely also fail and dead-letter, which is the right
      // behaviour. 1:1 with the Python RuntimeError. (No audit row — the Python raises before emit too.)
      throw new Error(
        `repository_id=${payload.repository_id} not found for ` +
          `installation_id=${payload.installation_id}; reconcile race`,
      );
    }
    if (!enabledRow.enabled) {
      await emitAuditEvent({
        client,
        actorKind: "system",
        actorId: null,
        action: "pr.skipped_disabled",
        targetKind: "pull_request",
        targetId: String(payload.pr_number),
        before: null,
        after: { reason: "repository.enabled=false" },
        clock,
      });
      return ReviewPullRequestResultV1.parse({
        status: "skipped_disabled",
        pr_number: payload.pr_number,
      });
    }

    const fullName = `${payload.gh_owner}/${payload.gh_repo_name}`;
    // Python holder format EXACTLY: ReviewPR-{owner}/{repo}-{pr_number}-{head_sha[:8]}.
    const holder = `ReviewPR-${fullName}-${payload.pr_number}-${payload.head_sha.slice(0, 8)}`;
    const acquired = await acquirePrReviewMutex({
      client,
      installationId: payload.installation_id,
      repositoryId: payload.repository_id,
      prNumber: payload.pr_number,
      holderWorkflowId: holder,
      clock,
    });
    if (!acquired.acquired) {
      await emitAuditEvent({
        client,
        actorKind: "system",
        actorId: null,
        action: "pr.skipped_busy",
        targetKind: "pull_request",
        targetId: String(payload.pr_number),
        before: null,
        after: { holder_workflow_id: acquired.holderWorkflowId },
        clock,
      });
      return ReviewPullRequestResultV1.parse({
        status: "skipped_busy",
        pr_number: payload.pr_number,
      });
    }

    // Mutex stays held; the workflow's finally block releases it via the release activity.
    //
    // I3 fix (S19.SMOKE.2): the `after` carries head_sha=the actual SHA (a pre-PR#115 bug set it to the
    // repo full_name); `action` is dropped (no downstream consumer). 1:1 with the Python emit.
    await emitAuditEvent({
      client,
      actorKind: "system",
      actorId: null,
      action: "pr.accepted",
      targetKind: "pull_request",
      targetId: String(payload.pr_number),
      before: null,
      after: { head_sha: payload.head_sha },
      clock,
    });
    return ReviewPullRequestResultV1.parse({
      status: "accepted",
      pr_number: payload.pr_number,
      mutex_id: acquired.mutexId,
    });
  });
}
