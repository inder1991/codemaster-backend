/**
 * Unit tests for the ETag-aware {@link GitHubIssueClient.getIssue} — the 1:1 port of the frozen Python
 * `codemaster/integrations/github/api_client.py::GitHubApiClient.get_issue` (DM-WIRE T4 / S22.DM.16).
 *
 * `get_issue` deliberately bypasses the shared `_request` retry loop (it needs a custom If-None-Match
 * request header + an ETag response-header read) and NEVER raises — it returns `(payload, etag, status)`
 * so the consuming activity can absorb failures into a `(None, None)` resolver entry.
 *
 * The HTTP transport is the injected {@link CassetteHttpClient} replay double; the token provider is an
 * in-memory function. Each case replays a real cassette:
 *   - 200 → (payload dict, fresh ETag, 200).
 *   - 304 → (null, the inbound if_none_match, 304) — sends If-None-Match.
 *   - 404 → (null, null, 404).
 *   - 403 rate-limited → (null, null, 403) — surfaced, NOT raised.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { CassetteHttpClient } from "#backend/infra/cassettes.js";
import type { TokenProvider } from "#backend/integrations/github/api_client.js";

import { GitHubIssueClient } from "#backend/integrations/github/issue_client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// test/unit/integrations/github -> test/cassettes/github
const GH_CASSETTES = resolve(HERE, "..", "..", "..", "cassettes", "github");

function cassetteClient(name: string): CassetteHttpClient {
  return CassetteHttpClient.fromPath(resolve(GH_CASSETTES, name));
}

const tokenProvider: TokenProvider = async () => {
  await Promise.resolve();
  return "tok";
};

const INSTALLATION_ID = 12345;

describe("GitHubIssueClient.getIssue", () => {
  it("200 → returns (payload, fresh ETag, 200)", async () => {
    const http = cassetteClient("get_issue_200.yaml");
    const client = new GitHubIssueClient({ tokenProvider, http });

    const [payload, etag, status] = await client.getIssue({
      installationId: INSTALLATION_ID,
      owner: "acme",
      repo: "example",
      issueNumber: 42,
    });

    expect(status).toBe(200);
    expect(etag).toBe('"abc123etag"');
    expect(payload).not.toBeNull();
    expect((payload as Record<string, unknown>)["title"]).toBe("Fix the widget rendering");
    expect((payload as Record<string, unknown>)["state"]).toBe("open");
    http.assertFullyConsumed();
  });

  it("304 → returns (null, the inbound if_none_match, 304) after sending If-None-Match", async () => {
    const http = cassetteClient("get_issue_304.yaml");
    const client = new GitHubIssueClient({ tokenProvider, http });

    const [payload, etag, status] = await client.getIssue({
      installationId: INSTALLATION_ID,
      owner: "acme",
      repo: "example",
      issueNumber: 42,
      ifNoneMatch: '"cached-etag"',
    });

    expect(status).toBe(304);
    expect(payload).toBeNull();
    // The 304 path returns the INBOUND if_none_match (still valid), not a freshly-read ETag.
    expect(etag).toBe('"cached-etag"');
    http.assertFullyConsumed();
  });

  it("404 → returns (null, null, 404) without raising", async () => {
    const http = cassetteClient("get_issue_404.yaml");
    const client = new GitHubIssueClient({ tokenProvider, http });

    const [payload, etag, status] = await client.getIssue({
      installationId: INSTALLATION_ID,
      owner: "acme",
      repo: "example",
      issueNumber: 999,
    });

    expect(status).toBe(404);
    expect(payload).toBeNull();
    expect(etag).toBeNull();
    http.assertFullyConsumed();
  });

  it("403 rate-limited → surfaces (null, null, 403); does NOT raise", async () => {
    const http = cassetteClient("get_issue_403_rate_limited.yaml");
    const client = new GitHubIssueClient({ tokenProvider, http });

    const [payload, etag, status] = await client.getIssue({
      installationId: INSTALLATION_ID,
      owner: "acme",
      repo: "example",
      issueNumber: 42,
    });

    expect(status).toBe(403);
    expect(payload).toBeNull();
    expect(etag).toBeNull();
    http.assertFullyConsumed();
  });
});
