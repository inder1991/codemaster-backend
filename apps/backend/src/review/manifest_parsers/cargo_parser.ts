// Rust (Cargo) dependency parsers — 1:1 TS port of the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_cargo.py
//   (Commit 5 of FOLLOW-UP-manifest-dependency-parsing).
//
// Covers Cargo.toml + Cargo.lock. Pure module: NO I/O, NO clock/random/crypto. Sandbox-safe (runs in the
// parse_manifest_dependencies activity, not the workflow body). Both bodies are TOML — parsed via the
// shared `parseTomlManifest` adapter (the ONLY TOML import seam), and any parse failure / non-table root
// degrades THAT manifest to an empty ParseOutcome (fail-open), exactly as the Python catches
// `tomllib.TOMLDecodeError`.

import { ParsedDependencyV1 } from "#contracts/pr_context.v1.js";

import { isRejection, normalizeName, type NormalizationRejection } from "./normalize.js";
import type { ParseOutcome } from "./parse_outcome.js";
import { parseTomlManifest } from "./toml_adapter.js";

// Mirrors the Python `_VERSION_SPEC_MAX_LENGTH` — over-long specs are TRUNCATED (not rejected) before the
// contract sees them, matching `ParsedDependencyV1.version_spec`'s max_length=256.
const VERSION_SPEC_MAX_LENGTH = 256;

/** A Cargo dependency type — `"prod" | "dev" | "unknown"` per the Python `dependency_type` literals. */
type CargoDependencyType = "prod" | "dev" | "unknown";

/**
 * Parse a Cargo.toml body. Honors `[dependencies]` (prod), `[dev-dependencies]` + `[build-dependencies]`
 * (dev), and `[target.*.dependencies]` (prod). Inline-table values like
 * `tokio = { version = "1", features = ["full"] }` are unpacked to extract the `.version` field. A TOML
 * parse failure / non-table root degrades to an empty ParseOutcome (fail-open).
 */
export function parseCargoToml({
  body,
  source_manifest,
}: {
  body: string;
  source_manifest: string;
}): ParseOutcome {
  let data: Record<string, unknown>;
  try {
    data = parseTomlManifest(body);
  } catch {
    return { records: [], rejections: [] };
  }

  const records: Array<ParsedDependencyV1> = [];
  const rejections: Array<NormalizationRejection> = [];

  const sections: ReadonlyArray<readonly [string, CargoDependencyType]> = [
    ["dependencies", "prod"],
    ["dev-dependencies", "dev"],
    ["build-dependencies", "dev"],
  ];

  for (const [sectionKey, depType] of sections) {
    const section = data[sectionKey];
    if (!isPlainObject(section)) {
      continue;
    }
    for (const [rawName, rawSpec] of Object.entries(section)) {
      const versionSpec = extractCargoVersion(rawSpec);
      emitCargo({
        rawName,
        versionSpec,
        dependencyType: depType,
        sourceManifest: source_manifest,
        records,
        rejections,
      });
    }
  }

  // [target.<triple>.dependencies] — walk nested.
  const target = data["target"];
  if (isPlainObject(target)) {
    for (const tripleData of Object.values(target)) {
      if (!isPlainObject(tripleData)) {
        continue;
      }
      const deps = tripleData["dependencies"];
      if (!isPlainObject(deps)) {
        continue;
      }
      for (const [rawName, rawSpec] of Object.entries(deps)) {
        const versionSpec = extractCargoVersion(rawSpec);
        emitCargo({
          rawName,
          versionSpec,
          dependencyType: "prod",
          sourceManifest: source_manifest,
          records,
          rejections,
        });
      }
    }
  }

  return { records, rejections };
}

/**
 * Parse a Cargo.lock body. Walks the `[[package]]` array-of-tables; each entry has name + version.
 * `dependency_type` is `"unknown"` (a lockfile doesn't carry scope). A TOML parse failure / non-table
 * root degrades to an empty ParseOutcome (fail-open).
 */
export function parseCargoLock({
  body,
  source_manifest,
}: {
  body: string;
  source_manifest: string;
}): ParseOutcome {
  let data: Record<string, unknown>;
  try {
    data = parseTomlManifest(body);
  } catch {
    return { records: [], rejections: [] };
  }

  const records: Array<ParsedDependencyV1> = [];
  const rejections: Array<NormalizationRejection> = [];

  const packages = data["package"];
  if (!Array.isArray(packages)) {
    return { records: [], rejections: [] };
  }

  for (const entry of packages) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const rawName = entry["name"];
    const version = entry["version"];
    if (typeof rawName !== "string") {
      continue;
    }
    const versionSpec = typeof version === "string" ? version : null;
    emitCargo({
      rawName,
      versionSpec,
      dependencyType: "unknown",
      sourceManifest: source_manifest,
      records,
      rejections,
    });
  }

  return { records, rejections };
}

/**
 * Cargo dependency values can be:
 *   - a plain string version: `serde = "1.0"`
 *   - an inline table: `tokio = { version = "1", features = ["full"] }`
 *   - a git/path table without a version field.
 * Returns the version string when extractable, else null (1:1 with Python `_extract_cargo_version`).
 */
function extractCargoVersion(rawSpec: unknown): string | null {
  if (typeof rawSpec === "string") {
    return rawSpec;
  }
  if (isPlainObject(rawSpec)) {
    const v = rawSpec["version"];
    return typeof v === "string" ? v : null;
  }
  return null;
}

/**
 * Normalize the name, drop on rejection, truncate an over-long version spec, then append the constructed
 * record (1:1 with Python `_emit_cargo`). The record is validated through `ParsedDependencyV1.parse` so it
 * fails exactly as the Pydantic model would — but the version-spec truncation here means the contract's
 * max_length=256 never trips for that field, matching the Python ordering.
 */
function emitCargo({
  rawName,
  versionSpec,
  dependencyType,
  sourceManifest,
  records,
  rejections,
}: {
  rawName: string;
  versionSpec: string | null;
  dependencyType: CargoDependencyType;
  sourceManifest: string;
  records: Array<ParsedDependencyV1>;
  rejections: Array<NormalizationRejection>;
}): void {
  const normalized = normalizeName(rawName, "cargo");
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
      ecosystem: "cargo",
      name: normalized,
      version_spec: spec,
      dependency_type: dependencyType,
      source_manifest: sourceManifest,
    }),
  );
}

/** True for a non-null, non-array object (the TS analogue of Python's `isinstance(x, dict)`). The TOML
 *  adapter returns plain objects for tables, so this discriminates tables from strings / numbers / arrays. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
