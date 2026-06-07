// Go ecosystem dependency parsers — 1:1 TS port of the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_go.py
//   (Commit 5 of FOLLOW-UP-manifest-dependency-parsing).
//
// Covers go.mod (module manifest) + go.sum (checksum file). Both are custom line-based text parsers
// (no TOML/JSON lib). Pure functions: NO I/O, NO clock, NO random — replay-safe inside the Temporal
// sandbox. Names normalized via normalizeName(raw, "go"); rejections returned in a parallel list so the
// activity can log them with structured payloads. Malformed input fails open (empty ParseOutcome).
//
// Parity notes (venv-cross-checked against the frozen Python):
//  - Python's `str.splitlines()` splits on a broad set of line boundaries and DROPS a trailing empty
//    line; {@link pySplitlines} replicates that exactly (NOT JS `"...".split("\n")`).
//  - Python `\w` (unicode, the default for `str`) matches `\p{L}`, `\p{N}`, and `_` (U+005F only — NOT
//    the broader `Pc` connector class, and NOT combining marks). The go.mod require-line regex uses
//    `\w`, so the JS port uses `[\p{L}\p{N}_…]` with the `u` flag — otherwise a name like `café.com/foo`
//    would silently fail JS's ASCII `\w` and skip (no rejection) instead of matching → normalize-reject
//    as the Python does.
//  - Python `.strip()` / `.split()` (no-arg) use a unicode whitespace set that differs from JS `.trim()`
//    / `\s`; {@link pyStrip}, {@link pyRStrip}, {@link pySplitWhitespace} replicate Python's set exactly.

import { ParsedDependencyV1 } from "#contracts/pr_context.v1.js";

import { isRejection, normalizeName, type NormalizationRejection } from "./normalize.js";
import type { ParseOutcome } from "./parse_outcome.js";

/** One parser input — body + the manifest path it came from (mirrors the Python keyword args). */
export type GoParseInput = {
  readonly body: string;
  readonly source_manifest: string;
};

// Matches the contract field's max_length cap; truncation is defensive so the construction never raises
// on adversarial version_spec input (mirrors `_go.py::_VERSION_SPEC_MAX_LENGTH`).
const VERSION_SPEC_MAX_LENGTH = 256;

// Python unicode `\w` for these parsers = letters (`\p{L}`), numbers (`\p{N}`), and `_` (U+005F).
const PY_WORD = "\\p{L}\\p{N}_";

// 1:1 port of `_GO_REQUIRE_LINE`:
//   ^\s*(?:require\s+)?([\w./\-]+)\s+([\w.\-+/]+)(?:\s+//\s+(\w+))?\s*$
// `\w` → PY_WORD with the `u` flag (see parity notes). The third group never fires in practice because
// the caller strips the `//` comment before matching, but it is preserved for byte-faithfulness.
const GO_REQUIRE_LINE = new RegExp(
  `^\\s*(?:require\\s+)?([${PY_WORD}./\\-]+)\\s+([${PY_WORD}.\\-+/]+)(?:\\s+//\\s+([${PY_WORD}]+))?\\s*$`,
  "u",
);

// Python `str` whitespace code points (what `.strip()` / `.split()` treat as whitespace for `str`). Built
// from explicit code points because JS `\s` omits 0x1C–0x1F and 0x85 and includes 0xFEFF — neither matches
// Python. Source: probed from the frozen Python venv (every `c` where `c.strip() == ""`).
const PY_WHITESPACE_CODEPOINTS: ReadonlyArray<number> = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
];
const PY_WHITESPACE_CLASS = PY_WHITESPACE_CODEPOINTS.map((cp) => `\\u{${cp.toString(16)}}`).join("");
const PY_RSTRIP_RE = new RegExp(`[${PY_WHITESPACE_CLASS}]+$`, "u");
const PY_LSTRIP_RE = new RegExp(`^[${PY_WHITESPACE_CLASS}]+`, "u");
const PY_SPLIT_RE = new RegExp(`[${PY_WHITESPACE_CLASS}]+`, "u");

// Python `str.splitlines()` line-boundary code points: \n \r \v \f 0x1c 0x1d 0x1e 0x85 U+2028 U+2029.
const PY_LINE_BOUNDARIES: ReadonlySet<string> = new Set(
  [0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029].map((cp) =>
    String.fromCodePoint(cp),
  ),
);

/**
 * Replicate Python `str.splitlines()`: split on the {@link PY_LINE_BOUNDARIES} set, treat a `\r\n` pair as
 * one boundary, and DO NOT emit a trailing empty line for a body ending in a boundary. NEVER throws.
 */
function pySplitlines(s: string): Array<string> {
  const out: Array<string> = [];
  let current = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (PY_LINE_BOUNDARIES.has(ch)) {
      // `\r\n` counts as a single boundary.
      if (ch === "\r" && s[i + 1] === "\n") {
        i += 1;
      }
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current !== "") {
    out.push(current);
  }
  return out;
}

/** Python `str.rstrip()` over the str-whitespace set. */
function pyRStrip(s: string): string {
  return s.replace(PY_RSTRIP_RE, "");
}

/** Python `str.lstrip()` over the str-whitespace set. */
function pyLStrip(s: string): string {
  return s.replace(PY_LSTRIP_RE, "");
}

/** Python `str.strip()` over the str-whitespace set. */
function pyStrip(s: string): string {
  return s.replace(PY_LSTRIP_RE, "").replace(PY_RSTRIP_RE, "");
}

/** Python `str.split()` with no separator: split on whitespace runs, dropping leading/trailing/empty. */
function pySplitWhitespace(s: string): Array<string> {
  const trimmed = pyStrip(s);
  if (trimmed === "") {
    return [];
  }
  return trimmed.split(PY_SPLIT_RE);
}

/** Python `str.split("//")[0]` — everything before the FIRST `//` (the whole string if none). */
function splitFirst(s: string, sep: string): string {
  const idx = s.indexOf(sep);
  return idx === -1 ? s : s.slice(0, idx);
}

/**
 * Parse a go.mod body. Tracks `require (...)` blocks + single require lines. `// indirect` markers map to
 * dependency_type=`unknown` (neither prod nor dev in Go's taxonomy). Malformed lines are skipped. 1:1 with
 * `_go.py::parse_go_mod`.
 */
export function parseGoMod(input: GoParseInput): ParseOutcome {
  const { body, source_manifest } = input;
  const records: Array<ParsedDependencyV1> = [];
  const rejections: Array<NormalizationRejection> = [];
  let inRequireBlock = false;

  for (const rawLine of pySplitlines(body)) {
    // `raw_line.split("//")[0].rstrip()` unless the line (lstripped) is itself a `//` comment → "".
    const line = pyLStrip(rawLine).startsWith("//") ? "" : pyRStrip(splitFirst(rawLine, "//"));
    const stripped = pyStrip(line);

    // Block boundaries.
    if (stripped === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (stripped === ")" && inRequireBlock) {
      inRequireBlock = false;
      continue;
    }

    // Reconstruct the indirect marker from the raw line.
    const indirect = rawLine.includes("// indirect");

    // Skip module / go / toolchain / replace / exclude / retract directives — not direct deps.
    if (
      stripped.startsWith("module ") ||
      stripped.startsWith("go ") ||
      stripped.startsWith("toolchain") ||
      stripped.startsWith("replace") ||
      stripped.startsWith("exclude") ||
      stripped.startsWith("retract")
    ) {
      continue;
    }
    if (stripped === "") {
      continue;
    }

    // Inside a require block OR a single-line require statement.
    let match: RegExpMatchArray | null;
    if (inRequireBlock) {
      match = stripped.match(GO_REQUIRE_LINE);
    } else if (stripped.startsWith("require ")) {
      match = stripped.match(GO_REQUIRE_LINE);
    } else {
      continue;
    }

    if (!match) {
      continue;
    }
    const path = match[1] as string;
    const version = match[2] as string;
    emitGo({
      rawName: path,
      versionSpec: version,
      dependencyType: indirect ? "unknown" : "prod",
      sourceManifest: source_manifest,
      records,
      rejections,
    });
  }

  return { records, rejections };
}

/**
 * Parse a go.sum body. Each unique `<path> <version>` pair emits one record; the parallel `/go.mod`
 * entries get deduped. All entries are dependency_type=`unknown` — go.sum doesn't carry scope. 1:1 with
 * `_go.py::parse_go_sum`.
 */
export function parseGoSum(input: GoParseInput): ParseOutcome {
  const { body, source_manifest } = input;
  const records: Array<ParsedDependencyV1> = [];
  const rejections: Array<NormalizationRejection> = [];
  const seen = new Set<string>();

  for (const line of pySplitlines(body)) {
    const parts = pySplitWhitespace(line);
    if (parts.length < 3) {
      // `<path> <version> <hash>` minimum.
      continue;
    }
    const path = parts[0] as string;
    let version = parts[1] as string;
    // Drop trailing /go.mod from the version field.
    if (version.endsWith("/go.mod")) {
      version = version.slice(0, version.length - "/go.mod".length);
    }
    const key = `${path} ${version}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    emitGo({
      rawName: path,
      versionSpec: version,
      dependencyType: "unknown",
      sourceManifest: source_manifest,
      records,
      rejections,
    });
  }

  return { records, rejections };
}

type EmitArgs = {
  readonly rawName: string;
  readonly versionSpec: string | null;
  readonly dependencyType: ParsedDependencyV1["dependency_type"];
  readonly sourceManifest: string;
  readonly records: Array<ParsedDependencyV1>;
  readonly rejections: Array<NormalizationRejection>;
};

/** Normalize the name; append to records OR rejections. 1:1 with `_go.py::_emit_go`. */
function emitGo(args: EmitArgs): void {
  const { rawName, dependencyType, sourceManifest, records, rejections } = args;
  let { versionSpec } = args;
  const normalized = normalizeName(rawName, "go");
  if (isRejection(normalized)) {
    rejections.push(normalized);
    return;
  }
  if (versionSpec !== null) {
    // Python `len(...)` + slice are code-point-based; the go.sum version field is not regex-gated so it
    // may carry astral chars. Iterate code points (NOT UTF-16 units) to match Python exactly.
    const codePoints = Array.from(versionSpec);
    if (codePoints.length > VERSION_SPEC_MAX_LENGTH) {
      versionSpec = codePoints.slice(0, VERSION_SPEC_MAX_LENGTH).join("");
    }
  }
  records.push(
    ParsedDependencyV1.parse({
      ecosystem: "go",
      name: normalized,
      version_spec: versionSpec,
      dependency_type: dependencyType,
      source_manifest: sourceManifest,
    }),
  );
}
