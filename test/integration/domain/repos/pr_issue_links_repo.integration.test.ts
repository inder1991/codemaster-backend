import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresLinkedIssuesRepo } from "#backend/domain/repos/pr_issue_links_repo.js";

import { disposeAllPools, getPool } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (migrations applied). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise. We NEVER touch any other DB.
//
// 1:1 port of the read slice `list_links_for_pr` consumed by `fetchLinkedIssues` (DM-WIRE T4). The
// producer-side `replace_links` / `derive_pr_issue_link_id` are webhook-path concerns NOT consumed by
// this activity and are out of scope for the port; this test seeds rows via raw SQL.

let pool: Pool;

beforeAll(() => {
  if (!INTEGRATION_DSN) return;
  pool = getPool(INTEGRATION_DSN);
});

afterAll(async () => {
  await disposeAllPools();
});

function uniqueBigint(): number {
  return (parseInt(randomUUID().replace(/-/g, "").slice(0, 12), 16) % 9_000_000_000) + 1;
}

type Fixture = {
  installationId: string;
  repositoryId: string;
  ghUserId: string;
  prId: string;
};

async function seedFixture(installationId: string): Promise<Fixture> {
  const repositoryId = randomUUID();
  const ghUserId = randomUUID();
  const prId = randomUUID();
  const opened = new Date("2099-01-01T00:00:00.000Z");
  await pool.query(
    `INSERT INTO core.installations
       (installation_id, github_installation_id, account_login, account_type)
     VALUES ($1, $2, $3, 'Organization')`,
    [installationId, uniqueBigint(), `acct-${installationId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO core.repositories
       (repository_id, installation_id, github_repo_id, full_name, default_branch, enabled)
     VALUES ($1, $2, $3, $4, 'main', true)`,
    [repositoryId, installationId, uniqueBigint(), `org/repo-${repositoryId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO core.gh_users (gh_user_id, github_user_id, login, user_type)
     VALUES ($1, $2, $3, 'User')`,
    [ghUserId, uniqueBigint(), `user-${ghUserId.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO core.pull_requests
       (pr_id, installation_id, repository_id, github_pull_request_id, pr_number,
        author_gh_user_id, state, title, base_ref, base_sha, head_ref, head_sha, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', 'test pr', 'main', $7, 'feature', $8, $9)`,
    [
      prId,
      installationId,
      repositoryId,
      uniqueBigint(),
      (uniqueBigint() % 100_000) + 1,
      ghUserId,
      "a".repeat(40),
      "b".repeat(40),
      opened,
    ],
  );
  return { installationId, repositoryId, ghUserId, prId };
}

async function insertLink(args: {
  installationId: string;
  prId: string;
  issueNumber: number;
  linkageKind: string;
  source: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO core.pr_issue_links
       (pr_issue_link_id, installation_id, pr_id, github_issue_number, linkage_kind, source, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())`,
    [args.installationId, args.prId, args.issueNumber, args.linkageKind, args.source],
  );
}

async function cleanup(fx: Fixture): Promise<void> {
  await pool.query(`DELETE FROM core.pr_issue_links WHERE installation_id = $1`, [fx.installationId]);
  await pool.query(`DELETE FROM core.pull_requests WHERE installation_id = $1`, [fx.installationId]);
  await pool.query(`DELETE FROM core.repositories WHERE installation_id = $1`, [fx.installationId]);
  await pool.query(`DELETE FROM core.gh_users WHERE gh_user_id = $1`, [fx.ghUserId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [fx.installationId]);
}

function repoFor(): PostgresLinkedIssuesRepo {
  return PostgresLinkedIssuesRepo.fromDsn(INTEGRATION_DSN as string);
}

describeDb("PostgresLinkedIssuesRepo (integration, disposable PG)", () => {
  it("listLinksForPr returns an empty array when the PR has no links", async () => {
    const installationId = randomUUID();
    const fx = await seedFixture(installationId);
    try {
      const r = repoFor();
      const out = await r.listLinksForPr({ installationId, prId: fx.prId });
      expect(out).toEqual([]);
    } finally {
      await cleanup(fx);
    }
  });

  it("listLinksForPr returns the full (issue_number, linkage_kind, source) triples, ordered", async () => {
    const installationId = randomUUID();
    const fx = await seedFixture(installationId);
    try {
      await insertLink({
        installationId,
        prId: fx.prId,
        issueNumber: 5,
        linkageKind: "mentioned",
        source: "title",
      });
      await insertLink({
        installationId,
        prId: fx.prId,
        issueNumber: 3,
        linkageKind: "closes",
        source: "description",
      });
      await insertLink({
        installationId,
        prId: fx.prId,
        issueNumber: 5,
        linkageKind: "closes",
        source: "description",
      });

      const r = repoFor();
      const out = await r.listLinksForPr({ installationId, prId: fx.prId });
      // ORDER BY github_issue_number ASC, source ASC.
      expect(out).toEqual([
        { github_issue_number: 3, linkage_kind: "closes", source: "description" },
        { github_issue_number: 5, linkage_kind: "closes", source: "description" },
        { github_issue_number: 5, linkage_kind: "mentioned", source: "title" },
      ]);
    } finally {
      await cleanup(fx);
    }
  });

  it("listLinksForPr is tenant-isolated — installation A's read never sees B's links", async () => {
    const installA = randomUUID();
    const installB = randomUUID();
    const fxA = await seedFixture(installA);
    const fxB = await seedFixture(installB);
    try {
      await insertLink({
        installationId: installA,
        prId: fxA.prId,
        issueNumber: 11,
        linkageKind: "closes",
        source: "description",
      });
      await insertLink({
        installationId: installB,
        prId: fxB.prId,
        issueNumber: 22,
        linkageKind: "fixes",
        source: "description",
      });

      const r = repoFor();
      const outA = await r.listLinksForPr({ installationId: installA, prId: fxA.prId });
      expect(outA.map((l) => l.github_issue_number)).toEqual([11]);

      // Cross-tenant: A's installation_id with B's pr_id → zero rows (no leak).
      const crossed = await r.listLinksForPr({ installationId: installA, prId: fxB.prId });
      expect(crossed).toEqual([]);
    } finally {
      await cleanup(fxA);
      await cleanup(fxB);
    }
  });
});
