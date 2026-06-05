export const meta = {
  name: 'phase23-chunker',
  description: 'core-loop chunk step: the tree-sitter chunker (web-tree-sitter/WASM, ADR-0067). Grammar loader + startup self-check; the LINE-based treesitter_python + treesitter_tsjs chunkers (rows + col-0, NO byte-offset mapping needed); token_budget + batcher post-passes; hunk_fallback (non-parity) + selector; the chunk_and_redact activity (reusing the ported redaction). Verified by adversarial golden-corpus DiffChunkV1 parity vs frozen Python.',
  phases: [
    { title: 'LoaderPython', detail: 'treesitter_loader (web-tree-sitter, 3 vendored wasm, parser cache, startup SHA self-check) + the Python chunker + python golden-corpus DiffChunkV1 parity' },
    { title: 'TsJs', detail: 'the TS/JS chunker (typescript/tsx/javascript dispatch, export-wrapper descent, function/class/arrow detection) + ts/js golden-corpus parity' },
    { title: 'PostAndActivity', detail: 'token_budget (estimate_tokens + non-ASCII 2.5x + midpoint split) + batcher + hunk_fallback (non-parity) + selector + the chunk_and_redact activity (reuse ported redaction)' },
    { title: 'Verify', detail: 'adversarial full-corpus dual-run vs frozen Python: DiffChunkV1 tuples byte-equal (chunk_id/start_line/end_line/body/chunk_kind/language) for python + ts/js; post-pass determinism; activity end-to-end' },
  ],
}

const REPO = '/Users/ascoe/Projects/codemaster-backend'
const PY = REPO + '/vendor/codemaster-py/.venv/bin/python'
const CK = REPO + '/vendor/codemaster-py/codemaster/chunking'
const ACT = REPO + '/vendor/codemaster-py/codemaster/activities'
const FIX = REPO + '/vendor/codemaster-py/tests/fixtures/diff_chunking'
const GRAM = REPO + '/apps/backend/src/backend/chunking/grammars'

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['component', 'files_written', 'commands', 'all_green', 'notes'],
  properties: {
    component: { type: 'string' }, files_written: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'passed'], properties: { cmd: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } } } },
    all_green: { type: 'boolean' }, notes: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'checks', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['SOUND', 'WEAK', 'INCONCLUSIVE'] },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'pass'], properties: { name: { type: 'string' }, pass: { type: 'boolean' }, detail: { type: 'string' } } } },
    issues: { type: 'array', items: { type: 'string' } },
  },
}

const STYLE = [
  'WORKING DIR: ' + REPO + '. ABSOLUTE paths. Bash cwd RESETS between calls — prefix EVERY command with (cd ' + REPO + ' && ...).',
  'TS STYLE (validate-fast = gates -> lint -> typecheck -> test): ESM .js specifiers; "type" not "interface"; Array<T>; NO any (unknown+narrow); named exports; explicit return types; import { type X }; no unused vars; snake_case FILENAMES; camelCase members.',
  'IMPORTS: #contracts/* , #platform/* , #backend/* ; same-dir relative ./x.js.',
  'GATE: check_clock_random scans apps/** + libs/**/src — the chunker is PURE (no Date/Math.random/setTimeout). check_tenant_scoped_raw_sql: no DB in the chunker. web-tree-sitter is ALREADY a dep (do NOT add deps). The grammar wasm are VENDORED at ' + GRAM + '/*.wasm (pinned, SHA in manifest.json) — load from there, NEVER fetch.',
  'web-tree-sitter API (ESM): `import { Parser, Language } from "web-tree-sitter"`; `await Parser.init()` ONCE; `const lang = await Language.load("<abs path to .wasm>")`; `const p = new Parser(); p.setLanguage(lang); const tree = p.parse(srcString);`. Node fields: `node.type`, `node.isNamed` (may be getter), `node.startPosition.{row,column}`, `node.endPosition.{row,column}` (0-based), `node.childCount`/`node.child(i)`/`node.children`. In vitest, init the parser in a beforeAll (async). Resolve the wasm path relative to the module (import.meta.url) so it works under tsc-built dist AND vitest.',
  'CRITICAL — the chunker is LINE-BASED, encoding-agnostic (ADR-0067 cond 5): use node.startPosition.row (=Python node.start_point[0]) + endPosition.row + the `endPosition.column === 0` backup; slice the body BY LINES. Do NOT use byte offsets / startIndex; NO UTF-16->UTF-8 mapping is needed (rows + col-0 match Python byte-for-byte, verified). Token estimate is INTEGER division `Math.trunc(len/4)` to match Python `len(body)//4`.',
  'GUARDRAILS: touch ONLY the files this task names. NO eslint --fix on the repo; NO git add/commit; CLEAN UP scratch (UNIQUE names; delete from tools/parity). You are the ONLY workflow running.',
  'RUN BEFORE RETURNING (all pass): (cd ' + REPO + ' && npx tsc -p tsconfig.json) clean; (cd ' + REPO + ' && npx eslint <your .ts files>); (cd ' + REPO + ' && npx tsx scripts/gates/check_clock_random.ts); (cd ' + REPO + ' && npx vitest run <your test files>).',
].join('\n')

const REUSE = [
  'ALREADY PORTED — REUSE, DO NOT re-implement:',
  '- #contracts/diff_chunking.v1.js — DiffChunkV1 (the chunk contract) + computeChunkId(path, startLine, endLine, body). Grep its EXACT field names + computeChunkId signature; build every chunk through it (chunk_id parity is the strongest single proof).',
  '- #backend/redact/* — the ported PII + secret redactors (grep for the redactPII / detectSecrets / the inline-redact entry the activity needs). The redaction half is DONE; the activity REUSES it.',
  '- The vendored grammars: ' + GRAM + '/{tree-sitter-python,tree-sitter-javascript,tree-sitter-typescript}.wasm + manifest.json (pinned SHA-256).',
].join('\n')

phase('LoaderPython')

const P1 = [
  'Port the tree-sitter GRAMMAR LOADER + the PYTHON chunker (chunk step, part 1) to TypeScript, 1:1 with frozen Python. web-tree-sitter/WASM per ADR-0067.',
  STYLE, REUSE,
  'READ FULLY: ' + CK + '/treesitter_python.py (the parity-critical core: _FUNCTION_NODE_TYPES={function_definition,async_function_definition}, _CLASS_NODE_TYPES={class_definition}, decorated_definition handling [the anchor/outer-node span incl. decorators], the chunk() flow [_assert_diff_size >50K lines reject; parse; _extract_candidates over root.children; hunk-range intersection filter via _overlaps line-range; module-level fallback when no candidates or no hunk overlap], _extract_candidates [start_line=node.start_point[0]+1, end_line=node.end_point[0]+1, the `end_point[1]==0 and end_line>start_line -> end_line-=1` backup, slice_body="".join(lines[start_line-1:end_line]) via body.splitlines(keepends=True)], token estimate len(body)//4, the parse-error single-module-chunk fallback) and ' + CK + '/chunker_port.py (the ChunkerPort protocol: chunk({path, body: bytes, hunk_ranges}) -> DiffChunkV1[]; MAX_DIFF_LINES) and ' + CK + '/selector.py (just the extension constants for context).',
  'PORT TO:',
  '- ' + REPO + '/apps/backend/src/backend/chunking/treesitter_loader.ts — initialize web-tree-sitter once; load the 4 grammars (python, typescript, tsx, javascript) from the vendored wasm; a parser cache (mirrors Python class-level _parser/_parsers). A startupSelfCheck() that loads every required grammar AND verifies each wasm file SHA-256 against grammars/manifest.json (fail loud) — per ADR-0067 cond 3. Export a getParser(lang)/getLanguage(lang) seam.',
  '- ' + REPO + '/apps/backend/src/backend/chunking/treesitter_python.ts — the Python chunker implementing the ChunkerPort shape (chunk({path, body, hunkRanges})). body is bytes (Uint8Array/Buffer) — decode UTF-8 with replacement to a string for parsing + line-slicing (match Python body.decode errors="replace"). LINE-based per the STYLE note. Handle decorated_definition (span includes decorators). Hunk intersection + module fallback + parse-error fallback EXACTLY.',
  'GOLDEN PARITY: tools/parity/run_chunk_python_ref.py drives the frozen Python python-chunker over the fixtures and dumps DiffChunkV1 tuples as JSON. test/parity/chunk_python.parity.test.ts runs the TS python chunker on the SAME (path, body, hunk_ranges) and asserts byte-parity of the DiffChunkV1 list (chunk_id, start_line, end_line, body, language, chunk_kind, token_estimate). COVER: the simple cases at ' + FIX + '/python/{async_def,class_def,decorated_def,function_def}.py AND the 50-file corpus at ' + FIX + '/sample_corpus/python/sample_*.py (whole-file: hunk_ranges=() -> all top-level defs; AND a with-hunks case restricting to a subset). The 50-file corpus byte-parity is the acceptance bar.',
  'Also a loader unit test test/unit/chunking/treesitter_loader.test.ts (all 4 grammars load; the SHA self-check passes; a parse smoke).',
  'Return component="chunk_loader_python", files_written, commands, all_green, notes: the loader API + self-check, the decorated-def span handling, the col-0 backup, the fallback triggers, the token//4 integer-div, the web-tree-sitter init/path-resolution approach, corpus parity count, and any divergence risk for the verifier.',
].join('\n')

const p1 = await agent(P1, { label: 'port:loader+python', phase: 'LoaderPython', schema: BUILD_SCHEMA })

phase('TsJs')

const P2 = [
  'Port the TS/JS tree-sitter chunker (chunk step, part 2) to TypeScript, 1:1 with frozen Python. Depends on part 1 (treesitter_loader.ts — REUSE its getParser/getLanguage).',
  STYLE, REUSE,
  'Part-1 built (reuse its loader): ' + JSON.stringify(p1).slice(0, 400),
  'READ FULLY: ' + CK + '/treesitter_tsjs.py — _FUNCTION_NODE_TYPES={function_declaration,function_expression}, _CLASS_NODE_TYPES={class_declaration,abstract_class_declaration}, _EXPORT_WRAPPER_TYPES={export_statement,export_default_declaration}; the lexical_declaration -> variable_declarator -> arrow_function/function_expression handling (emit function-kind); _LANG_BY_EXT {.ts:typescript, .tsx:tsx, .js/.jsx/.mjs/.cjs:javascript}; the 3 parsers (typescript=language_typescript(), tsx=language_tsx(), javascript=language()); _iter_top_level_decls (descend through export wrappers, yield inner decl); the SAME line-based byte->line mapping + col-0 backup + hunk filter + module fallback as the python chunker.',
  'PORT TO: ' + REPO + '/apps/backend/src/backend/chunking/treesitter_tsjs.ts — the TS/JS chunker (ChunkerPort shape). The vendored tree-sitter-typescript.wasm is the typescript variant; tsx uses the SAME typescript wasm? NO — CHECK: the manifest vendors tree-sitter-typescript.wasm (language_typescript). If .tsx needs a separate tsx grammar wasm (language_tsx) that is NOT vendored, NOTE it as a gap (vendor tree-sitter-tsx.wasm from the tarball in a follow-up) and route .tsx through the typescript grammar with a documented caveat, OR vendor the tsx wasm if present in the tarball. Match Python parser selection.',
  'GOLDEN PARITY: extend run_chunk_python_ref.py (or a sibling run_chunk_tsjs_ref.py) to drive the frozen Python tsjs-chunker; test/parity/chunk_tsjs.parity.test.ts asserts DiffChunkV1 byte-parity over ' + FIX + '/sample_corpus/{typescript,javascript}/ (and the ts/js simple fixtures if present). Whole-file + with-hunks. Byte-parity over the corpus is the bar.',
  'Return component="chunk_tsjs", files_written, commands, all_green, notes: the export-wrapper descent, the arrow/lexical-decl handling, the 3-language dispatch + the tsx-wasm decision, corpus parity count, divergence risk for the verifier.',
].join('\n')

const p2 = await agent(P2, { label: 'port:tsjs', phase: 'TsJs', schema: BUILD_SCHEMA })

phase('PostAndActivity')

const P3 = [
  'Port the chunker POST-PASSES + selector + the chunk_and_redact ACTIVITY (chunk step, part 3) to TypeScript, 1:1 with frozen Python. Depends on parts 1+2 (the chunkers).',
  STYLE, REUSE,
  'Parts 1+2 built: ' + JSON.stringify({ p1: p1.component, p2: p2.component }).slice(0, 200),
  'READ FULLY:',
  '- ' + CK + '/token_budget.py — estimate_tokens (len(body)/4 base + the R-18 non-ASCII >10% -> 2.5x factor; match the exact threshold + multiplier + rounding), MAX_CHUNK_TOKENS=6000, enforce_token_budget (queue; pass-through if <=max preserving identity; else _split_once at line midpoint mid=n_lines//2, left_end=start_line+mid-1, right_start=left_end+1, recompute chunk_id, re-queue; single-line oversized returned unchanged).',
  '- ' + CK + '/batcher.py — batch_adjacent(chunks, budget_tokens=2000): group adjacent same-directory chunks under budget; single-file groups unchanged; multi-file -> one chunk_kind="batch" chunk with body separators "--- <path>:<start>-<end> ---" and metadata (start_line=1, end_line=total, path="<dir>/[<n> files]").',
  '- ' + CK + '/hunk_fallback.py — the NON-PARITY fallback: per hunk expand by line_window (default 20) both sides, clamp, merge overlapping, emit chunk_kind="hunk" DiffChunkV1; the extension->language label table; unknown ext -> language=None. Mark NON-PARITY in code + tests (best-effort).',
  '- ' + CK + '/selector.py — ChunkerRegistry.select_for(path): .py -> python; {.ts,.tsx,.js,.jsx,.mjs,.cjs} -> tsjs; else fallback. _extract_extension (case-insensitive, dotfiles, compound ext). build() constructing the 3 singletons.',
  '- ' + ACT + '/chunk_and_redact.py (chunk_and_redact_activity: workspace_path, files, changed_line_ranges -> DiffChunkV1[]; per file read body from disk, select_for, chunk(path, body, hunk_ranges), accumulate, _redact_chunks_inline [REUSE the ported redaction], return) and ' + ACT + '/redact_chunks.py (the standalone redact_chunks activity — thin wrapper over the ported redactors).',
  'PORT TO: apps/backend/src/backend/chunking/{token_budget,batcher,hunk_fallback,selector}.ts + apps/backend/src/backend/activities/chunk_and_redact.activity.ts (+ redact_chunks if it is a distinct wired activity). Use the single-typed-input pattern (inv-11) for the activity envelope if the Python takes >1 positional arg — define a CONTRACT (e.g. ChunkAndRedactInputV1 in libs/contracts) with a parity test.',
  'TESTS: token_budget parity (oversized -> deterministic midpoint split), batcher parity (multi-file grouping), hunk_fallback unit (NON-parity sanity), selector unit (dispatch + ext extraction edge cases), and the activity unit/integration (a temp workspace with a couple files -> DiffChunkV1[] with redaction markers; drive the frozen Python activity for parity where feasible).',
  'Return component="chunk_post_activity", files_written, commands, all_green, notes: the non-ASCII token factor, the split/batch determinism, the selector dispatch, the activity envelope contract + inv-11, the redaction reuse, divergence risk for the verifier.',
].join('\n')

const p3 = await agent(P3, { label: 'port:post+activity', phase: 'PostAndActivity', schema: BUILD_SCHEMA })

phase('Verify')

const VERIFY = [
  'ADVERSARIAL Tier-1 verifier for the tree-sitter chunker. REFUTE that the TS chunker produces DiffChunkV1 lists byte-equal to the frozen Python over the WHOLE fixture corpus + that the post-passes + activity match.',
  STYLE,
  'Built: ' + JSON.stringify({ p1: p1.component, p2: p2.component, p3: p3.component }).slice(0, 300),
  'Independently drive BOTH the frozen Python chunkers (' + PY + ', codemaster.chunking.*) and the TS chunkers via throwaway scratch (UNIQUE names; delete after). Byte-compare the DiffChunkV1 tuples (chunk_id, path, start_line, end_line, body, language, chunk_kind, token_estimate).',
  '1. PYTHON CORPUS: every ' + FIX + '/sample_corpus/python/sample_*.py (all 50) whole-file (hunk_ranges=()) -> DiffChunkV1 list byte-equal. Plus a with-hunks subset case. ANY file diverging = WEAK; report the file + the first diverging chunk field.',
  '2. TS/JS CORPUS: every ' + FIX + '/sample_corpus/{typescript,javascript}/* -> byte-equal. Include an .tsx case if present (note the tsx-grammar decision).',
  '3. EDGE CASES: a file with NO top-level defs (module fallback); a syntactically-broken file (parse-error fallback); a decorated def (python); an export-wrapped + arrow-function decl (tsjs); a non-ASCII file (rows match — the line-based invariant).',
  '4. POST-PASSES: an oversized chunk (>6000 tok) -> enforce_token_budget splits identically (same count + boundaries) on both sides; estimate_tokens with >10% non-ASCII -> the 2.5x factor matches; batch_adjacent over a multi-file set -> identical batches.',
  '5. ACTIVITY: chunk_and_redact end-to-end over a small temp workspace (2-3 files incl. a secret/PII) -> DiffChunkV1[] with redaction applied, matching the frozen Python activity.',
  'Run (cd ' + REPO + ' && npx vitest run <the chunk tests>) + check_clock_random; tsc clean (delete scratch FIRST). verdict=WEAK if ANY corpus file, edge case, post-pass, or the activity diverges; SOUND otherwise. Report the exact diverging file/chunk/field. Clean up ALL scratch.',
].join('\n')

const verify = await agent(VERIFY, { label: 'verify:chunker', phase: 'Verify', schema: VERIFY_SCHEMA })

return { p1, p2, p3, verify }
