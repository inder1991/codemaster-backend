import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { persistReviewWalkthrough } from "#backend/activities/persist_review_walkthrough.activity.js";
import { ReviewWalkthroughsRepo } from "#backend/domain/repos/review_walkthroughs_repo.js";

import { disposeAllPools } from "#platform/db/database.js";

import { type PersistReviewWalkthroughInputV1 } from "#contracts/persist_review_walkthrough.v1.js";
import { type WalkthroughV1 } from "#contracts/walkthrough.v1.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

// DB-gated integration test for the `persist_review_walkthrough` activity, against the DISPOSABLE
// Postgres (migrations applied; core.review_walkthroughs present). Runs ONLY when CODEMASTER_PG_CORE_DSN
// is set (via describeDb); SKIPS otherwise so validate-fast stays green without a DB. NEVER touches any
// other DB. Each test uses a UNIQUE installation_id + review_id so rows never collide, and cleans up its
// own rows in `finally`.
//
// The activity is the thin wrapper over ReviewWalkthroughsRepo.upsert — 1:1 in intent with the frozen
// Python `@activity.defn persist_review_walkthrough_activity`
// (vendor/codemaster-py/codemaster/activities/persist_review_walkthrough.py). The repo round-trip is
// proved exhaustively in review_walkthroughs_repo.integration.test.ts; THIS test proves the ACTIVITY
// composes the repo correctly end-to-end: typed input → row in core.review_walkthroughs → read back the
// same bytes; idempotent on review_id; the write carries installation_id (tenancy).

// A reader repo built over the same shared pool (the activity opens its own repo from the DSN; we read
// back through this one to assert what landed). Constructed in beforeAll (only when a DSN is configured).
let reader: ReviewWalkthroughsRepo;

beforeAll(() => {
  if (!INTEGRATION_DSN) return; // block skips; don't open a pool against an undefined DSN
  // The activity reads the DSN from process.env; mirror it so reader + activity share the ONE
  // process-wide pool (ADR-0062). Set unconditionally inside the gated block.
  process.env.CODEMASTER_PG_CORE_DSN = INTEGRATION_DSN;
  reader = ReviewWalkthroughsRepo.fromDsn(INTEGRATION_DSN);
});

afterAll(async () => {
  // ADR-0062 teardown: end the shared pool(s) via the central seam — NOT a private close.
  await disposeAllPools();
});

/** A minimal-but-complete WalkthroughV1 with every optional left to its default (built via the contract
 *  so the shape is exactly what the wire/repo round-trips). */
function minimalWalkthrough(): WalkthroughV1 {
  return {
    schema_version: 1,
    tldr: "Tidies up the request handler.",
    file_rows: [],
    configuration_section_md: "",
    degradation_note: null,
    truncated: false,
    suggested_reviewers: [],
    linked_issues: [],
    sanitization_event: null,
  };
}

/** A maximal WalkthroughV1 exercising every nested array + the sanitization_event sub-contract, so the
 *  JSONB column must round-trip byte-faithfully THROUGH the activity. */
function richWalkthrough(installationId: string): WalkthroughV1 {
  return {
    schema_version: 2, // bare int, not Literal — must survive the round-trip
    tldr: "Refactors the handler and links the tracking issue.",
    file_rows: [
      {
        path: "src/app.py",
        change_summary: "refactored the request handler",
        severity_max: "issue",
        finding_count: 3,
      },
      {
        path: "src/util/helpers.py",
        change_summary: "extracted a pure helper",
        severity_max: "nit",
        finding_count: 0,
      },
    ],
    configuration_section_md: "## Config\n- `max_tokens` raised to 4096",
    degradation_note: "one chunk was truncated",
    truncated: true,
    suggested_reviewers: ["octocat", "hubot"],
    linked_issues: [
      { issue_number: 42, linkage_kind: "closes", title: "Null deref", state: "open" },
      { issue_number: 7, linkage_kind: "mentioned", title: null, state: null },
    ],
    sanitization_event: {
      schema_version: 1,
      installation_id: installationId,
      request_id: randomUUID(),
      original_text: "leaked AKIA-style secret in preamble",
      redacted_text: "[redacted]",
      spans_redacted: 2,
      detector_kinds: ["aws_key", "generic_secret"],
      stage: "walkthrough",
    },
  };
}

/** Build the single typed input envelope the activity takes (CLAUDE.md invariant 11). */
function input(args: {
  reviewId: string;
  installationId: string;
  walkthrough: WalkthroughV1;
}): PersistReviewWalkthroughInputV1 {
  return {
    schema_version: 1,
    review_id: args.reviewId,
    installation_id: args.installationId,
    walkthrough: args.walkthrough,
  };
}

/** Delete the walkthrough row a test created (PK cleanup through the repo). */
async function cleanup(reviewId: string): Promise<void> {
  await reader.deleteForTest({ reviewId });
}

describeDb("persistReviewWalkthrough activity (integration, disposable PG)", () => {
  it("persists the typed input then the row reads back faithfully (minimal walkthrough)", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    try {
      const wt = minimalWalkthrough();

      // ACT under test: the activity unpacks the typed input and upserts via the repo, returning void.
      const result = await persistReviewWalkthrough(
        input({ reviewId, installationId, walkthrough: wt }),
      );
      expect(result).toBeUndefined();

      const row = await reader.get({ reviewId, installationId });
      expect(row).not.toBeNull();
      expect(row?.review_id).toBe(reviewId);
      expect(row?.installation_id).toBe(installationId); // tenancy column persisted
      expect(row?.walkthrough).toEqual(wt);
    } finally {
      await cleanup(reviewId);
    }
  });

  it("round-trips a rich walkthrough byte-faithfully through the activity (nested arrays + sanitization_event JSONB)", async () => {
    const installationId = randomUUID();
    const reviewId = randomUUID();
    try {
      const wt = richWalkthrough(installationId);
      await persistReviewWalkthrough(input({ reviewId, installationId, walkthrough: wt }));

      const row = await reader.get({ reviewId, installationId });
      expect(row).not.toBeNull();
      expect(row?.walkthrough).toEqual(wt);
      expect(row?.walkthrough.schema_version).toBe(2); // bare int, not Literal — survives
      expect(row?.walkthrough.sanitization_event?.detector_kinds).toEqual([
        "aws_key",
        "generic_secret",
      ]);
    } finally {
      await cleanup(reviewId);
    }
  });

  it("is idempotent on review_id — a second persist UPDATEs in place (no duplicate row)", async () => {
    // Mirrors the Python repo's ON CONFLICT (review_id) DO UPDATE — the activity inherits its idempotency.
    const installationId = randomUUID();
    const reviewId = randomUUID();
    try {
      await persistReviewWalkthrough(
        input({ reviewId, installationId, walkthrough: minimalWalkthrough() }),
      );

      const second: WalkthroughV1 = { ...minimalWalkthrough(), tldr: "Now with a new summary." };
      await persistReviewWalkthrough(input({ reviewId, installationId, walkthrough: second }));

      const row = await reader.get({ reviewId, installationId });
      expect(row?.walkthrough.tldr).toBe("Now with a new summary.");

      // Exactly one row exists for this review_id.
      const count = await reader.countForTest({ reviewId });
      expect(count).toBe(1);
    } finally {
      await cleanup(reviewId);
    }
  });

  it("ON CONFLICT migrates installation_id when the same review is re-persisted under a different tenant", async () => {
    // Mirrors the Python ON CONFLICT (review_id) DO UPDATE SET installation_id = EXCLUDED.installation_id.
    const reviewId = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    try {
      await persistReviewWalkthrough(
        input({ reviewId, installationId: tenantA, walkthrough: minimalWalkthrough() }),
      );
      await persistReviewWalkthrough(
        input({ reviewId, installationId: tenantB, walkthrough: minimalWalkthrough() }),
      );

      // The row now belongs to tenant B …
      expect(await reader.get({ reviewId, installationId: tenantB })).not.toBeNull();
      // … and is NO LONGER visible to tenant A.
      expect(await reader.get({ reviewId, installationId: tenantA })).toBeNull();
    } finally {
      await cleanup(reviewId);
    }
  });
});
