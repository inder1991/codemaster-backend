// Unit tests for the ADR-0058 normalization pipeline — 1:1 with the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_normalize.py::normalize_name.
// Expectations transcribed from the 8-step contract; cross-checked against the Python venv.

import { describe, expect, it } from "vitest";

import {
  MAX_NAME_LENGTH,
  isRejection,
  normalizeName,
  type NormalizationRejection,
} from "#backend/review/manifest_parsers/normalize.js";

function rej(r: ReturnType<typeof normalizeName>): NormalizationRejection {
  expect(isRejection(r)).toBe(true);
  return r as NormalizationRejection;
}

describe("normalizeName — happy path", () => {
  it("lowercases (step 2)", () => {
    expect(normalizeName("Requests", "pip")).toBe("requests");
  });

  it("NFKC-folds fullwidth → ASCII then lowercases (step 1+2)", () => {
    // "ＡＢ" (U+FF21 U+FF22 fullwidth) → NFKC "AB" → lower "ab".
    expect(normalizeName("ＡＢ", "npm")).toBe("ab");
  });

  it("keeps valid name chars (dot, underscore, at, slash, plus, hyphen)", () => {
    expect(normalizeName("python_jose", "pip")).toBe("python_jose");
    expect(normalizeName("@scope/pkg", "npm")).toBe("@scope/pkg");
    expect(normalizeName("github.com/foo/bar", "go")).toBe("github.com/foo/bar");
  });
});

describe("normalizeName — step 3 control chars", () => {
  it("strips an embedded control char (not rejected)", () => {
    // U+0001 (SOH) embedded mid-name → stripped → "requests".
    expect(normalizeName("req" + String.fromCharCode(1) + "uests", "npm")).toBe("requests");
  });

  it("rejects when stripping control chars empties the name", () => {
    // A lone non-whitespace control char survives the empty/whitespace guard, then strips to "".
    expect(rej(normalizeName(String.fromCharCode(1), "npm")).reason).toBe("control_chars");
  });
});

describe("normalizeName — step 5 pip extras (gated)", () => {
  it("strips `[extras]` for pip", () => {
    expect(normalizeName("requests[security]", "pip")).toBe("requests");
  });

  it("does NOT strip extras for non-pip ecosystems (the bracket then fails the ASCII regex)", () => {
    expect(rej(normalizeName("requests[security]", "npm")).reason).toBe("regex_validation");
  });

  it("rejects when extras-strip empties the name (pip)", () => {
    expect(rej(normalizeName("[onlyextras]", "pip")).reason).toBe("extras_strip_empty");
  });
});

describe("normalizeName — step 6 go trailing version (gated)", () => {
  it("strips `/vN` (N>=2) for go", () => {
    expect(normalizeName("github.com/foo/bar/v2", "go")).toBe("github.com/foo/bar");
  });

  it("strips /v1 too (regex is /v\\d+$; the v0/v1 comment explains rarity, not an exception) — venv-confirmed", () => {
    expect(normalizeName("github.com/foo/bar/v1", "go")).toBe("github.com/foo/bar");
  });

  it("does NOT strip `/v` with no trailing digit", () => {
    expect(normalizeName("github.com/foo/bar/v", "go")).toBe("github.com/foo/bar/v");
  });

  it("does NOT strip /vN for non-go ecosystems", () => {
    expect(normalizeName("foo/v2", "npm")).toBe("foo/v2");
  });
});

describe("normalizeName — step 7 ASCII regex + step 8 length", () => {
  it("rejects a precomposed accented char (NFKC does not fold é→e)", () => {
    expect(rej(normalizeName("réquests", "pip")).reason).toBe("regex_validation");
  });

  it("rejects spaces and symbols", () => {
    expect(rej(normalizeName("has space", "npm")).reason).toBe("regex_validation");
    expect(rej(normalizeName("bang!", "npm")).reason).toBe("regex_validation");
  });

  it("accepts a name exactly at the length cap, rejects one over", () => {
    const at = "a".repeat(MAX_NAME_LENGTH);
    expect(normalizeName(at, "npm")).toBe(at);
    expect(rej(normalizeName("a".repeat(MAX_NAME_LENGTH + 1), "npm")).reason).toBe("length_cap");
  });
});

describe("normalizeName — empty / whitespace", () => {
  it("empty → regex_validation", () => {
    expect(rej(normalizeName("", "npm")).reason).toBe("regex_validation");
  });
  it("whitespace-only → regex_validation", () => {
    expect(rej(normalizeName("   ", "npm")).reason).toBe("regex_validation");
  });
});
