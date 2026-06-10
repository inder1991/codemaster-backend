// W3.3 (F2 / F3 / F5 / gate ③) — fix-prompt GitHub-comment RECOVERABLE claim + operational marker
// recovery + tenant scope.
//
// The naive "set comment_posted_at, then post" conflates in-flight with done: a crash AFTER the claim
// but BEFORE the GitHub post permanently suppresses the comment. So `comment_posted_at`+`github_comment_id`
// are set ONLY on success (the biconditional CHECK); the in-flight claim is a reclaimable LEASE
// (`comment_claim_owner`/`comment_claim_expires_at`) a re-run takes over once it expires. The marker
// (`<!-- codemaster:fix-prompt-marker:${review_id} -->`) is OPERATIONAL — it is the recovery oracle for
// the "post succeeded, crash before recordCommentPosted" window: the re-run scans listIssueComments for
// the marker, recovers the id, records it, and never double-posts.
//
// Scenarios (the W3.3 failing-test contract):
//   (a) DEDUPE        — two runs (same review_id) → createIssueComment EXACTLY ONCE; posted + comment id set.
//   (b) F3 crash-BEFORE-post — crash BETWEEN claimCommentPost and createIssueComment (post NEVER made),
//                       claim left to expire; re-run re-claims + posts → ONE createIssueComment total.
//   (c) F2 crash-AFTER-post-before-record — createIssueComment SUCCEEDS (id 555), crash BEFORE
//                       recordCommentPosted; claim expires; re-run → marker scan finds 555 →
//                       recordCommentPosted(555) → ZERO new createIssueComment.
//   (d) ABORT         — already-aborted AbortSignal → no post, no claim.
//   (e) CONCURRENT    — a second run while the first holds a LIVE (unexpired) claim → skips.
//
// Runs ONLY when CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise. NEVER touches any other
// DB. Each test uses a fresh review_id + tenant and cleans up its rows. The 120s production claim TTL is
// overridden per-test to a TINY value so the expiry path is exercised without a real-time sleep.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { disposeAllPools, getPool } from "#platform/db/database.js";

import { FixPromptActivities } from "#backend/activities/generate_fix_prompt.activity.js";
import { FixPromptRepo } from "#backend/domain/repos/fix_prompt_repo.js";
import { fixPromptMarkerFor } from "#backend/activities/generate_fix_prompt.activity.js";

import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { GenerateFixPromptInputV1 } from "#contracts/generate_fix_prompt.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// 2099 keeps any clock-driven write out of a missing range partition (same convention as the
// post_review_results integration test). All claim-expiry math uses Postgres now(), NOT this clock.
const FIXED_CLOCK = new FakeClock({ now: new Date("2099-03-04T05:06:07.000Z") });

// A stub cache whose forRole REJECTS — buildFixPrompt is best-effort and degrades to the deterministic
// base, so the test never makes a real LLM call (and never asserts on the LLM path; W3.3 is about the
// post-claim/marker recovery, not theme synthesis).
const NO_LLM_CACHE = {
  forRole: async (): Promise<never> => {
    throw new Error("no LLM in this slice");
  },
};

// Recording GH client stub — implements the slice the activity uses (createIssueComment +
// listIssueComments), both with per-call installationId. `nextCreateId` controls the id createIssueComment
// returns; `onBeforeCreate`/`onAfterCreate` are crash-injection hooks; `seed` pre-populates the issue
// comments listIssueComments returns (the "remote already has the comment" recovery oracle).
type RecordingGh = {
  createIssueComment(args: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<number>;
  listIssueComments(args: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
  }): Promise<Array<Record<string, unknown>>>;
  createCalls: Array<{ body: string }>;
  listCalls: number;
};

function makeGh(opts: {
  nextCreateId?: number;
  onBeforeCreate?: () => void;
  onAfterCreate?: () => void;
  seed?: Array<{ id: number; body: string }>;
}): RecordingGh {
  const seed = opts.seed ?? [];
  const gh: RecordingGh = {
    createCalls: [],
    listCalls: 0,
    createIssueComment: async ({ body }) => {
      gh.createCalls.push({ body });
      opts.onBeforeCreate?.();
      const id = opts.nextCreateId ?? 4242;
      // Record the just-posted comment so a later listIssueComments scan can recover it (mirrors the
      // real GitHub round-trip: a created comment is visible to a subsequent GET).
      seed.push({ id, body });
      opts.onAfterCreate?.();
      return id;
    },
    listIssueComments: async () => {
      gh.listCalls += 1;
      return seed.map((c) => ({ id: c.id, body: c.body }) as Record<string, unknown>);
    },
  };
  return gh;
}

const minimalAggregated = (): AggregatedFindingsV1 =>
  AggregatedFindingsV1.parse({
    findings: [
      {
        file: "src/a.ts",
        start_line: 1,
        end_line: 1,
        severity: "issue",
        category: "bug",
        title: "t",
        body: "b",
        confidence: 0.5,
      },
    ],
    dedupe_stats: { input_count: 1, exact_dropped: 0, semantic_merged: 0, capped: 0 },
    policy_revision: 0,
  });

const makeInput = (overrides: { reviewId: string; installationId: string }): GenerateFixPromptInputV1 =>
  GenerateFixPromptInputV1.parse({
    review_id: overrides.reviewId,
    installation_id: overrides.installationId,
    github_installation_id: 12345,
    pr_number: 7,
    owner: "acme",
    repo: "widget",
    aggregated: minimalAggregated(),
  });

describeDb("generateFixPrompt — recoverable post claim + operational marker (integration)", () => {
  const repo = FixPromptRepo.fromDsn(INTEGRATION_DSN as string);
  const pool = getPool(INTEGRATION_DSN as string);
  const tenants: Array<string> = [];

  const freshTenant = (): string => {
    const t = randomUUID();
    tenants.push(t);
    return t;
  };

  beforeAll(async () => {
    await pool.query("SELECT 1 FROM core.fix_prompts WHERE false");
  });

  afterAll(async () => {
    if (tenants.length > 0) {
      await pool.query("DELETE FROM core.fix_prompts WHERE installation_id = ANY($1::uuid[])", [tenants]);
    }
    await disposeAllPools();
  });

  // (a) DEDUPE — two runs, same review_id → createIssueComment EXACTLY ONCE.
  it("(a) dedupes: two runs post the comment exactly once", async () => {
    const reviewId = randomUUID();
    const installationId = freshTenant();
    const gh = makeGh({ nextCreateId: 111 });
    const act = new FixPromptActivities({ cache: NO_LLM_CACHE, repo, gh, clock: FIXED_CLOCK });
    const input = makeInput({ reviewId, installationId });

    const r1 = await act.generateFixPrompt(input);
    // Second run drives the dedupe short-circuit (createCalls.length === 1 below); result unused.
    await act.generateFixPrompt(input);

    expect(r1.comment_posted).toBe(true);
    // The second run sees comment_posted_at set → short-circuits BEFORE claim/post.
    expect(gh.createCalls.length).toBe(1);

    const { rows } = await pool.query<{ id: string; posted: string | null }>(
      "SELECT github_comment_id::text AS id, comment_posted_at::text AS posted FROM core.fix_prompts WHERE review_id = $1 AND installation_id = $2",
      [reviewId, installationId],
    );
    expect(rows[0]?.id).toBe("111");
    expect(rows[0]?.posted).not.toBeNull();
  });

  // (b) F3 crash-BEFORE-post — crash BETWEEN claim and createIssueComment; the post is NEVER made.
  it("(b) crash before post leaves the claim to expire; re-run posts exactly once (never lost)", async () => {
    const reviewId = randomUUID();
    const installationId = freshTenant();

    // Run 1: crash injected at the onBeforeCreate hook → createIssueComment THROWS, so the post is never
    // completed and recordCommentPosted is never reached. With a tiny TTL the claim expires immediately.
    const ghCrash = makeGh({
      nextCreateId: 222,
      onBeforeCreate: () => {
        throw new Error("CRASH between claim and post");
      },
    });
    const act1 = new FixPromptActivities({ cache: NO_LLM_CACHE, repo, gh: ghCrash, clock: FIXED_CLOCK });
    const input = makeInput({ reviewId, installationId });
    await expect(act1.generateFixPrompt(input, undefined, { claimTtlSeconds: 0 })).rejects.toThrow(
      /CRASH between claim and post/,
    );

    // The crash happened AFTER claim, BEFORE a successful post → comment_posted_at stays NULL (never lost).
    const mid = await pool.query<{ posted: string | null }>(
      "SELECT comment_posted_at::text AS posted FROM core.fix_prompts WHERE review_id = $1 AND installation_id = $2",
      [reviewId, installationId],
    );
    expect(mid.rows[0]?.posted).toBeNull();

    // Run 2: a clean client. The expired claim (TTL=0) is reclaimable; the marker scan finds nothing
    // (the first post never landed), so it posts → exactly ONE createIssueComment across both runs.
    const ghOk = makeGh({ nextCreateId: 333 });
    const act2 = new FixPromptActivities({ cache: NO_LLM_CACHE, repo, gh: ghOk, clock: FIXED_CLOCK });
    const r2 = await act2.generateFixPrompt(input, undefined, { claimTtlSeconds: 0 });

    expect(r2.comment_posted).toBe(true);
    expect(ghCrash.createCalls.length).toBe(1); // the throwing attempt counted its one (failed) call
    expect(ghOk.createCalls.length).toBe(1); // the recovery run posted exactly once
    const { rows } = await pool.query<{ id: string; posted: string | null }>(
      "SELECT github_comment_id::text AS id, comment_posted_at::text AS posted FROM core.fix_prompts WHERE review_id = $1 AND installation_id = $2",
      [reviewId, installationId],
    );
    expect(rows[0]?.id).toBe("333");
    expect(rows[0]?.posted).not.toBeNull();
  });

  // (c) F2 crash-AFTER-post-before-record — createIssueComment SUCCEEDS (id 555), crash before record;
  //     the operational marker scan recovers 555 → ZERO new createIssueComment.
  it("(c) crash after post recovers the comment id via the marker scan; no duplicate post", async () => {
    const reviewId = randomUUID();
    const installationId = freshTenant();

    // Run 1: createIssueComment SUCCEEDS and the comment (with marker) lands remotely; the crash is
    // injected AFTER the post returns 555 but BEFORE recordCommentPosted runs. comment_posted_at stays
    // NULL (the record never happened) but the remote comment exists.
    const remote: Array<{ id: number; body: string }> = [];
    const ghCrash = makeGh({
      nextCreateId: 555,
      seed: remote,
      onAfterCreate: () => {
        throw new Error("CRASH after post before record");
      },
    });
    const act1 = new FixPromptActivities({ cache: NO_LLM_CACHE, repo, gh: ghCrash, clock: FIXED_CLOCK });
    const input = makeInput({ reviewId, installationId });
    await expect(act1.generateFixPrompt(input, undefined, { claimTtlSeconds: 0 })).rejects.toThrow(
      /CRASH after post before record/,
    );

    // The marker is embedded in the posted body (the recovery oracle).
    expect(remote.length).toBe(1);
    expect(remote[0]?.body).toContain(fixPromptMarkerFor(reviewId));
    const mid = await pool.query<{ posted: string | null }>(
      "SELECT comment_posted_at::text AS posted FROM core.fix_prompts WHERE review_id = $1 AND installation_id = $2",
      [reviewId, installationId],
    );
    expect(mid.rows[0]?.posted).toBeNull();

    // Run 2: a fresh client that SHARES the remote seed (the comment 555 is visible to listIssueComments).
    // The expired claim is reclaimed; the marker scan finds 555 → recordCommentPosted(555) → NO create.
    const ghRecover = makeGh({ nextCreateId: 999, seed: remote });
    const act2 = new FixPromptActivities({ cache: NO_LLM_CACHE, repo, gh: ghRecover, clock: FIXED_CLOCK });
    const r2 = await act2.generateFixPrompt(input, undefined, { claimTtlSeconds: 0 });

    expect(r2.comment_posted).toBe(true);
    expect(ghRecover.createCalls.length).toBe(0); // ZERO new createIssueComment — recovered by marker
    expect(ghRecover.listCalls).toBeGreaterThanOrEqual(1); // the marker scan ran
    const { rows } = await pool.query<{ id: string; posted: string | null }>(
      "SELECT github_comment_id::text AS id, comment_posted_at::text AS posted FROM core.fix_prompts WHERE review_id = $1 AND installation_id = $2",
      [reviewId, installationId],
    );
    expect(rows[0]?.id).toBe("555"); // the recovered remote id, not the would-be-new 999
    expect(rows[0]?.posted).not.toBeNull();
  });

  // (d) ABORT — an already-aborted signal → no post, no claim (and persist still ran, so the record exists
  //     with a NULL post state).
  it("(d) an already-aborted signal posts nothing and claims nothing", async () => {
    const reviewId = randomUUID();
    const installationId = freshTenant();
    const gh = makeGh({ nextCreateId: 777 });
    const act = new FixPromptActivities({ cache: NO_LLM_CACHE, repo, gh, clock: FIXED_CLOCK });
    const input = makeInput({ reviewId, installationId });

    const r = await act.generateFixPrompt(input, AbortSignal.abort());

    expect(r.comment_posted).toBe(false);
    expect(gh.createCalls.length).toBe(0);
    expect(gh.listCalls).toBe(0);
    const { rows } = await pool.query<{ posted: string | null; owner: string | null }>(
      "SELECT comment_posted_at::text AS posted, comment_claim_owner AS owner FROM core.fix_prompts WHERE review_id = $1 AND installation_id = $2",
      [reviewId, installationId],
    );
    // persist ran (the record exists, serves the API/UI) but no post + no claim were taken.
    expect(rows.length).toBe(1);
    expect(rows[0]?.posted).toBeNull();
    expect(rows[0]?.owner).toBeNull();
  });

  // (e) CONCURRENT — a second run while the first holds a LIVE (unexpired) claim → skips the post.
  it("(e) a live (unexpired) claim held by another run makes a concurrent run skip", async () => {
    const reviewId = randomUUID();
    const installationId = freshTenant();
    const input = makeInput({ reviewId, installationId });

    // Pre-persist + a LIVE claim by some other owner with a long TTL (300s).
    const seedAct = new FixPromptActivities({
      cache: NO_LLM_CACHE,
      repo,
      gh: makeGh({}),
      clock: FIXED_CLOCK,
    });
    // Use the activity once with a crash BEFORE post so the claim is taken & left live (long TTL).
    const ghLive = makeGh({
      onBeforeCreate: () => {
        throw new Error("hold the live claim");
      },
    });
    const holder = new FixPromptActivities({ cache: NO_LLM_CACHE, repo, gh: ghLive, clock: FIXED_CLOCK });
    await expect(holder.generateFixPrompt(input, undefined, { claimTtlSeconds: 300 })).rejects.toThrow(
      /hold the live claim/,
    );
    void seedAct;

    // A concurrent run finds the LIVE claim → claimCommentPost loses → skips the post entirely.
    const ghConcurrent = makeGh({ nextCreateId: 888 });
    const concurrent = new FixPromptActivities({
      cache: NO_LLM_CACHE,
      repo,
      gh: ghConcurrent,
      clock: FIXED_CLOCK,
    });
    const r = await concurrent.generateFixPrompt(input, undefined, { claimTtlSeconds: 300 });

    expect(r.comment_posted).toBe(false); // the concurrent run could not claim → did not post
    expect(ghConcurrent.createCalls.length).toBe(0);
  });
});
