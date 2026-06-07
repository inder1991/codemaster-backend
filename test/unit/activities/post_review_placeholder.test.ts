/**
 * Unit coverage of `post_review_placeholder` (1:1 with the frozen Python
 * `tests/unit/activities/test_post_review_placeholder.py`). Drives the pure {@link doPostPlaceholder} with
 * a scripted stub GitHub issue-comment client + a spy/throwing audit-emit callback (the TS analogue of the
 * Python `_stub_gh_client` + `_stub_session_factory`), so NO live GitHub and NO live DB are touched.
 *
 * Mirrors the Python cases:
 *   - marker format + DISTINCTNESS from the review marker (neither a substring of the other).
 *   - placeholder body embeds the marker + the human-readable strings.
 *   - happy path: no existing marker → list + POST, with the right owner/repo/pr_number/body.
 *   - unrelated comments (incl. a null body) do NOT short-circuit the POST.
 *   - idempotency: an existing comment carrying our marker → skip the POST.
 *   - best-effort swallow: a list failure, a post failure, and an audit-emit failure each return without
 *     raising (and the post-failure path never reaches the audit emit).
 *   - the input contract rejects extra fields and pins schema_version to 1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  doPostPlaceholder,
  markerForPlaceholder,
  placeholderBody,
  type GhIssueCommentPostClient,
  type PlaceholderAuditEmit,
  type PostPlaceholderDeps,
} from "#backend/activities/post_review_placeholder.activity.js";
import { markerFor as reviewMarker } from "#backend/activities/post_review_results.activity.js";

import { PostReviewPlaceholderInput } from "#contracts/post_review_placeholder_input.v1.js";

const PR_ID = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";
const REVIEW_ID = "33333333-3333-3333-3333-333333333333";
const INSTALLATION_ID = "44444444-4444-4444-4444-444444444444";

function makeInput(overrides: Partial<PostReviewPlaceholderInput> = {}): PostReviewPlaceholderInput {
  return PostReviewPlaceholderInput.parse({
    pr_id: PR_ID,
    run_id: RUN_ID,
    review_id: REVIEW_ID,
    installation_id: INSTALLATION_ID,
    owner: "test-org",
    repo_name: "test-repo",
    pr_number: 42,
    ...overrides,
  });
}

type StubArgs = {
  listReturns?: Array<Record<string, unknown>>;
  createReturns?: number;
  listThrows?: Error;
  createThrows?: Error;
};

type StubCalls = {
  list: Array<{ owner: string; repo: string; prNumber: number }>;
  create: Array<{ owner: string; repo: string; prNumber: number; body: string }>;
};

function makeStub(args: StubArgs): { client: GhIssueCommentPostClient; calls: StubCalls } {
  const calls: StubCalls = { list: [], create: [] };
  const client: GhIssueCommentPostClient = {
    async listIssueComments({ owner, repo, prNumber }) {
      calls.list.push({ owner, repo, prNumber });
      if (args.listThrows !== undefined) {
        throw args.listThrows;
      }
      return args.listReturns ?? [];
    },
    async createIssueComment({ owner, repo, prNumber, body }) {
      calls.create.push({ owner, repo, prNumber, body });
      if (args.createThrows !== undefined) {
        throw args.createThrows;
      }
      return args.createReturns ?? 9999;
    },
  };
  return { client, calls };
}

/** A spy audit-emit that records its calls; or throws when `throws` is set (the swallow-path driver). */
function makeEmit(throws?: Error): {
  emit: PlaceholderAuditEmit;
  calls: Array<{ githubCommentId: number; prId: string }>;
} {
  const calls: Array<{ githubCommentId: number; prId: string }> = [];
  const emit: PlaceholderAuditEmit = async (a) => {
    calls.push({ githubCommentId: a.githubCommentId, prId: a.prId });
    if (throws !== undefined) {
      throw throws;
    }
  };
  return { emit, calls };
}

function makeDeps(stub: StubArgs, emitThrows?: Error): {
  deps: PostPlaceholderDeps;
  calls: StubCalls;
  emitCalls: Array<{ githubCommentId: number; prId: string }>;
} {
  const { client, calls } = makeStub(stub);
  const { emit, calls: emitCalls } = makeEmit(emitThrows);
  return { deps: { ghClient: client, emitEvent: emit }, calls, emitCalls };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  infoSpy.mockRestore();
  debugSpy.mockRestore();
});

// ─── marker shape + distinctness ─────────────────────────────────────────────────────────────────

describe("placeholder marker", () => {
  it("renders the exact marker format", () => {
    expect(markerForPlaceholder(PR_ID)).toBe(
      "<!-- codemaster:placeholder-marker:11111111-1111-1111-1111-111111111111 -->",
    );
  });

  it("is distinct from the review marker (neither a substring of the other)", () => {
    // Critical invariant: the two surfaces (issue comment vs review) are addressed by distinct markers so
    // neither cleanup can accidentally target the other.
    expect(markerForPlaceholder(PR_ID)).not.toBe(reviewMarker(PR_ID));
    expect(markerForPlaceholder(PR_ID).includes(reviewMarker(PR_ID))).toBe(false);
    expect(reviewMarker(PR_ID).includes(markerForPlaceholder(PR_ID))).toBe(false);
  });

  it("embeds the marker + the human-readable strings in the body", () => {
    const body = placeholderBody(PR_ID);
    expect(body.includes(markerForPlaceholder(PR_ID))).toBe(true);
    expect(body.includes("codemaster review")).toBe(true);
    expect(body.includes("reviewing this PR")).toBe(true);
  });
});

// ─── happy path ──────────────────────────────────────────────────────────────────────────────────

describe("doPostPlaceholder", () => {
  it("posts the placeholder when no existing marker comment is present", async () => {
    const { deps, calls, emitCalls } = makeDeps({ listReturns: [], createReturns: 8675309 });

    await doPostPlaceholder(makeInput(), deps);

    expect(calls.list).toHaveLength(1);
    expect(calls.list[0]).toEqual({ owner: "test-org", repo: "test-repo", prNumber: 42 });

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]!.owner).toBe("test-org");
    expect(calls.create[0]!.repo).toBe("test-repo");
    expect(calls.create[0]!.prNumber).toBe(42);
    expect(calls.create[0]!.body.includes(markerForPlaceholder(PR_ID))).toBe(true);

    // Audit emit carried the created comment id.
    expect(emitCalls).toEqual([{ githubCommentId: 8675309, prId: PR_ID }]);
  });

  it("ignores unrelated comments (including null bodies) and still posts", async () => {
    const { deps, calls } = makeDeps({
      listReturns: [
        { id: 1, body: "lgtm" },
        { id: 2, body: "CI passed" },
        { id: 3, body: null },
      ],
      createReturns: 8675309,
    });

    await doPostPlaceholder(makeInput(), deps);

    expect(calls.create).toHaveLength(1);
  });

  it("skips the POST when a comment already carries our marker (Temporal-retry idempotency)", async () => {
    const marker = markerForPlaceholder(PR_ID);
    const { deps, calls, emitCalls } = makeDeps({
      listReturns: [
        { id: 1, body: "ci passed" },
        { id: 2, body: `🤖 reviewing...\n${marker}` },
      ],
    });

    await doPostPlaceholder(makeInput(), deps);

    expect(calls.list).toHaveLength(1);
    expect(calls.create).toHaveLength(0);
    expect(emitCalls).toHaveLength(0);
  });

  // ─── best-effort swallow ─────────────────────────────────────────────────────────────────────

  it("swallows a list failure (no POST, no raise, logs list_failed)", async () => {
    const { deps, calls } = makeDeps({ listThrows: new Error("github 500") });

    await expect(doPostPlaceholder(makeInput(), deps)).resolves.toBeUndefined();

    expect(calls.create).toHaveLength(0);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("list_failed"))).toBe(true);
  });

  it("swallows a post failure (no audit emit, no raise, logs post_failed)", async () => {
    const { deps, emitCalls } = makeDeps({
      listReturns: [],
      createThrows: new Error("github 502"),
    });

    await expect(doPostPlaceholder(makeInput(), deps)).resolves.toBeUndefined();

    expect(emitCalls).toHaveLength(0);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("post_failed"))).toBe(true);
  });

  it("swallows an audit-emit failure (POST already landed; logs audit_emit_failed)", async () => {
    const { deps, calls } = makeDeps(
      { listReturns: [], createReturns: 8675309 },
      new Error("db down"),
    );

    await expect(doPostPlaceholder(makeInput(), deps)).resolves.toBeUndefined();

    expect(calls.create).toHaveLength(1);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("audit_emit_failed"))).toBe(true);
  });
});

// ─── input contract ───────────────────────────────────────────────────────────────────────────────

describe("PostReviewPlaceholderInput contract", () => {
  it("rejects extra fields (.strict)", () => {
    expect(() =>
      PostReviewPlaceholderInput.parse({
        pr_id: PR_ID,
        run_id: RUN_ID,
        review_id: REVIEW_ID,
        installation_id: INSTALLATION_ID,
        owner: "o",
        repo_name: "r",
        pr_number: 1,
        mystery_field: "???",
      }),
    ).toThrow();
  });

  it("pins schema_version to 1", () => {
    expect(() =>
      PostReviewPlaceholderInput.parse({
        schema_version: 2,
        pr_id: PR_ID,
        run_id: RUN_ID,
        review_id: REVIEW_ID,
        installation_id: INSTALLATION_ID,
        owner: "o",
        repo_name: "r",
        pr_number: 1,
      }),
    ).toThrow();
  });

  it("defaults schema_version to 1 when omitted", () => {
    const parsed = PostReviewPlaceholderInput.parse({
      pr_id: PR_ID,
      run_id: RUN_ID,
      review_id: REVIEW_ID,
      installation_id: INSTALLATION_ID,
      owner: "o",
      repo_name: "r",
      pr_number: 1,
    });
    expect(parsed.schema_version).toBe(1);
  });
});
