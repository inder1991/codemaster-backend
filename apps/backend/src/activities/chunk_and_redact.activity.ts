/**
 * `chunkAndRedact` activity — 1:1-in-intent port of the frozen Python composite activity
 * `@activity.defn chunk_and_redact_activity` (vendor/codemaster-py/codemaster/activities/chunk_and_redact.py).
 *
 * Composite activity: `ChunkerRegistry.selectFor(path)` per changed file + INLINE redaction. Reads
 * each file's body from disk, routes it through the registry-selected chunker (Python / TS-JS /
 * hunk-fallback), accumulates every chunk in INPUT FILE ORDER, then redacts the whole accumulated
 * list in place and returns the merged `DiffChunkV1[]` ready for the per-chunk review activity to
 * consume.
 *
 * ## Redaction reuse (the ported half is DONE — this activity REUSES it)
 *
 * Redaction is INLINED rather than delegated to a separate Temporal activity, to avoid a round-trip
 * per chunk — exactly the frozen Python rationale (`_redact_chunks_inline`). It reuses the already-
 * ported Sprint-7 detectors: `redactPii` (#backend/redact/pii_redactor) for the `[REDACTED:<kind>]`
 * PII markers, and `detectSecrets` (#backend/redact/secret_detector) spliced as `[REDACTED:<kind>]`.
 * The standalone {@link redactChunks} activity (the thin wrapper) shares the same `doRedact` helper —
 * one redaction implementation, two entry points, matching the frozen `redact_chunks.py` + the
 * activity's `_redact_chunks_inline` both routing through `_do_redact`.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The frozen Python activity dispatches with THREE positional arguments (`chunk_and_redact_activity(
 * workspace_path, files, changed_line_ranges)`) — a known live invariant-11 violation. This port
 * CLOSES it: the single positional input is the {@link ChunkAndRedactInputV1} envelope. There is no
 * Python Pydantic counterpart — it is introduced during the port (see the contract header).
 *
 * ## Runtime context (vs. the workflow body)
 *
 * Activities run in the NORMAL Node runtime — NOT the workflow V8-isolate sandbox. Byte reads use
 * `node:fs` synchronously (a filesystem read, NOT a clock/random seam — check_clock_random permits fs
 * reads; the redactors + chunkers are pure). `doChunkAndRedact` is the pure orchestration that
 * tests/parity drive directly; `chunkAndRedact` is the registered activity that constructs the REAL
 * {@link ChunkerRegistry} and delegates. The registry is INJECTED into `doChunkAndRedact` so the
 * parity oracle drives the same orchestration with the real chunkers (mirroring the frozen Python
 * exporting its inner orchestration).
 *
 * ## Path-traversal defense (parity-significant)
 *
 * `workspace_path` is resolved to an absolute path; each `workspace / rel_path` is resolved and
 * verified to stay UNDER the workspace root — a `..`-escape throws {@link WorkspacePathOutsideRootError}
 * (mirrors the frozen Python `target.relative_to(workspace)` ValueError → raise). Missing / deleted
 * files are skipped (mirrors `if not target.is_file(): continue`).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { detectSecrets } from "#backend/redact/secret_detector.js";
import { redactPii } from "#backend/redact/pii_redactor.js";

import { ChunkerRegistry } from "../chunking/selector.js";
import { type HunkRange } from "../chunking/treesitter_python.js";

import { computeChunkId, DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import { ChunkAndRedactInputV1 } from "#contracts/chunk_and_redact.v1.js";

/** Platform path separator (resolved paths use it). Module-level so the traversal check reads cleanly. */
const pathSep = process.platform === "win32" ? "\\" : "/";

/** Port of chunk_and_redact.py::WorkspacePathOutsideRootError — a file path resolved outside the root. */
export class WorkspacePathOutsideRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathOutsideRootError";
  }
}

// ── Redaction (port of redact_chunks.py — the ported detectors are REUSED) ───────────────────────────

/** Port of redact_chunks.py::_estimate_tokens — `max(1, len(body) // 4)` (CODE-POINT length). */
function estimateTokens(body: string): number {
  return Math.max(1, Math.trunc([...body].length / 4));
}

/**
 * Port of redact_chunks.py::_redact_secrets — replace each detected secret with a `[REDACTED:<kind>]`
 * marker. Splices from the END (findings sorted DESCENDING by start_offset) so earlier offsets stay
 * valid as later ones are replaced — byte-identical to the frozen Python.
 */
function redactSecrets(text: string): string {
  const findings = detectSecrets(text);
  if (findings.length === 0) {
    return text;
  }
  const sorted = [...findings].sort((a, b) => b.start_offset - a.start_offset);
  let out = text;
  for (const f of sorted) {
    const replacement = `[REDACTED:${f.kind}]`;
    out = out.slice(0, f.start_offset) + replacement + out.slice(f.end_offset);
  }
  return out;
}

/**
 * Port of redact_chunks.py::_redact_chunk — run a chunk's body through PII then secret redaction.
 *
 * Order: PII first (so email/SSN/credit-card patterns see the raw bytes), then secrets on the
 * PII-cleaned text. If the body is UNCHANGED, the SAME chunk object is returned (identity preserved —
 * the Python `if redacted_body == chunk.body: return chunk`). If changed, the chunk_id is RE-MINTED
 * deterministically from the post-redaction content (R-7: the redacted chunk is a different content
 * artifact, so its content-addressable UUIDv5 differs but stays stable).
 */
function redactChunk(chunk: DiffChunkV1): DiffChunkV1 {
  const { rewritten } = redactPii(chunk.body);
  const redactedBody = redactSecrets(rewritten);
  if (redactedBody === chunk.body) {
    return chunk;
  }
  return DiffChunkV1.parse({
    chunk_id: computeChunkId({
      path: chunk.path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      body: redactedBody,
    }),
    path: chunk.path,
    language: chunk.language,
    start_line: chunk.start_line,
    end_line: chunk.end_line,
    body: redactedBody,
    chunk_kind: chunk.chunk_kind,
    token_estimate: estimateTokens(redactedBody),
  });
}

/** Port of redact_chunks.py::_do_redact — the pure redaction helper. Tests + both activity entry
 *  points (inline composite + standalone wrapper) invoke this. */
export function doRedact(chunks: ReadonlyArray<DiffChunkV1>): Array<DiffChunkV1> {
  return chunks.map((c) => redactChunk(c));
}

// ── Composite chunk + redact orchestration ───────────────────────────────────────────────────────

/**
 * The composite orchestration, ported EXACTLY (iteration order + path-traversal defense + skip-missing
 * + per-file chunk accumulation + final whole-list redaction):
 *
 *   workspace = resolve(workspace_path)
 *   for rel_path in files:
 *     target = resolve(workspace / rel_path)
 *     if not under workspace: raise WorkspacePathOutsideRootError
 *     if not target.is_file(): continue                       # skip deleted / missing
 *     body = read_bytes(target)
 *     ranges = changed_line_ranges.get(rel_path, ())
 *     chunker = registry.select_for(rel_path)
 *     all_chunks += await chunker.chunk(rel_path, body, ranges)
 *   return doRedact(all_chunks)
 *
 * The registry is INJECTED so the parity oracle drives the same orchestration the activity runs.
 */
export async function doChunkAndRedact(args: {
  workspacePath: string;
  files: ReadonlyArray<string>;
  changedLineRanges: Readonly<Record<string, ReadonlyArray<HunkRange>>>;
  registry: ChunkerRegistry;
}): Promise<Array<DiffChunkV1>> {
  const { workspacePath, files, changedLineRanges, registry } = args;
  const workspace = resolve(workspacePath);

  const allChunks: Array<DiffChunkV1> = [];
  for (const relPath of files) {
    const target = resolve(workspace, relPath);

    // Path-traversal defense: `target` must stay UNDER `workspace`. A `relative(workspace, target)`
    // that starts with ".." (or is absolute) means the resolved path escaped the root — mirrors the
    // frozen Python `target.relative_to(workspace)` ValueError branch.
    const rel = relative(workspace, target);
    if (rel === ".." || rel.startsWith(`..${pathSep}`) || isAbsolute(rel)) {
      throw new WorkspacePathOutsideRootError(
        `file ${JSON.stringify(relPath)} resolves outside workspace_root=${JSON.stringify(workspace)}`,
      );
    }

    // Skip deleted / missing files (mirrors `if not target.is_file(): continue`). `target` is a path
    // resolved under the workspace root and verified by the traversal check above — never user-injected.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- `target` is verified to resolve under the workspace root (traversal check above)
    if (!existsSync(target) || !statSync(target).isFile()) {
      continue;
    }

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- `target` is verified to resolve under the workspace root (traversal check above)
    const body = readFileSync(target);
    // eslint-disable-next-line security/detect-object-injection -- relPath indexes a plain wire-record; absence → [] default, not undefined-injection
    const ranges = changedLineRanges[relPath] ?? [];
    const chunker = registry.selectFor(relPath);
    const fileChunks = await chunker.chunk({ path: relPath, body, hunkRanges: ranges });
    for (const fc of fileChunks) {
      allChunks.push(fc);
    }
  }

  return doRedact(allChunks);
}

/**
 * The registered composite activity. Takes the single typed {@link ChunkAndRedactInputV1} envelope
 * (invariant 11), constructs the REAL {@link ChunkerRegistry} (one per call; the loader's parser cache
 * is process-wide so every registry shares the warm parsers), and delegates to {@link doChunkAndRedact}.
 */
export async function chunkAndRedact(input: ChunkAndRedactInputV1): Promise<Array<DiffChunkV1>> {
  // Parse at the activity boundary: a wrong-shape dispatch (e.g. a camelCase key from a drifting caller)
  // throws a clear ZodError here instead of crashing in `resolve(undefined)` deeper in.
  const parsed = ChunkAndRedactInputV1.parse(input);
  const registry = ChunkerRegistry.build();
  return doChunkAndRedact({
    workspacePath: parsed.workspace_path,
    files: parsed.files,
    changedLineRanges: parsed.changed_line_ranges,
    registry,
  });
}

/**
 * Port of the standalone `redact_chunks` activity (redact_chunks.py::RedactChunksActivity.redact_chunks)
 * — a thin wrapper over the ported redactors. Routes every chunk's body through PII + secret redaction
 * via the shared {@link doRedact} helper. Single positional input (the chunk list) already satisfies
 * invariant 11. Kept as a distinct entry point because it is independently wired in the frozen worker
 * registry (it is the second line of defence after archive-side redaction).
 */
export async function redactChunks(chunks: ReadonlyArray<DiffChunkV1>): Promise<Array<DiffChunkV1>> {
  return doRedact(chunks);
}
