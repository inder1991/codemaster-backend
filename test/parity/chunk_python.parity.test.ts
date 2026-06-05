import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pyChunkPython, shutdownChunkRef, type RefChunk } from "./chunk_python_oracle.js";
import { TreeSitterPythonChunker, type HunkRange } from "#backend/chunking/treesitter_python.js";
import { startupSelfCheck } from "#backend/chunking/treesitter_loader.js";

// Golden parity for the Python chunker. Each case runs the SAME (path, body bytes, hunk_ranges)
// through the frozen Python TreeSitterPythonChunker (via tools/parity/run_chunk_python_ref.py) and the
// TS port, then asserts byte-parity of the DiffChunkV1 list — chunk_id, start_line, end_line, body,
// language, chunk_kind, token_estimate, schema_version. chunk_id parity is the strongest single proof:
// it folds path + span + sha256(body), so an id match implies the slice body is byte-identical.
//
// Coverage: the 4 simple fixtures (async/class/decorated/function), the 50-file sample corpus
// whole-file (hunk_ranges=() → all top-level defs), AND a with-hunks case restricting the corpus to a
// subset of changed lines. The 50-file corpus whole-file byte-parity is the acceptance bar.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(
  HERE,
  "..",
  "..",
  "vendor",
  "codemaster-py",
  "tests",
  "fixtures",
  "diff_chunking",
);
const SIMPLE_DIR = join(FIXTURES_DIR, "python");
const CORPUS_DIR = join(FIXTURES_DIR, "sample_corpus", "python");

const chunker = new TreeSitterPythonChunker();

beforeAll(async () => {
  // Boot the loader (Parser.init + grammar load + SHA self-check) before any chunk call.
  await startupSelfCheck();
});

afterAll(() => shutdownChunkRef());

/** Normalize a TS DiffChunkV1 to the same plain-object shape the Python ref emits (model_dump). */
function tsChunkToPlain(c: {
  schema_version: number;
  chunk_id: string;
  path: string;
  language: string | null;
  start_line: number;
  end_line: number;
  body: string;
  chunk_kind: string;
  token_estimate: number;
}): RefChunk {
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

/** Run BOTH chunkers on identical inputs and assert byte-parity of the full DiffChunkV1 list. */
async function assertChunkParity(
  path: string,
  body: Uint8Array,
  hunkRanges: ReadonlyArray<HunkRange>,
): Promise<void> {
  const py = await pyChunkPython({ path, body, hunkRanges });
  const tsRaw = await chunker.chunk({ path, body, hunkRanges });
  const ts = tsRaw.map(tsChunkToPlain);
  // Field-by-field equality of the entire list (count + ordering + every scalar).
  expect(ts, `path=${path} hunks=${JSON.stringify(hunkRanges)}`).toEqual(py);
}

const SIMPLE_FIXTURES = ["async_def.py", "class_def.py", "decorated_def.py", "function_def.py"];

describe("TreeSitterPythonChunker parity — simple fixtures (whole-file)", () => {
  for (const name of SIMPLE_FIXTURES) {
    it(`is byte-equal: ${name}`, async () => {
      const body = readFileSync(join(SIMPLE_DIR, name));
      await assertChunkParity(name, body, []);
    }, 30_000);
  }
});

const CORPUS_FILES = readdirSync(CORPUS_DIR)
  .filter((f) => /^sample_\d+\.py$/.test(f))
  .sort();

describe("TreeSitterPythonChunker parity — 50-file sample corpus (whole-file)", () => {
  it("has the expected 50-file corpus", () => {
    expect(CORPUS_FILES.length).toBe(50);
  });

  for (const name of CORPUS_FILES) {
    it(`is byte-equal whole-file: ${name}`, async () => {
      const body = readFileSync(join(CORPUS_DIR, name));
      await assertChunkParity(name, body, []);
    }, 30_000);
  }
});

describe("TreeSitterPythonChunker parity — with-hunks restriction (subset)", () => {
  // Restrict to a narrow changed-line window in the middle of each corpus file. The Python and TS
  // chunkers must agree on which candidates intersect the hunk — and, when none intersect, on the
  // clamped module-fallback window. We derive a deterministic window per file from its line count so
  // the case exercises both the intersection branch and (for files whose mid-window misses every
  // top-level def) the module-fallback branch — both proven equal here.
  for (const name of CORPUS_FILES) {
    it(`is byte-equal with mid-file hunk: ${name}`, async () => {
      const body = readFileSync(join(CORPUS_DIR, name));
      const total = readFileSync(join(CORPUS_DIR, name), "utf-8").split("\n").length;
      // A small window around the file's midpoint (1-based, inclusive). Clamp to >=1.
      const mid = Math.max(1, Math.trunc(total / 2));
      const hunks: ReadonlyArray<HunkRange> = [[mid, Math.max(mid, mid + 3)]];
      await assertChunkParity(name, body, hunks);
    }, 30_000);
  }
});
