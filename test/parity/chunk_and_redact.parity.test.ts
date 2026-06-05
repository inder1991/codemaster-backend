import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pyChunkAndRedact, shutdownPostPassRef, type RefChunk } from "./post_pass_oracle.js";
import {
  chunkAndRedact,
  doRedact,
  redactChunks,
  WorkspacePathOutsideRootError,
} from "#backend/activities/chunk_and_redact.activity.js";
import { ChunkerRegistry } from "#backend/chunking/selector.js";
import { startupSelfCheck } from "#backend/chunking/treesitter_loader.js";
import { ChunkAndRedactInputV1 } from "#contracts/chunk_and_redact.v1.js";
import { computeChunkId, DiffChunkV1 } from "#contracts/diff_chunking.v1.js";

// End-to-end parity for the composite chunk_and_redact activity against the FROZEN Python
// chunk_and_redact_activity (over the real ChunkerRegistry + real PII/secret redactors) via
// run_post_pass_ref.py. Each case materializes the SAME files (raw bytes) + changed_line_ranges into
// BOTH a real TS temp workspace AND a Python-side tmp workspace, then asserts byte-parity of the full
// redacted DiffChunkV1 list. chunk_id parity is the strongest proof: the activity RE-MINTS chunk_id
// from the POST-redaction body, so an id match implies the redaction markers ([REDACTED:<kind>]) landed
// at byte-identical offsets — i.e. PII-first-then-secrets ordering + the descending-offset secret
// splice + the per-file chunk accumulation all match the source-of-truth.

afterAll(() => shutdownPostPassRef());

beforeAll(async () => {
  await startupSelfCheck();
});

const enc = new TextEncoder();

function toPlain(c: DiffChunkV1): RefChunk {
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

type FileSpec = { rel: string; text: string };

/** Materialize files into a fresh temp workspace and return its absolute path. */
function materialize(files: ReadonlyArray<FileSpec>): string {
  const root = mkdtempSync(join(tmpdir(), "codemaster-chunkredact-"));
  for (const f of files) {
    const abs = join(root, f.rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.text);
  }
  return root;
}

/** Run the activity on identical inputs through BOTH impls and assert byte-parity of the list. */
async function assertActivityParity(
  files: ReadonlyArray<FileSpec>,
  changedLineRanges: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>,
): Promise<void> {
  const root = materialize(files);
  const input = ChunkAndRedactInputV1.parse({
    workspace_path: root,
    files: files.map((f) => f.rel),
    changed_line_ranges: changedLineRanges,
  });
  const ts = (await chunkAndRedact(input)).map(toPlain);
  const py = await pyChunkAndRedact({
    files: files.map((f) => ({ rel: f.rel, body: enc.encode(f.text) })),
    changedLineRanges,
  });
  expect(ts).toEqual(py);
}

describe("chunkAndRedact activity parity — frozen Python composite", () => {
  it("chunks a python function + redacts inline PII (re-minted chunk_id)", async () => {
    const files: Array<FileSpec> = [
      { rel: "a.py", text: 'def f():\n    email = "alice@example.com"\n    return 1\n' },
    ];
    await assertActivityParity(files, { "a.py": [[1, 3]] });
  }, 60_000);

  it("redacts a secret (AWS key) inside a chunk", async () => {
    const files: Array<FileSpec> = [
      {
        rel: "cfg.py",
        text: 'def load():\n    key = "AKIAIOSFODNN7EXAMPLA"\n    return key\n',
      },
    ];
    await assertActivityParity(files, { "cfg.py": [[1, 3]] });
  }, 60_000);

  it("accumulates chunks across multiple files in INPUT ORDER", async () => {
    const files: Array<FileSpec> = [
      { rel: "one.py", text: "def one():\n    return 1\n\ndef two():\n    return 2\n" },
      { rel: "two.ts", text: "export function a(): number {\n  return 1;\n}\n" },
    ];
    await assertActivityParity(files, { "one.py": [[1, 5]], "two.ts": [[1, 3]] });
  }, 60_000);

  it("routes a hunk-fallback (.go) file via the registry (NON-AST language)", async () => {
    const goSrc =
      "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"x\")\n}\n";
    const files: Array<FileSpec> = [{ rel: "main.go", text: goSrc }];
    await assertActivityParity(files, { "main.go": [[5, 6]] });
  }, 60_000);

  it("skips a missing / deleted file (still routes the present files)", async () => {
    // Materialize ONLY a.py but pass a missing b.py in the file list.
    const root = materialize([{ rel: "a.py", text: "def g():\n    return 7\n" }]);
    const input = ChunkAndRedactInputV1.parse({
      workspace_path: root,
      files: ["a.py", "b_missing.py"],
      changed_line_ranges: { "a.py": [[1, 2]] },
    });
    const ts = (await chunkAndRedact(input)).map(toPlain);
    const py = await pyChunkAndRedact({
      files: [{ rel: "a.py", body: enc.encode("def g():\n    return 7\n") }],
      changedLineRanges: { "a.py": [[1, 2]] },
    });
    expect(ts).toEqual(py);
  }, 60_000);

  it("treats a file with no changed_line_ranges as whole-file (python) / empty (fallback)", async () => {
    const files: Array<FileSpec> = [
      { rel: "whole.py", text: "def a():\n    return 1\n\ndef b():\n    return 2\n" },
    ];
    // No ranges → python chunker chunks the whole file (all top-level defs).
    await assertActivityParity(files, {});
  }, 60_000);
});

describe("chunkAndRedact activity — path-traversal defense", () => {
  it("throws WorkspacePathOutsideRootError on a `..`-escape", async () => {
    const root = materialize([{ rel: "a.py", text: "x = 1\n" }]);
    const input = ChunkAndRedactInputV1.parse({
      workspace_path: root,
      files: ["../escape.py"],
      changed_line_ranges: {},
    });
    await expect(chunkAndRedact(input)).rejects.toBeInstanceOf(WorkspacePathOutsideRootError);
  });
});

describe("doRedact / redactChunks — shared redaction helper", () => {
  function chunk(body: string): DiffChunkV1 {
    return DiffChunkV1.parse({
      chunk_id: computeChunkId({ path: "x.py", start_line: 1, end_line: 1, body }),
      path: "x.py",
      language: "python",
      start_line: 1,
      end_line: 1,
      body,
      chunk_kind: "module",
      token_estimate: 1,
    });
  }

  it("returns the SAME chunk object when nothing is redacted (identity)", () => {
    const c = chunk("x = 1\n");
    expect(doRedact([c])[0]).toBe(c);
  });

  it("re-mints chunk_id when the body changes (PII redacted)", () => {
    const c = chunk('email = "alice@example.com"\n');
    const [out] = doRedact([c]);
    expect(out!.chunk_id).not.toBe(c.chunk_id);
    expect(out!.body).toContain("[REDACTED:email]");
  });

  it("redactChunks (standalone wrapper) delegates to the same helper", async () => {
    const c = chunk('key = "AKIAIOSFODNN7EXAMPLA"\n');
    const out = await redactChunks([c]);
    expect(out[0]!.body).toContain("[REDACTED:aws_access_key_id]");
  });
});

describe("doChunkAndRedact registry injection (smoke)", () => {
  it("builds a registry without crashing (singletons)", () => {
    const reg = ChunkerRegistry.build();
    expect(reg.python).toBeDefined();
    expect(reg.tsjs).toBeDefined();
    expect(reg.fallback).toBeDefined();
  });
});
