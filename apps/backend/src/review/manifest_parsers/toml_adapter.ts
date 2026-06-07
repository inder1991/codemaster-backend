// Thin, SWAPPABLE adapter over the TOML parser (smol-toml) — the ONLY place smol-toml is imported, per
// the dependency guardrail (ADR-MANIFEST-TOML). The ecosystem parsers (pyproject.toml / Pipfile /
// Cargo.toml) call `parseTomlManifest` instead of importing a TOML library directly, so the library is
// trivially replaceable (e.g. @iarna/toml) without touching any parser.
//
// Runs in the parse_manifest_dependencies ACTIVITY (worker, NOT the workflow sandbox) — Node `Buffer` is
// available + smol-toml never reaches the workflow bundle (the parsers are activity-only).

import { parse as parseToml } from "smol-toml";

/** Raised on a size-cap breach, a TOML parse failure, or a non-table root. Parsers catch it + degrade
 *  ONLY that manifest (fail-open), exactly as the Python parsers catch `tomllib.TOMLDecodeError`. */
export class TomlParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TomlParseError";
  }
}

/**
 * Defensive size cap before parsing (guardrail #5). The fetch_manifest_snapshots activity already
 * truncates each manifest to 32 KB; this is defense-in-depth so a pathological body reaching the parser
 * by any other path can't drive a pathological parse.
 */
export const MAX_TOML_PARSE_BYTES = 1_000_000;

/**
 * Parse a TOML manifest body to its root table. Throws {@link TomlParseError} on a size-cap breach, a
 * parse failure, or a non-table root — the caller (an ecosystem parser) catches it and returns an empty
 * {@link ParseOutcome} for THAT manifest only (fail-open; the review proceeds). 1:1 in spirit with the
 * Python `try: tomllib.loads(body) except tomllib.TOMLDecodeError: return ParseOutcome([], [])`.
 */
export function parseTomlManifest(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > MAX_TOML_PARSE_BYTES) {
    throw new TomlParseError(`TOML manifest exceeds ${MAX_TOML_PARSE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (e) {
    throw new TomlParseError(`TOML parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TomlParseError("TOML root is not a table");
  }
  return parsed as Record<string, unknown>;
}
