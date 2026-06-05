import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  _resetCachesForTest,
  getLanguage,
  getParser,
  startupSelfCheck,
  type GrammarName,
} from "#backend/chunking/treesitter_loader.js";

// Loader unit test: every required grammar loads, the SHA-256 self-check passes against the pinned
// manifest, and a freshly-loaded parser actually parses a trivial source. The loader owns the
// process-wide web-tree-sitter init + parser cache (ADR-0067); these assertions are the boot-time
// contract the worker relies on (a missing / drifted .wasm must fail loud here, not mid-review).

const GRAMMARS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "backend",
  "src",
  "backend",
  "chunking",
  "grammars",
);

const REQUIRED: ReadonlyArray<GrammarName> = ["python", "typescript", "tsx", "javascript"];

type ManifestEntry = { readonly wasm: string; readonly sha256: string };
type Manifest = { readonly grammars: Readonly<Record<string, ManifestEntry>> };

beforeAll(async () => {
  // web-tree-sitter Parser.init() must run before any Language.load; the loader does this lazily,
  // but warming it in beforeAll keeps each `it` deterministic and fast.
  await startupSelfCheck();
});

describe("treesitter_loader", () => {
  it("loads all 4 grammars (python, typescript, tsx, javascript)", async () => {
    for (const name of REQUIRED) {
      const lang = await getLanguage(name);
      expect(lang, `grammar ${name} failed to load`).toBeDefined();
    }
  });

  it("getParser returns a parser bound to each grammar (cached singleton)", async () => {
    for (const name of REQUIRED) {
      const a = await getParser(name);
      const b = await getParser(name);
      expect(a, `parser ${name} undefined`).toBeDefined();
      // Same process-wide cached instance on the second call (mirrors the Python class-level cache).
      expect(a).toBe(b);
    }
  });

  it("startupSelfCheck verifies every required .wasm SHA-256 against the manifest", async () => {
    const raw = await readFile(join(GRAMMARS_DIR, "manifest.json"), "utf-8");
    const manifest = JSON.parse(raw) as Manifest;
    // Independently recompute each pinned hash so this test would catch a manifest that was edited to
    // match a tampered artifact (the self-check and the manifest must agree with the bytes on disk).
    for (const key of ["python", "typescript", "javascript"] as const) {
      const entry = manifest.grammars[key];
      expect(entry, `manifest missing ${key}`).toBeDefined();
      const bytes = await readFile(join(GRAMMARS_DIR, entry!.wasm));
      const actual = createHash("sha256").update(bytes).digest("hex");
      expect(actual, `SHA mismatch for ${entry!.wasm}`).toBe(entry!.sha256);
    }
    // And the loader's own self-check passes (it loads + SHA-verifies every required grammar).
    await expect(startupSelfCheck()).resolves.toBeUndefined();
  });

  it("re-runs cleanly after a cache reset (idempotent self-check)", async () => {
    _resetCachesForTest();
    await expect(startupSelfCheck()).resolves.toBeUndefined();
  });

  it("a freshly-loaded python parser parses a trivial source (smoke)", async () => {
    const parser = await getParser("python");
    const tree = parser.parse("def f():\n    return 1\n");
    expect(tree).not.toBeNull();
    const root = tree!.rootNode;
    expect(root.type).toBe("module");
    // The single top-level statement is a function_definition starting at row 0.
    const top = root.children.filter((c) => c !== null);
    expect(top.length).toBe(1);
    expect(top[0]!.type).toBe("function_definition");
    expect(top[0]!.startPosition.row).toBe(0);
  });
});
