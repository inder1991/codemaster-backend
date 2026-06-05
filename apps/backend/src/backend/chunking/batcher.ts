// Adjacent-file batching — 1:1 port of the frozen Python post-pass
// (vendor/codemaster-py/codemaster/chunking/batcher.py).
//
// Post-pass over a chunker's output that collapses runs of adjacent same-directory chunks whose
// combined `token_estimate` fits the batch budget into a single `chunk_kind="batch"` chunk. Saves an
// LLM call per trivial change (single-line config tweak across 5 sibling YAML files → one review
// call instead of five).
//
// A run breaks when:
//   * the next chunk's directory differs;
//   * adding the next chunk would exceed BATCH_TOKEN_BUDGET;
//   * the next chunk has `chunk_kind="batch"` already (don't nest);
//   * the run is non-adjacent in the input order.
//
// The batched chunk's `path` is rendered as `"<dirname>/[<n> files]"` and start_line/end_line collapse
// to 1 / total_lines. The body concatenates each source's body, prefixed with a separator line:
//     --- <path>:<start>-<end> ---
//     <source body>
// Single-source runs pass through unchanged (no batching for n=1). chunk_id is re-minted from the
// batch (path, 1, n_lines, body) via the shared `computeChunkId` so chunk_id parity is preserved.

import { computeChunkId, DiffChunkV1 } from "#contracts/diff_chunking.v1.js";

/** Port of batcher.py::BATCH_TOKEN_BUDGET. */
export const BATCH_TOKEN_BUDGET = 2_000;

/**
 * Port of `os.path.dirname` (POSIX semantics — the production corpus uses workspace-relative POSIX
 * paths). Mirrors CPython `posixpath.dirname`: split on the LAST `/` (the separator stays on the head),
 * then rstrip trailing slashes UNLESS the head is all slashes.
 *
 *   "a/b/c.py" → "a/b"   "c.py" → ""   "a/" → "a"   "/x.py" → "/"   "///x.py" → "///"   "a///b.py" → "a"
 */
function posixDirname(path: string): string {
  const i = path.lastIndexOf("/") + 1;
  let head = path.slice(0, i);
  if (head !== "" && !/^\/+$/.test(head)) {
    head = head.replace(/\/+$/, "");
  }
  return head;
}

/** Port of batcher.py::_separator — the per-source body prefix line. */
function separator(c: DiffChunkV1): string {
  return `--- ${c.path}:${c.start_line}-${c.end_line} ---\n`;
}

/** Count of `\n` occurrences in `s` (port of Python `str.count("\n")`). */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) === 0x0a) {
      n += 1;
    }
  }
  return n;
}

/**
 * Port of batcher.py::_make_batch — fold a multi-source group into one `chunk_kind="batch"` chunk.
 *
 *   body        = "".join(separator(c) + c.body + ("\n" if not c.body.endswith("\n") else "") for c)
 *   n_lines     = body.count("\n") or 1          (0 → 1, matching Python `or 1`)
 *   dirname     = _dirname(group[0].path) or "." (empty → ".", matching Python `or "."`)
 *   language    = the single common language iff exactly ONE distinct non-null language across the
 *                 group, else null. NOTE: `{c.language for c in group if c.language}` is a Python set —
 *                 iteration order is NOT defined, but `len == 1` collapses to a single value so the
 *                 ordering ambiguity cannot affect the result.
 *   batch_path  = `${dirname}/[${group.length} files]`
 *   token_est   = sum of the group's token_estimate
 */
function makeBatch(group: ReadonlyArray<DiffChunkV1>): DiffChunkV1 {
  const bodyParts: Array<string> = [];
  for (const c of group) {
    bodyParts.push(separator(c));
    bodyParts.push(c.body);
    if (!c.body.endsWith("\n")) {
      bodyParts.push("\n");
    }
  }
  const body = bodyParts.join("");
  const nLines = countNewlines(body) || 1;
  const dirname = posixDirname(group[0]!.path) || ".";
  const languages = new Set<string>();
  for (const c of group) {
    if (c.language) {
      languages.add(c.language);
    }
  }
  const language: string | null = languages.size === 1 ? [...languages][0]! : null;
  const batchPath = `${dirname}/[${group.length} files]`;
  let tokenEstimate = 0;
  for (const c of group) {
    tokenEstimate += c.token_estimate;
  }
  return DiffChunkV1.parse({
    chunk_id: computeChunkId({ path: batchPath, start_line: 1, end_line: nLines, body }),
    path: batchPath,
    language,
    start_line: 1,
    end_line: nLines,
    body,
    chunk_kind: "batch",
    token_estimate: tokenEstimate,
  });
}

/**
 * Port of batcher.py::batch_adjacent — collapse adjacent same-dir chunks under `budgetTokens`. Returns
 * the input UNCHANGED (same array reference, matching the Python `return chunks`) when fewer than 2
 * chunks. A pre-existing `chunk_kind="batch"` chunk flushes the current run and passes through (no
 * nesting).
 *
 * @throws RangeError when `budgetTokens <= 0` (mirrors the Python `ValueError`).
 */
export function batchAdjacent(
  chunks: ReadonlyArray<DiffChunkV1>,
  opts: { budgetTokens?: number } = {},
): Array<DiffChunkV1> {
  const budgetTokens = opts.budgetTokens ?? BATCH_TOKEN_BUDGET;
  if (budgetTokens <= 0) {
    throw new RangeError("budget_tokens must be positive");
  }
  if (chunks.length < 2) {
    return [...chunks];
  }

  const out: Array<DiffChunkV1> = [];
  let currentGroup: Array<DiffChunkV1> = [];
  let currentTokens = 0;
  let currentDir: string | null = null;

  const flush = (): void => {
    if (currentGroup.length === 0) {
      return;
    }
    if (currentGroup.length === 1) {
      out.push(currentGroup[0]!);
    } else {
      out.push(makeBatch(currentGroup));
    }
    currentGroup = [];
    currentTokens = 0;
    currentDir = null;
  };

  for (const c of chunks) {
    if (c.chunk_kind === "batch") {
      flush();
      out.push(c);
      continue;
    }
    const cDir = posixDirname(c.path);
    if (currentDir === null || cDir !== currentDir || currentTokens + c.token_estimate > budgetTokens) {
      flush();
      currentDir = cDir;
      currentGroup = [c];
      currentTokens = c.token_estimate;
    } else {
      currentGroup.push(c);
      currentTokens += c.token_estimate;
    }
  }

  flush();
  return out;
}
