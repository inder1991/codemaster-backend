import { afterAll, describe, expect, it } from "vitest";

import { pyEnforceTokenBudget, pyEstimateTokens, shutdownPostPassRef } from "./post_pass_oracle.js";
import { enforceTokenBudget, estimateTokens, MAX_CHUNK_TOKENS } from "#backend/chunking/token_budget.js";
import { computeChunkId, DiffChunkV1 } from "#contracts/diff_chunking.v1.js";

// Golden parity for the token-budget post-pass against the frozen Python
// (token_budget.estimate_tokens + token_budget.enforce_token_budget) via run_post_pass_ref.py.
//
// Two surfaces:
//   1. estimateTokens — the R-18 non-ASCII safety factor. Probes the ASCII path, the 100%-non-ASCII
//      path, AND the exact 10% boundary (factor stays 1.0 at == 10%, flips to 2.5 ABOVE 10%) plus the
//      int(len/4 * factor) FLOAT-then-truncate arithmetic (NOT integer division). Each value is
//      asserted equal to the frozen Python.
//   2. enforceTokenBudget — the deterministic line-midpoint split. chunk_id parity is the strongest
//      single proof (it folds path + span + sha256(body)), so a full-list match implies every split
//      body + (left_end, right_start) line number is byte-identical to the frozen Python.

afterAll(() => shutdownPostPassRef());

/** Build a TS DiffChunkV1 with a content-addressable chunk_id (the same shape the chunkers mint). */
function chunk(args: {
  path: string;
  language: string | null;
  start_line: number;
  end_line: number;
  body: string;
  chunk_kind: "function" | "class" | "module" | "hunk" | "batch";
  token_estimate: number;
}): DiffChunkV1 {
  return DiffChunkV1.parse({
    chunk_id: computeChunkId({
      path: args.path,
      start_line: args.start_line,
      end_line: args.end_line,
      body: args.body,
    }),
    ...args,
  });
}

/** Strip a TS DiffChunkV1 to the plain shape the Python ref emits (model_dump). */
function toPlain(c: DiffChunkV1): {
  schema_version: number;
  chunk_id: string;
  path: string;
  language: string | null;
  start_line: number;
  end_line: number;
  body: string;
  chunk_kind: string;
  token_estimate: number;
} {
  return {
    schema_version: c.schema_version,
    chunk_id: c.chunk_id,
    path: c.path,
    language: c.language,
    start_line: c.start_line,
    end_line: c.end_line,
    body: c.body,
    chunk_kind: c.chunk_kind,
    token_estimate: c.token_estimate,
  };
}

describe("estimateTokens parity — R-18 non-ASCII safety factor", () => {
  const cases: Array<{ name: string; body: string }> = [
    { name: "empty → 1", body: "" },
    { name: "pure ASCII (100 chars)", body: "a".repeat(100) },
    { name: "single char", body: "x" },
    { name: "100% non-ASCII (hiragana)", body: "あ".repeat(100) },
    { name: "exactly 10% non-ASCII → factor 1.0", body: "a".repeat(90) + "あ".repeat(10) },
    { name: "11% non-ASCII → factor 2.5", body: "a".repeat(89) + "あ".repeat(11) },
    { name: "sparse emoji below threshold", body: "a".repeat(99) + "\u{1F600}" },
    { name: "cyrillic heavy", body: "д".repeat(40) + "a".repeat(10) },
    { name: "odd length truncation", body: "a".repeat(7) },
  ];
  for (const { name, body } of cases) {
    it(`is equal: ${name}`, async () => {
      expect(estimateTokens(body)).toBe(await pyEstimateTokens(body));
    }, 30_000);
  }
});

describe("enforceTokenBudget parity — deterministic midpoint split", () => {
  /** Run BOTH through the post-pass on identical inputs + max_tokens; assert byte-parity of the list. */
  async function assertBudgetParity(
    chunks: ReadonlyArray<DiffChunkV1>,
    maxTokens: number,
  ): Promise<void> {
    const ts = enforceTokenBudget(chunks, { maxTokens }).map(toPlain);
    const py = await pyEnforceTokenBudget(chunks.map(toPlain), maxTokens);
    expect(ts, `max_tokens=${maxTokens}`).toEqual(py);
  }

  it("passes already-fitting chunks through unchanged (identity)", async () => {
    const c = chunk({
      path: "a.py",
      language: "python",
      start_line: 1,
      end_line: 2,
      body: "x = 1\ny = 2\n",
      chunk_kind: "module",
      token_estimate: 3,
    });
    // identity preserved on the TS side
    expect(enforceTokenBudget([c], { maxTokens: 6000 })[0]).toBe(c);
    await assertBudgetParity([c], 6000);
  }, 30_000);

  it("splits an 8-line oversized chunk at the line midpoint (mid=4)", async () => {
    const body = Array.from({ length: 8 }, (_, i) => `line${i} ${"x".repeat(36)}\n`).join("");
    const c = chunk({
      path: "big.py",
      language: "python",
      start_line: 10,
      end_line: 17,
      body,
      chunk_kind: "module",
      token_estimate: 7000,
    });
    await assertBudgetParity([c], 50);
  }, 30_000);

  it("recursively splits until every sub-chunk fits (16 lines, tiny budget)", async () => {
    const body = Array.from({ length: 16 }, (_, i) => `line ${i} ${"y".repeat(20)}\n`).join("");
    const c = chunk({
      path: "huge.py",
      language: "python",
      start_line: 1,
      end_line: 16,
      body,
      chunk_kind: "module",
      token_estimate: 9000,
    });
    await assertBudgetParity([c], 30);
  }, 30_000);

  it("returns a single-line oversized chunk UNCHANGED (can't split)", async () => {
    const body = "z".repeat(40000) + "\n";
    const c = chunk({
      path: "oneline.py",
      language: "python",
      start_line: 5,
      end_line: 5,
      body,
      chunk_kind: "module",
      token_estimate: 10000,
    });
    expect(enforceTokenBudget([c], { maxTokens: 6000 })[0]).toBe(c);
    await assertBudgetParity([c], 6000);
  }, 30_000);

  it("preserves ordering across a mix of fitting + oversized chunks", async () => {
    const small = chunk({
      path: "s.py",
      language: "python",
      start_line: 1,
      end_line: 1,
      body: "a\n",
      chunk_kind: "module",
      token_estimate: 1,
    });
    const bigBody = Array.from({ length: 6 }, (_, i) => `b${i} ${"q".repeat(30)}\n`).join("");
    const big = chunk({
      path: "b.py",
      language: "python",
      start_line: 1,
      end_line: 6,
      body: bigBody,
      chunk_kind: "module",
      token_estimate: 8000,
    });
    const tail = chunk({
      path: "t.py",
      language: "python",
      start_line: 1,
      end_line: 1,
      body: "c\n",
      chunk_kind: "module",
      token_estimate: 1,
    });
    await assertBudgetParity([small, big, tail], 40);
  }, 30_000);

  it("rejects a non-positive max_tokens (parity of the ValueError → RangeError)", () => {
    expect(() => enforceTokenBudget([], { maxTokens: 0 })).toThrow();
  });

  it("uses MAX_CHUNK_TOKENS as the default budget", () => {
    expect(MAX_CHUNK_TOKENS).toBe(6000);
  });
});
