// Unit tests for the manifest-fetch GitHub methods getContents / getRecursiveTree (1:1 with the Python
// get_contents / get_recursive_tree). The _request retry/auth envelope is cassette-tested elsewhere; here
// a tiny stub HTTP client exercises the NEW parsing logic (404→null, non-file→null, base64-ascii bytes,
// blob filtering + ASCII sort + truncated flag).

import { describe, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import {
  GitHubApiClient,
  type GitHubHttpClient,
  type GitHubHttpRequestArgs,
  type GitHubHttpResponse,
  type TokenProvider,
} from "#backend/integrations/github/api_client.js";

const provider: TokenProvider = async () => "tok";

function stubHttp(responder: (args: GitHubHttpRequestArgs) => GitHubHttpResponse): GitHubHttpClient {
  return { request: async (args) => responder(args) };
}

function jsonResp(status: number, body: unknown): GitHubHttpResponse {
  return { status, headers: {}, body_text: JSON.stringify(body) };
}

function makeClient(responder: (args: GitHubHttpRequestArgs) => GitHubHttpResponse): GitHubApiClient {
  return new GitHubApiClient({ tokenProvider: provider, http: stubHttp(responder), clock: new FakeClock() });
}

const BASE = { installationId: 1, installationUuid: "11111111-1111-1111-1111-111111111111", owner: "octo", repo: "app" };

describe("GitHubApiClient.getContents (manifest fetch)", () => {
  it("200 file → [base64-ascii bytes, sha] (decodes to the original content)", async () => {
    const b64 = Buffer.from("hello = 1\n").toString("base64");
    const client = makeClient(() => jsonResp(200, { type: "file", content: b64, sha: "abc123" }));
    const out = await client.getContents({ ...BASE, path: "pyproject.toml", ref: "deadbeef" });
    expect(out).not.toBeNull();
    const [bytes, sha] = out!;
    expect(sha).toBe("abc123");
    // bytes are the base64 STRING as ASCII; the activity base64-decodes them back to the content.
    expect(Buffer.from(Buffer.from(bytes).toString("ascii"), "base64").toString("utf8")).toBe("hello = 1\n");
  });

  it("404 → null (file absent at the ref)", async () => {
    const client = makeClient(() => jsonResp(404, { message: "Not Found" }));
    expect(await client.getContents({ ...BASE, path: "go.mod", ref: "x" })).toBeNull();
  });

  it("a directory listing (array root) → null", async () => {
    const client = makeClient(() => jsonResp(200, [{ type: "file", name: "a" }]));
    expect(await client.getContents({ ...BASE, path: "src", ref: "x" })).toBeNull();
  });

  it("type!=file (submodule/symlink) → null", async () => {
    const client = makeClient(() => jsonResp(200, { type: "submodule", content: "x", sha: "s" }));
    expect(await client.getContents({ ...BASE, path: "vendored", ref: "x" })).toBeNull();
  });

  it("missing content/sha → null", async () => {
    const client = makeClient(() => jsonResp(200, { type: "file" }));
    expect(await client.getContents({ ...BASE, path: "x", ref: "x" })).toBeNull();
  });

  it("nested monorepo path: preserves '/' separators (encodes each segment, not the whole path)", async () => {
    // encodeURIComponent on the WHOLE path turns '/' into %2F, producing
    // /contents/services%2Fapi%2Fpackage.json which GitHub's contents API 404s. The fix encodes each
    // segment and rejoins with literal '/', so monorepo nested manifests resolve.
    let capturedUrl = "";
    const client = makeClient((args) => {
      capturedUrl = args.url;
      return jsonResp(200, { type: "file", content: Buffer.from("x = 1\n").toString("base64"), sha: "s" });
    });
    await client.getContents({ ...BASE, path: "services/api/package.json", ref: "deadbeef" });
    expect(capturedUrl).toContain("/contents/services/api/package.json?ref=deadbeef");
    expect(capturedUrl).not.toContain("%2F");
  });

  it("a path segment that needs encoding is still percent-encoded (only the '/' is preserved)", async () => {
    let capturedUrl = "";
    const client = makeClient((args) => {
      capturedUrl = args.url;
      return jsonResp(200, { type: "file", content: Buffer.from("x").toString("base64"), sha: "s" });
    });
    // a space in a segment must encode to %20; the '/' separator stays literal.
    await client.getContents({ ...BASE, path: "my dir/package.json", ref: "x" });
    expect(capturedUrl).toContain("/contents/my%20dir/package.json?ref=x");
  });
});

describe("GitHubApiClient.getRecursiveTree", () => {
  it("ASCII-sorts blob paths, filters non-blobs, surfaces truncated=false", async () => {
    const client = makeClient(() =>
      jsonResp(200, {
        truncated: false,
        tree: [
          { type: "blob", path: "src/b.ts" },
          { type: "tree", path: "src" }, // directory — filtered out
          { type: "blob", path: "a.ts" },
          { type: "blob" }, // no path — filtered
          { path: "x.ts" }, // no type — filtered
        ],
      }),
    );
    const [paths, truncated] = await client.getRecursiveTree({ ...BASE, treeSha: "deadbeef" });
    expect(paths).toEqual(["a.ts", "src/b.ts"]);
    expect(truncated).toBe(false);
  });

  it("truncated=true is surfaced (best-effort signal)", async () => {
    const client = makeClient(() => jsonResp(200, { truncated: true, tree: [] }));
    const [paths, truncated] = await client.getRecursiveTree({ ...BASE, treeSha: "x" });
    expect(paths).toEqual([]);
    expect(truncated).toBe(true);
  });

  it("missing tree key → empty paths", async () => {
    const client = makeClient(() => jsonResp(200, {}));
    const [paths, truncated] = await client.getRecursiveTree({ ...BASE, treeSha: "x" });
    expect(paths).toEqual([]);
    expect(truncated).toBe(false);
  });
});
