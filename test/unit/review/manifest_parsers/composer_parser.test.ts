// Unit tests for the Composer (PHP) parsers — 1:1 with the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_composer.py
//   ::parse_composer_json / ::parse_composer_lock.
//
// Every expected vector below was derived by RUNNING the frozen Python parser through the project venv
// (cd vendor/codemaster-py && .venv/bin/python ...) on these exact fixtures, then hardcoded here. The
// "venv-cross-checked" comments mark the assertions transcribed from that run. Pure-function parity test:
// covers both manifest formats, prod/dev dependency types, the `php` skip, non-string version specs,
// normalization rejections, malformed/empty/non-object roots (fail-open → empty), section-shape misuse
// (require-as-list, packages-as-object), skipped lock entries (non-dict / missing name / non-str name),
// and over-long version_spec truncation to the 256-char contract cap.

import { describe, expect, it } from "vitest";

import {
  parseComposerJson,
  parseComposerLock,
} from "#backend/review/manifest_parsers/composer_parser.js";

/** Compact view of a record for terse expectations: [name, version_spec, dependency_type]. */
function recView(oc: ReturnType<typeof parseComposerJson>): Array<[string, string | null, string]> {
  return oc.records.map((r) => [r.name, r.version_spec, r.dependency_type]);
}

/** Compact view of rejections: [raw_name, reason]. */
function rejView(oc: ReturnType<typeof parseComposerJson>): Array<[string, string]> {
  return oc.rejections.map((r) => [r.raw_name, r.reason]);
}

describe("parseComposerJson — happy path + php skip + ext-* passthrough", () => {
  it("require → prod, require-dev → dev; `php` skipped, `ext-*` kept (venv-cross-checked)", () => {
    const body = JSON.stringify({
      require: {
        php: ">=8.1",
        "ext-mbstring": "*",
        "monolog/monolog": "^3.0",
        "symfony/console": "6.4.*",
      },
      "require-dev": {
        "phpunit/phpunit": "^10.0",
        "mockery/mockery": "~1.5",
      },
    });
    const oc = parseComposerJson({ body, source_manifest: "composer.json" });
    // venv-cross-checked: php dropped; ext-mbstring kept as prod; require-dev → dev.
    expect(recView(oc)).toEqual([
      ["ext-mbstring", "*", "prod"],
      ["monolog/monolog", "^3.0", "prod"],
      ["symfony/console", "6.4.*", "prod"],
      ["phpunit/phpunit", "^10.0", "dev"],
      ["mockery/mockery", "~1.5", "dev"],
    ]);
    expect(rejView(oc)).toEqual([]);
  });

  it("emits the full ParsedDependencyV1 shape (venv-cross-checked)", () => {
    const oc = parseComposerJson({
      body: JSON.stringify({ require: { "monolog/monolog": "^3.0" } }),
      source_manifest: "composer.json",
    });
    // venv-cross-checked: model_dump() == this exact object.
    expect(oc.records).toEqual([
      {
        schema_version: 1,
        ecosystem: "composer",
        name: "monolog/monolog",
        version_spec: "^3.0",
        dependency_type: "prod",
        source_manifest: "composer.json",
      },
    ]);
  });
});

describe("parseComposerJson — edge specs + normalization rejection", () => {
  it("non-string spec → null; bad name rejected; name lowercased (venv-cross-checked)", () => {
    const body = JSON.stringify({
      require: {
        "Foo/Bar": { version: "^1.0" }, // non-str spec → null; name → lowercased "foo/bar"
        "has space": "^2.0", // rejected: regex_validation
        "symfony/console": "6.4.*",
      },
    });
    const oc = parseComposerJson({ body, source_manifest: "composer.json" });
    // venv-cross-checked.
    expect(recView(oc)).toEqual([
      ["foo/bar", null, "prod"],
      ["symfony/console", "6.4.*", "prod"],
    ]);
    expect(rejView(oc)).toEqual([["has space", "regex_validation"]]);
  });

  it("over-long version_spec truncated to 256 (venv-cross-checked)", () => {
    const longSpec = "^" + "9".repeat(300);
    const oc = parseComposerJson({
      body: JSON.stringify({ require: { "foo/bar": longSpec } }),
      source_manifest: "composer.json",
    });
    // venv-cross-checked: len == 256, prefix "^999999999".
    expect(oc.records).toHaveLength(1);
    const rec = oc.records[0];
    expect(rec).toBeDefined();
    expect(rec?.version_spec?.length).toBe(256);
    expect(rec?.version_spec?.startsWith("^999999999")).toBe(true);
    expect(rec?.name).toBe("foo/bar");
  });
});

describe("parseComposerJson — malformed / non-object / empty (fail-open)", () => {
  it("malformed JSON → empty (venv-cross-checked)", () => {
    const oc = parseComposerJson({ body: "{not json", source_manifest: "composer.json" });
    expect(oc.records).toEqual([]);
    expect(oc.rejections).toEqual([]);
  });

  it("array root (non-object) → empty (venv-cross-checked)", () => {
    const oc = parseComposerJson({ body: "[1,2,3]", source_manifest: "composer.json" });
    expect(oc.records).toEqual([]);
    expect(oc.rejections).toEqual([]);
  });

  it("empty body → empty (venv-cross-checked)", () => {
    const oc = parseComposerJson({ body: "", source_manifest: "composer.json" });
    expect(oc.records).toEqual([]);
    expect(oc.rejections).toEqual([]);
  });

  it("empty object → empty (venv-cross-checked)", () => {
    const oc = parseComposerJson({ body: "{}", source_manifest: "composer.json" });
    expect(oc.records).toEqual([]);
    expect(oc.rejections).toEqual([]);
  });

  it("require as a list (non-object section) is skipped; require-dev object honored (venv-cross-checked)", () => {
    const body = JSON.stringify({ require: ["a", "b"], "require-dev": { "x/y": "1" } });
    const oc = parseComposerJson({ body, source_manifest: "composer.json" });
    // venv-cross-checked: only the dev section produces a record.
    expect(recView(oc)).toEqual([["x/y", "1", "dev"]]);
    expect(rejView(oc)).toEqual([]);
  });
});

describe("parseComposerLock — happy path + skipped entries", () => {
  it("packages → prod, packages-dev → dev; lowercases; skips non-dict/missing/non-str-name; non-str version → null (venv-cross-checked)", () => {
    const lock = JSON.stringify({
      packages: [
        { name: "monolog/monolog", version: "3.5.0" },
        { name: "Symfony/Console", version: "v6.4.2" }, // uppercase → lowercased
        { name: "no-version-pkg/x" }, // missing version → null
        { name: "bad name", version: "1.0" }, // rejected
        { version: "1.0" }, // missing name → skipped (continue)
        { name: 123, version: "1.0" }, // name not str → skipped
        "not-a-dict", // entry not dict → skipped
        { name: "okpkg/y", version: 99 }, // version not str → null
      ],
      "packages-dev": [{ name: "phpunit/phpunit", version: "10.5.0" }],
    });
    const oc = parseComposerLock({ body: lock, source_manifest: "composer.lock" });
    // venv-cross-checked.
    expect(recView(oc)).toEqual([
      ["monolog/monolog", "3.5.0", "prod"],
      ["symfony/console", "v6.4.2", "prod"],
      ["no-version-pkg/x", null, "prod"],
      ["okpkg/y", null, "prod"],
      ["phpunit/phpunit", "10.5.0", "dev"],
    ]);
    expect(rejView(oc)).toEqual([["bad name", "regex_validation"]]);
  });

  it("over-long version truncated to 256 (venv-cross-checked)", () => {
    const longV = "1." + "2".repeat(300);
    const oc = parseComposerLock({
      body: JSON.stringify({ packages: [{ name: "foo/bar", version: longV }] }),
      source_manifest: "composer.lock",
    });
    // venv-cross-checked: len == 256.
    expect(oc.records).toHaveLength(1);
    expect(oc.records[0]?.version_spec?.length).toBe(256);
    expect(oc.records[0]?.name).toBe("foo/bar");
  });
});

describe("parseComposerLock — malformed / non-object / section misuse (fail-open)", () => {
  it("malformed JSON → empty (venv-cross-checked)", () => {
    const oc = parseComposerLock({ body: "nope", source_manifest: "composer.lock" });
    expect(oc.records).toEqual([]);
    expect(oc.rejections).toEqual([]);
  });

  it("array root (non-object) → empty (venv-cross-checked)", () => {
    const oc = parseComposerLock({ body: "[]", source_manifest: "composer.lock" });
    expect(oc.records).toEqual([]);
    expect(oc.rejections).toEqual([]);
  });

  it("empty object → empty (venv-cross-checked)", () => {
    const oc = parseComposerLock({ body: "{}", source_manifest: "composer.lock" });
    expect(oc.records).toEqual([]);
    expect(oc.rejections).toEqual([]);
  });

  it("packages as an object (non-array section) skipped; packages-dev array honored (venv-cross-checked)", () => {
    const body = JSON.stringify({
      packages: { name: "x" },
      "packages-dev": [{ name: "a/b", version: "1" }],
    });
    const oc = parseComposerLock({ body, source_manifest: "composer.lock" });
    // venv-cross-checked: prod section dropped, dev section yields one record.
    expect(recView(oc)).toEqual([["a/b", "1", "dev"]]);
    expect(rejView(oc)).toEqual([]);
  });
});
