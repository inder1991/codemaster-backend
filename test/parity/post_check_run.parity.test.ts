import { afterAll, describe, expect, it } from "vitest";

import {
  pyDoPostCheckRun,
  shutdownPostCheckRunRef,
  type PostCheckRunRequest,
  type RecordedCall,
} from "./post_check_run_oracle.js";
import { doPostCheckRun } from "#backend/activities/post_check_run.activity.js";
import {
  CHECK_RUN_NAME,
  GitHubApiCheckRunClient,
  type GhCheckRunClient,
} from "#backend/integrations/github/check_run_client.js";
import {
  GitHubApiClient,
  type GitHubHttpClient,
  type GitHubHttpRequestArgs,
  type GitHubHttpResponse,
  type TokenProvider,
} from "#backend/integrations/github/api_client.js";
import { FakeClock } from "#platform/clock.js";
import type { PostCheckRunInputV1 } from "#contracts/posted_check_run.v1.js";

afterAll(() => {
  shutdownPostCheckRunRef();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS `doPostCheckRun` orchestration (validate → find → update/create, with
// conclusion ALWAYS "neutral") is byte-equal to the frozen Python `_do_post_check_run`
// (vendor/codemaster-py/codemaster/activities/post_check_run.py), driven over the dedicated ref
// (tools/parity/run_post_check_run_ref.py).
//
// Both sides drive a scripted RECORDING STUB GhCheckRunClient — the real GitHub REST client is OUT OF
// SCOPE here (exercised separately by the FetchGhCheckRunClient transport test below). The stub returns
// the caller-scripted `existing` id (int → update path) or null (create path) and records each call, so
// the find→update/create LOGIC + the call SEQUENCE are byte-verifiable WITHOUT a network round-trip.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const PR_META: PostCheckRunInputV1["pr_meta"] = {
  pr_id: "11111111-1111-4111-8111-111111111111",
  installation_id: "22222222-2222-4222-8222-222222222222",
  repo: "octo/hello-world",
  pr_title: "Add widget",
  pr_description: "",
  author_login: null,
  draft: false,
  base_ref: null,
  head_ref: null,
  opened_at: null,
};

/** A TS recording stub `GhCheckRunClient` mirroring the Python `_RecordingStubClient`: returns the
 *  scripted `existing` from findExistingCheckRun, and records every call as the SAME snake_case shape the
 *  Python driver emits (so the recorded call sequences byte-compare directly). NO network. */
function recordingStubClient(existing: number | null): {
  client: GhCheckRunClient;
  calls: Array<RecordedCall>;
} {
  const calls: Array<RecordedCall> = [];
  const NEW_CHECK_RUN_ID = 7777; // must match the Python stub's NEW_CHECK_RUN_ID.
  const client: GhCheckRunClient = {
    findExistingCheckRun({ owner, repo, headSha, name }): Promise<number | null> {
      calls.push({
        method: "find_existing_check_run",
        kwargs: { owner, repo, head_sha: headSha, name },
      });
      return Promise.resolve(existing);
    },
    createCheckRun({ owner, repo, headSha, name, status, conclusion, summary }): Promise<number> {
      calls.push({
        method: "create_check_run",
        kwargs: { owner, repo, head_sha: headSha, name, status, conclusion, summary },
      });
      return Promise.resolve(NEW_CHECK_RUN_ID);
    },
    updateCheckRun({ owner, repo, checkRunId, status, conclusion, summary }): Promise<void> {
      calls.push({
        method: "update_check_run",
        kwargs: { owner, repo, check_run_id: checkRunId, status, conclusion, summary },
      });
      return Promise.resolve();
    },
  };
  return { client, calls };
}

/**
 * Run the SAME request through the TS `doPostCheckRun` and the frozen Python `_do_post_check_run`, and
 * assert byte-equality of the returned PostedCheckRunV1 (sans the TS-only schema_version, which has no
 * Python dataclass counterpart) AND the recorded call sequence (method + kwargs).
 */
async function assertParity(req: PostCheckRunRequest): Promise<void> {
  const { client, calls: tsCalls } = recordingStubClient(req.existing);
  const ts = await doPostCheckRun({
    prMeta: PR_META,
    headSha: req.head_sha,
    summary: req.summary,
    owner: req.owner,
    repoName: req.repo_name,
    ghClient: client,
  });
  const py = await pyDoPostCheckRun(req);

  expect(py.ok).toBe(true);
  if (!py.ok) return; // narrows for TS; the assertion above already failed if false.

  // Return value: the two load-bearing fields match the Python dataclass byte-for-byte.
  expect({ check_run_id: ts.check_run_id, was_update: ts.was_update }).toEqual(py.result);
  // Call sequence: same methods, same kwargs, same order.
  expect(tsCalls).toEqual(py.calls);
}

describe("post_check_run _do_post_check_run parity (Python ↔ TS)", () => {
  it("create path — no existing run → was_update=false, create called (conclusion neutral)", async () => {
    await assertParity({
      pr_meta: PR_META,
      head_sha: "abc123",
      summary: "All clear.",
      owner: "octo",
      repo_name: "hello-world",
      existing: null,
    });
  }, 30_000);

  it("update path — existing run at head_sha → was_update=true, update called", async () => {
    await assertParity({
      pr_meta: PR_META,
      head_sha: "def456",
      summary: "1 nit.",
      owner: "octo",
      repo_name: "hello-world",
      existing: 4242,
    });
  }, 30_000);

  it("empty summary → raises on BOTH sides (no client calls)", async () => {
    const { client, calls } = recordingStubClient(null);
    await expect(
      doPostCheckRun({
        prMeta: PR_META,
        headSha: "abc123",
        summary: "",
        owner: "octo",
        repoName: "hello-world",
        ghClient: client,
      }),
    ).rejects.toThrow("summary must be non-empty");
    expect(calls).toEqual([]); // validation precedes any client call.

    const py = await pyDoPostCheckRun({
      pr_meta: PR_META,
      head_sha: "abc123",
      summary: "",
      owner: "octo",
      repo_name: "hello-world",
      existing: null,
    });
    expect(py.ok).toBe(false);
    if (!py.ok) expect(py.err).toContain("summary must be non-empty");
  }, 30_000);

  it("empty head_sha → raises on BOTH sides (no client calls)", async () => {
    const { client, calls } = recordingStubClient(null);
    await expect(
      doPostCheckRun({
        prMeta: PR_META,
        headSha: "",
        summary: "All clear.",
        owner: "octo",
        repoName: "hello-world",
        ghClient: client,
      }),
    ).rejects.toThrow("head_sha must be set");
    expect(calls).toEqual([]);

    const py = await pyDoPostCheckRun({
      pr_meta: PR_META,
      head_sha: "",
      summary: "All clear.",
      owner: "octo",
      repo_name: "hello-world",
      existing: null,
    });
    expect(py.ok).toBe(false);
    if (!py.ok) expect(py.err).toContain("head_sha must be set");
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Stub-vs-real split: the REAL GitHubApiCheckRunClient over a RECORDING STUB of the GitHubApiClient
// transport. Asserts the EXACT REST method / url / json body for find / create / update + the response
// parse (the new check_run_id) — the wire contract the parity oracle (which stubs the whole client)
// cannot reach.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A recording GitHubHttpClient: records each request and returns the NEXT scripted response. */
function recordingTransport(responses: ReadonlyArray<GitHubHttpResponse>): {
  http: GitHubHttpClient;
  requests: Array<GitHubHttpRequestArgs>;
} {
  const requests: Array<GitHubHttpRequestArgs> = [];
  let i = 0;
  const http: GitHubHttpClient = {
    request(args: GitHubHttpRequestArgs): Promise<GitHubHttpResponse> {
      requests.push(args);
      const resp = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return Promise.resolve(resp);
    },
  };
  return { http, requests };
}

function okJson(body: unknown): GitHubHttpResponse {
  return { status: 200, headers: {}, body_text: JSON.stringify(body) };
}

const tokenProvider: TokenProvider = () => Promise.resolve("tok");
const INSTALLATION_ID = 555;

function realClient(responses: ReadonlyArray<GitHubHttpResponse>): {
  client: GitHubApiCheckRunClient;
  requests: Array<GitHubHttpRequestArgs>;
} {
  const { http, requests } = recordingTransport(responses);
  const api = new GitHubApiClient({ tokenProvider, http, clock: new FakeClock() });
  const client = new GitHubApiCheckRunClient({ api, installationId: INSTALLATION_ID });
  return { client, requests };
}

describe("GitHubApiCheckRunClient — exact REST wire contract (recording-stub transport)", () => {
  it("findExistingCheckRun → GET commits/{sha}/check-runs, returns matching run id", async () => {
    const { client, requests } = realClient([
      okJson({ check_runs: [{ id: 1, name: "other" }, { id: 99, name: CHECK_RUN_NAME }] }),
    ]);
    const id = await client.findExistingCheckRun({
      owner: "octo",
      repo: "hello-world",
      headSha: "abc123",
      name: CHECK_RUN_NAME,
    });
    expect(id).toBe(99);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe(
      "https://api.github.com/repos/octo/hello-world/commits/abc123/check-runs",
    );
  });

  it("findExistingCheckRun → null when no run matches the name", async () => {
    const { client } = realClient([okJson({ check_runs: [{ id: 1, name: "other" }] })]);
    const id = await client.findExistingCheckRun({
      owner: "octo",
      repo: "hello-world",
      headSha: "abc123",
      name: CHECK_RUN_NAME,
    });
    expect(id).toBeNull();
  });

  it("createCheckRun → POST check-runs with the exact body, returns the new id", async () => {
    const { client, requests } = realClient([okJson({ id: 4242 })]);
    const newId = await client.createCheckRun({
      owner: "octo",
      repo: "hello-world",
      headSha: "abc123",
      name: CHECK_RUN_NAME,
      status: "completed",
      conclusion: "neutral",
      summary: "All clear.",
    });
    expect(newId).toBe(4242);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("https://api.github.com/repos/octo/hello-world/check-runs");
    expect(requests[0]!.json_body).toEqual({
      name: CHECK_RUN_NAME,
      head_sha: "abc123",
      status: "completed",
      conclusion: "neutral",
      output: { title: CHECK_RUN_NAME, summary: "All clear." },
    });
  });

  it("updateCheckRun → PATCH check-runs/{id} (NOT PUT) with the exact body", async () => {
    const { client, requests } = realClient([okJson({ id: 4242 })]);
    await client.updateCheckRun({
      owner: "octo",
      repo: "hello-world",
      checkRunId: 4242,
      status: "completed",
      conclusion: "neutral",
      summary: "1 nit.",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("PATCH");
    expect(requests[0]!.url).toBe("https://api.github.com/repos/octo/hello-world/check-runs/4242");
    expect(requests[0]!.json_body).toEqual({
      status: "completed",
      conclusion: "neutral",
      output: { title: CHECK_RUN_NAME, summary: "1 nit." },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PostCheckRunInputV1 + PostedCheckRunV1 — the contracts introduced/promoted DURING the port. The input
// envelope CLOSES the Python 5-positional invariant-11 dispatch; there is no Python counterpart to
// byte-diff, so cover round-trip + validation only.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("posted_check_run.v1 contracts (validation only)", () => {
  it("PostedCheckRunV1 applies schema_version default and accepts the two fields", async () => {
    const { PostedCheckRunV1 } = await import("#contracts/posted_check_run.v1.js");
    const parsed = PostedCheckRunV1.parse({ check_run_id: 7, was_update: true });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.check_run_id).toBe(7);
    expect(parsed.was_update).toBe(true);
  });

  it("PostedCheckRunV1 rejects unknown keys (.strict())", async () => {
    const { PostedCheckRunV1 } = await import("#contracts/posted_check_run.v1.js");
    expect(() => PostedCheckRunV1.parse({ check_run_id: 7, was_update: true, bogus: 1 })).toThrow();
  });

  it("PostCheckRunInputV1 accepts a valid envelope + applies schema_version default", async () => {
    const { PostCheckRunInputV1 } = await import("#contracts/posted_check_run.v1.js");
    const parsed = PostCheckRunInputV1.parse({
      pr_meta: PR_META,
      head_sha: "abc123",
      summary: "All clear.",
      owner: "octo",
      repo_name: "hello-world",
    });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.owner).toBe("octo");
  });

  it("PostCheckRunInputV1 rejects unknown top-level keys (.strict())", async () => {
    const { PostCheckRunInputV1 } = await import("#contracts/posted_check_run.v1.js");
    expect(() =>
      PostCheckRunInputV1.parse({
        pr_meta: PR_META,
        head_sha: "abc123",
        summary: "All clear.",
        owner: "octo",
        repo_name: "hello-world",
        bogus: true,
      }),
    ).toThrow();
  });
});
