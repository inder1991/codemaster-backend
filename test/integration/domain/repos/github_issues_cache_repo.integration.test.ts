import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresGithubIssuesCacheRepo } from "#backend/domain/repos/github_issues_cache_repo.js";

import { FakeClock } from "#platform/clock.js";
import { disposeAllPools, getPool } from "#platform/db/database.js";

import { describeDb, INTEGRATION_DSN } from "../../_db.js";

// DB-gated integration test against a DISPOSABLE Postgres (migrations applied). Runs ONLY when
// CODEMASTER_PG_CORE_DSN is set (via describeDb); SKIPS otherwise so validate-fast stays green
// without a DB. We NEVER touch any other DB. Each test uses a UNIQUE installation_id so rows never
// collide, and cleans up the installation subtree in finally.
//
// 1:1 port of the Python PostgresGithubIssuesCacheRepo (get_many + upsert) — DM-WIRE T4 / S22.DM.16.

const FIXED_CLOCK = new FakeClock({ now: new Date("2099-01-01T00:00:00.000Z") });

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

type Fixture = { installationId: string; repositoryId: string };

async function seedFixture(installationId: string): Promise<Fixture> {
  const repositoryId = randomUUID();
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
  return { installationId, repositoryId };
}

async function cleanup(fx: Fixture): Promise<void> {
  await pool.query(`DELETE FROM core.github_issues_cache WHERE installation_id = $1`, [
    fx.installationId,
  ]);
  await pool.query(`DELETE FROM core.repositories WHERE installation_id = $1`, [fx.installationId]);
  await pool.query(`DELETE FROM core.installations WHERE installation_id = $1`, [fx.installationId]);
}

function repoFor(): PostgresGithubIssuesCacheRepo {
  return PostgresGithubIssuesCacheRepo.fromDsn({ dsn: INTEGRATION_DSN as string, clock: FIXED_CLOCK });
}

describeDb("PostgresGithubIssuesCacheRepo (integration, disposable PG)", () => {
  it("getMany returns an empty map for an empty issue-number tuple without touching the DB", async () => {
    const r = repoFor();
    const out = await r.getMany({ installationId: randomUUID(), issueNumbers: [] });
    expect(out.size).toBe(0);
  });

  it("upsert then getMany round-trips a cache entry keyed by issue number", async () => {
    const installationId = randomUUID();
    const fx = await seedFixture(installationId);
    try {
      const r = repoFor();
      await r.upsert({
        installationId,
        repositoryId: fx.repositoryId,
        githubIssueNumber: 42,
        title: "Fix the widget",
        body: "body text",
        state: "open",
        etag: '"etag-42"',
      });

      const out = await r.getMany({ installationId, issueNumbers: [42] });
      expect(out.size).toBe(1);
      const entry = out.get(42);
      expect(entry?.title).toBe("Fix the widget");
      expect(entry?.state).toBe("open");
      expect(entry?.body).toBe("body text");
      expect(entry?.etag).toBe('"etag-42"');
      // cached_at is the injected FakeClock instant (deterministic).
      expect(entry?.cached_at.getTime()).toBe(new Date("2099-01-01T00:00:00.000Z").getTime());
    } finally {
      await cleanup(fx);
    }
  });

  it("upsert is idempotent on (installation_id, issue_number) and refreshes title/state/etag", async () => {
    const installationId = randomUUID();
    const fx = await seedFixture(installationId);
    try {
      const r = repoFor();
      await r.upsert({
        installationId,
        repositoryId: fx.repositoryId,
        githubIssueNumber: 7,
        title: "Old title",
        body: null,
        state: "open",
        etag: '"old"',
      });
      await r.upsert({
        installationId,
        repositoryId: fx.repositoryId,
        githubIssueNumber: 7,
        title: "New title",
        body: "now has a body",
        state: "closed",
        etag: '"new"',
      });

      const out = await r.getMany({ installationId, issueNumbers: [7] });
      expect(out.size).toBe(1);
      const e = out.get(7);
      expect(e?.title).toBe("New title");
      expect(e?.state).toBe("closed");
      expect(e?.body).toBe("now has a body");
      expect(e?.etag).toBe('"new"');

      // Exactly one row persisted (ON CONFLICT DO UPDATE, not a second insert).
      const count = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM core.github_issues_cache
         WHERE installation_id = $1 AND github_issue_number = 7`,
        [installationId],
      );
      expect(Number(count.rows[0]?.n)).toBe(1);
    } finally {
      await cleanup(fx);
    }
  });

  it("getMany returns only the requested issue numbers and is tenant-isolated", async () => {
    const installA = randomUUID();
    const installB = randomUUID();
    const fxA = await seedFixture(installA);
    const fxB = await seedFixture(installB);
    try {
      const r = repoFor();
      await r.upsert({
        installationId: installA,
        repositoryId: fxA.repositoryId,
        githubIssueNumber: 100,
        title: "A-100",
        body: null,
        state: "open",
        etag: null,
      });
      await r.upsert({
        installationId: installA,
        repositoryId: fxA.repositoryId,
        githubIssueNumber: 200,
        title: "A-200",
        body: null,
        state: "open",
        etag: null,
      });
      await r.upsert({
        installationId: installB,
        repositoryId: fxB.repositoryId,
        githubIssueNumber: 100,
        title: "B-100",
        body: null,
        state: "open",
        etag: null,
      });

      // Only #100 requested → #200 absent even though it exists.
      const outA = await r.getMany({ installationId: installA, issueNumbers: [100] });
      expect([...outA.keys()]).toEqual([100]);
      expect(outA.get(100)?.title).toBe("A-100");

      // installA's request never sees installB's #100 (tenancy isolation).
      expect(outA.get(100)?.title).not.toBe("B-100");
    } finally {
      await cleanup(fxA);
      await cleanup(fxB);
    }
  });

  it("upsert truncates a title longer than 500 chars (matches the column + the Python slice)", async () => {
    const installationId = randomUUID();
    const fx = await seedFixture(installationId);
    try {
      const r = repoFor();
      const longTitle = "x".repeat(600);
      await r.upsert({
        installationId,
        repositoryId: fx.repositoryId,
        githubIssueNumber: 9,
        title: longTitle,
        body: null,
        state: "open",
        etag: null,
      });
      const out = await r.getMany({ installationId, issueNumbers: [9] });
      expect(out.get(9)?.title).toHaveLength(500);
    } finally {
      await cleanup(fx);
    }
  });
});
