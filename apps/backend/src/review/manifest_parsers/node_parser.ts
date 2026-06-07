// Node ecosystem dependency parsers — 1:1 TS port of the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_node.py
//   (Commit 4 of FOLLOW-UP-manifest-dependency-parsing).
//
// Covers package.json (top-level manifest) + package-lock.json (lockfile v1 + v2+). Only top-level
// direct dependencies are emitted from lockfiles to honor MAX_DEPENDENCIES_PER_MANIFEST; the full
// transitive walk stays out of v1 scope.
//
// Pure functions: NO I/O, NO clock, NO random. Both parsers JSON.parse the body; on failure they
// return an empty ParseOutcome (fail-open) — identical to the Python `json.JSONDecodeError` handler.

import { ParsedDependencyV1 } from "#contracts/pr_context.v1.js";

import { isRejection, normalizeName } from "./normalize.js";
import type { NormalizationRejection } from "./normalize.js";
import type { ParseOutcome } from "./parse_outcome.js";

// Matches the contract field's max_length cap; truncation is defensive so the Pydantic/Zod write never
// raises on adversarial version_spec input. 1:1 with `_node.py::_VERSION_SPEC_MAX_LENGTH`.
const VERSION_SPEC_MAX_LENGTH = 256;

/** Python `dependency_type` Literal vocabulary used by the npm emitters. */
type NpmDependencyType = "prod" | "dev" | "optional" | "test" | "unknown";

// 1:1 with `_node.py::_SECTION_TO_TYPE`. Insertion order is load-bearing for record ordering parity —
// JS object property iteration preserves insertion order for string keys, matching the Python dict.
const SECTION_TO_TYPE: ReadonlyArray<readonly [string, NpmDependencyType]> = [
  ["dependencies", "prod"],
  ["devDependencies", "dev"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "unknown"], // peer semantics don't fit our taxonomy
];

/** Python `isinstance(x, dict)` — a plain JSON object (NOT null, NOT an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse `body` as JSON; return the parsed value, or `undefined` on any parse failure (fail-open). */
function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Parse a package.json body. Honors the 4 dependency sections (`dependencies` → prod, `devDependencies`
 * → dev, `optionalDependencies` → optional, `peerDependencies` → unknown). 1:1 with
 * `_node.py::parse_package_json`. Malformed JSON or a non-object root → empty ParseOutcome.
 */
export function parsePackageJson(args: { body: string; source_manifest: string }): ParseOutcome {
  const { body, source_manifest } = args;

  const data = tryParseJson(body);

  const records: Array<ParsedDependencyV1> = [];
  const rejections: Array<NormalizationRejection> = [];

  if (!isPlainObject(data)) {
    return { records: [], rejections: [] };
  }

  for (const [sectionKey, depType] of SECTION_TO_TYPE) {
    const section = data[sectionKey];
    if (!isPlainObject(section)) {
      continue;
    }
    for (const rawName of Object.keys(section)) {
      const rawSpec = section[rawName];
      const versionSpec = typeof rawSpec === "string" ? rawSpec : null;
      emitNpm({
        rawName,
        versionSpec,
        dependencyType: depType,
        sourceManifest: source_manifest,
        records,
        rejections,
      });
    }
  }

  return { records, rejections };
}

/**
 * Parse a package-lock.json body. Lockfile v2+ stores top-level deps under `packages` keyed by path
 * (""=root, "node_modules/<name>" for direct deps); the root entry ("") carries `dependencies` /
 * `devDependencies` / `optionalDependencies` / `peerDependencies` maps with the same shape as
 * package.json sections. Lockfile v1 stores deps under `dependencies` keyed by name, with the version on
 * each entry's `version` field and a `dev: true` marker for dev deps. Only top-level / direct deps are
 * emitted; the full transitive walk stays out of v1 scope to honor MAX_DEPENDENCIES_PER_MANIFEST. 1:1
 * with `_node.py::parse_package_lock_json`. Malformed JSON or a non-object root → empty ParseOutcome.
 */
export function parsePackageLockJson(args: { body: string; source_manifest: string }): ParseOutcome {
  const { body, source_manifest } = args;

  const data = tryParseJson(body);

  const records: Array<ParsedDependencyV1> = [];
  const rejections: Array<NormalizationRejection> = [];

  if (!isPlainObject(data)) {
    return { records: [], rejections: [] };
  }

  // Lockfile v2+ path.
  const packages = data["packages"];
  if (isPlainObject(packages)) {
    // The root entry is keyed by "" and carries its own `dependencies` / `devDependencies` maps — same
    // shape as package.json sections.
    const root = packages[""];
    if (isPlainObject(root)) {
      for (const [sectionKey, depType] of SECTION_TO_TYPE) {
        const section = root[sectionKey];
        if (!isPlainObject(section)) {
          continue;
        }
        for (const rawName of Object.keys(section)) {
          const rawSpec = section[rawName];
          const versionSpec = typeof rawSpec === "string" ? rawSpec : null;
          emitNpm({
            rawName,
            versionSpec,
            dependencyType: depType,
            sourceManifest: source_manifest,
            records,
            rejections,
          });
        }
      }
    }
    // v2+ branch returns here even when root is absent — matches the Python early return.
    return { records, rejections };
  }

  // Lockfile v1 fallback: `dependencies` is name-keyed at top level.
  const depsV1 = data["dependencies"];
  if (isPlainObject(depsV1)) {
    for (const rawName of Object.keys(depsV1)) {
      const entry = depsV1[rawName];
      let versionSpec: string | null = null;
      let depType: "prod" | "dev" = "prod";
      if (isPlainObject(entry)) {
        const v = entry["version"];
        if (typeof v === "string") {
          versionSpec = v;
        }
        // v1 dev marker: `dev: true` on the entry (strictly boolean `true`; `1`/truthy do NOT count, to
        // match Python's `entry.get("dev") is True`).
        if (entry["dev"] === true) {
          depType = "dev";
        }
      }
      emitNpm({
        rawName,
        versionSpec,
        dependencyType: depType,
        sourceManifest: source_manifest,
        records,
        rejections,
      });
    }
  }

  return { records, rejections };
}

/**
 * Normalize + emit one npm record. Scoped names (@scope/pkg) pass through `normalizeName` unchanged (the
 * `/` and `@` are in the ASCII regex class). 1:1 with `_node.py::_emit_npm`.
 */
function emitNpm(args: {
  rawName: string;
  versionSpec: string | null;
  dependencyType: NpmDependencyType;
  sourceManifest: string;
  records: Array<ParsedDependencyV1>;
  rejections: Array<NormalizationRejection>;
}): void {
  const { rawName, dependencyType, sourceManifest, records, rejections } = args;
  let versionSpec = args.versionSpec;

  const normalized = normalizeName(rawName, "npm");
  if (isRejection(normalized)) {
    rejections.push(normalized);
    return;
  }
  // Cap version_spec at the contract's max_length.
  if (versionSpec !== null && versionSpec.length > VERSION_SPEC_MAX_LENGTH) {
    versionSpec = versionSpec.slice(0, VERSION_SPEC_MAX_LENGTH);
  }
  records.push(
    ParsedDependencyV1.parse({
      ecosystem: "npm",
      name: normalized,
      version_spec: versionSpec,
      dependency_type: dependencyType,
      source_manifest: sourceManifest,
    }),
  );
}
