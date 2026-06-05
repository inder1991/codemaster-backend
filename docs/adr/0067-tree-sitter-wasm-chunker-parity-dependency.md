# ADR-0067: tree-sitter (web-tree-sitter / WASM) as a parity dependency for the chunker

- Status: Accepted
- Date: 2026-06-05
- Deciders: project owner + backend platform (Python→TypeScript migration)
- Related: ADR-0066 (Temporal-TS workflow bundle); frozen `vendor/codemaster-py/codemaster/chunking/`
  (`treesitter_python`, `treesitter_tsjs`, `selector`, `markdown_chunker`, `hunk_fallback`,
  `token_budget`, `batcher`, `chunker_port`); the `chunk_and_redact` / `redact_chunks` activities.

## Context

The Python→TypeScript backend port is bringing up the review pipeline's **chunking** step. The frozen
Python chunker parses each changed file with **tree-sitter** and walks the syntax tree to cut
semantic chunks (functions, classes, blocks); unsupported languages fall back to a diff-hunk chunker.

Chunk boundaries are **not an implementation detail** — each chunk becomes exactly one
`bedrock_review_chunk` LLM call, so the boundaries *are* the review input. A different parser (or a
different grammar version) yields different boundaries → different prompts → the dual-run review output
diverges and parity becomes impossible to reason about. The chunker is therefore a place where the
parser is a **parity dependency**, not a convenience dependency.

The frozen Python reference pins:

- `tree-sitter == 0.25.2` (core; grammars compiled at ABI 15)
- `tree-sitter-python == 0.25.0`
- `tree-sitter-javascript == 0.25.0`
- `tree-sitter-typescript == 0.23.2`

## Decision

Adopt **tree-sitter** in TypeScript via **`web-tree-sitter` (the WebAssembly binding)**, loading the
**same grammars at the same versions** as the Python reference. This was approved by the project owner
as a justified spine dependency, conditioned on a parity/perf spike (done; see below) and the
conditions in *Consequences*.

**Why WASM over native (`node-tree-sitter`):** runtime portability for the OpenShift containers wins.
WASM avoids `node-gyp`, native ABI drift, and a base-image compiler/toolchain requirement — the class
of dependency that causes CI/image surprises. Chunking is parity-critical but not a dominant runtime
cost (see the benchmark), so the WASM-vs-native speed gap is acceptable. `web-tree-sitter` is pure
WASM/JS (no native build).

**Grammar artifacts:** the exact-version grammar `.wasm` ship **prebuilt inside the npm grammar
tarballs** (`tree-sitter-python@0.25.0` → `tree-sitter-python.wasm`, etc.), so no emscripten build is
needed. They are **vendored into the repo** at `apps/backend/src/backend/chunking/grammars/` with a
pinned manifest (`manifest.json`: source npm version + SHA-256) and loaded from that directory at
startup. They are **never fetched at runtime**. `web-tree-sitter` itself is added to
`package.json` dependencies (`^0.25`, ABI-15 compatible).

## Spike evidence (acceptance gate)

A parity/perf spike validated the choice before any chunker code was written:

- **Byte-parity — PROVEN.** For Python, JavaScript, and TypeScript fixtures, `web-tree-sitter` with the
  vendored grammars produced **byte-identical parse trees** to the frozen Python `tree-sitter`: every
  node matched on `(type, is_named, start_byte, end_byte, start_point, end_point)` — 154 (py) + 99 (js)
  + 143 (ts) nodes, **zero divergence**.
- **Perf — acceptable.** On a real 1224-line / 52 KB source file: `web-tree-sitter` WASM **3.2 ms/parse**
  vs Python native **1.76 ms/parse** (~1.8× slower, consistent with the tree-sitter docs). Negligible
  against the pipeline's clone / retrieval / DB / LLM costs. Native is **not** justified unless a real
  benchmark later shows WASM chunking is a bottleneck.

## Consequences

Conditions on this dependency (all required):

1. **Version pinning.** Grammar `.wasm` are pinned by exact source-npm version + SHA-256 in
   `grammars/manifest.json`, matching the Python packages. `web-tree-sitter` is pinned in
   `package.json` / lockfile. Bumping any grammar version is a parity change requiring a re-run of the
   golden fixtures.
2. **No runtime asset fetch.** Grammars load from the vendored repo directory, bundled into the image.
3. **Startup self-check.** The worker bootstrap loads all required grammars (and verifies the on-disk
   SHA-256 against the manifest) at startup, failing loud if any grammar is missing/altered — rather
   than failing mid-review.
4. **Golden parity fixtures.** Same source file in Python and TS must produce identical chunk
   boundaries. Tests record boundary metadata — file path, language, **start/end byte offsets** (the
   **primary** proof), start/end lines, and chunk kind.
5. **Encoding: the chunker is LINE-based, so no UTF-16→UTF-8 mapping is needed (verified).** Note for
   future maintainers: `web-tree-sitter` reports **UTF-16 code-unit** offsets (`startIndex`/`endIndex`
   and point *columns*), whereas the Python `tree-sitter` reports **UTF-8 byte** offsets — these diverge
   for non-ASCII source (verified: a 17-UTF-16-char comment is 20 UTF-8 bytes). HOWEVER, the frozen
   `treesitter_python` / `treesitter_tsjs` chunkers do **not** use node byte offsets at all: they use
   the point **row** (`node.start_point[0]` / `end_point[0]`, 1-based line numbers) plus a single
   `end_point[1] == 0` (column-at-line-start) check, then slice the body **by lines**. `DiffChunkV1`
   identity is `(path, start_line, end_line, body)` — entirely line-based. Rows and the col-0 test are
   **encoding-agnostic** (a newline is a newline; column 0 is column 0), and this was verified to match
   byte-for-byte on a non-ASCII fixture (Python rows 0–2/5–7 == web-tree-sitter rows 0–2/5–7; col-0
   check identical). So a UTF-16→UTF-8 mapping is **not required for the chunker**. It would only become
   necessary if a future consumer reads node byte offsets / columns directly — at which point map via
   `Buffer.byteLength(src.slice(0, idx), "utf8")`.
6. **Fallback is explicitly NON-parity.** The diff-hunk fallback for languages without a tree-sitter
   grammar is marked non-parity in code + tests (it is a best-effort path, not a byte-parity guarantee).
7. **Dep-health note.** `web-tree-sitter` is pure WASM/JS (no `node-gyp`, no native ABI). The grammar
   `.wasm` are binary artifacts in git (~2.3 MB total) — the build/deploy must copy
   `apps/backend/src/backend/chunking/grammars/*.wasm` into the runtime image alongside the compiled JS
   (they are NOT emitted by `tsc`). The startup self-check (condition 3) is the guard against a deploy
   that drops them.

## Alternatives considered

- **`node-tree-sitter` (native bindings).** Faster and version-matched npm grammars, but reintroduces
  `node-gyp` / native build fragility in CI and the container image. Rejected for runtime portability;
  may be revisited only if WASM chunking is measured to be a real bottleneck.
- **A pure-JS / heuristic chunker.** Rejected: different parse trees → different chunk boundaries →
  breaks same-input→same-review parity, which is the entire point of the migration.
