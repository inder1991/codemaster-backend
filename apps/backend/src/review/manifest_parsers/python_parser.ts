// Python ecosystem dependency parsers — 1:1 TS port of the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_python.py
//   (Commit 3 of FOLLOW-UP-manifest-dependency-parsing).
//
// Covers 5 Python manifest formats:
//   * pyproject.toml         — PEP 621 + Poetry sections
//   * requirements.txt       — PEP 508 line-based
//   * requirements-dev.txt   — same grammar, dev scope
//   * Pipfile                — TOML [packages] + [dev-packages]
//   * Pipfile.lock           — JSON default/develop sections
//
// All parsers return a {@link ParseOutcome}. Rejected entries (per ADR-0058) are returned in a parallel
// list so the parse activity can log them with structured payloads.
//
// Pure functions: NO I/O, NO clock, NO random. Replay-safe (these run in the parse activity, not the
// workflow sandbox). pyproject.toml + Pipfile bodies go through {@link parseTomlManifest} (the swappable
// TOML adapter) — a parse failure / non-table root throws {@link TomlParseError}, which we catch and
// degrade ONLY that manifest (empty ParseOutcome), matching the Python `except tomllib.TOMLDecodeError`.

import { ParsedDependencyV1 } from "#contracts/pr_context.v1.js";

import { isRejection, normalizeName, type NormalizationRejection } from "./normalize.js";
import type { ParseOutcome } from "./parse_outcome.js";
import { parseTomlManifest, TomlParseError } from "./toml_adapter.js";

/** The closed dependency_type vocabulary (1:1 with the Pydantic `Literal`). */
type DependencyType = "prod" | "dev" | "optional" | "test" | "unknown";

// Matches the contract field's max_length cap; truncation is defensive so the contract write never
// raises on adversarial version_spec input. Mirrors Python `_VERSION_SPEC_MAX_LENGTH`.
const VERSION_SPEC_MAX_LENGTH = 256;

// PEP 508 name extraction: capture the leading run of name characters, stopping at the first
// version-comparator char, whitespace, or extras-bracket. Mirrors Python `_PEP508_NAME_PREFIX`
// (`^([A-Za-z0-9._\-]+)`). NOTE: no `g` / `i` flags — case-sensitive prefix exactly like Python.
const PEP508_NAME_PREFIX = /^([A-Za-z0-9._-]+)/;

// Poetry / PEP 621 optional-dependency group-name → dependency_type maps (1:1 with the Python
// frozensets). Lower-cased before lookup.
const DEV_GROUP_NAMES: ReadonlySet<string> = new Set(["dev", "develop", "development"]);
const TEST_GROUP_NAMES: ReadonlySet<string> = new Set(["test", "tests", "testing"]);

/** Mutable accumulators threaded through `emit`, matching the Python list-append pattern. */
type Accumulators = {
  readonly records: Array<ParsedDependencyV1>;
  readonly rejections: Array<NormalizationRejection>;
};

// ─── pyproject.toml ───────────────────────────────────────────────

/** Parse a pyproject.toml body. Honors PEP 621 + Poetry sections. */
export function parsePyproject({
  body,
  source_manifest,
}: {
  body: string;
  source_manifest: string;
}): ParseOutcome {
  let data: Record<string, unknown>;
  try {
    data = parseTomlManifest(body);
  } catch (e) {
    if (e instanceof TomlParseError) {
      return { records: [], rejections: [] };
    }
    throw e;
  }

  const acc: Accumulators = { records: [], rejections: [] };

  // PEP 621 [project] section.
  const project = asRecord(data["project"]);
  for (const rawSpec of ensureStrList(project["dependencies"])) {
    emit(rawSpec, "prod", source_manifest, acc);
  }

  const optional = project["optional-dependencies"];
  if (isRecord(optional)) {
    // Object key iteration order mirrors Python dict insertion order (TOML table order).
    for (const [group, specs] of Object.entries(optional)) {
      const depType = classifyPythonGroup(group);
      for (const rawSpec of ensureStrList(specs)) {
        emit(rawSpec, depType, source_manifest, acc);
      }
    }
  }

  // Poetry: tool.poetry.dependencies + tool.poetry.group.*.dependencies.
  // The Python iterates `for raw_name in (poetry.get("dependencies") or {})` with NO dict guard, so a
  // list yields its elements and a bare string yields its characters — `pyIterKeys` replicates that.
  const poetry = asRecord(asRecord(data["tool"])["poetry"]);
  for (const rawName of pyIterKeys(poetry["dependencies"])) {
    if (rawName === "python") {
      // not a package dep
      continue;
    }
    emit(rawName, "prod", source_manifest, acc);
  }

  const groups = poetry["group"];
  if (isRecord(groups)) {
    for (const [groupName, groupData] of Object.entries(groups)) {
      if (!isRecord(groupData)) {
        continue;
      }
      const depType = classifyPythonGroup(groupName);
      for (const rawName of pyIterKeys(groupData["dependencies"])) {
        if (rawName === "python") {
          continue;
        }
        emit(rawName, depType, source_manifest, acc);
      }
    }
  }

  return { records: acc.records, rejections: acc.rejections };
}

// ─── requirements.txt / requirements-dev.txt ──────────────────────

/**
 * Parse a line-based requirements file. Skips comments, directives (`-r`/`-e`/`--`), and empty lines.
 */
export function parseRequirementsTxt({
  body,
  source_manifest,
  isDev,
}: {
  body: string;
  source_manifest: string;
  isDev: boolean;
}): ParseOutcome {
  const acc: Accumulators = { records: [], rejections: [] };
  const depType: DependencyType = isDev ? "dev" : "prod";

  for (const rawLine of splitlines(body)) {
    // Strip the first `#`-comment, then trim — matches Python `raw_line.split("#", 1)[0].strip()`.
    const hashIdx = rawLine.indexOf("#");
    const line = (hashIdx === -1 ? rawLine : rawLine.slice(0, hashIdx)).trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("-") || line.startsWith("--")) {
      // -r other-requirements.txt / -e <vcs> / --hash=... — skip.
      continue;
    }
    emit(line, depType, source_manifest, acc);
  }

  return { records: acc.records, rejections: acc.rejections };
}

// ─── Pipfile (TOML) ───────────────────────────────────────────────

/** Parse a Pipfile body. TOML `[packages]` (prod) + `[dev-packages]` (dev). */
export function parsePipfile({
  body,
  source_manifest,
}: {
  body: string;
  source_manifest: string;
}): ParseOutcome {
  let data: Record<string, unknown>;
  try {
    data = parseTomlManifest(body);
  } catch (e) {
    if (e instanceof TomlParseError) {
      return { records: [], rejections: [] };
    }
    throw e;
  }

  const acc: Accumulators = { records: [], rejections: [] };

  // `for raw_name in (data.get("packages") or {})` — bare iteration (no dict guard), matching Python.
  for (const rawName of pyIterKeys(data["packages"])) {
    emit(rawName, "prod", source_manifest, acc);
  }
  for (const rawName of pyIterKeys(data["dev-packages"])) {
    emit(rawName, "dev", source_manifest, acc);
  }

  return { records: acc.records, rejections: acc.rejections };
}

// ─── Pipfile.lock (JSON) ──────────────────────────────────────────

/** Parse a Pipfile.lock body. JSON `default` (prod) + `develop` (dev) sections. */
export function parsePipfileLock({
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

  const acc: Accumulators = { records: [], rejections: [] };

  if (!isRecord(data)) {
    return { records: [], rejections: [] };
  }

  const sections: ReadonlyArray<readonly [string, DependencyType]> = [
    ["default", "prod"],
    ["develop", "dev"],
  ];
  for (const [sectionName, depType] of sections) {
    // eslint-disable-next-line security/detect-object-injection -- `sectionName` is one of two fixed string literals ("default"/"develop") from the local `sections` const, not user input.
    const section = data[sectionName];
    if (!isRecord(section)) {
      continue;
    }
    for (const rawName of Object.keys(section)) {
      emit(rawName, depType, source_manifest, acc);
    }
  }

  return { records: acc.records, rejections: acc.rejections };
}

// ─── Internals ────────────────────────────────────────────────────

/**
 * Extract name + version_spec from a raw PEP 508 spec; normalize; append to records OR rejections.
 * Internal helper used by every Python parser (1:1 with Python `_emit`).
 *
 * `rawSpec` is typed `unknown` because the un-guarded poetry/Pipfile iteration sites can hand a
 * non-string element from a mixed-type TOML/JSON array. Python's `_emit` would then call
 * `_split_name_and_version(non_str)` → `non_str.strip()` → raise `AttributeError`. We re-create that
 * throw (a `TypeError`) so the partial-then-throw behavior matches exactly, rather than silently
 * skipping the bad element.
 */
function emit(
  rawSpec: unknown,
  dependencyType: DependencyType,
  source_manifest: string,
  acc: Accumulators,
): void {
  if (typeof rawSpec !== "string") {
    // Mirror Python `<non-str>.strip()` → AttributeError; raised mid-iteration before later items.
    throw new TypeError(
      `manifest dependency spec is not a string (got ${typeof rawSpec}) — cannot extract a name`,
    );
  }
  const [nameRaw, versionSpec] = splitNameAndVersion(rawSpec);
  const normalized = normalizeName(nameRaw, "pip");
  if (isRejection(normalized)) {
    acc.rejections.push(normalized);
    return;
  }
  acc.records.push(
    ParsedDependencyV1.parse({
      ecosystem: "pip",
      name: normalized,
      version_spec: versionSpec,
      dependency_type: dependencyType,
      source_manifest,
    }),
  );
}

/**
 * Split a raw PEP 508 string like `fastapi[all]>=0.90` into name=`fastapi[all]` (extras handled by the
 * normalizer) and version_spec=`>=0.90`. Returns [name_with_extras, version_or_null]. 1:1 with Python
 * `_split_name_and_version`.
 */
function splitNameAndVersion(rawSpec: string): [string, string | null] {
  const stripped = rawSpec.trim();
  const match = PEP508_NAME_PREFIX.exec(stripped);
  if (match === null) {
    // Whole input fails to match the name prefix; let normalize_name reject it as regex_validation.
    return [stripped, null];
  }
  const namePrefix = match[1] as string;
  const nameEnd = match[0].length;
  // Extras bracket immediately after the name? Include it in the name part so normalize_name's
  // extras-strip can drop it.
  let rest = stripped.slice(nameEnd);
  let nameWithExtras = namePrefix;
  if (rest.startsWith("[")) {
    const bracketClose = rest.indexOf("]");
    if (bracketClose !== -1) {
      nameWithExtras = namePrefix + rest.slice(0, bracketClose + 1);
      rest = rest.slice(bracketClose + 1);
    }
  }
  const restTrimmed = rest.trim();
  let versionSpec: string | null = restTrimmed === "" ? null : restTrimmed;
  // Cap version_spec at the contract's max_length.
  if (versionSpec !== null && versionSpec.length > VERSION_SPEC_MAX_LENGTH) {
    versionSpec = versionSpec.slice(0, VERSION_SPEC_MAX_LENGTH);
  }
  return [nameWithExtras, versionSpec];
}

/**
 * Map a Poetry / PEP 621 optional-dependency group name to the closed dependency_type vocabulary.
 * 1:1 with Python `_classify_python_group`.
 */
function classifyPythonGroup(name: string): DependencyType {
  const n = name.toLowerCase();
  if (DEV_GROUP_NAMES.has(n)) {
    return "dev";
  }
  if (TEST_GROUP_NAMES.has(n)) {
    return "test";
  }
  return "optional";
}

/**
 * Coerce a manifest field to a list of string. Returns [] for anything else (malformed input).
 * 1:1 with Python `_ensure_str_list`.
 */
function ensureStrList(value: unknown): Array<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

/** True when `value` is a non-null, non-array object — the TS analogue of Python `isinstance(x, dict)`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replicate Python `for x in (value or {})` for the UN-guarded poetry/Pipfile iteration sites:
 *   - dict   → iterates its KEYS (insertion order)
 *   - list   → iterates its ELEMENTS (any type — a non-str element later raises in `emit`, see below)
 *   - str    → iterates its CHARACTERS (single code points)
 *   - falsy / anything else → `{}` → no iterations
 *
 * Yields `unknown` (not `string`) because a TOML/JSON array CAN mix types (`packages = ["x", 123]`).
 * Python passes each element straight to `_emit`, where `_split_name_and_version` calls `.strip()`;
 * a non-str element raises `AttributeError` mid-iteration (venv-confirmed: `["x",123,"y"]` emits `x`,
 * then raises before reaching `y`). `emit` here re-creates that throw on a non-string item so the
 * observable behavior — including the partial-then-throw ordering — is identical.
 */
function pyIterKeys(value: unknown): Array<unknown> {
  if (typeof value === "string") {
    // Python iterates a bare string by code point. `Array.from` splits on code points (not UTF-16 units),
    // matching Python `for ch in s`.
    return Array.from(value);
  }
  if (Array.isArray(value)) {
    return value as Array<unknown>;
  }
  if (isRecord(value)) {
    return Object.keys(value);
  }
  return [];
}

/**
 * Coerce a value to a record, returning {} when it is not one — the analogue of Python `x or {}`
 * for `data.get(key)` chains where the absent / falsy value is replaced by an empty dict and then
 * iterated. (Python `(data.get("tool") or {}).get("poetry") or {}` etc.)
 */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

// Python `str.splitlines()` line boundaries: LF, CR, CRLF, plus VT, FF, FS, GS, RS, NEL, LS, PS.
// `\r\n` MUST come first in the alternation so it collapses to a single break (not two empty lines).
// Built from explicit escapes so the non-printable boundary chars are unambiguous in source.
const PY_LINE_BOUNDARIES = new RegExp(
  // eslint-disable-next-line no-control-regex -- intentional: replicate Python splitlines boundaries.
  "\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]",
  "g",
);

/**
 * Split a body the way Python `str.splitlines()` does: on the full set of Unicode line boundaries
 * (LF/CR/CRLF/VT/FF/FS/GS/RS/NEL/LS/PS), collapsing `\r\n` to one break and NOT yielding a trailing
 * empty element for a terminal break. Mirrors the line iteration in `parse_requirements_txt`.
 */
function splitlines(body: string): Array<string> {
  if (body === "") {
    return [];
  }
  const lines: Array<string> = [];
  let lastIndex = 0;
  PY_LINE_BOUNDARIES.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_LINE_BOUNDARIES.exec(body)) !== null) {
    lines.push(body.slice(lastIndex, m.index));
    lastIndex = m.index + m[0].length;
  }
  // Trailing segment after the last boundary; Python omits it ONLY when it is empty (terminal break).
  if (lastIndex < body.length) {
    lines.push(body.slice(lastIndex));
  }
  return lines;
}
