import { afterAll, describe, expect, it } from "vitest";

import { pyBatchAdjacent, shutdownPostPassRef } from "./post_pass_oracle.js";
import { batchAdjacent, BATCH_TOKEN_BUDGET } from "#backend/chunking/batcher.js";
import { computeChunkId, DiffChunkV1 } from "#contracts/diff_chunking.v1.js";

// Golden parity for the adjacent-file batching post-pass against the frozen Python
// (batcher.batch_adjacent) via run_post_pass_ref.py. Each case runs identical (chunks, budget_tokens)
// through BOTH and asserts byte-parity of the resulting DiffChunkV1 list. chunk_id parity is the
// strongest single proof — the batch chunk's id folds the rendered batch path + 1 + n_lines +
// sha256(separator-joined body), so an id match implies the body separators, the `<dir>/[<n> files]`
// path, and the n_lines = body.count("\n") count are all byte-identical.

afterAll(() => shutdownPostPassRef());

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

/** Run BOTH through batch_adjacent on identical inputs + budget; assert byte-parity of the list. */
async function assertBatchParity(
  chunks: ReadonlyArray<DiffChunkV1>,
  budgetTokens: number,
): Promise<void> {
  const ts = batchAdjacent(chunks, { budgetTokens }).map(toPlain);
  const py = await pyBatchAdjacent(chunks.map(toPlain), budgetTokens);
  expect(ts, `budget=${budgetTokens}`).toEqual(py);
}

/** A tiny per-file chunk in `dir`, one line of `body`. */
function fileChunk(dir: string, name: string, language: string | null, tokens: number): DiffChunkV1 {
  const path = dir === "" ? name : `${dir}/${name}`;
  return chunk({
    path,
    language,
    start_line: 1,
    end_line: 1,
    body: `content of ${name}\n`,
    chunk_kind: "module",
    token_estimate: tokens,
  });
}

describe("batchAdjacent parity — multi-file grouping", () => {
  it("returns the SAME reference for <2 chunks (no batching)", async () => {
    const c = [fileChunk("cfg", "a.yaml", "yaml", 5)];
    expect(batchAdjacent(c)).not.toBe(c); // TS returns a copy (spread), but value-equal
    expect(batchAdjacent(c).map(toPlain)).toEqual(await pyBatchAdjacent(c.map(toPlain), 2000));
  }, 30_000);

  it("collapses 5 adjacent same-dir chunks into ONE batch under budget", async () => {
    const chunks = ["a.yaml", "b.yaml", "c.yaml", "d.yaml", "e.yaml"].map((n) =>
      fileChunk("cfg", n, "yaml", 50),
    );
    await assertBatchParity(chunks, 2000);
    // sanity: TS produces a single batch chunk with the rendered path.
    const out = batchAdjacent(chunks, { budgetTokens: 2000 });
    expect(out.length).toBe(1);
    expect(out[0]!.chunk_kind).toBe("batch");
    expect(out[0]!.path).toBe("cfg/[5 files]");
  }, 30_000);

  it("breaks the run when the directory changes", async () => {
    const chunks = [
      fileChunk("a", "1.yaml", "yaml", 10),
      fileChunk("a", "2.yaml", "yaml", 10),
      fileChunk("b", "3.yaml", "yaml", 10),
      fileChunk("b", "4.yaml", "yaml", 10),
    ];
    await assertBatchParity(chunks, 2000);
  }, 30_000);

  it("breaks the run when adding the next chunk would exceed the budget", async () => {
    const chunks = [
      fileChunk("d", "1.yaml", "yaml", 600),
      fileChunk("d", "2.yaml", "yaml", 600),
      fileChunk("d", "3.yaml", "yaml", 600),
      fileChunk("d", "4.yaml", "yaml", 600),
    ];
    // budget 1500 → [1,2] (1200) then 3 would push to 1800 > 1500 → flush; [3,4] (1200).
    await assertBatchParity(chunks, 1500);
  }, 30_000);

  it("keeps single-file groups UNCHANGED (n=1 never batches)", async () => {
    const chunks = [
      fileChunk("a", "solo.yaml", "yaml", 10),
      fileChunk("b", "solo2.yaml", "yaml", 10),
      fileChunk("c", "solo3.yaml", "yaml", 10),
    ];
    await assertBatchParity(chunks, 2000);
  }, 30_000);

  it("does NOT nest a pre-existing batch chunk (flush + passthrough)", async () => {
    const pre = chunk({
      path: "x/[3 files]",
      language: null,
      start_line: 1,
      end_line: 5,
      body: "--- x/a:1-1 ---\na\n--- x/b:1-1 ---\nb\n--- x/c:1-1 ---\nc\n",
      chunk_kind: "batch",
      token_estimate: 30,
    });
    const chunks = [
      fileChunk("x", "1.yaml", "yaml", 10),
      fileChunk("x", "2.yaml", "yaml", 10),
      pre,
      fileChunk("x", "3.yaml", "yaml", 10),
      fileChunk("x", "4.yaml", "yaml", 10),
    ];
    await assertBatchParity(chunks, 2000);
  }, 30_000);

  it("renders a null language when the group mixes languages", async () => {
    const chunks = [
      fileChunk("mix", "a.yaml", "yaml", 10),
      fileChunk("mix", "b.json", "json", 10),
    ];
    await assertBatchParity(chunks, 2000);
    const out = batchAdjacent(chunks, { budgetTokens: 2000 });
    expect(out[0]!.language).toBeNull();
  }, 30_000);

  it("uses '.' as the dirname for root-level files", async () => {
    const chunks = [
      fileChunk("", "a.yaml", "yaml", 10),
      fileChunk("", "b.yaml", "yaml", 10),
    ];
    await assertBatchParity(chunks, 2000);
    const out = batchAdjacent(chunks, { budgetTokens: 2000 });
    expect(out[0]!.path).toBe("./[2 files]");
  }, 30_000);

  it("rejects a non-positive budget (parity of the ValueError → RangeError)", () => {
    expect(() => batchAdjacent([], { budgetTokens: 0 })).toThrow();
  });

  it("uses BATCH_TOKEN_BUDGET as the default budget", () => {
    expect(BATCH_TOKEN_BUDGET).toBe(2000);
  });
});
