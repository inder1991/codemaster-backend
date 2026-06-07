// ADR-0058 — 8-step canonical dependency-name normalization. 1:1 TS port of the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_normalize.py.
//
// Pure function. NO I/O. NO state. The rules are LOCKED in ADR-0058; drift requires amending the ADR.
// Returns the canonical name (string) on success, or a {@link NormalizationRejection} on any rejection.
// NEVER throws. Rejections are NEVER silently swallowed — the caller logs the structured warning.
//
// Per-step contract:
//   1. NFKC unicode normalization (defeats homoglyph attacks)
//   2. Lowercase (post-NFKC)
//   3. Strip control characters \x00-\x1F + \x7F (remove, not reject, unless it empties the name)
//   4. (ecosystem scoping — handled in the ecosystem parsers, not here)
//   5. Python extras strip — drop `[...]` suffixes (ecosystem="pip" only)
//   6. Go module trailing-version strip — drop `/vN` (ecosystem="go" only)
//   7. ASCII regex validation — ^[a-z0-9._@/+-]+$
//   8. Length cap — max 256 chars

/** Closed vocabulary of rejection reasons (the structured-log `reason` per ADR-0058). */
export type RejectionReason =
  | "control_chars"
  | "extras_strip_empty"
  | "regex_validation"
  | "length_cap"
  | "scope_strip_empty";

/** The ecosystems whose names this pipeline normalizes (1:1 with `ParsedDependencyV1.ecosystem`). */
export type ManifestEcosystem = "pip" | "npm" | "go" | "cargo" | "composer";

/** One-shot record returned when normalization rejects a name (caller logs it; never swallowed). */
export type NormalizationRejection = {
  readonly raw_name: string;
  readonly reason: RejectionReason;
};

/** Step 8 — hard length cap matching `ParsedDependencyV1.name`'s max_length=256. Adjust both together. */
export const MAX_NAME_LENGTH = 256;

// Step 7 regex — ASCII-only class: a-z 0-9 . _ @ / + -. Adjusting requires amending ADR-0058. NOTE:
// path-traversal payloads like `../../etc/passwd` PASS (`.` and `/` are valid) — callers MUST NOT treat
// names as file paths (defense-in-depth lives outside the name-normalization layer).
const ASCII_NAME_REGEX = /^[a-z0-9._@/+-]+$/;
// Step 5 — Python extras `[extras]`.
const PYTHON_EXTRAS_RE = /\[[^\]]*\]/g;
// Step 6 — Go module trailing version `.../vN`. The regex `/v\d+$` strips ANY trailing `/v<digits>`
// (incl. `/v1`); the ADR's "v0/v1 carry no suffix" note explains why the suffix is RARE for those, not
// that they're excluded. `/v` with no digit is NOT stripped (venv-confirmed parity).
const GO_TRAILING_VERSION_RE = /\/v\d+$/;
// C0 control chars 0x00-0x1F + DEL 0x7F.
// eslint-disable-next-line no-control-regex -- intentional: ADR-0058 step 3 strips control chars.
const CONTROL_CHAR_TEST = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex -- intentional: ADR-0058 step 3 strips control chars.
const CONTROL_CHAR_STRIP = /[\x00-\x1f\x7f]/g;

/**
 * Apply the ADR-0058 8-step normalization pipeline. Returns the canonical name on success, or a
 * {@link NormalizationRejection} on any rejection. NEVER throws.
 */
export function normalizeName(
  raw: string,
  ecosystem: ManifestEcosystem,
): string | NormalizationRejection {
  // Empty / whitespace-only → regex-validation rejection (an empty string can't match a min-1 regex).
  if (raw === "" || raw.trim() === "") {
    return { raw_name: raw, reason: "regex_validation" };
  }

  // Step 1 — NFKC. Step 2 — lowercase (locale-independent).
  let text = raw.normalize("NFKC").toLowerCase();

  // Step 3 — strip control chars (remove, not reject, unless it empties the name).
  if (CONTROL_CHAR_TEST.test(text)) {
    text = text.replace(CONTROL_CHAR_STRIP, "");
    if (text === "") {
      return { raw_name: raw, reason: "control_chars" };
    }
  }

  // Step 5 — Python extras strip (ecosystem-gated).
  if (ecosystem === "pip") {
    text = text.replace(PYTHON_EXTRAS_RE, "");
    if (text === "") {
      return { raw_name: raw, reason: "extras_strip_empty" };
    }
  }

  // Step 6 — Go module trailing-version strip (ecosystem-gated).
  if (ecosystem === "go") {
    text = text.replace(GO_TRAILING_VERSION_RE, "");
    if (text === "") {
      return { raw_name: raw, reason: "scope_strip_empty" };
    }
  }

  // Step 7 + Step 8 — regex then length cap (single exit point per ADR-0058). The regex requires ASCII,
  // so by the length check `text` is ASCII → JS `.length` (UTF-16 units) equals Python `len` (code points).
  if (!ASCII_NAME_REGEX.test(text)) {
    return { raw_name: raw, reason: "regex_validation" };
  }
  if (text.length > MAX_NAME_LENGTH) {
    return { raw_name: raw, reason: "length_cap" };
  }
  return text;
}

/** Narrow a {@link normalizeName} result to the rejection branch. */
export function isRejection(r: string | NormalizationRejection): r is NormalizationRejection {
  return typeof r !== "string";
}
