/**
 * Sanity tests for the bundled-config resolver + the uuid4 minter.
 *
 *   - `RUFF_CONFIG_PATH` / `ESLINT_CONFIG_PATH` resolve via `import.meta.url` (NOT cwd) and the
 *     files exist + carry codemaster's opinionated baseline. This catches the build-asset-copy
 *     regression class: if the assets aren't where the resolver points, the runners can't pass
 *     `--config` and the bundled baseline silently doesn't apply.
 *   - `uuid4()` mints a canonical lowercase RFC4122 v4 UUID (the AnalysisFindingV1.finding_id shape).
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ESLINT_CONFIG_PATH, RUFF_CONFIG_PATH } from "#backend/analysis/config_assets.js";
import { uuid4 } from "#backend/analysis/uuid4.js";

describe("bundled config assets", () => {
  it("RUFF_CONFIG_PATH points at codemaster's bundled ruff.toml", () => {
    expect(RUFF_CONFIG_PATH).toMatch(/config[/\\]static_analysis[/\\]ruff\.toml$/);
    const body = readFileSync(RUFF_CONFIG_PATH, "utf8");
    // the baseline selects the security (S) + bugbear (B) + pyflakes (F) families.
    expect(body).toContain('"S"');
    expect(body).toContain('"B"');
    expect(body).toContain('"F"');
  });

  it("ESLINT_CONFIG_PATH points at codemaster's bundled eslint.config.mjs", () => {
    expect(ESLINT_CONFIG_PATH).toMatch(/config[/\\]static_analysis[/\\]eslint[/\\]eslint\.config\.mjs$/);
    const body = readFileSync(ESLINT_CONFIG_PATH, "utf8");
    expect(body).toContain('"no-eval": "error"');
    expect(body).toContain('"no-var": "error"');
  });
});

describe("uuid4", () => {
  const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("mints a canonical lowercase RFC4122 v4 UUID", () => {
    for (let i = 0; i < 50; i++) {
      expect(uuid4()).toMatch(UUID_V4_RE);
    }
  });

  it("is collision-free across many mints", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(uuid4());
    expect(seen.size).toBe(1000);
  });
});
