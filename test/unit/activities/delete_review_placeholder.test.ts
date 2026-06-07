/**
 * Unit coverage of `delete_review_placeholder` (1:1 with the frozen Python
 * `tests/unit/activities/test_delete_review_placeholder.py`). Drives the pure {@link doDeletePlaceholder}
 * with a scripted stub GitHub issue-comment client + a spy/throwing audit-emit callback, so NO live GitHub
 * and NO live DB are touched.
 *
 * Mirrors the Python cases:
 *   - no-op when no marker matches, and when the PR has no comments.
 *   - DELETE the single matching comment (right comment_id / owner / repo) + audit emit.
 *   - DELETE EVERY matching comment (Temporal-retry defensive multi-delete).
 *   - null-body comments are skipped by the marker filter.
 *   - best-effort swallow: a list failure → no delete; a delete failure on the FIRST match → the SECOND
 *     match is still attempted; an audit-emit failure → swallowed (DELETE already landed).
 *   - the marker is byte-identical to the placeholder marker (lockstep pin).
 *   - the input contract rejects extra fields and pins schema_version to 1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  doDeletePlaceholder,
  markerForDeletePlaceholder,
  type DeletePlaceholderAuditEmit,
  type DeletePlaceholderDeps,
  type GhIssueCommentDeleteClient,
} from "#backend/activities/delete_review_placeholder.activity.js";
import { markerForPlaceholder } from "#backend/activities/post_review_placeholder.activity.js";

import { DeleteReviewPlaceholderInput } from "#contracts/delete_review_placeholder_input.v1.js";

const PR_ID = "11111111-1111-1111-1111-111111111111";
const RUN_ID = "22222222-2222-2222-2222-222222222222";
const REVIEW_ID = "33333333-3333-3333-3333-333333333333";
const INSTALLATION_ID = "44444444-4444-4444-4444-444444444444";

function makeInput(
  overrides: Partial<DeleteReviewPlaceholderInput> = {},
): DeleteReviewPlaceholderInput {
  return DeleteReviewPlaceholderInput.parse({
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
  listThrows?: Error;
  /** Per-call delete outcomes in order: undefined → success, Error → that delete throws. */
  deleteOutcomes?: Array<Error | undefined>;
  deleteThrows?: Error;
};

type StubCalls = {
  list: number;
  delete: Array<{ owner: string; repo: string; commentId: number }>;
};

function makeStub(args: StubArgs): { client: GhIssueCommentDeleteClient; calls: StubCalls } {
  const calls: StubCalls = { list: 0, delete: [] };
  const outcomes = [...(args.deleteOutcomes ?? [])];
  const client: GhIssueCommentDeleteClient = {
    async listIssueComments() {
      calls.list += 1;
      if (args.listThrows !== undefined) {
        throw args.listThrows;
      }
      return args.listReturns ?? [];
    },
    async deleteIssueComment({ owner, repo, commentId }) {
      calls.delete.push({ owner, repo, commentId });
      if (args.deleteThrows !== undefined) {
        throw args.deleteThrows;
      }
      const outcome = outcomes.shift();
      if (outcome instanceof Error) {
        throw outcome;
      }
    },
  };
  return { client, calls };
}

function makeEmit(throws?: Error): {
  emit: DeletePlaceholderAuditEmit;
  calls: Array<{ githubCommentId: number }>;
} {
  const calls: Array<{ githubCommentId: number }> = [];
  const emit: DeletePlaceholderAuditEmit = async (a) => {
    calls.push({ githubCommentId: a.githubCommentId });
    if (throws !== undefined) {
      throw throws;
    }
  };
  return { emit, calls };
}

function makeDeps(stub: StubArgs, emitThrows?: Error): {
  deps: DeletePlaceholderDeps;
  calls: StubCalls;
  emitCalls: Array<{ githubCommentId: number }>;
} {
  const { client, calls } = makeStub(stub);
  const { emit, calls: emitCalls } = makeEmit(emitThrows);
  return { deps: { ghClient: client, emitEvent: emit }, calls, emitCalls };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  debugSpy.mockRestore();
});

// ─── no-op paths ───────────────────────────────────────────────────────────────────────────────────

describe("doDeletePlaceholder no-op", () => {
  it("no-ops when no comment carries the marker", async () => {
    const { deps, calls } = makeDeps({
      listReturns: [
        { id: 1, body: "ci passed" },
        { id: 2, body: "lgtm" },
      ],
    });

    await doDeletePlaceholder(makeInput(), deps);

    expect(calls.delete).toHaveLength(0);
  });

  it("no-ops when the PR has no comments", async () => {
    const { deps, calls } = makeDeps({ listReturns: [] });

    await doDeletePlaceholder(makeInput(), deps);

    expect(calls.delete).toHaveLength(0);
  });
});

// ─── delete paths ──────────────────────────────────────────────────────────────────────────────────

describe("doDeletePlaceholder delete", () => {
  it("deletes the single matching comment + emits the audit event", async () => {
    const marker = markerForDeletePlaceholder(PR_ID);
    const { deps, calls, emitCalls } = makeDeps({
      listReturns: [
        { id: 1, body: "ci passed" },
        { id: 8675309, body: `🤖 reviewing...\n${marker}` },
      ],
    });

    await doDeletePlaceholder(makeInput(), deps);

    expect(calls.delete).toHaveLength(1);
    expect(calls.delete[0]).toEqual({ owner: "test-org", repo: "test-repo", commentId: 8675309 });
    expect(emitCalls).toEqual([{ githubCommentId: 8675309 }]);
  });

  it("deletes EVERY matching comment (Temporal-retry defensive multi-delete)", async () => {
    const marker = markerForDeletePlaceholder(PR_ID);
    const { deps, calls } = makeDeps({
      listReturns: [
        { id: 100, body: `first placeholder\n${marker}` },
        { id: 101, body: "unrelated" },
        { id: 102, body: `second placeholder\n${marker}` },
      ],
    });

    await doDeletePlaceholder(makeInput(), deps);

    expect(calls.delete).toHaveLength(2);
    expect(new Set(calls.delete.map((d) => d.commentId))).toEqual(new Set([100, 102]));
  });

  it("skips null-body comments in the marker filter", async () => {
    const marker = markerForDeletePlaceholder(PR_ID);
    const { deps, calls } = makeDeps({
      listReturns: [
        { id: 1, body: null },
        { id: 2, body: `match\n${marker}` },
      ],
    });

    await doDeletePlaceholder(makeInput(), deps);

    expect(calls.delete).toHaveLength(1);
    expect(calls.delete[0]!.commentId).toBe(2);
  });

  // ─── best-effort swallow ─────────────────────────────────────────────────────────────────────

  it("swallows a list failure (no delete, no raise, logs list_failed)", async () => {
    const { deps, calls } = makeDeps({ listThrows: new Error("github 500") });

    await expect(doDeletePlaceholder(makeInput(), deps)).resolves.toBeUndefined();

    expect(calls.delete).toHaveLength(0);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("list_failed"))).toBe(true);
  });

  it("continues to the next match when the first delete fails", async () => {
    const marker = markerForDeletePlaceholder(PR_ID);
    const { deps, calls, emitCalls } = makeDeps({
      listReturns: [
        { id: 100, body: marker },
        { id: 102, body: marker },
      ],
      // First delete throws; second succeeds.
      deleteOutcomes: [new Error("github 500"), undefined],
    });

    await doDeletePlaceholder(makeInput(), deps);

    expect(calls.delete).toHaveLength(2);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("delete_failed"))).toBe(true);
    // Only the successful delete (102) emitted an audit event.
    expect(emitCalls).toEqual([{ githubCommentId: 102 }]);
  });

  it("swallows an audit-emit failure (DELETE already landed; logs audit_emit_failed)", async () => {
    const marker = markerForDeletePlaceholder(PR_ID);
    const { deps, calls } = makeDeps({ listReturns: [{ id: 100, body: marker }] }, new Error("db down"));

    await expect(doDeletePlaceholder(makeInput(), deps)).resolves.toBeUndefined();

    expect(calls.delete).toHaveLength(1);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("audit_emit_failed"))).toBe(true);
  });
});

// ─── marker lockstep + input contract ───────────────────────────────────────────────────────────────

describe("delete marker + contract", () => {
  it("marker is byte-identical to the placeholder marker (lockstep)", () => {
    // Both are duplicated locally (no import cycle); this pins them so neither can drift.
    expect(markerForDeletePlaceholder(PR_ID)).toBe(markerForPlaceholder(PR_ID));
  });

  it("rejects extra fields (.strict)", () => {
    expect(() =>
      DeleteReviewPlaceholderInput.parse({
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
      DeleteReviewPlaceholderInput.parse({
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
});
