// Tree-sitter grammar loader — 1:1 port of the frozen Python class-level parser caches
// (vendor/codemaster-py/codemaster/chunking/treesitter_python.py::TreeSitterPythonChunker._get_parser
// and treesitter_tsjs.py::TreeSitterTsJsChunker._parsers).
//
// web-tree-sitter / WASM adoption per ADR-0067: the grammar .wasm artifacts are VENDORED alongside
// this module (./grammars/*.wasm, pinned by SHA-256 in ./grammars/manifest.json) and loaded from disk
// at startup. They are NEVER fetched at runtime — that is the load-bearing condition of the dep
// adoption (ADR-0067 cond 2 "no_runtime_fetch").
//
// Parity-critical: the chunk boundaries these grammars produce ARE the per-chunk LLM input, so the
// grammar versions MUST match the frozen Python reference exactly. `startupSelfCheck()` verifies each
// required .wasm SHA-256 against the manifest (ADR-0067 cond 3 "fail loud on tamper/drift") and loads
// every required grammar so a missing/corrupt artifact crashes at boot, not mid-review.
//
// Process-wide singletons: `Parser.init()` runs once; each grammar Language + its bound Parser are
// cached. Mirrors the Python class-level `_parser` / `_parsers` caches — the parser warms up once per
// worker, not per file.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Language, Parser } from "web-tree-sitter";

/** Logical grammar names the loader knows how to load. Mirrors the frozen Python grammar set:
 *  the Python chunker uses `python`; the TS/JS chunker uses `typescript` / `tsx` / `javascript`. */
export type GrammarName = "python" | "typescript" | "tsx" | "javascript";

/** Resolve the vendored grammars directory relative to THIS module (import.meta.url) so the path is
 *  correct under both the tsc-built dist tree AND vitest's in-place ESM execution. */
const GRAMMARS_DIR = join(dirname(fileURLToPath(import.meta.url)), "grammars");

/** Filename of each grammar's vendored .wasm, relative to {@link GRAMMARS_DIR}. The `.ts` and `.tsx`
 *  variants are TWO distinct languages exported from the tree-sitter-typescript tarball — typescript
 *  (`language_typescript()`) and tsx (`language_tsx()`, which parses JSX). Both .wasm are vendored;
 *  `.tsx` MUST use the tsx grammar to match the Python reference byte-for-byte on JSX. */
const GRAMMAR_WASM: Readonly<Record<GrammarName, string>> = {
  python: "tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
};

/** Manifest-key for each grammar (each logical name has its own manifest entry). */
const MANIFEST_KEY: Readonly<Record<GrammarName, string>> = {
  python: "python",
  typescript: "typescript",
  tsx: "tsx",
  javascript: "javascript",
};

/** The grammars the self-check loads + SHA-verifies. Every logical name the chunkers route to. */
const REQUIRED_GRAMMARS: ReadonlyArray<GrammarName> = ["python", "typescript", "tsx", "javascript"];

/** Shape of grammars/manifest.json (only the fields the self-check reads). */
type Manifest = {
  readonly grammars: Readonly<Record<string, { readonly wasm: string; readonly sha256: string }>>;
};

let initPromise: Promise<void> | undefined;
const languageCache = new Map<GrammarName, Language>();
const parserCache = new Map<GrammarName, Parser>();

/** Run `Parser.init()` exactly once, process-wide (idempotent; safe under concurrent callers). */
async function ensureInit(): Promise<void> {
  initPromise ??= Parser.init();
  await initPromise;
}

/** Load (and cache) the {@link Language} for `name` from its vendored .wasm. Idempotent. */
export async function getLanguage(name: GrammarName): Promise<Language> {
  const cached = languageCache.get(name);
  if (cached) {
    return cached;
  }
  await ensureInit();
  // eslint-disable-next-line security/detect-object-injection -- `name` is a GrammarName literal union; the lookup is a frozen const map, not user input
  const wasmPath = join(GRAMMARS_DIR, GRAMMAR_WASM[name]);
  const lang = await Language.load(wasmPath);
  languageCache.set(name, lang);
  return lang;
}

/** Return (and cache) a {@link Parser} with `name`'s grammar bound. Mirrors the Python class-level
 *  parser cache: one parser per grammar per process, reused across every chunk call. */
export async function getParser(name: GrammarName): Promise<Parser> {
  const cached = parserCache.get(name);
  if (cached) {
    return cached;
  }
  const lang = await getLanguage(name);
  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(name, parser);
  return parser;
}

/** Read + parse grammars/manifest.json. */
async function loadManifest(): Promise<Manifest> {
  const raw = await readFile(join(GRAMMARS_DIR, "manifest.json"), "utf-8");
  return JSON.parse(raw) as Manifest;
}

/** Hex-lowercase SHA-256 of a file's bytes. */
async function sha256OfFile(absPath: string): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- absPath is a repo-vendored grammar path joined from a const dir + a const filename; never user-derived
  const bytes = await readFile(absPath);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verify every required grammar .wasm against the pinned SHA-256 in the manifest AND load each
 * grammar so a missing / corrupt artifact fails loud at startup (ADR-0067 cond 3). Throws on the
 * FIRST mismatch / missing manifest entry with a precise message; on success every required grammar
 * is loaded + cached, so the first real chunk call hits a warm parser.
 *
 * Call this once at worker / service boot. Idempotent (re-verifies; caches make re-loads cheap).
 */
export async function startupSelfCheck(): Promise<void> {
  const manifest = await loadManifest();
  for (const name of REQUIRED_GRAMMARS) {
    // eslint-disable-next-line security/detect-object-injection -- `name` is a GrammarName literal union; these are frozen const maps, not user input
    const key = MANIFEST_KEY[name];
    // `key` is a fixed manifest section name derived from the literal union; the manifest is a repo file.
    // eslint-disable-next-line security/detect-object-injection
    const entry = manifest.grammars[key];
    if (!entry) {
      throw new Error(`treesitter_loader self-check: manifest has no entry for grammar "${key}"`);
    }
    // eslint-disable-next-line security/detect-object-injection -- `name` is a GrammarName literal union; frozen const map
    const wasmFile = GRAMMAR_WASM[name];
    if (entry.wasm !== wasmFile) {
      throw new Error(
        `treesitter_loader self-check: manifest "${key}".wasm=${entry.wasm} ` +
          `but loader expects ${wasmFile}`,
      );
    }
    const actual = await sha256OfFile(join(GRAMMARS_DIR, wasmFile));
    if (actual !== entry.sha256) {
      throw new Error(
        `treesitter_loader self-check: SHA-256 mismatch for ${wasmFile} — ` +
          `expected ${entry.sha256}, got ${actual}. The vendored grammar drifted from the pin; ` +
          `chunk boundaries would no longer match the frozen Python reference (ADR-0067).`,
      );
    }
    // Load (and cache) the grammar so a corrupt-but-right-hash artifact still fails loud here.
    await getLanguage(name);
  }
}

/** Test-only seam: drop all cached parsers/languages so a self-check can be re-exercised in
 *  isolation. NOT used in production (the caches are process-lifetime singletons). */
export function _resetCachesForTest(): void {
  languageCache.clear();
  parserCache.clear();
  initPromise = undefined;
}
