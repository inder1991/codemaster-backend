/**
 * Unit tests for the `fetchManifestSnapshots` activity — the 1:1 port of the frozen Python
 * `codemaster/activities/fetch_manifest_snapshots.py`.
 *
 * EVERY expected vector in this file was derived by RUNNING the frozen Python parser via its venv
 *   (vendor/codemaster-py/.venv/bin/python) on the exact same fixtures, then hardcoded here. Each such
 * literal is annotated `venv-cross-checked`.
 *
 * Coverage (mirrors every branch the Python has):
 *   PURE helpers
 *     - processContentBytes: SUCCESS / EMPTY / BINARY(NUL) / NUL-beyond-8KB / TOO_LARGE(ascii) /
 *       TOO_LARGE(multibyte-straddle, 4-byte rewind) / DECODE_FAILED(invalid utf-8) /
 *       BINARY-takes-precedence-over-large / sha256-over-original-bytes.
 *     - isLikelyBinary / utf8SafeTruncate.
 *     - selectInPriorityOrder: root-first, lockfile-last, nested, dedup, vendored/non-manifest dropped.
 *     - walkParentDirs.
 *     - resolveNearestManifests: nearest-enclosing, stop-at-first, already-seen-keeps-walking, excluded
 *       changed path skipped, empty.
 *     - NEAREST_WALK_BASENAMES set.
 *   ORCHESTRATION (stub GithubContentsPort)
 *     - mixed success / not_found / fetch_failed, nearest-walk surfacing a root manifest.
 *     - GitHubAppUnauthorized propagates.
 *     - budget cap (128 KB) drops the over-budget tail.
 *     - MAX_MANIFESTS (50) output cap.
 *     - tree-fetch failure / tree-truncated → nearest-walk degrades to no extra manifests.
 *     - empty candidate_paths → no tree call, empty output.
 *     - per-pod LRU cache: SUCCESS cached (2nd run no new call); NOT_FOUND not cached.
 */

import { describe, it, expect } from "vitest";

import {
  FetchManifestSnapshotsActivity,
  ManifestFetchCache,
  MAX_MANIFESTS,
  MAX_PER_MANIFEST_BYTES,
  MAX_TOTAL_MANIFEST_BYTES,
  NEAREST_WALK_BASENAMES,
  type GithubContentsPort,
  isLikelyBinary,
  processContentBytes,
  resolveNearestManifests,
  selectInPriorityOrder,
  utf8SafeTruncate,
  walkParentDirs,
} from "#backend/activities/fetch_manifest_snapshots.activity.js";
import { GitHubAppUnauthorized } from "#backend/integrations/github/api_client.js";

import type { FetchManifestSnapshotsInputV1 } from "#contracts/fetch_manifest_snapshots.v1.js";

const IID = "11111111-1111-1111-1111-111111111111";
const REPO = "22222222-2222-2222-2222-222222222222";
const SHA = "a".repeat(40);

function input(over: Partial<FetchManifestSnapshotsInputV1> = {}): FetchManifestSnapshotsInputV1 {
  return {
    schema_version: 1,
    installation_id: IID,
    github_installation_id: 999,
    repository_id: REPO,
    gh_owner: "acme",
    gh_repo_name: "ex",
    head_sha: SHA,
    candidate_paths: [],
    ...over,
  };
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// PURE — constants
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("match the Python caps", () => {
    // venv-cross-checked: caps 32768 128000 50
    expect(MAX_PER_MANIFEST_BYTES).toBe(32_768);
    expect(MAX_TOTAL_MANIFEST_BYTES).toBe(128_000);
    expect(MAX_MANIFESTS).toBe(50);
  });

  it("NEAREST_WALK_BASENAMES = 29 ASC-sorted exact basenames", () => {
    // venv-cross-checked: _NEAREST_WALK_BASENAMES (count 29, exact order below).
    expect([...NEAREST_WALK_BASENAMES]).toEqual([
      "Cargo.lock",
      "Cargo.toml",
      "Directory.Packages.props",
      "Dockerfile",
      "Gemfile",
      "Gemfile.lock",
      "MODULE.bazel",
      "Pipfile",
      "Pipfile.lock",
      "WORKSPACE",
      "build.gradle",
      "build.gradle.kts",
      "compose.yaml",
      "composer.json",
      "composer.lock",
      "docker-compose.yml",
      "go.mod",
      "go.sum",
      "mix.exs",
      "mix.lock",
      "package-lock.json",
      "package.json",
      "pnpm-lock.yaml",
      "poetry.lock",
      "pom.xml",
      "pyproject.toml",
      "requirements-dev.txt",
      "requirements.txt",
      "yarn.lock",
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// PURE — processContentBytes (all branches)
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("processContentBytes", () => {
  it("SUCCESS — small text", () => {
    const p = processContentBytes(utf8('{"name": "hi"}'));
    // venv-cross-checked: status=success ctype=text byte_length=14 truncated=False
    expect(p.fetchStatus).toBe("success");
    expect(p.contentType).toBe("text");
    expect(p.byteLength).toBe(14);
    expect(p.truncated).toBe(false);
    expect(p.rawBody).toBe('{"name": "hi"}');
    // venv-cross-checked: sha256 of b'{"name": "hi"}'
    expect(p.sha256).toBe("170b1fcbf420ecc7f2fb5007586ace8c195edf5ab3dd865f3586f64514cd3c32");
  });

  it("EMPTY body → SUCCESS, empty sha-of-empty", () => {
    const p = processContentBytes(new Uint8Array(0));
    // venv-cross-checked: status=success ctype=text byte_length=0 truncated=False
    expect(p.fetchStatus).toBe("success");
    expect(p.contentType).toBe("text");
    expect(p.byteLength).toBe(0);
    expect(p.rawBody).toBe("");
    // venv-cross-checked: SHA empty
    expect(p.sha256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("BINARY — NUL byte in first 8 KB → decode_failed / binary", () => {
    const p = processContentBytes(new Uint8Array([0x61, 0x62, 0x63, 0x00, 0x64, 0x65, 0x66]));
    // venv-cross-checked BINARY-real-NUL: status=decode_failed ctype=binary byte_length=7 truncated=False
    expect(p.fetchStatus).toBe("decode_failed");
    expect(p.contentType).toBe("binary");
    expect(p.byteLength).toBe(7);
    expect(p.rawBody).toBe("");
    // venv-cross-checked sha256 of b'abc\x00def'
    expect(p.sha256).toBe("516a5e926ce20c5f4d80f00e1a01abdf14986def6588d6abeed9fce090bc660c");
  });

  it("NUL just BEYOND the first 8 KB → NOT binary (SUCCESS)", () => {
    // NUL at index exactly 8192 — outside the data[:8*1024] sample (indices 0..8191).
    const data = new Uint8Array(8 * 1024 + 1 + 10);
    data.fill(0x61, 0, 8 * 1024); // 'a' * 8192
    data[8 * 1024] = 0x00; // NUL at index 8192
    data.fill(0x62, 8 * 1024 + 1); // 'b' * 10
    const p = processContentBytes(data);
    // venv-cross-checked NUL-beyond-8KB: status=success ctype=text byte_length=8203 truncated=False
    expect(p.fetchStatus).toBe("success");
    expect(p.contentType).toBe("text");
    expect(p.byteLength).toBe(8203);
    expect(p.truncated).toBe(false);
    expect(p.sha256).toBe("4344af52e103fe03e3a497cdc48dec8d3e5a9516330284c5b17eeaeb9df8399d");
  });

  it("TOO_LARGE — ascii body over 32 KB → too_large / truncated at 32768", () => {
    const big = new Uint8Array(MAX_PER_MANIFEST_BYTES + 100).fill(0x61); // 'a'*32868
    const p = processContentBytes(big);
    // venv-cross-checked TOO_LARGE ascii: status=too_large ctype=text byte_length=32868 truncated=True,
    // raw_body_len=32768.
    expect(p.fetchStatus).toBe("too_large");
    expect(p.contentType).toBe("text");
    expect(p.byteLength).toBe(32868);
    expect(p.truncated).toBe(true);
    expect(p.rawBody.length).toBe(32768);
    // venv-cross-checked: sha256 of the ORIGINAL 32868-byte buffer.
    expect(p.sha256).toBe("d04b4b198532ea18a81358a00661c982310da76e4309979e533cffdbd356b3de");
  });

  it("TOO_LARGE — 3-byte char straddling the cut → 4-byte rewind keeps 32767 codepoints", () => {
    // y*(MAX-1) + '€'(3 bytes, straddles MAX) + z*50. The euro's first byte lands at index MAX-1, so a
    // raw slice at MAX would split it; the rewind walks back to drop the partial euro entirely.
    const euro = utf8("€"); // 3 bytes: e2 82 ac
    const data = new Uint8Array(MAX_PER_MANIFEST_BYTES - 1 + euro.length + 50);
    data.fill(0x79, 0, MAX_PER_MANIFEST_BYTES - 1); // 'y' * (MAX-1)
    data.set(euro, MAX_PER_MANIFEST_BYTES - 1);
    data.fill(0x7a, MAX_PER_MANIFEST_BYTES - 1 + euro.length); // 'z' * 50
    const p = processContentBytes(data);
    // venv-cross-checked TOO_LARGE multibyte-straddle: status=too_large byte_length=32820 truncated=True,
    // raw_body_len=32767, last char 'y'.
    expect(p.fetchStatus).toBe("too_large");
    expect(p.byteLength).toBe(32820);
    expect(p.truncated).toBe(true);
    expect(p.rawBody.length).toBe(32767);
    expect(p.rawBody.at(-1)).toBe("y");
    expect(p.sha256).toBe("6491861325bcfb2e2c8e53639481d3833d0fd5805313e471588319b8e65448b4");
  });

  it("DECODE_FAILED — invalid UTF-8 within size → decode_failed / unknown", () => {
    const p = processContentBytes(new Uint8Array([0xff, 0xfe, 0x20, 0x68, 0x69])); // b'\xff\xfe hi'
    // venv-cross-checked DECODE-real-invalid: status=decode_failed ctype=unknown byte_length=5
    // truncated=False.
    expect(p.fetchStatus).toBe("decode_failed");
    expect(p.contentType).toBe("unknown");
    expect(p.byteLength).toBe(5);
    expect(p.rawBody).toBe("");
    expect(p.sha256).toBe("6c6a2776c8e63a220945e08aa1ca0c7da0ab60dbf921b01249f8fb0c67443fdf");
  });

  it("BINARY detection takes precedence over TOO_LARGE", () => {
    // 'a'*100 + NUL + 'b'*MAX — over the size cap, but the NUL in the first 8 KB wins.
    const data = new Uint8Array(100 + 1 + MAX_PER_MANIFEST_BYTES);
    data.fill(0x61, 0, 100);
    data[100] = 0x00;
    data.fill(0x62, 101);
    const p = processContentBytes(data);
    // venv-cross-checked BINARY-over-large: status=decode_failed ctype=binary byte_length=32869
    // truncated=False.
    expect(p.fetchStatus).toBe("decode_failed");
    expect(p.contentType).toBe("binary");
    expect(p.byteLength).toBe(32869);
    expect(p.truncated).toBe(false);
    expect(p.sha256).toBe("b2d88834f5e36e36178012df0ce69d600679a0c6498c6926a3ca958c06d4e3c2");
  });

  it("DECODE_FAILED — over-size body that is invalid UTF-8 at every rewind boundary", () => {
    // 0xff is never a valid UTF-8 byte, so all 4 rewind attempts fail → the Python fallback re-raises
    // UnicodeDecodeError → DECODE_FAILED / unknown (NOT too_large). Exercises the rewind-exhausted path.
    const data = new Uint8Array(MAX_PER_MANIFEST_BYTES + 10).fill(0xff);
    const p = processContentBytes(data);
    // venv-cross-checked all-0xff over-size: status=decode_failed ctype=unknown byte_length=32778.
    expect(p.fetchStatus).toBe("decode_failed");
    expect(p.contentType).toBe("unknown");
    expect(p.byteLength).toBe(32778);
    expect(p.truncated).toBe(false);
    expect(p.rawBody).toBe("");
    expect(p.sha256.slice(0, 12)).toBe("78a0fd672616");
  });

  it("SUCCESS — multibyte within size keeps the decoded codepoints", () => {
    const p = processContentBytes(utf8("€ test ✓"));
    // venv-cross-checked SUCCESS-multibyte: status=success ctype=text byte_length=12, raw_len=8.
    expect(p.fetchStatus).toBe("success");
    expect(p.byteLength).toBe(12);
    expect(p.rawBody.length).toBe(8);
    expect(p.rawBody).toBe("€ test ✓");
  });
});

describe("isLikelyBinary / utf8SafeTruncate", () => {
  it("isLikelyBinary detects NUL only in the first 8 KB", () => {
    expect(isLikelyBinary(new Uint8Array([1, 2, 0, 3]))).toBe(true);
    expect(isLikelyBinary(utf8("plain text"))).toBe(false);
    // Fill the whole buffer with a non-NUL byte first, then plant a single NUL JUST past the 8 KB sample
    // (index 8194). The sample is data[0..8191]; a NUL outside it must NOT trip the heuristic.
    const late = new Uint8Array(8 * 1024 + 5).fill(0x61);
    late[8 * 1024 + 2] = 0x00;
    expect(isLikelyBinary(late)).toBe(false);
  });

  it("utf8SafeTruncate returns [text, false] when it fits", () => {
    const [text, truncated] = utf8SafeTruncate(utf8("abc"), 10);
    expect(text).toBe("abc");
    expect(truncated).toBe(false);
  });

  it("utf8SafeTruncate rewinds off a multibyte boundary", () => {
    const data = utf8("ab€cd"); // a b (e2 82 ac) c d → cutting at 3 lands mid-euro
    const [text, truncated] = utf8SafeTruncate(data, 3);
    // 4-byte rewind drops the partial euro → "ab".
    expect(text).toBe("ab");
    expect(truncated).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// PURE — selectInPriorityOrder / walkParentDirs / resolveNearestManifests
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("selectInPriorityOrder", () => {
  it("root-first, lockfile-last, nested, dedup, vendored/non-manifest dropped", () => {
    const cands = selectInPriorityOrder([
      "package-lock.json",
      "package.json",
      "services/api/package.json",
      "services/api/yarn.lock",
      "go.mod",
      "vendor/foo/package.json", // Tier-3 excluded
      "src/main.py", // not a manifest
      "package.json", // dup
      "Cargo.toml",
      "sub/Cargo.lock",
    ]);
    // venv-cross-checked PRIORITY order + ecosystem + lockfile flags:
    expect(
      cands.map((c) => ({
        path: c.path,
        eco: c.pattern.ecosystem,
        lock: c.pattern.is_lockfile,
      })),
    ).toEqual([
      { path: "Cargo.toml", eco: "rust", lock: false },
      { path: "go.mod", eco: "go", lock: false },
      { path: "package.json", eco: "node", lock: false },
      { path: "package-lock.json", eco: "node", lock: true },
      { path: "services/api/package.json", eco: "node", lock: false },
      { path: "services/api/yarn.lock", eco: "node", lock: true },
      { path: "sub/Cargo.lock", eco: "rust", lock: true },
    ]);
  });

  it("empty input → empty", () => {
    expect(selectInPriorityOrder([])).toEqual([]);
  });
});

describe("walkParentDirs", () => {
  it("yields deepest-to-root parent dirs, root as empty string", () => {
    // venv-cross-checked WALK_PARENT_DIRS:
    expect(walkParentDirs("src/foo/bar.py")).toEqual(["src/foo", "src", ""]);
    expect(walkParentDirs("a.py")).toEqual([""]);
    expect(walkParentDirs("x/y/z/w.go")).toEqual(["x/y/z", "x/y", "x", ""]);
    expect(walkParentDirs("go.mod")).toEqual([""]);
  });
});

describe("resolveNearestManifests", () => {
  const tree = new Set([
    "package.json",
    "services/api/package.json",
    "services/api/src/handler.ts",
    "services/web/package.json",
    "vendor/x/package.json",
    "libs/util/Cargo.toml",
  ]);

  it("finds nearest enclosing manifest per changed path (ASC-sorted), skips excluded changed path", () => {
    const res = resolveNearestManifests({
      changedPaths: [
        "services/api/src/handler.ts",
        "services/web/index.ts",
        "libs/util/src/lib.rs",
        "vendor/x/y.js", // excluded changed path → skipped entirely
      ],
      repoTreePaths: tree,
      alreadySeen: new Set(),
    });
    // venv-cross-checked NEAREST 1:
    expect([...res]).toEqual([
      "libs/util/Cargo.toml",
      "services/api/package.json",
      "services/web/package.json",
    ]);
  });

  it("already-seen nearest dir does NOT stop the walk — keeps climbing to root", () => {
    const res = resolveNearestManifests({
      changedPaths: ["services/api/src/handler.ts"],
      repoTreePaths: tree,
      alreadySeen: new Set(["services/api/package.json"]),
    });
    // venv-cross-checked NEAREST 2: walks past the already-seen services/api/package.json to root.
    expect([...res]).toEqual(["package.json"]);
  });

  it("stops at the FIRST enclosing dir (does not keep walking to root)", () => {
    const res = resolveNearestManifests({
      changedPaths: ["a/b/c/d.ts"],
      repoTreePaths: new Set(["package.json", "a/b/package.json"]),
      alreadySeen: new Set(),
    });
    // venv-cross-checked NEAREST 3:
    expect([...res]).toEqual(["a/b/package.json"]);
  });

  it("changed path inside an excluded dir is skipped", () => {
    const res = resolveNearestManifests({
      changedPaths: ["vendor/x/y.js"],
      repoTreePaths: tree,
      alreadySeen: new Set(),
    });
    // venv-cross-checked NEAREST 4:
    expect([...res]).toEqual([]);
  });

  it("empty changed paths → empty", () => {
    // venv-cross-checked NEAREST 5:
    expect([
      ...resolveNearestManifests({
        changedPaths: [],
        repoTreePaths: new Set(),
        alreadySeen: new Set(),
      }),
    ]).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// ORCHESTRATION — stub GithubContentsPort
// ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * In-memory {@link GithubContentsPort}. `files` maps path → decoded blob bytes; `getContents` base64-
 * encodes them to ASCII bytes (exactly the Python `get_contents` return shape). `tree` drives
 * `getRecursiveTree`; set `treeRaises`/`treeTruncated` to exercise the nearest-walk fallbacks.
 */
class StubClient implements GithubContentsPort {
  public readonly contentCalls: Array<string> = [];
  public treeCalls = 0;

  public constructor(
    private readonly opts: {
      files?: Record<string, Uint8Array>;
      tree?: ReadonlyArray<string> | null;
      treeTruncated?: boolean;
      treeRaises?: boolean;
      failPaths?: ReadonlySet<string>;
      unauthPaths?: ReadonlySet<string>;
    } = {},
  ) {}

  public async getContents(args: {
    installationId: number;
    installationUuid: string;
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<readonly [Uint8Array, string] | null> {
    this.contentCalls.push(args.path);
    if (this.opts.unauthPaths?.has(args.path)) {
      throw new GitHubAppUnauthorized("nope");
    }
    if (this.opts.failPaths?.has(args.path)) {
      throw new Error("boom");
    }
    const blob = this.opts.files?.[args.path];
    if (blob === undefined) {
      return null;
    }
    // Mirror get_contents: return (content_b64.encode("ascii"), sha).
    const b64ascii = new Uint8Array(Buffer.from(Buffer.from(blob).toString("base64"), "ascii"));
    return [b64ascii, `blob:${args.path}`];
  }

  public async getRecursiveTree(args: {
    installationId: number;
    installationUuid: string;
    owner: string;
    repo: string;
    treeSha: string;
  }): Promise<readonly [ReadonlyArray<string>, boolean]> {
    void args; // satisfies the GithubContentsPort signature; the stub ignores the request shape.
    this.treeCalls += 1;
    if (this.opts.treeRaises) {
      throw new Error("tree boom");
    }
    const tree = this.opts.tree ?? [];
    return [[...tree].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), this.opts.treeTruncated ?? false];
  }
}

describe("fetchManifestSnapshots — orchestration", () => {
  it("mixed: success + not_found + fetch_failed, plus nearest-walk surfacing a root manifest", async () => {
    const client = new StubClient({
      files: { "package.json": utf8('{"name":"a"}'), "go.mod": utf8("module x") },
      tree: ["package.json", "go.mod", "requirements.txt"],
      failPaths: new Set(["Cargo.toml"]),
    });
    const act = new FetchManifestSnapshotsActivity({ githubClient: client, cache: new ManifestFetchCache() });
    const out = await act.fetchManifestSnapshots(
      input({ candidate_paths: ["package.json", "go.mod", "Cargo.toml", "yarn.lock"] }),
    );

    // venv-cross-checked CASE-mixed: 5 rows in this exact order; requirements.txt surfaced by the
    // nearest-walk (root-level changed paths walk up to the root tree). content_type for the
    // failure/not-found rows is the ManifestSnapshot default 'text'.
    expect(
      out.manifests.map((m) => ({
        path: m.path,
        status: m.fetch_status,
        eco: m.detected_ecosystem,
        ctype: m.content_type,
        blen: m.byte_length,
        trunc: m.truncated,
        bodyLen: m.raw_body.length,
        sha: m.sha256,
      })),
    ).toEqual([
      { path: "Cargo.toml", status: "fetch_failed", eco: "rust", ctype: "text", blen: 0, trunc: false, bodyLen: 0, sha: "" },
      {
        path: "go.mod",
        status: "success",
        eco: "go",
        ctype: "text",
        blen: 8,
        trunc: false,
        bodyLen: 8,
        // venv-cross-checked sha256 of b'module x'
        sha: "a509ab544d4261ce92b9f59abab36b08011aa15414635486816664e74c1b96b3",
      },
      {
        path: "package.json",
        status: "success",
        eco: "node",
        ctype: "text",
        blen: 12,
        trunc: false,
        bodyLen: 12,
        // venv-cross-checked sha256 of b'{"name":"a"}'
        sha: "d9d719b27480b55cd4918020e7473e716ed3569c8adafe926cf9b10b4f8ef064",
      },
      { path: "requirements.txt", status: "not_found", eco: "python", ctype: "text", blen: 0, trunc: false, bodyLen: 0, sha: "" },
      { path: "yarn.lock", status: "not_found", eco: "node", ctype: "text", blen: 0, trunc: false, bodyLen: 0, sha: "" },
    ]);
    // venv-cross-checked calls order:
    expect(client.contentCalls).toEqual(["Cargo.toml", "go.mod", "package.json", "requirements.txt", "yarn.lock"]);
  });

  it("GitHubAppUnauthorized propagates (does NOT degrade to a row)", async () => {
    const client = new StubClient({ files: {}, tree: [], unauthPaths: new Set(["package.json"]) });
    const act = new FetchManifestSnapshotsActivity({ githubClient: client, cache: new ManifestFetchCache() });
    await expect(
      act.fetchManifestSnapshots(input({ candidate_paths: ["package.json"] })),
    ).rejects.toBeInstanceOf(GitHubAppUnauthorized);
  });

  it("budget cap (128 KB) drops the over-budget tail", async () => {
    // 5 root manifests of 30000 bytes each. SUCCESS bodies are 30000 each (under per-manifest cap).
    // 30000*4 = 120000 ≤ 128000; the 5th (30000 more → 150000) exceeds → break. ASC sort order:
    // Cargo.toml, Pipfile, go.mod, package.json, pom.xml — pom.xml is the dropped 5th.
    const body = new Uint8Array(30000).fill(0x61);
    const paths = ["package.json", "go.mod", "Cargo.toml", "pom.xml", "Pipfile"];
    const files: Record<string, Uint8Array> = {};
    for (const p of paths) {
      files[p] = body;
    }
    const client = new StubClient({ files, treeRaises: true }); // tree fails → no nearest-walk noise
    const act = new FetchManifestSnapshotsActivity({ githubClient: client, cache: new ManifestFetchCache() });
    const out = await act.fetchManifestSnapshots(input({ candidate_paths: paths }));
    // venv-cross-checked 30KBx5 cap128KB → count 4: Cargo.toml, Pipfile, go.mod, package.json.
    expect(out.manifests.map((m) => m.path)).toEqual(["Cargo.toml", "Pipfile", "go.mod", "package.json"]);
    expect(out.manifests.every((m) => m.fetch_status === "success")).toBe(true);
  });

  it("MAX_MANIFESTS (50) caps the output", async () => {
    const paths = Array.from({ length: 51 }, (_, i) => `svc${String(i).padStart(2, "0")}/package.json`);
    const files: Record<string, Uint8Array> = {};
    for (const p of paths) {
      files[p] = utf8("{}");
    }
    const client = new StubClient({ files, treeRaises: true });
    const act = new FetchManifestSnapshotsActivity({ githubClient: client, cache: new ManifestFetchCache() });
    const out = await act.fetchManifestSnapshots(input({ candidate_paths: paths }));
    // venv-cross-checked MAX_MANIFESTS 51 → count 50 (first svc00/package.json, last svc49/package.json).
    expect(out.manifests.length).toBe(50);
    expect(out.manifests[0]?.path).toBe("svc00/package.json");
    expect(out.manifests[49]?.path).toBe("svc49/package.json");
  });

  it("tree-fetch failure → nearest-walk degrades to no extra manifests", async () => {
    const client = new StubClient({ files: { "package.json": utf8("{}") }, treeRaises: true });
    const act = new FetchManifestSnapshotsActivity({ githubClient: client, cache: new ManifestFetchCache() });
    const out = await act.fetchManifestSnapshots(input({ candidate_paths: ["package.json"] }));
    // venv-cross-checked TREE-RAISES fallback → count 1 (package.json success), 1 content call.
    expect(out.manifests.map((m) => [m.path, m.fetch_status])).toEqual([["package.json", "success"]]);
    expect(client.contentCalls).toEqual(["package.json"]);
  });

  it("tree-truncated → nearest-walk degrades to no extra manifests", async () => {
    const client = new StubClient({
      files: { "package.json": utf8("{}") },
      tree: ["package.json", "go.mod"],
      treeTruncated: true,
    });
    const act = new FetchManifestSnapshotsActivity({ githubClient: client, cache: new ManifestFetchCache() });
    const out = await act.fetchManifestSnapshots(input({ candidate_paths: ["package.json"] }));
    // venv-cross-checked TREE-TRUNCATED fallback → count 1; go.mod NOT surfaced.
    expect(out.manifests.map((m) => m.path)).toEqual(["package.json"]);
  });

  it("empty candidate_paths → no tree call, empty output", async () => {
    const client = new StubClient({ files: {}, tree: ["package.json"] });
    const act = new FetchManifestSnapshotsActivity({ githubClient: client, cache: new ManifestFetchCache() });
    const out = await act.fetchManifestSnapshots(input({ candidate_paths: [] }));
    // venv-cross-checked EMPTY candidates → count 0, tree NOT called.
    expect(out.manifests).toEqual([]);
    expect(client.treeCalls).toBe(0);
    expect(client.contentCalls).toEqual([]);
  });
});

describe("fetchManifestSnapshots — per-pod LRU cache", () => {
  it("SUCCESS is cached: a 2nd run with the same cache makes no new GitHub call", async () => {
    const cache = new ManifestFetchCache();
    const client = new StubClient({ files: { "package.json": utf8("{}") }, tree: [] });
    const act = new FetchManifestSnapshotsActivity({ githubClient: client, cache });

    await act.fetchManifestSnapshots(input({ candidate_paths: ["package.json"] }));
    // venv-cross-checked: after run1 calls=['package.json'], hits=0 misses=1 size=1.
    expect(client.contentCalls).toEqual(["package.json"]);
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(1);
    expect(cache.size).toBe(1);

    await act.fetchManifestSnapshots(input({ candidate_paths: ["package.json"] }));
    // venv-cross-checked: after run2 calls UNCHANGED (cache hit), hits=1 misses=1.
    expect(client.contentCalls).toEqual(["package.json"]);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it("NOT_FOUND is not cached: a 2nd run re-fetches", async () => {
    const cache = new ManifestFetchCache();
    const client = new StubClient({ files: {}, tree: [] });
    const act = new FetchManifestSnapshotsActivity({ githubClient: client, cache });

    await act.fetchManifestSnapshots(input({ candidate_paths: ["go.mod"] }));
    await act.fetchManifestSnapshots(input({ candidate_paths: ["go.mod"] }));
    // venv-cross-checked NOT_FOUND not cached → calls ['go.mod','go.mod'], size 0.
    expect(client.contentCalls).toEqual(["go.mod", "go.mod"]);
    expect(cache.size).toBe(0);
  });
});
