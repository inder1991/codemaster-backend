// PHP (Composer) dependency parsers — 1:1 TS port of the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_composer.py
//   (Commit 5 of FOLLOW-UP-manifest-dependency-parsing).
//
// Covers composer.json + composer.lock. Both are JSON.
//
// Pure module: NO I/O, NO clock/random/crypto. Sandbox-safe.
//   * composer.json — `require` (prod) + `require-dev` (dev). Each value maps name → spec; the `php`
//     pseudo-dep is skipped (runtime constraint, not a package). `ext-*` keys are NOT special-cased —
//     they normalize cleanly and produce records, matching the Python.
//   * composer.lock — `packages` (prod) + `packages-dev` (dev) arrays; each entry has name + version.
//
// Names are normalized via {@link normalizeName} with ecosystem="composer"; rejected names land in
// `rejections`. Malformed JSON / non-object root → empty {@link ParseOutcome} (fail-open).

import { ParsedDependencyV1 } from "#contracts/pr_context.v1.js";

import { type NormalizationRejection, isRejection, normalizeName } from "./normalize.js";
import type { ParseOutcome } from "./parse_outcome.js";

/** Matches the contract field's `max_length`; truncation is defensive so the parse never throws on an
 *  adversarial version_spec. 1:1 with the Python `_VERSION_SPEC_MAX_LENGTH`. */
const VERSION_SPEC_MAX_LENGTH = 256;

/** One parsed composer dependency `dependency_type`. Mirrors the Python `Literal[...]`. */
type ComposerDependencyType = "prod" | "dev" | "optional" | "test" | "unknown";

/** Narrow an unknown to a plain object (Python `isinstance(x, dict)`). Arrays / null are excluded. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a composer.json body. `require` → prod, `require-dev` → dev. The `php` pseudo-dep is skipped
 * (it's a runtime constraint, not a package). Malformed JSON or a non-object root → empty outcome.
 */
export function parseComposerJson({
  body,
  source_manifest,
}: {
  body: string;
  source_manifest: string;
}): ParseOutcome {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { records: [], rejections: [] };
  }

  const records: Array<ParsedDependencyV1> = [];
  const rejections: Array<NormalizationRejection> = [];

  if (!isObject(data)) {
    return { records: [], rejections: [] };
  }

  const sections: ReadonlyArray<readonly [string, ComposerDependencyType]> = [
    ["require", "prod"],
    ["require-dev", "dev"],
  ];
  for (const [sectionKey, depType] of sections) {
    const section = data[sectionKey];
    if (!isObject(section)) {
      continue;
    }
    for (const [rawName, rawSpec] of Object.entries(section)) {
      if (rawName === "php") {
        // runtime constraint, not a package
        continue;
      }
      const versionSpec = typeof rawSpec === "string" ? rawSpec : null;
      emitComposer({
        rawName,
        versionSpec,
        dependencyType: depType,
        source_manifest,
        records,
        rejections,
      });
    }
  }

  return { records, rejections };
}

/**
 * Parse a composer.lock body. Walks `packages` (prod) + `packages-dev` (dev) arrays. Each entry has a
 * name + version. Malformed JSON or a non-object root → empty outcome.
 */
export function parseComposerLock({
  body,
  source_manifest,
}: {
  body: string;
  source_manifest: string;
}): ParseOutcome {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { records: [], rejections: [] };
  }

  const records: Array<ParsedDependencyV1> = [];
  const rejections: Array<NormalizationRejection> = [];

  if (!isObject(data)) {
    return { records: [], rejections: [] };
  }

  const sections: ReadonlyArray<readonly [string, ComposerDependencyType]> = [
    ["packages", "prod"],
    ["packages-dev", "dev"],
  ];
  for (const [sectionKey, depType] of sections) {
    const section = data[sectionKey];
    if (!Array.isArray(section)) {
      continue;
    }
    for (const entry of section) {
      if (!isObject(entry)) {
        continue;
      }
      const rawName = entry["name"];
      const version = entry["version"];
      if (typeof rawName !== "string") {
        continue;
      }
      const versionSpec = typeof version === "string" ? version : null;
      emitComposer({
        rawName,
        versionSpec,
        dependencyType: depType,
        source_manifest,
        records,
        rejections,
      });
    }
  }

  return { records, rejections };
}

/**
 * Normalize the name; on rejection append to `rejections`, else truncate the version_spec to the
 * contract cap and append a {@link ParsedDependencyV1}. 1:1 with the Python `_emit_composer`.
 */
function emitComposer({
  rawName,
  versionSpec,
  dependencyType,
  source_manifest,
  records,
  rejections,
}: {
  rawName: string;
  versionSpec: string | null;
  dependencyType: ComposerDependencyType;
  source_manifest: string;
  records: Array<ParsedDependencyV1>;
  rejections: Array<NormalizationRejection>;
}): void {
  const normalized = normalizeName(rawName, "composer");
  if (isRejection(normalized)) {
    rejections.push(normalized);
    return;
  }
  let spec = versionSpec;
  if (spec !== null && spec.length > VERSION_SPEC_MAX_LENGTH) {
    spec = spec.slice(0, VERSION_SPEC_MAX_LENGTH);
  }
  records.push(
    ParsedDependencyV1.parse({
      ecosystem: "composer",
      name: normalized,
      version_spec: spec,
      dependency_type: dependencyType,
      source_manifest,
    }),
  );
}
