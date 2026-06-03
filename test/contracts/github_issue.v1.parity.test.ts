import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { GithubIssueV1 } from "../../libs/contracts/src/github_issue.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `GithubIssueV1(**payload).model_dump(mode="json")`) and through
// Zod (`GithubIssueV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
//
// GithubIssueV1 carries a REQUIRED `cached_at` datetime field. Pydantic emits a "Z"/offset ISO
// string while Zod passes the input string through verbatim — the canonicalizer (its own docstring:
// "so Python model_dump and JS JSON.stringify don't diff spuriously") normalizes both to microsecond
// UTC. We therefore re-canonicalize the oracle's raw output (`canonicalize(JSON.parse(r.out))`) so
// the datetime normalization applies to BOTH sides, rather than comparing against the raw "Z" form.
// UUID fields use lowercase RFC4122 strings (Pydantic lowercases UUIDs on dump).
const PY = "contracts.github_issue.v1";

describe("GithubIssueV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated open-issue payload identically", async () => {
    const payload = {
      schema_version: 1,
      github_issue_cache_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      github_issue_number: 1234,
      title: "Crash on empty diff",
      body: "Steps to reproduce: open a PR with no file changes.",
      state: "open",
      etag: 'W/"abc123def456"',
      cached_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(GithubIssueV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("applies the same defaults (schema_version/body/etag) when omitted", async () => {
    const payload = {
      github_issue_cache_id: "44444444-4444-4444-4444-444444444444",
      installation_id: "55555555-5555-5555-5555-555555555555",
      repository_id: "66666666-6666-6666-6666-666666666666",
      github_issue_number: 42,
      title: "Closed bug",
      state: "closed",
      cached_at: "2026-06-03T11:30:45+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(GithubIssueV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("treats an explicit-null body/etag identically (str | None defaults)", async () => {
    const payload = {
      github_issue_cache_id: "77777777-7777-7777-7777-777777777777",
      installation_id: "88888888-8888-8888-8888-888888888888",
      repository_id: "99999999-9999-9999-9999-999999999999",
      github_issue_number: 1,
      // empty title permitted (min_length=0).
      title: "",
      body: null,
      state: "open",
      etag: null,
      cached_at: "2026-06-03T00:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(GithubIssueV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("accepts the issue-number upper boundary (le=999_999_999) identically", async () => {
    const payload = {
      github_issue_cache_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      installation_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      repository_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      github_issue_number: 999_999_999,
      title: "Max issue number",
      state: "closed",
      cached_at: "2026-01-15T08:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(GithubIssueV1.parse(payload))).toBe(canonicalize(JSON.parse(r.out!)));
  }, 30_000);

  it("both REJECT an issue number below the floor (github_issue_number < 1, ge=1)", async () => {
    const bad = {
      github_issue_cache_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      github_issue_number: 0,
      title: "x",
      state: "open",
      cached_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => GithubIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an issue number above the ceiling (github_issue_number > 999_999_999, le)", async () => {
    const bad = {
      github_issue_cache_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      github_issue_number: 1_000_000_000,
      title: "x",
      state: "open",
      cached_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GithubIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a too-long title (max_length=500)", async () => {
    const bad = {
      github_issue_cache_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      github_issue_number: 1,
      title: "x".repeat(501),
      state: "open",
      cached_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GithubIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a too-long etag (max_length=64)", async () => {
    const bad = {
      github_issue_cache_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      github_issue_number: 1,
      title: "x",
      state: "open",
      etag: "e".repeat(65),
      cached_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GithubIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown state (Literal ↔ z.enum)", async () => {
    const bad = {
      github_issue_cache_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      github_issue_number: 1,
      title: "x",
      state: "merged",
      cached_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GithubIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-UUID id (z.string().uuid())", async () => {
    const bad = {
      github_issue_cache_id: "not-a-uuid",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      github_issue_number: 1,
      title: "x",
      state: "open",
      cached_at: "2026-06-03T10:00:00+00:00",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GithubIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a missing required cached_at (no default)", async () => {
    const bad = {
      github_issue_cache_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      github_issue_number: 1,
      title: "x",
      state: "open",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic: Field required
    expect(() => GithubIssueV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      github_issue_cache_id: "11111111-1111-1111-1111-111111111111",
      installation_id: "22222222-2222-2222-2222-222222222222",
      repository_id: "33333333-3333-3333-3333-333333333333",
      github_issue_number: 1,
      title: "x",
      state: "open",
      cached_at: "2026-06-03T10:00:00+00:00",
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GithubIssueV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GithubIssueV1.parse(bad)).toThrow();
  }, 30_000);
});
