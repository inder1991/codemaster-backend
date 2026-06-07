// Behavioral tests for GitHubPullRequestPayloadV1 — the trust-tier boundary contract for the GitHub
// pull_request webhook. Constraints transcribed verbatim from the frozen Python contract.

import { describe, expect, it } from "vitest";

import { GitHubPullRequestPayloadV1 } from "#contracts/github_pull_request_payload.v1.js";

const ACCOUNT = { id: 7, login: "octocat", type: "User" };
const VALID = {
  action: "opened",
  number: 42,
  pull_request: {
    number: 42,
    title: "Add widget",
    body: "a description",
    head: { sha: "a".repeat(40), repo: { full_name: "acme/widgets" }, ref: "feat/x" },
    base: { sha: "b".repeat(40), repo: { full_name: "acme/widgets" }, ref: "main" },
    user: ACCOUNT,
    draft: false,
    merged: false,
    id: 99,
    created_at: "2026-01-01T00:00:00Z",
  },
  repository: { id: 555, full_name: "acme/widgets", owner: { id: 1, login: "acme", type: "Organization" } },
  installation: { id: 123 },
  sender: ACCOUNT,
};

describe("GitHubPullRequestPayloadV1", () => {
  it("parses a valid pull_request.opened payload (installation.account optional)", () => {
    const p = GitHubPullRequestPayloadV1.parse(VALID);
    expect(p.action).toBe("opened");
    expect(p.pull_request.head.sha).toBe("a".repeat(40));
    expect(p.repository.owner.login).toBe("acme");
    expect(p.installation.id).toBe(123);
    expect(p.installation.account).toBeNull();
  });

  it("rejects a missing head.sha", () => {
    const bad = {
      ...VALID,
      pull_request: { ...VALID.pull_request, head: { repo: { full_name: "acme/widgets" }, ref: "x" } },
    };
    expect(() => GitHubPullRequestPayloadV1.parse(bad)).toThrow();
  });

  it("rejects a non-hex / short sha", () => {
    const bad = {
      ...VALID,
      pull_request: { ...VALID.pull_request, head: { ...VALID.pull_request.head, sha: "z".repeat(40) } },
    };
    expect(() => GitHubPullRequestPayloadV1.parse(bad)).toThrow();
  });

  it("rejects an unknown action (a future GitHub expansion surfaces in test)", () => {
    expect(() => GitHubPullRequestPayloadV1.parse({ ...VALID, action: "labeled" })).toThrow();
  });

  it("strips unknown top-level keys (extra=ignore ↔ .strip())", () => {
    const p = GitHubPullRequestPayloadV1.parse({ ...VALID, bogus: "dropped" });
    expect((p as Record<string, unknown>).bogus).toBeUndefined();
  });

  it("coerces a null pull_request.body to empty string", () => {
    const p = GitHubPullRequestPayloadV1.parse({
      ...VALID,
      pull_request: { ...VALID.pull_request, body: null },
    });
    expect(p.pull_request.body).toBe("");
  });

  it("defaults an absent body → '', absent id → 0, absent created_at → null", () => {
    const pr = {
      number: 42,
      title: "t",
      head: { sha: "a".repeat(40), repo: { full_name: "acme/widgets" } },
      base: { sha: "b".repeat(40), repo: { full_name: "acme/widgets" } },
    };
    const p = GitHubPullRequestPayloadV1.parse({ ...VALID, pull_request: pr });
    expect(p.pull_request.body).toBe("");
    expect(p.pull_request.id).toBe(0);
    expect(p.pull_request.created_at).toBeNull();
    expect(p.pull_request.head.ref).toBe(""); // ref default
  });
});
