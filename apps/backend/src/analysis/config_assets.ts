/**
 * Bundled static-analysis config resolution.
 *
 * codemaster ships its OWN opinionated Ruff + ESLint baselines (copied verbatim from
 * `vendor/codemaster-py/codemaster/config/static_analysis/`). The runners pass these via `--config`
 * so the source repo's own `pyproject.toml` / `eslint.config.*` can never win over the bot's
 * baseline (memory: feedback_platform_owned_review_baseline.md — repos may ADD rules later, never
 * WEAKEN the baseline).
 *
 * Resolution is via `import.meta.url`, NOT `process.cwd()`: the runner executes in the activity with
 * `cwd=workspace` (the cloned PR), so a cwd-relative path would point into the PR, not into
 * codemaster's bundled assets. Mirrors the chunker's grammar loader
 * (`apps/backend/src/chunking/treesitter_loader.ts`), which resolves its vendored `.wasm` the same
 * way so the path is correct under BOTH vitest's in-place ESM run AND the tsc-built `dist/` tree.
 *
 * Build note (owner-provided infra): `tsc` emits only `.js`; the `.toml` / `.mjs` assets must be
 * copied into `dist/apps/backend/src/config/static_analysis/` by the build step (the analogue of
 * `scripts/build_copy_grammars.mjs` for the tree-sitter grammars). The build wiring is owned by the
 * Integrate/build phase; this module only resolves the path. Under vitest / tsx the `src/` copy is
 * resolved directly.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of THIS module (`apps/backend/src/analysis/` in src; the mirrored dir under `dist/`). */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Bundled config root, relative to this module. */
const CONFIG_ROOT = join(MODULE_DIR, "..", "config", "static_analysis");

/** Absolute path to codemaster's bundled Ruff config (`ruff.toml`). */
export const RUFF_CONFIG_PATH: string = join(CONFIG_ROOT, "ruff.toml");

/** Absolute path to codemaster's bundled ESLint flat config (`eslint.config.mjs`). */
export const ESLINT_CONFIG_PATH: string = join(CONFIG_ROOT, "eslint", "eslint.config.mjs");
