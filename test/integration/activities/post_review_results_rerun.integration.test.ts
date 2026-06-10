// W3.1 (D4) — durable comment_ids on core.posted_reviews + lost-claim recovery + repair-needed metric.
//
// The won-claim path persists `github_review_id` AND `comment_ids`; a crash-then-re-run loses the claim
// and the lost-claim path must return the STORED `comment_ids` (NOT `[]`) so inline lifecycle
// finalization works on the re-run. A posted review whose stored `comment_ids` is empty BUT whose input
// still carries kept findings emits `codemaster_posted_reviews_comment_ids_repair_needed_total` (D4's
// repair signal).
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise. NEVER touches any
// other DB. Every test seeds a fresh FK chain (pull_request_reviews[current_run_id] → review_runs) for
// the AD-4 stale-write guard + a standalone core.posted_reviews row keyed by pr_meta.pr_id; all rows are
// cleaned up per-test.
//
// COUNTER-TIMING GOTCHA (verified empirically; same as chunk_response_parser.counters.test.ts): the
// activity caches its Counter instruments at MODULE scope (created once at import) per the metrics-seam
// convention. An OTel counter created BEFORE a MeterProvider is registered binds to the no-op meter and
// never records to a later-registered provider. So the in-memory provider is registered in `beforeAll`
// and the activity module is DYNAMICALLY IMPORTED afterward, so its module-scope counters (including the
// new repair-needed counter) bind to the in-memory provider.
import { createHash, randomInt } from "node:crypto";

import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { disposeAllPools } from "#platform/db/database.js";
import { FakeClock } from "#platform/clock.js";

import { type PostReviewInputV1 } from "#contracts/post_review_input.v1.js";
import { type PrMetaV1, type WalkthroughV1 } from "#contracts/walkthrough.v1.js";
import { type AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { type ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { type PostedReviewV1 } from "#contracts/posted_review.v1.js";

import {
  type CreatedReviewV1,
  type GhReviewClient,
  type ReviewComment,
} from "#backend/integrations/github/review_client.js";
// W4.3 (gate ①): the terminal-cancel error the abort gate throws. Static import is safe — the runner
// module has no import cycle back into the activity (it depends only on #platform / #contracts / ./).
import { TerminalCancelError } from "#backend/runner/review_job_runner.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// 2099 keeps any FakeClock-driven audit emit out of a missing range partition (same convention as the
// post_review_results integration test). The doPost age computation uses Postgres now(), NOT this clock.
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-03-04T05:06:07.000Z") });

// Dynamically-imported activity surface (see COUNTER-TIMING GOTCHA above). Hand-written structural types
// so we never statically import the module (which would eagerly bind its module-scope counters to the
// no-op meter BEFORE the provider is registered).
type DoPost = (
  input: PostReviewInputV1,
  deps: {
    ghClient: GhReviewClient;
    dsn: string;
    clock?: FakeClock;
    inFlightWindowSeconds?: number;
    sameRunTakeover?: boolean;
    // W4.3 (gate ①): optional abort signal. When already-aborted, doPost throws TerminalCancelError
    // BEFORE any GitHub write (createReview/updateReview). Absent → byte-identical Temporal behaviour.
    signal?: AbortSignal;
  },
) => Promise<PostedReviewV1>;
type MarkerFor = (prId: string) => string;

let doPost: DoPost;
let markerFor: MarkerFor;

let pool: Pool;
let exporter: InMemoryMetricExporter;
let provider: MeterProvider;

const REPAIR_NEEDED_NAME = "codemaster_posted_reviews_comment_ids_repair_needed_total";

beforeAll(async () => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool / provider against an undefined DSN
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 8 });

  // DELTA temporality (not CUMULATIVE) so each forceFlush reports only the adds SINCE the last
  // collection — combined with exporter.reset() in beforeEach, every test asserts EXACTLY its own
  // counter adds (no cross-test running-total accumulation).
  exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 2_147_483_647 });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  // Dynamic import AFTER provider registration so the module-scope counters bind to the real meter.
  ({ doPost, markerFor } = await import("#backend/activities/post_review_results.activity.js"));
});

afterAll(async () => {
  await provider?.shutdown();
  metrics.disable(); // reset the process-global provider so other test files start clean.
  // The doPost path opens the ADR-0062 shared pool for INTEGRATION_DSN; end it so the run leaks no socket.
  await disposeAllPools();
});

beforeEach(() => {
  // Drop any prior export batches so `sumFor` sees only this test's flush.
  exporter?.reset();
});

/** Every data point of `name` (which carries no labels), across all collected metrics. */
function pointsFor(name: string): Array<DataPoint<number>> {
  const out: Array<DataPoint<number>> = [];
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === name) {
          for (const dp of m.dataPoints as Array<DataPoint<number>>) {
            out.push(dp);
          }
        }
      }
    }
  }
  return out;
}

/** Sum the value of the (label-less) counter `name` across the reset-then-single-flush batches. */
function sumFor(name: string): number {
  return pointsFor(name).reduce((acc, dp) => acc + dp.value, 0);
}

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

// ─── FK-chain seed (1:1 in shape with the post_review_results integration test) ─────────────────

type Seed = {
  installationId: string;
  reviewId: string;
  currentRunId: string;
  prId: string;
};

async function seedTenant(): Promise<Seed> {
  const installationId = newUuid();
  const reviewId = newUuid();
  const currentRunId = newUuid();
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
    [currentRunId, reviewId],
  );
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = $1 WHERE review_id = $2`, [
    currentRunId,
    reviewId,
  ]);
  return { installationId, reviewId, currentRunId, prId };
}

async function cleanupTenant(seed: Seed): Promise<void> {
  await pool.query(`DELETE FROM core.posted_reviews WHERE pr_id = $1`, [seed.prId]);
  await pool.query(`DELETE FROM audit.workflow_events WHERE run_id = $1`, [seed.currentRunId]);
  await pool.query(`UPDATE core.pull_request_reviews SET current_run_id = NULL WHERE review_id = $1`, [
    seed.reviewId,
  ]);
  await pool.query(`DELETE FROM core.review_runs WHERE run_id = $1`, [seed.currentRunId]);
  await pool.query(`DELETE FROM core.pull_request_reviews WHERE review_id = $1`, [seed.reviewId]);
}

/** Read the persisted core.posted_reviews row state (github_review_id + publication_outcome + comment_ids). */
async function readPostedRow(prId: string): Promise<
  | {
      github_review_id: string | null;
      publication_outcome: string;
      comment_ids: Array<number>;
    }
  | undefined
> {
  const res = await pool.query<{
    github_review_id: string | null;
    publication_outcome: string;
    comment_ids: Array<number>;
  }>(
    `SELECT github_review_id, publication_outcome, comment_ids FROM core.posted_reviews WHERE pr_id = $1`,
    [prId],
  );
  return res.rows[0];
}

/** Pre-seed the Phase-1 claim-row shape: an OWNED posted_reviews row with github_review_id NULL +
 *  publication_outcome='degraded_unposted' (the exact state after a crash between claim and Phase-2). A
 *  re-run loses the ON CONFLICT claim → enters the lost-claim NULL-row branch → the W3.2 takeover. */
async function seedNullClaimRow(prId: string): Promise<void> {
  await pool.query(
    `INSERT INTO core.posted_reviews (pr_id, marker, posted_at) VALUES ($1, $2, now())`,
    [prId, `<!-- codemaster:review-marker:${prId} -->`],
  );
}

// ─── fixtures ────────────────────────────────────────────────────────────────────────────────────

const FILE_IN_DIFF = "src/app.ts";

function finding(overrides: Partial<ReviewFindingV1> = {}): ReviewFindingV1 {
  return {
    schema_version: 1,
    file: FILE_IN_DIFF,
    start_line: 10,
    end_line: 10,
    severity: "issue",
    category: "bug",
    title: "Null deref",
    body: "Possible null dereference here.",
    suggestion: null,
    confidence: 0.9,
    sources: [],
    scope: "chunk_observed",
    evidence_refs: [],
    ...overrides,
  };
}

function makeInput(args: {
  seed: Seed;
  findings: ReadonlyArray<ReviewFindingV1>;
  changedLineRanges?: Record<string, Array<[number, number]>>;
}): PostReviewInputV1 {
  const prMeta: PrMetaV1 = {
    pr_id: args.seed.prId,
    installation_id: args.seed.installationId,
    repo: "octo/app",
    pr_title: "Add feature",
    pr_description: "desc",
    author_login: null,
    draft: false,
    base_ref: null,
    head_ref: null,
    opened_at: null,
  };
  const walkthrough: WalkthroughV1 = {
    schema_version: 1,
    tldr: "Adds a feature.",
    file_rows: [],
    configuration_section_md: "",
    degradation_note: null,
    truncated: false,
    suggested_reviewers: [],
    linked_issues: [],
    sanitization_event: null,
  };
  const aggregated: AggregatedFindingsV1 = {
    schema_version: 1,
    findings: [...args.findings],
    dedupe_stats: {
      input_count: args.findings.length,
      exact_dropped: 0,
      semantic_merged: 0,
      capped: 0,
      semantic_skipped: false,
    },
    policy_revision: 0,
  };
  return {
    schema_version: 1,
    walkthrough,
    aggregated,
    pr_meta: prMeta,
    github_installation_id: 4815162342,
    head_sha: "abc123",
    walkthrough_md: "## Walkthrough\n\nAdds a feature.",
    owner: "octo",
    repo_name: "app",
    pr_number: 7,
    run_id: args.seed.currentRunId,
    review_id: args.seed.reviewId,
    changed_line_ranges: args.changedLineRanges ?? { [FILE_IN_DIFF]: [[1, 100]] },
  };
}

// ─── scripted stub GhReviewClient ────────────────────────────────────────────────────────────────

type StubScript = {
  createReview?: Array<CreatedReviewV1 | (() => CreatedReviewV1)>;
  /** Scripted return for findExistingReviewByMarker (W3.2 takeover). Default: null (no remote review). */
  findExistingReviewByMarker?: number | null;
  /** Scripted comment ids for listReviewComments (W3.2 takeover recovery). Default: []. */
  reviewComments?: Array<number>;
  /** W3.2 racer hook: invoked AFTER the marker search, BEFORE the takeover CAS, so the test can simulate
   *  another writer winning the row (sets github_review_id between the lost-claim SELECT and the CAS). */
  beforeCas?: () => Promise<void>;
};

type StubCalls = {
  createReview: Array<{ comments: ReadonlyArray<ReviewComment> }>;
  updateReview: Array<{ reviewId: number; body: string }>;
  findExistingReviewByMarker: Array<{ marker: string }>;
  listReviewComments: Array<{ reviewId: number }>;
};

function makeStub(script: StubScript): { client: GhReviewClient; calls: StubCalls } {
  const createSeq = [...(script.createReview ?? [])];
  const calls: StubCalls = {
    createReview: [],
    updateReview: [],
    findExistingReviewByMarker: [],
    listReviewComments: [],
  };
  const client: GhReviewClient = {
    async findExistingReviewByMarker({ marker }) {
      calls.findExistingReviewByMarker.push({ marker });
      // The racer hook fires right after the marker search (the takeover reads the marker, then the racer
      // wins the row, then the takeover CAS finds 0 rows). Modelled here because doPost calls the marker
      // search immediately before the CAS.
      if (script.beforeCas) {
        await script.beforeCas();
      }
      return script.findExistingReviewByMarker ?? null;
    },
    async createReview({ comments }) {
      calls.createReview.push({ comments });
      const next = createSeq.shift();
      if (next === undefined) {
        throw new Error("stub createReview called more times than scripted");
      }
      return typeof next === "function" ? next() : next;
    },
    async updateReview({ reviewId, body }) {
      calls.updateReview.push({ reviewId, body });
    },
    async listReviewComments({ reviewId }) {
      calls.listReviewComments.push({ reviewId });
      return [...(script.reviewComments ?? [])];
    },
    async createIssueComment() {
      throw new Error("not used in this test");
    },
    async listIssueComments() {
      return [];
    },
    async deleteIssueComment() {
      // no-op
    },
  };
  return { client, calls };
}

// ─── tests ───────────────────────────────────────────────────────────────────────────────────────

describeDb("post_review_results doPost — durable comment_ids re-run recovery (W3.1 / D4)", () => {
  let seed: Seed;

  beforeEach(async () => {
    seed = await seedTenant();
  });

  afterEach(async () => {
    await cleanupTenant(seed);
  });

  it("WON: createReview ids are persisted to core.posted_reviews.comment_ids (durable)", async () => {
    // Stub A wins the claim and creates the review with two inline comment ids.
    const createdA: CreatedReviewV1 = { reviewId: 999, commentIds: [1001, 1002] };
    const { client, calls } = makeStub({ createReview: [createdA] });
    const input = makeInput({
      seed,
      findings: [finding({ start_line: 10, end_line: 10 }), finding({ start_line: 20, end_line: 20 })],
    });

    const result = await doPost(input, {
      ghClient: client,
      dsn: INTEGRATION_DSN!,
      clock: FIXED_CLOCK,
    });

    expect(result.publication_outcome).toBe("inline_posted");
    expect(result.review_id).toBe(999);
    expect(result.comment_ids).toEqual([1001, 1002]);
    expect(calls.createReview.length).toBe(1);

    // The row carries BOTH github_review_id=999 AND the durable comment_ids (NOT the DB default []).
    const row = await readPostedRow(seed.prId);
    expect(row).toBeDefined();
    expect(Number(row!.github_review_id)).toBe(999);
    expect(row!.comment_ids).toEqual([1001, 1002]);
  });

  it("RE-RUN lost-claim: returns the STORED comment_ids (not []) and never re-creates", async () => {
    // First run (stub A) wins the claim, stores reviewId 999 + comment ids.
    const createdA: CreatedReviewV1 = { reviewId: 999, commentIds: [1001, 1002] };
    const stubA = makeStub({ createReview: [createdA] });
    const input = makeInput({
      seed,
      findings: [finding({ start_line: 10, end_line: 10 }), finding({ start_line: 20, end_line: 20 })],
    });
    const first = await doPost(input, { ghClient: stubA.client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });
    expect(first.review_id).toBe(999);
    expect(stubA.calls.createReview.length).toBe(1);

    // Re-run (stub B) — the row already holds the claim → lost-claim path. ZERO createReview on B, ONE
    // updateReview, and the returned PostedReviewV1.comment_ids MUST be the stored ids (recovers inline
    // lifecycle finalization), NOT the [] it returned before W3.1.
    const stubB = makeStub({});
    const second = await doPost(input, { ghClient: stubB.client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

    expect(second.was_update).toBe(true);
    expect(second.review_id).toBe(999);
    expect(stubB.calls.createReview.length).toBe(0); // ZERO create on the re-run
    expect(stubB.calls.updateReview.length).toBe(1); // ONE update
    expect(stubB.calls.updateReview[0]!.reviewId).toBe(999);
    expect(second.comment_ids).toEqual([1001, 1002]); // STORED ids recovered, NOT []

    // The persisted row is unchanged.
    const row = await readPostedRow(seed.prId);
    expect(Number(row!.github_review_id)).toBe(999);
    expect(row!.comment_ids).toEqual([1001, 1002]);
  });

  it("REPAIR-NEEDED: lost-claim re-run on a winner with EMPTY stored comment_ids but kept findings → metric increments", async () => {
    // Pre-seed a winning row that published (github_review_id set) but stored EMPTY comment_ids — the
    // pre-W3.1 corruption shape (won-claim that never wrote the ids). The re-run's input STILL carries a
    // kept finding, so the lost-claim path can't recover ids for inline finalization → emit the repair
    // signal.
    await pool.query(
      `INSERT INTO core.posted_reviews
         (pr_id, marker, github_review_id, publication_outcome, comment_ids, posted_at)
       VALUES ($1, $2, $3, 'inline_posted', '[]'::jsonb, now())`,
      [seed.prId, markerFor(seed.prId), 4242],
    );

    const { client, calls } = makeStub({});
    const input = makeInput({ seed, findings: [finding({ start_line: 10, end_line: 10 })] });

    const result = await doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

    expect(result.was_update).toBe(true);
    expect(result.review_id).toBe(4242);
    expect(result.comment_ids).toEqual([]); // nothing to recover
    expect(calls.updateReview.length).toBe(1);

    await provider.forceFlush();
    expect(sumFor(REPAIR_NEEDED_NAME)).toBe(1);
  });

  it("REPAIR-NEEDED: NOT emitted when stored comment_ids are present (no repair signal on the healthy path)", async () => {
    await pool.query(
      `INSERT INTO core.posted_reviews
         (pr_id, marker, github_review_id, publication_outcome, comment_ids, posted_at)
       VALUES ($1, $2, $3, 'inline_posted', '[1001]'::jsonb, now())`,
      [seed.prId, markerFor(seed.prId), 4242],
    );

    const { client } = makeStub({});
    const input = makeInput({ seed, findings: [finding({ start_line: 10, end_line: 10 })] });

    const result = await doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK });

    expect(result.comment_ids).toEqual([1001]);

    await provider.forceFlush();
    expect(sumFor(REPAIR_NEEDED_NAME)).toBe(0);
  });
});

// ─── W3.2 (E7 + v3-F1): same-run takeover WITH remote-recovery on the NULL-row path ─────────────────
//
// A NULL github_review_id row means EITHER (i) createReview never ran (claim taken, crash before create)
// OR (ii) createReview SUCCEEDED but the DB UPDATE crashed before storing the id. Blindly re-creating
// handles (i) but DOUBLE-POSTS a second GitHub review in (ii). So sameRunTakeover FIRST recovers from
// GitHub by marker, and creates ONLY when no matching remote review exists. The takeover also bypasses
// the 300s IN_FLIGHT_WINDOW (a freshly-seeded NULL row is < window age) because in the runner world the
// re-run IS the retry of the crashed self.
describeDb("post_review_results doPost — same-run takeover w/ remote-recovery (W3.2 / E7 / v3-F1)", () => {
  let seed: Seed;

  beforeEach(async () => {
    seed = await seedTenant();
  });

  afterEach(async () => {
    await cleanupTenant(seed);
  });

  it("(a) create-never-ran: marker finds nothing → re-creates, exactly ONE createReview total", async () => {
    // Phase-1 claim row exists (NULL github_review_id), createReview never ran. Re-run loses the claim →
    // lost-claim NULL branch → takeover: marker search finds nothing → re-create lands the review.
    await seedNullClaimRow(seed.prId);

    const created: CreatedReviewV1 = { reviewId: 4242, commentIds: [7001, 7002] };
    const { client, calls } = makeStub({
      createReview: [created],
      findExistingReviewByMarker: null, // no remote review exists yet
    });
    const input = makeInput({
      seed,
      findings: [finding({ start_line: 10, end_line: 10 }), finding({ start_line: 20, end_line: 20 })],
    });

    const result = await doPost(input, {
      ghClient: client,
      dsn: INTEGRATION_DSN!,
      clock: FIXED_CLOCK,
      sameRunTakeover: true,
    });

    // Marker searched, found nothing → re-created exactly once. ZERO listReviewComments (no remote review).
    expect(calls.findExistingReviewByMarker.length).toBe(1);
    expect(calls.createReview.length).toBe(1);
    expect(calls.listReviewComments.length).toBe(0);
    expect(result.review_id).toBe(4242);
    expect(result.comment_ids).toEqual([7001, 7002]);
    expect(result.publication_outcome).toBe("inline_posted");

    // The row was CAS-flipped from the NULL claim to the created review.
    const row = await readPostedRow(seed.prId);
    expect(Number(row!.github_review_id)).toBe(4242);
    expect(row!.comment_ids).toEqual([7001, 7002]);
    expect(row!.publication_outcome).toBe("inline_posted");
  });

  it("(b) v3-F1 create-succeeded-DB-crashed: marker finds 999 → recovers id + comment_ids, ZERO new createReview", async () => {
    // createReview SUCCEEDED on the crashed run (remote review 999 + 3 comment ids) but the row UPDATE was
    // skipped, so github_review_id is still NULL. Re-run with takeover → marker finds 999 → re-fetch its
    // comment_ids → CAS-store. NO second createReview (the duplicate-review window is closed).
    await seedNullClaimRow(seed.prId);

    const { client, calls } = makeStub({
      // createReview MUST NOT be called — script empty so a stray call throws.
      findExistingReviewByMarker: 999, // the orphaned remote review the crashed run created
      reviewComments: [8001, 8002, 8003], // its 3 inline comment ids, recovered via GET /reviews/999/comments
    });
    const input = makeInput({
      seed,
      findings: [
        finding({ start_line: 10, end_line: 10 }),
        finding({ start_line: 20, end_line: 20 }),
        finding({ start_line: 30, end_line: 30 }),
      ],
    });

    const result = await doPost(input, {
      ghClient: client,
      dsn: INTEGRATION_DSN!,
      clock: FIXED_CLOCK,
      sameRunTakeover: true,
    });

    expect(calls.findExistingReviewByMarker.length).toBe(1);
    expect(calls.listReviewComments.length).toBe(1); // GET /reviews/999/comments
    expect(calls.listReviewComments[0]!.reviewId).toBe(999);
    expect(calls.createReview.length).toBe(0); // ZERO new createReview — no duplicate review
    expect(calls.updateReview.length).toBe(0); // recovered directly via CAS, not the lost-claim update path
    expect(result.review_id).toBe(999);
    expect(result.comment_ids).toEqual([8001, 8002, 8003]);

    // The row carries the recovered 999 + its comment ids (CAS-stored).
    const row = await readPostedRow(seed.prId);
    expect(Number(row!.github_review_id)).toBe(999);
    expect(row!.comment_ids).toEqual([8001, 8002, 8003]);
    expect(row!.publication_outcome).toBe("inline_posted");
  });

  it("(c) racer: another writer sets github_review_id between read and CAS → 0-row CAS → lost-claim update", async () => {
    // The takeover reads the NULL row, marker finds remote review 999, but a RACER wins the row first (sets
    // github_review_id=777 + inline_posted). The CAS (WHERE github_review_id IS NULL) matches 0 rows → fall
    // through to the lost-claim update path: updateReview on the racer's 777, return the racer's comment_ids.
    await seedNullClaimRow(seed.prId);

    const { client, calls } = makeStub({
      findExistingReviewByMarker: 999,
      reviewComments: [8001], // would be recovered IF the CAS won — but the racer pre-empts it
      beforeCas: async () => {
        // Simulate the racer winning the row before our CAS lands.
        await pool.query(
          `UPDATE core.posted_reviews
              SET github_review_id = 777, publication_outcome = 'inline_posted',
                  comment_ids = '[5001, 5002]'::jsonb, updated_at = now()
            WHERE pr_id = $1`,
          [seed.prId],
        );
      },
    });
    const input = makeInput({ seed, findings: [finding({ start_line: 10, end_line: 10 })] });

    const result = await doPost(input, {
      ghClient: client,
      dsn: INTEGRATION_DSN!,
      clock: FIXED_CLOCK,
      sameRunTakeover: true,
    });

    // Marker found 999 + the CAS was attempted (0 rows) → fell through to the lost-claim update path.
    expect(calls.createReview.length).toBe(0); // NEVER blindly re-create
    expect(calls.updateReview.length).toBe(1); // lost-claim update path on the racer's review
    expect(calls.updateReview[0]!.reviewId).toBe(777);
    expect(result.was_update).toBe(true);
    expect(result.review_id).toBe(777);
    expect(result.comment_ids).toEqual([5001, 5002]); // the racer's stored ids, recovered by the lost-claim read

    // The racer's row is intact (the loser's CAS never touched it).
    const row = await readPostedRow(seed.prId);
    expect(Number(row!.github_review_id)).toBe(777);
    expect(row!.comment_ids).toEqual([5001, 5002]);
  });

  it("default (no sameRunTakeover): NULL-row within window still RAISES (Temporal path byte-identical)", async () => {
    // Without the flag, a fresh NULL claim row (< 300s) is treated as a legitimate in-flight winner → the
    // lost-claim path raises PostReviewTransientError. This pins that the takeover is OPT-IN only.
    await seedNullClaimRow(seed.prId);

    const { client, calls } = makeStub({ findExistingReviewByMarker: 999 });
    const input = makeInput({ seed, findings: [finding({ start_line: 10, end_line: 10 })] });

    await expect(
      doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK }),
    ).rejects.toThrow(/still NULL/);

    // The marker was NEVER searched on the default path (no takeover).
    expect(calls.findExistingReviewByMarker.length).toBe(0);
    expect(calls.createReview.length).toBe(0);
  });
});

// ─── W4.3 (gate ①): no GitHub write after abort ─────────────────────────────────────────────────────
//
// doPost gains an OPTIONAL `signal`. The enforceable guarantee (F7): no NEW GitHub write STARTS after
// `signal.aborted`. The gate sits IMMEDIATELY BEFORE each create call (attemptCreateWithBodyOnlyFallback,
// on both the won-claim and the same-run-takeover paths) and before `updateReview` — it throws
// TerminalCancelError("aborted"). On the won-claim path the claim row stays NULL (github_review_id never
// set) so the next run's same-run takeover (W3.2) recovers it. Absent signal → byte-identical (proven by
// every test above running with no `signal`); a present-but-NOT-aborted signal must proceed normally.
describeDb("post_review_results doPost — no GitHub write after abort (W4.3 / gate ①)", () => {
  let seed: Seed;

  beforeEach(async () => {
    seed = await seedTenant();
  });

  afterEach(async () => {
    await cleanupTenant(seed);
  });

  it("won-claim: aborted signal → throws TerminalCancelError BEFORE createReview (claim row stays NULL)", async () => {
    // Stub WOULD create the review, but the aborted signal must short-circuit before the create call so
    // ZERO createReview is started — leaving the claim row at github_review_id NULL for W3.2 recovery.
    const created: CreatedReviewV1 = { reviewId: 999, commentIds: [1001, 1002] };
    const { client, calls } = makeStub({ createReview: [created] });
    const input = makeInput({ seed, findings: [finding({ start_line: 10, end_line: 10 })] });
    const aborted = AbortSignal.abort();

    await expect(
      doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK, signal: aborted }),
    ).rejects.toBeInstanceOf(TerminalCancelError);

    // No GitHub write of any kind started after the abort.
    expect(calls.createReview.length).toBe(0);
    expect(calls.updateReview.length).toBe(0);

    // The claim row exists (Phase-1 won the claim) but github_review_id is still NULL — the next run's
    // same-run takeover recovers it (W3.2). The crash-equivalent here is the abort short-circuit.
    const row = await readPostedRow(seed.prId);
    expect(row).toBeDefined();
    expect(row!.github_review_id).toBeNull();
  });

  it("lost-claim: aborted signal → throws TerminalCancelError BEFORE updateReview (no update started)", async () => {
    // Pre-seed a winning row (a prior winner published reviewId 4242). A lost-claim re-run would normally
    // dispatch updateReview; the aborted signal must short-circuit before it so ZERO updateReview starts.
    await pool.query(
      `INSERT INTO core.posted_reviews
         (pr_id, marker, github_review_id, publication_outcome, comment_ids, posted_at)
       VALUES ($1, $2, $3, 'inline_posted', '[1001]'::jsonb, now())`,
      [seed.prId, markerFor(seed.prId), 4242],
    );
    const { client, calls } = makeStub({});
    const input = makeInput({ seed, findings: [finding({ start_line: 10, end_line: 10 })] });
    const aborted = AbortSignal.abort();

    await expect(
      doPost(input, { ghClient: client, dsn: INTEGRATION_DSN!, clock: FIXED_CLOCK, signal: aborted }),
    ).rejects.toBeInstanceOf(TerminalCancelError);

    expect(calls.updateReview.length).toBe(0);
    expect(calls.createReview.length).toBe(0);
  });

  it("takeover-create: aborted signal → throws TerminalCancelError BEFORE the takeover createReview", async () => {
    // The same-run-takeover path re-creates the review when the marker search finds nothing. The aborted
    // signal must short-circuit before that create. (The marker search itself is a read; the gate fires
    // before the only WRITE — createReview.)
    await seedNullClaimRow(seed.prId);
    const created: CreatedReviewV1 = { reviewId: 4242, commentIds: [7001] };
    const { client, calls } = makeStub({ createReview: [created], findExistingReviewByMarker: null });
    const input = makeInput({ seed, findings: [finding({ start_line: 10, end_line: 10 })] });
    const aborted = AbortSignal.abort();

    await expect(
      doPost(input, {
        ghClient: client,
        dsn: INTEGRATION_DSN!,
        clock: FIXED_CLOCK,
        sameRunTakeover: true,
        signal: aborted,
      }),
    ).rejects.toBeInstanceOf(TerminalCancelError);

    // ZERO createReview started after the abort (the only write on the takeover path).
    expect(calls.createReview.length).toBe(0);
  });

  it("present-but-NOT-aborted signal proceeds normally (won-claim create runs)", async () => {
    // A live (un-aborted) signal must NOT block the write — the gate only fires on `signal.aborted`.
    const created: CreatedReviewV1 = { reviewId: 999, commentIds: [1001, 1002] };
    const { client, calls } = makeStub({ createReview: [created] });
    const input = makeInput({
      seed,
      findings: [finding({ start_line: 10, end_line: 10 }), finding({ start_line: 20, end_line: 20 })],
    });
    const live = new AbortController();

    const result = await doPost(input, {
      ghClient: client,
      dsn: INTEGRATION_DSN!,
      clock: FIXED_CLOCK,
      signal: live.signal,
    });

    expect(result.review_id).toBe(999);
    expect(calls.createReview.length).toBe(1);
    expect(result.comment_ids).toEqual([1001, 1002]);
  });
});
