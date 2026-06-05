import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pyChunkTsjs, shutdownChunkTsjsRef, type RefChunk } from "./chunk_tsjs_oracle.js";
import { startupSelfCheck } from "#backend/chunking/treesitter_loader.js";
import { TreeSitterTsJsChunker, type HunkRange } from "#backend/chunking/treesitter_tsjs.js";

// Golden parity for the TS/JS chunker. Each case runs the SAME (path, body bytes, hunk_ranges) through
// the frozen Python TreeSitterTsJsChunker (via tools/parity/run_chunk_tsjs_ref.py) and the TS port,
// then asserts byte-parity of the DiffChunkV1 list — chunk_id, start_line, end_line, body, language,
// chunk_kind, token_estimate, schema_version. chunk_id parity is the strongest single proof: it folds
// path + span + sha256(body), so an id match implies the slice body is byte-identical.
//
// Coverage:
//   * the `.ts` simple fixtures (arrow_const / class_decl / function_decl) — whole-file;
//   * the 50-file `.ts` sample corpus — whole-file (hunk_ranges=() → all top-level decls) AND a
//     with-hunks case restricting the corpus to a subset of changed lines (exercises both the
//     intersection branch and the module-fallback branch);
//   * the `.js` sample corpus — IF present (the frozen repo ships only the `.ts` corpus today);
//   * a `.js` / hunk-fallback / constants-only behavioral spread so the javascript grammar path + the
//     module fallback are both proven equal even without a `.js` corpus.
//
// The 50-file `.ts` corpus whole-file byte-parity is the acceptance bar.
//
// `.tsx` JSX is BYTE-PARITY (see below + treesitter_tsjs.ts header): the Python ref routes `.tsx`
// through tree-sitter's `language_tsx()` variant, and the vendored `tree-sitter-tsx.wasm` (pinned in
// grammars/manifest.json) is that same variant, so the loader's `tsx` grammar parses JSX → per-decl
// chunks identical to the reference (jsx_body.tsx → 2 function chunks, byte-equal).

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
const SIMPLE_DIR = join(FIXTURES_DIR, "tsjs");
const TS_CORPUS_DIR = join(FIXTURES_DIR, "sample_corpus", "typescript");
const JS_CORPUS_DIR = join(FIXTURES_DIR, "sample_corpus", "javascript");

const chunker = new TreeSitterTsJsChunker();

beforeAll(async () => {
  // Boot the loader (Parser.init + grammar load + SHA self-check) before any chunk call.
  await startupSelfCheck();
});

afterAll(() => shutdownChunkTsjsRef());

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
  const py = await pyChunkTsjs({ path, body, hunkRanges });
  const tsRaw = await chunker.chunk({ path, body, hunkRanges });
  const ts = tsRaw.map(tsChunkToPlain);
  // Field-by-field equality of the entire list (count + ordering + every scalar).
  expect(ts, `path=${path} hunks=${JSON.stringify(hunkRanges)}`).toEqual(py);
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// The `.ts` simple fixtures (the `.tsx` one is asserted as a divergence below).
const SIMPLE_TS_FIXTURES = ["arrow_const.ts", "class_decl.ts", "function_decl.ts"];

describe("TreeSitterTsJsChunker parity — simple .ts fixtures (whole-file)", () => {
  for (const name of SIMPLE_TS_FIXTURES) {
    it(`is byte-equal: ${name}`, async () => {
      const body = readFileSync(join(SIMPLE_DIR, name));
      await assertChunkParity(name, body, []);
    }, 30_000);
  }
});

const TS_CORPUS_FILES = readdirSync(TS_CORPUS_DIR)
  .filter((f) => /^sample_\d+\.ts$/.test(f))
  .sort();

describe("TreeSitterTsJsChunker parity — 50-file .ts sample corpus (whole-file)", () => {
  it("has the expected 50-file corpus", () => {
    expect(TS_CORPUS_FILES.length).toBe(50);
  });

  for (const name of TS_CORPUS_FILES) {
    it(`is byte-equal whole-file: ${name}`, async () => {
      const body = readFileSync(join(TS_CORPUS_DIR, name));
      await assertChunkParity(name, body, []);
    }, 30_000);
  }
});

describe("TreeSitterTsJsChunker parity — .ts corpus with-hunks restriction (subset)", () => {
  // Restrict to a narrow changed-line window in the middle of each corpus file. Python and TS must
  // agree on which candidates intersect the hunk — and, when none intersect, on the clamped
  // module-fallback window. Exercises both the intersection branch and the module-fallback branch.
  for (const name of TS_CORPUS_FILES) {
    it(`is byte-equal with mid-file hunk: ${name}`, async () => {
      const body = readFileSync(join(TS_CORPUS_DIR, name));
      const total = readFileSync(join(TS_CORPUS_DIR, name), "utf-8").split("\n").length;
      const mid = Math.max(1, Math.trunc(total / 2));
      const hunks: ReadonlyArray<HunkRange> = [[mid, Math.max(mid, mid + 3)]];
      await assertChunkParity(name, body, hunks);
    }, 30_000);
  }
});

// The `.js` corpus does not ship in the frozen repo today; run it only if present (forward-compat).
const JS_CORPUS_FILES = existsSync(JS_CORPUS_DIR)
  ? readdirSync(JS_CORPUS_DIR)
      .filter((f) => /^sample_\d+\.js$/.test(f))
      .sort()
  : [];

describe.runIf(JS_CORPUS_FILES.length > 0)(
  "TreeSitterTsJsChunker parity — .js sample corpus (whole-file)",
  () => {
    for (const name of JS_CORPUS_FILES) {
      it(`is byte-equal whole-file: ${name}`, async () => {
        const body = readFileSync(join(JS_CORPUS_DIR, name));
        await assertChunkParity(name, body, []);
      }, 30_000);
    }
  },
);

describe("TreeSitterTsJsChunker parity — javascript + fallback behavioral spread", () => {
  // No `.js` corpus ships today, so exercise the javascript grammar path + module fallback directly.
  // Every case runs through BOTH chunkers and asserts byte-parity.
  it("byte-equal: .js function declarations (javascript grammar + label)", async () => {
    const src = "function foo() { return 1; }\n\nfunction bar() { return 2; }\n";
    await assertChunkParity("src/foo.js", enc(src), []);
  }, 30_000);

  it("byte-equal: .jsx arrow + function decls (javascript grammar)", async () => {
    const src = "export const A = () => 1;\n\nexport function B() { return 2; }\n";
    await assertChunkParity("src/widget.jsx", enc(src), []);
  }, 30_000);

  it("byte-equal: .mjs / .cjs route to javascript", async () => {
    const src = "export function m() { return 1; }\n";
    await assertChunkParity("src/mod.mjs", enc(src), []);
    await assertChunkParity("src/mod.cjs", enc(src), []);
  }, 30_000);

  it("byte-equal: constants-only file → module fallback", async () => {
    const src = "export const PI = 3.14;\nexport const E = 2.71;\n";
    await assertChunkParity("src/consts.ts", enc(src), []);
  }, 30_000);

  it("byte-equal: comment-only file with hunk outside any decl → module fallback", async () => {
    const src = "// Only a comment.\n// Another.\n// Third.\n";
    await assertChunkParity("src/comments.ts", enc(src), [[1, 2]]);
  }, 30_000);

  it("byte-equal: empty body → no chunks", async () => {
    await assertChunkParity("src/empty.ts", new Uint8Array(0), []);
  }, 30_000);

  it("byte-equal: hunk filter keeps only the intersecting decl", async () => {
    const body = readFileSync(join(SIMPLE_DIR, "function_decl.ts"));
    await assertChunkParity("src/function_decl.ts", body, [[6, 6]]);
  }, 30_000);
});

describe("TreeSitterTsJsChunker parity — .tsx JSX (tsx grammar)", () => {
  // tree-sitter-tsx.wasm is vendored and the loader routes `.tsx` through the tsx (language_tsx)
  // grammar, which parses JSX — same as the Python ref. So `.tsx` is now byte-parity: per-decl chunks,
  // NOT the module fallback. (Verified: jsx_body.tsx → 2 function chunks identical to language_tsx.)
  it("is byte-equal: jsx_body.tsx (per-decl JSX chunks, not the module fallback)", async () => {
    const body = readFileSync(join(SIMPLE_DIR, "jsx_body.tsx"));
    const ts = (await chunker.chunk({ path: "src/jsx_body.tsx", body, hunkRanges: [] })).map(
      tsChunkToPlain,
    );
    const py = await pyChunkTsjs({ path: "src/jsx_body.tsx", body, hunkRanges: [] });
    // tsx grammar emits real per-decl chunks (NOT a single module fallback) on both sides; the full
    // DiffChunkV1 list (incl. the language label, which the Python ref sets to "typescript" for .tsx)
    // must be byte-equal.
    expect(ts.length).toBeGreaterThan(1);
    expect(ts).toEqual(py);
  }, 30_000);
});
