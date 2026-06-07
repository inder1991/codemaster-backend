/**
 * DB-gated integration coverage of the placeholder POST + cleanup audit-emit round-trip, against a
 * DISPOSABLE Postgres (the squashed baseline migrated; audit.workflow_events + its
 * REVIEW_PLACEHOLDER_POSTED/DELETED CHECK + the FK chain present). Runs ONLY when CODEMASTER_PG_CORE_DSN is
 * set (via describeDb); SKIPS otherwise so validate-fast stays green without a DB. NEVER touches any other
 * DB.
 *
 * The unit tests stub the audit emit; THIS test drives the REAL {@link makePlaceholderAuditEmit} /
 * {@link makeDeletePlaceholderAuditEmit} (which open a transaction over the ADR-0062 shared pool and call
 * {@link emitWorkflowEvent}) with a STUB GitHub client, then asserts the real
 * `REVIEW_PLACEHOLDER_POSTED` / `REVIEW_PLACEHOLDER_DELETED` rows landed with the right
 * payload + installation_id + sequence_no. Each test seeds a fresh FK chain
 * (pull_request_reviews → review_runs) the workflow-event FK requires, and cleans it up after.
 */

import { createHash, randomInt } from "node:crypto";

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import {
  doPostPlaceholder,
  makePlaceholderAuditEmit,
  markerForPlaceholder,
  type GhIssueCommentPostClient,
} from "#backend/activities/post_review_placeholder.activity.js";
import {
  doDeletePlaceholder,
  makeDeletePlaceholderAuditEmit,
  type GhIssueCommentDeleteClient,
} from "#backend/activities/delete_review_placeholder.activity.js";

import { disposeAllPools } from "#platform/db/database.js";
import { FakeClock } from "#platform/clock.js";

import { PostReviewPlaceholderInput } from "#contracts/post_review_placeholder_input.v1.js";
import { DeleteReviewPlaceholderInput } from "#contracts/delete_review_placeholder_input.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// Inside a real partition range (audit.workflow_events is RANGE-partitioned on received_at; a 2026-06
// instant routes to audit.workflow_events_p20260601). The audit row's received_at uses THIS clock.
const FIXED_CLOCK = new FakeClock({ now: new Date("2026-06-15T05:06:07.000Z") });

let pool: Pool;
let db: Kysely<Record<string, never>>;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool }) });
});

afterAll(async () => {
  await db?.destroy();
  // The audit-emit closures open the ADR-0062 shared pool for INTEGRATION_DSN; end it so the run leaks
  // no socket.
  await disposeAllPools();
});

/** Deterministic-enough RFC4122 v4 UUID for fixtures (NOT security-sensitive). */
function newUuid(): string {
  const h = createHash("sha1")
    .update(Buffer.from(`${process.hrtime.bigint()}-${randomInt(0, 1 << 30)}`, "utf-8"))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x40, 6); // version 4
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const hx = b.toString("hex");
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-${hx.slice(12, 16)}-${hx.slice(16, 20)}-${hx.slice(20, 32)}`;
}

function uniqueBigint(): number {
  return randomInt(1, 2_000_000_000);
}

type Seed = {
  installationId: string;
  reviewId: string;
  runId: string;
  prId: string;
};

/**
 * Seed the FK chain emitWorkflowEvent needs: core.pull_request_reviews (review_id PK) → one
 * core.review_runs row (run_id PK; review_id FK RESTRICT). The placeholder audit rows are keyed by
 * (run_id, review_id) with a non-null installation_id.
 */
async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const reviewId = newUuid();
  const runId = newUuid();
  const prId = newUuid();
  const repoId = uniqueBigint();
  const prNumber = (uniqueBigint() % 9999) + 1;

  await pool.query(
    `INSERT INTO core.pull_request_reviews
       (review_id, provider, repo_id, pr_number, provider_pr_id, status, current_run_id)
     VALUES ($1, 'github', $2, $3, $4, 'open', NULL)`,
    [reviewId, repoId, prNumber, `pr-${repoId}-${prNumber}`],
  );
  await pool.query(
    `INSERT INTO core.review_runs (run_id, review_id, trigger_type, lifecycle_state)
     VALUES ($1, $2, 'pr_opened', 'PENDING')`,
    [runId, reviewId],
  );
  return { installationId, reviewId, runId, prId };
}

async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [seed.runId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
}

type WorkflowEventRow = {
  event_type: string;
  sequence_no: number;
  installation_id: string | null;
  payload: Record<string, unknown>;
};

async function readEvents(runId: string): Promise<Array<WorkflowEventRow>> {
  const res = await pool.query<WorkflowEventRow>(
    `SELECT event_type, sequence_no, installation_id, payload
       FROM audit.workflow_events
      WHERE run_id = $1
      ORDER BY sequence_no`,
    [runId],
  );
  return res.rows;
}

// ─── stub GitHub issue-comment clients ───────────────────────────────────────────────────────────

function postStub(args: {
  listReturns: Array<Record<string, unknown>>;
  createReturns: number;
}): GhIssueCommentPostClient {
  return {
    async listIssueComments() {
      return args.listReturns;
    },
    async createIssueComment() {
      return args.createReturns;
    },
  };
}

function deleteStub(listReturns: Array<Record<string, unknown>>): {
  client: GhIssueCommentDeleteClient;
  deleted: Array<number>;
} {
  const deleted: Array<number> = [];
  const client: GhIssueCommentDeleteClient = {
    async listIssueComments() {
      return listReturns;
    },
    async deleteIssueComment({ commentId }) {
      deleted.push(commentId);
    },
  };
  return { client, deleted };
}

// ─── tests ───────────────────────────────────────────────────────────────────────────────────────

describeDb("placeholder audit emit (integration, disposable PG)", () => {
  let seed: Seed;

  beforeEach(async () => {
    seed = await seedTenant();
  });

  afterEach(async () => {
    await cleanupTenant(seed);
  });

  it("POST path writes a REVIEW_PLACEHOLDER_POSTED audit row with the right payload", async () => {
    const input = PostReviewPlaceholderInput.parse({
      pr_id: seed.prId,
      run_id: seed.runId,
      review_id: seed.reviewId,
      installation_id: seed.installationId,
      owner: "octo",
      repo_name: "app",
      pr_number: 7,
    });
    const ghClient = postStub({ listReturns: [], createReturns: 8675309 });

    await doPostPlaceholder(input, {
      ghClient,
      emitEvent: makePlaceholderAuditEmit(INTEGRATION_DSN!, FIXED_CLOCK),
    });

    const events = await readEvents(seed.runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("REVIEW_PLACEHOLDER_POSTED");
    expect(events[0]!.sequence_no).toBe(1);
    expect(events[0]!.installation_id).toBe(seed.installationId);
    expect(events[0]!.payload).toMatchObject({
      pr_id: seed.prId,
      pr_number: 7,
      github_comment_id: 8675309,
    });
  });

  it("DELETE path writes one REVIEW_PLACEHOLDER_DELETED audit row per deleted comment", async () => {
    const marker = markerForPlaceholder(seed.prId);
    const input = DeleteReviewPlaceholderInput.parse({
      pr_id: seed.prId,
      run_id: seed.runId,
      review_id: seed.reviewId,
      installation_id: seed.installationId,
      owner: "octo",
      repo_name: "app",
      pr_number: 7,
    });
    // Two matching placeholder comments (a defensive multi-delete) + one unrelated comment.
    const { client } = deleteStub([
      { id: 100, body: `first\n${marker}` },
      { id: 101, body: "unrelated" },
      { id: 102, body: `second\n${marker}` },
    ]);

    await doDeletePlaceholder(input, {
      ghClient: client,
      emitEvent: makeDeletePlaceholderAuditEmit(INTEGRATION_DSN!, FIXED_CLOCK),
    });

    const events = await readEvents(seed.runId);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.event_type)).toEqual([
      "REVIEW_PLACEHOLDER_DELETED",
      "REVIEW_PLACEHOLDER_DELETED",
    ]);
    // sequence_no monotonic per run (1, 2) — emitWorkflowEvent computes it under the per-run advisory lock.
    expect(events.map((e) => e.sequence_no)).toEqual([1, 2]);
    const deletedIds = events.map((e) => e.payload["github_comment_id"]);
    expect(new Set(deletedIds)).toEqual(new Set([100, 102]));
    for (const e of events) {
      expect(e.installation_id).toBe(seed.installationId);
    }
  });

  it("POST is idempotent: an existing marker comment skips the POST AND the audit emit", async () => {
    const marker = markerForPlaceholder(seed.prId);
    const input = PostReviewPlaceholderInput.parse({
      pr_id: seed.prId,
      run_id: seed.runId,
      review_id: seed.reviewId,
      installation_id: seed.installationId,
      owner: "octo",
      repo_name: "app",
      pr_number: 7,
    });
    const ghClient = postStub({
      listReturns: [{ id: 5, body: `already here\n${marker}` }],
      createReturns: 9999,
    });

    await doPostPlaceholder(input, {
      ghClient,
      emitEvent: makePlaceholderAuditEmit(INTEGRATION_DSN!, FIXED_CLOCK),
    });

    const events = await readEvents(seed.runId);
    expect(events).toHaveLength(0);
  });
});
