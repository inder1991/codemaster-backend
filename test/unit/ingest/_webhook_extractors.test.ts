// Unit tests for the pure webhook body extractors (1:1 with the Python `_extract_*`). All fail CLOSED on
// malformed JSON / missing fields.

import { describe, expect, it } from "vitest";

import {
  extractInstallationId,
  extractPrMetadata,
  extractPrNodeId,
  extractRepoAndPr,
  extractSenderLogin,
} from "#backend/ingest/_webhook_extractors.js";

const buf = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));

const ACCOUNT = { id: 7, login: "octocat", type: "User" };
function prBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "opened",
    number: 42,
    pull_request: {
      number: 42,
      title: "Add widget",
      body: "desc",
      node_id: "PR_kwabc",
      head: { sha: "a".repeat(40), repo: { full_name: "fork/widgets" }, ref: "feat/x" },
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
    ...over,
  };
}

describe("extractInstallationId", () => {
  it("returns the int installation.id", () => {
    expect(extractInstallationId(buf({ installation: { id: 123 } }))).toBe(123);
  });
  it("returns null when absent / non-int / malformed", () => {
    expect(extractInstallationId(buf({}))).toBeNull();
    expect(extractInstallationId(buf({ installation: { id: "x" } }))).toBeNull();
    expect(extractInstallationId(new TextEncoder().encode("not json"))).toBeNull();
  });
});

describe("extractRepoAndPr", () => {
  it("returns [repoId, prNumber] for a PR event", () => {
    expect(extractRepoAndPr(buf(prBody()))).toEqual([555, 42]);
  });
  it("returns [repoId, null] for a non-PR event", () => {
    expect(extractRepoAndPr(buf({ repository: { id: 555 } }))).toEqual([555, null]);
  });
  it("rejects pr_number <= 0", () => {
    expect(extractRepoAndPr(buf({ repository: { id: 555 }, pull_request: { number: 0 } }))).toEqual([555, null]);
  });
});

describe("extractSenderLogin", () => {
  it("namespaces under user:", () => {
    expect(extractSenderLogin(buf({ sender: { login: "octocat" } }))).toBe("user:octocat");
  });
  it("returns null for absent / empty login", () => {
    expect(extractSenderLogin(buf({ sender: {} }))).toBeNull();
    expect(extractSenderLogin(buf({ sender: { login: "" } }))).toBeNull();
    expect(extractSenderLogin(buf({}))).toBeNull();
  });
});

describe("extractPrNodeId", () => {
  it("returns the node_id string", () => {
    expect(extractPrNodeId(buf(prBody()))).toBe("PR_kwabc");
  });
  it("returns null when absent", () => {
    expect(extractPrNodeId(buf({ pull_request: { number: 1 } }))).toBeNull();
  });
});

describe("extractPrMetadata", () => {
  it("projects the validated slice (cross-fork detected, truncations, id mapping)", () => {
    const m = extractPrMetadata(buf(prBody()));
    expect(m).not.toBeNull();
    expect(m!.action).toBe("opened");
    expect(m!.prNumber).toBe(42);
    expect(m!.headSha).toBe("a".repeat(40));
    expect(m!.ghOwner).toBe("acme");
    expect(m!.ghRepoName).toBe("widgets");
    expect(m!.isCrossFork).toBe(true); // head fork/widgets ≠ base acme/widgets
    expect(m!.githubPullRequestId).toBe(99);
    expect(m!.authorLogin).toBe("octocat");
    expect(m!.baseRef).toBe("main");
    expect(m!.headRef).toBe("feat/x");
    // opened_at normalized Z → +00:00 to byte-match Python's datetime.isoformat() wire shape.
    expect(m!.openedAt).toBe("2026-01-01T00:00:00+00:00");
  });

  it("maps github_pull_request_id 0 → null and truncates an over-long title", () => {
    const m = extractPrMetadata(
      buf(prBody({ pull_request: { ...(prBody().pull_request as object), id: 0, title: "x".repeat(600) } })),
    );
    expect(m!.githubPullRequestId).toBeNull();
    expect(m!.prTitle.length).toBe(500);
  });

  it("fails CLOSED (null) on a contract violation (missing head.sha)", () => {
    const bad = prBody();
    (bad.pull_request as Record<string, unknown>).head = { repo: { full_name: "acme/widgets" } };
    expect(extractPrMetadata(buf(bad))).toBeNull();
  });

  it("returns null for a non-PR / malformed body", () => {
    expect(extractPrMetadata(buf({ action: "created" }))).toBeNull();
    expect(extractPrMetadata(new TextEncoder().encode("nope"))).toBeNull();
  });
});
