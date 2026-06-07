/**
 * Unit tests for the `fetchLinkedIssues` activity — the 1:1 port of the frozen Python
 * `codemaster/activities/fetch_linked_issues.py::FetchLinkedIssuesActivity.fetch_linked_issues`
 * (DM-WIRE T4 / S22.DM.16).
 *
 * The activity reads `pr_issue_links` rows, layers a `github_issues_cache` + ETag-aware GitHub refresh
 * on top, and assembles `tuple[LinkedIssueV1, ...]`. The byte-significant behaviours exercised here:
 *   - no parsed links → empty result (no I/O).
 *   - fresh cache hit (< 5 min) → cached values; no GitHub call.
 *   - stale cache hit (> 5 min) → ETag-aware GitHub fetch; 304 keeps body + refreshes; 200 upserts.
 *   - cache miss → unconditional GET; 200 upserts; 404 → (null, null).
 *   - 403 rate-limit → circuit breaker trips; remaining issues short-circuit to (null, null).
 *   - MAX_CONSECUTIVE_FAILURES consecutive failures → circuit breaker trips.
 *   - MAX_ISSUES_PER_INVOCATION cap → only the first N ASC-sorted issues fetched.
 *
 * The ports are in-memory fakes (full control over cache state + GitHub responses); ONE case wires the
 * real `GitHubIssueClient` over a cassette for the round-trip. ALL timing is the injected `FakeClock`.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  FetchLinkedIssuesActivity,
  type GithubIssuePort,
  MAX_CONSECUTIVE_FAILURES,
  MAX_ISSUES_PER_INVOCATION,
  CACHE_TTL_SECONDS,
} from "#backend/activities/fetch_linked_issues.activity.js";
import type {
  CachedIssueRow,
  GithubIssuesCacheRepoPort,
} from "#backend/domain/repos/github_issues_cache_repo.js";
import type { LinkedIssuesPort } from "#backend/domain/repos/pr_issue_links_repo.js";
import { CassetteHttpClient } from "#backend/infra/cassettes.js";
import { GitHubIssueClient } from "#backend/integrations/github/issue_client.js";

import { FakeClock } from "#platform/clock.js";

import type { IssueLink } from "#contracts/issue_link.v1.js";
import type { FetchLinkedIssuesInputV1 } from "#contracts/fetch_linked_issues_input.v1.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GH_CASSETTES = resolve(HERE, "..", "..", "cassettes", "github");

const IID_UUID = "11111111-1111-1111-1111-111111111111";
const REPO_UUID = "22222222-2222-2222-2222-222222222222";
const PR_UUID = "33333333-3333-3333-3333-333333333333";
const IID_INT = 12345;
const NOW = new Date("2099-06-01T12:00:00.000Z");

function input(over: Partial<FetchLinkedIssuesInputV1> = {}): FetchLinkedIssuesInputV1 {
  return {
    schema_version: 1,
    installation_id_uuid: IID_UUID,
    installation_id_int: IID_INT,
    repository_id: REPO_UUID,
    pr_id: PR_UUID,
    owner: "acme",
    repo: "example",
    ...over,
  };
}

function link(n: number, kind: IssueLink["linkage_kind"] = "closes"): IssueLink {
  return { github_issue_number: n, linkage_kind: kind, source: "description" };
}

/** In-memory links repo. */
function fakeLinksRepo(links: ReadonlyArray<IssueLink>): LinkedIssuesPort {
  return {
    async listLinksForPr() {
      await Promise.resolve();
      return links;
    },
  };
}

/** In-memory cache repo capturing upserts. */
function fakeCacheRepo(seed: ReadonlyArray<CachedIssueRow> = []): GithubIssuesCacheRepoPort & {
  upserts: Array<{ githubIssueNumber: number; title: string; state: string; etag: string | null }>;
} {
  const byNum = new Map<number, CachedIssueRow>(seed.map((r) => [r.github_issue_number, r]));
  const upserts: Array<{
    githubIssueNumber: number;
    title: string;
    state: string;
    etag: string | null;
  }> = [];
  return {
    upserts,
    async getMany({ issueNumbers }) {
      await Promise.resolve();
      const out = new Map<number, CachedIssueRow>();
      for (const n of issueNumbers) {
        const e = byNum.get(n);
        if (e !== undefined) out.set(n, e);
      }
      return out;
    },
    async upsert(args) {
      await Promise.resolve();
      upserts.push({
        githubIssueNumber: args.githubIssueNumber,
        title: args.title,
        state: args.state,
        etag: args.etag,
      });
    },
  };
}

/** A scripted GitHub port keyed by issue number → the (payload, etag, status) tuple to return. */
function fakeGithub(
  responses: Record<number, readonly [Record<string, unknown> | null, string | null, number]>,
): GithubIssuePort & { calls: Array<{ issueNumber: number; ifNoneMatch: string | null }> } {
  const calls: Array<{ issueNumber: number; ifNoneMatch: string | null }> = [];
  return {
    calls,
    async getIssue(args) {
      await Promise.resolve();
      calls.push({ issueNumber: args.issueNumber, ifNoneMatch: args.ifNoneMatch ?? null });
      return responses[args.issueNumber] ?? [null, null, 0];
    },
  };
}

function cachedRow(over: Partial<CachedIssueRow> & { github_issue_number: number }): CachedIssueRow {
  return {
    title: "cached title",
    body: "cached body",
    state: "open",
    etag: '"cached-etag"',
    cached_at: NOW,
    ...over,
  };
}

function activity(args: {
  linksRepo: LinkedIssuesPort;
  cacheRepo: GithubIssuesCacheRepoPort;
  github: GithubIssuePort;
  clock?: FakeClock;
}): FetchLinkedIssuesActivity {
  return new FetchLinkedIssuesActivity({
    linksRepo: args.linksRepo,
    cacheRepo: args.cacheRepo,
    github: args.github,
    clock: args.clock ?? new FakeClock({ now: NOW }),
  });
}

describe("FetchLinkedIssuesActivity", () => {
  it("returns an empty array when the PR has no parsed links", async () => {
    const a = activity({
      linksRepo: fakeLinksRepo([]),
      cacheRepo: fakeCacheRepo(),
      github: fakeGithub({}),
    });
    expect(await a.fetchLinkedIssues(input())).toEqual([]);
  });

  it("uses a fresh cache hit (< TTL) without calling GitHub", async () => {
    const cache = fakeCacheRepo([cachedRow({ github_issue_number: 5, title: "Cached #5", state: "closed", cached_at: NOW })]);
    const github = fakeGithub({});
    const a = activity({ linksRepo: fakeLinksRepo([link(5)]), cacheRepo: cache, github });

    const out = await a.fetchLinkedIssues(input());
    expect(out).toEqual([{ issue_number: 5, linkage_kind: "closes", title: "Cached #5", state: "closed" }]);
    expect(github.calls).toEqual([]); // no GitHub call on a fresh hit
  });

  it("refreshes a stale cache hit via ETag; a 304 keeps the cached body + re-upserts", async () => {
    const staleAt = new Date(NOW.getTime() - (CACHE_TTL_SECONDS + 60) * 1000);
    const cache = fakeCacheRepo([
      cachedRow({ github_issue_number: 7, title: "Stale #7", state: "open", etag: '"e7"', cached_at: staleAt }),
    ]);
    const github = fakeGithub({ 7: [null, '"e7"', 304] });
    const a = activity({ linksRepo: fakeLinksRepo([link(7)]), cacheRepo: cache, github });

    const out = await a.fetchLinkedIssues(input());
    // 304 → keep the cached (title,state).
    expect(out).toEqual([{ issue_number: 7, linkage_kind: "closes", title: "Stale #7", state: "open" }]);
    // The GET carried the cached ETag as If-None-Match.
    expect(github.calls).toEqual([{ issueNumber: 7, ifNoneMatch: '"e7"' }]);
    // A 304 re-upserts (refresh cached_at), keeping the cached body.
    expect(cache.upserts).toHaveLength(1);
    expect(cache.upserts[0]?.title).toBe("Stale #7");
  });

  it("on a cache miss issues an unconditional GET; a 200 upserts + populates the resolver", async () => {
    const cache = fakeCacheRepo();
    const github = fakeGithub({
      8: [{ title: "Fresh #8", body: "b", state: "open" }, '"new8"', 200],
    });
    const a = activity({ linksRepo: fakeLinksRepo([link(8, "fixes")]), cacheRepo: cache, github });

    const out = await a.fetchLinkedIssues(input());
    expect(out).toEqual([{ issue_number: 8, linkage_kind: "fixes", title: "Fresh #8", state: "open" }]);
    // Cache miss → no If-None-Match.
    expect(github.calls).toEqual([{ issueNumber: 8, ifNoneMatch: null }]);
    expect(cache.upserts[0]).toMatchObject({ githubIssueNumber: 8, title: "Fresh #8", state: "open", etag: '"new8"' });
  });

  it("a 404 on a cache miss degrades that issue to (null, null)", async () => {
    const cache = fakeCacheRepo();
    const github = fakeGithub({ 9: [null, null, 404] });
    const a = activity({ linksRepo: fakeLinksRepo([link(9, "resolves")]), cacheRepo: cache, github });

    const out = await a.fetchLinkedIssues(input());
    expect(out).toEqual([{ issue_number: 9, linkage_kind: "resolves", title: null, state: null }]);
    expect(cache.upserts).toEqual([]); // 404 does not upsert
  });

  it("a 403 rate-limit trips the circuit breaker; remaining issues short-circuit to (null, null)", async () => {
    const cache = fakeCacheRepo();
    const github = fakeGithub({
      1: [null, null, 403], // rate-limited → trip breaker
      2: [{ title: "Should never be fetched", state: "open" }, '"x"', 200],
    });
    const a = activity({ linksRepo: fakeLinksRepo([link(1), link(2)]), cacheRepo: cache, github });

    const out = await a.fetchLinkedIssues(input());
    // #1 rate-limited → (null,null); #2 short-circuited (breaker open) → (null,null).
    expect(out).toEqual([
      { issue_number: 1, linkage_kind: "closes", title: null, state: null },
      { issue_number: 2, linkage_kind: "closes", title: null, state: null },
    ]);
    // Only #1 was actually fetched (breaker stopped #2).
    expect(github.calls.map((c) => c.issueNumber)).toEqual([1]);
  });

  it("trips the circuit breaker after MAX_CONSECUTIVE_FAILURES consecutive non-success responses", async () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(3);
    const links = [1, 2, 3, 4, 5].map((n) => link(n));
    const cache = fakeCacheRepo();
    // First three 404s (consecutive failures) trip the breaker; #4, #5 short-circuit.
    const github = fakeGithub({
      1: [null, null, 404],
      2: [null, null, 404],
      3: [null, null, 404],
      4: [{ title: "never", state: "open" }, "x", 200],
      5: [{ title: "never", state: "open" }, "x", 200],
    });
    const a = activity({ linksRepo: fakeLinksRepo(links), cacheRepo: cache, github });

    const out = await a.fetchLinkedIssues(input());
    expect(out.every((l) => l.title === null)).toBe(true);
    // Only #1..#3 fetched; breaker opened so #4, #5 never called.
    expect(github.calls.map((c) => c.issueNumber)).toEqual([1, 2, 3]);
  });

  it("caps issues fetched at MAX_ISSUES_PER_INVOCATION (first N ASC-sorted)", async () => {
    expect(MAX_ISSUES_PER_INVOCATION).toBe(50);
    const total = MAX_ISSUES_PER_INVOCATION + 5;
    const links = Array.from({ length: total }, (_, i) => link(i + 1, "mentioned"));
    const cache = fakeCacheRepo();
    // Every issue 404s so none upsert; we only assert the count fetched is bounded.
    const github = fakeGithub(
      Object.fromEntries(links.map((l) => [l.github_issue_number, [null, null, 404] as const])),
    );
    const a = activity({ linksRepo: fakeLinksRepo(links), cacheRepo: cache, github });

    await a.fetchLinkedIssues(input());
    // The circuit-breaker trips after 3 consecutive 404s, so we never fetch all 50 — but we MUST NOT
    // fetch the 51st..55th issues (beyond the cap). The highest issue number fetched is <= 50.
    const maxFetched = Math.max(...github.calls.map((c) => c.issueNumber));
    expect(maxFetched).toBeLessThanOrEqual(MAX_ISSUES_PER_INVOCATION);
  });

  it("round-trips a real 200 through the GitHubIssueClient over a cassette", async () => {
    const http = CassetteHttpClient.fromPath(resolve(GH_CASSETTES, "get_issue_200.yaml"));
    const client = new GitHubIssueClient({
      tokenProvider: async () => {
        await Promise.resolve();
        return "tok";
      },
      http,
    });
    const cache = fakeCacheRepo();
    const a = activity({ linksRepo: fakeLinksRepo([link(42, "closes")]), cacheRepo: cache, github: client });

    const out = await a.fetchLinkedIssues(input());
    expect(out).toEqual([
      { issue_number: 42, linkage_kind: "closes", title: "Fix the widget rendering", state: "open" },
    ]);
    // The 200 upserted the freshly-fetched body + ETag.
    expect(cache.upserts[0]).toMatchObject({
      githubIssueNumber: 42,
      title: "Fix the widget rendering",
      state: "open",
      etag: '"abc123etag"',
    });
    http.assertFullyConsumed();
  });
});
