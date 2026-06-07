// Unit tests for the Node ecosystem dependency parsers — 1:1 with the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_node.py
//   (parse_package_json + parse_package_lock_json).
//
// Every expected vector below was derived by RUNNING the frozen Python parser through its venv
//   (cd vendor/codemaster-py && .venv/bin/python -c "from codemaster.review.manifest_parsers._node ...")
// on the exact same fixture body, then transcribing the `model_dump()` output verbatim. Each block is
// marked "venv-cross-checked". Covers: each package.json section (prod/dev/optional/peer→unknown),
// lockfile v2+ (packages[""] sections), lockfile v1 (dependencies with dev marker + version field),
// non-string version specs, normalization rejections, malformed JSON → empty (fail-open), non-object
// roots, missing sections, non-dict sections, and an over-long version_spec (truncated to 256).

import { describe, expect, it } from "vitest";

import { ParsedDependencyV1 } from "#contracts/pr_context.v1.js";
import {
  parsePackageJson,
  parsePackageLockJson,
} from "#backend/review/manifest_parsers/node_parser.js";

/** Build the expected fully-validated record the way the parser does, so defaults match exactly. */
function rec(fields: {
  name: string;
  version_spec: string | null;
  dependency_type: ParsedDependencyV1["dependency_type"];
  source_manifest: string;
}): ParsedDependencyV1 {
  return ParsedDependencyV1.parse({
    ecosystem: "npm",
    name: fields.name,
    version_spec: fields.version_spec,
    dependency_type: fields.dependency_type,
    source_manifest: fields.source_manifest,
  });
}

const PKG = "package.json";
const LOCK = "package-lock.json";

describe("parsePackageJson — all 4 sections (venv-cross-checked)", () => {
  it("emits prod/dev/optional/peer(→unknown) in section order", () => {
    const body = JSON.stringify({
      name: "myapp",
      dependencies: { express: "^4.18.0", "@scope/pkg": "1.2.3" },
      devDependencies: { vitest: "^1.0.0" },
      optionalDependencies: { fsevents: "~2.3.0" },
      peerDependencies: { react: ">=18" },
    });
    const out = parsePackageJson({ body, source_manifest: PKG });
    // venv-cross-checked
    expect(out.records).toEqual([
      rec({ name: "express", version_spec: "^4.18.0", dependency_type: "prod", source_manifest: PKG }),
      rec({ name: "@scope/pkg", version_spec: "1.2.3", dependency_type: "prod", source_manifest: PKG }),
      rec({ name: "vitest", version_spec: "^1.0.0", dependency_type: "dev", source_manifest: PKG }),
      rec({ name: "fsevents", version_spec: "~2.3.0", dependency_type: "optional", source_manifest: PKG }),
      rec({ name: "react", version_spec: ">=18", dependency_type: "unknown", source_manifest: PKG }),
    ]);
    expect(out.rejections).toEqual([]);
  });
});

describe("parsePackageJson — non-string version specs → version_spec null (venv-cross-checked)", () => {
  it("number/object/null specs become null; string stays", () => {
    const body = JSON.stringify({ dependencies: { a: 123, b: { x: 1 }, c: null, d: "1.0.0" } });
    const out = parsePackageJson({ body, source_manifest: PKG });
    // venv-cross-checked
    expect(out.records).toEqual([
      rec({ name: "a", version_spec: null, dependency_type: "prod", source_manifest: PKG }),
      rec({ name: "b", version_spec: null, dependency_type: "prod", source_manifest: PKG }),
      rec({ name: "c", version_spec: null, dependency_type: "prod", source_manifest: PKG }),
      rec({ name: "d", version_spec: "1.0.0", dependency_type: "prod", source_manifest: PKG }),
    ]);
    expect(out.rejections).toEqual([]);
  });
});

describe("parsePackageJson — normalization (venv-cross-checked)", () => {
  it("lowercases names and rejects invalid ones", () => {
    const body = JSON.stringify({
      dependencies: { "Good-Name": "1.0", "has space": "2.0", "bang!": "3.0" },
    });
    const out = parsePackageJson({ body, source_manifest: PKG });
    // venv-cross-checked
    expect(out.records).toEqual([
      rec({ name: "good-name", version_spec: "1.0", dependency_type: "prod", source_manifest: PKG }),
    ]);
    expect(out.rejections).toEqual([
      { raw_name: "has space", reason: "regex_validation" },
      { raw_name: "bang!", reason: "regex_validation" },
    ]);
  });

  it("lowercases an all-uppercase name", () => {
    const body = JSON.stringify({ dependencies: { Express: "^4.0.0" } });
    const out = parsePackageJson({ body, source_manifest: PKG });
    // venv-cross-checked
    expect(out.records).toEqual([
      rec({ name: "express", version_spec: "^4.0.0", dependency_type: "prod", source_manifest: PKG }),
    ]);
    expect(out.rejections).toEqual([]);
  });
});

describe("parsePackageJson — malformed / non-object / empty → empty ParseOutcome (venv-cross-checked)", () => {
  it("malformed JSON → empty (fail-open)", () => {
    const out = parsePackageJson({ body: "{not json", source_manifest: PKG });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });

  it("array root → empty", () => {
    const out = parsePackageJson({ body: "[1,2,3]", source_manifest: PKG });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });

  it("string root → empty", () => {
    const out = parsePackageJson({ body: '"hello"', source_manifest: PKG });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });

  it("empty body → empty", () => {
    const out = parsePackageJson({ body: "", source_manifest: PKG });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });

  it("empty object → empty", () => {
    const out = parsePackageJson({ body: "{}", source_manifest: PKG });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });

  it("non-dict section is skipped (array `dependencies`)", () => {
    const body = JSON.stringify({ dependencies: ["express"], devDependencies: { vitest: "1.0" } });
    const out = parsePackageJson({ body, source_manifest: PKG });
    // venv-cross-checked
    expect(out.records).toEqual([
      rec({ name: "vitest", version_spec: "1.0", dependency_type: "dev", source_manifest: PKG }),
    ]);
    expect(out.rejections).toEqual([]);
  });
});

describe("parsePackageJson — over-long version_spec truncated to 256 (venv-cross-checked)", () => {
  it("caps version_spec at 256 chars", () => {
    const body = JSON.stringify({ dependencies: { pkg: "x".repeat(300) } });
    const out = parsePackageJson({ body, source_manifest: PKG });
    // venv-cross-checked: version_spec length == 256, value == "x" * 256
    expect(out.records).toEqual([
      rec({ name: "pkg", version_spec: "x".repeat(256), dependency_type: "prod", source_manifest: PKG }),
    ]);
    expect(out.records[0]?.version_spec).toHaveLength(256);
    expect(out.rejections).toEqual([]);
  });
});

describe("parsePackageLockJson — v2+ packages[''] sections (venv-cross-checked)", () => {
  it("emits root deps in section order; ignores node_modules/* entries", () => {
    const body = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {
          name: "myapp",
          dependencies: { express: "^4.18.0" },
          devDependencies: { vitest: "^1.0.0" },
          optionalDependencies: { fsevents: "~2.3.0" },
        },
        "node_modules/express": { version: "4.18.2" },
      },
    });
    const out = parsePackageLockJson({ body, source_manifest: LOCK });
    // venv-cross-checked
    expect(out.records).toEqual([
      rec({ name: "express", version_spec: "^4.18.0", dependency_type: "prod", source_manifest: LOCK }),
      rec({ name: "vitest", version_spec: "^1.0.0", dependency_type: "dev", source_manifest: LOCK }),
      rec({ name: "fsevents", version_spec: "~2.3.0", dependency_type: "optional", source_manifest: LOCK }),
    ]);
    expect(out.rejections).toEqual([]);
  });

  it("root present but no dep sections → empty", () => {
    const body = JSON.stringify({
      packages: { "": { name: "x" }, "node_modules/foo": { version: "1" } },
    });
    const out = parsePackageLockJson({ body, source_manifest: LOCK });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });

  it("packages present but root '' absent → empty (v2 branch returns early, no v1 fallback)", () => {
    const body = JSON.stringify({ packages: { "node_modules/foo": { version: "1" } } });
    const out = parsePackageLockJson({ body, source_manifest: LOCK });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });

  it("root section non-dict (array) is skipped → empty", () => {
    const body = JSON.stringify({ packages: { "": { dependencies: ["express"] } } });
    const out = parsePackageLockJson({ body, source_manifest: LOCK });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });
});

describe("parsePackageLockJson — v1 dependencies (venv-cross-checked)", () => {
  it("reads version field, dev:true marker, and handles non-dict / non-string version entries", () => {
    const body = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        express: { version: "4.18.2" },
        vitest: { version: "1.0.0", dev: true },
        noversion: {},
        weird: { version: 123 },
        notadict: "plainstring",
      },
    });
    const out = parsePackageLockJson({ body, source_manifest: LOCK });
    // venv-cross-checked
    expect(out.records).toEqual([
      rec({ name: "express", version_spec: "4.18.2", dependency_type: "prod", source_manifest: LOCK }),
      rec({ name: "vitest", version_spec: "1.0.0", dependency_type: "dev", source_manifest: LOCK }),
      rec({ name: "noversion", version_spec: null, dependency_type: "prod", source_manifest: LOCK }),
      rec({ name: "weird", version_spec: null, dependency_type: "prod", source_manifest: LOCK }),
      rec({ name: "notadict", version_spec: null, dependency_type: "prod", source_manifest: LOCK }),
    ]);
    expect(out.rejections).toEqual([]);
  });

  it("dev:false → prod", () => {
    const body = JSON.stringify({ dependencies: { foo: { version: "1.0", dev: false } } });
    const out = parsePackageLockJson({ body, source_manifest: LOCK });
    // venv-cross-checked
    expect(out.records).toEqual([
      rec({ name: "foo", version_spec: "1.0", dependency_type: "prod", source_manifest: LOCK }),
    ]);
    expect(out.rejections).toEqual([]);
  });

  it("dev:1 (truthy non-bool) stays prod — Python uses `is True`", () => {
    const body = JSON.stringify({ dependencies: { foo: { version: "1.0", dev: 1 } } });
    const out = parsePackageLockJson({ body, source_manifest: LOCK });
    // venv-cross-checked
    expect(out.records).toEqual([
      rec({ name: "foo", version_spec: "1.0", dependency_type: "prod", source_manifest: LOCK }),
    ]);
    expect(out.rejections).toEqual([]);
  });

  it("falls through to v1 when `packages` is a non-dict", () => {
    const body = JSON.stringify({
      packages: ["a"],
      dependencies: { express: { version: "4.0" } },
    });
    const out = parsePackageLockJson({ body, source_manifest: LOCK });
    // venv-cross-checked
    expect(out.records).toEqual([
      rec({ name: "express", version_spec: "4.0", dependency_type: "prod", source_manifest: LOCK }),
    ]);
    expect(out.rejections).toEqual([]);
  });

  it("v1 dependencies non-dict (array) → empty", () => {
    const body = JSON.stringify({ dependencies: ["express"] });
    const out = parsePackageLockJson({ body, source_manifest: LOCK });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });

  it("v1 rejects an invalid name", () => {
    const body = JSON.stringify({ dependencies: { "bad name": { version: "1.0" } } });
    const out = parsePackageLockJson({ body, source_manifest: LOCK });
    // venv-cross-checked
    expect(out.records).toEqual([]);
    expect(out.rejections).toEqual([{ raw_name: "bad name", reason: "regex_validation" }]);
  });
});

describe("parsePackageLockJson — malformed / non-object → empty (venv-cross-checked)", () => {
  it("malformed JSON → empty (fail-open)", () => {
    const out = parsePackageLockJson({ body: "{bad", source_manifest: LOCK });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });

  it("array root → empty", () => {
    const out = parsePackageLockJson({ body: "[1,2]", source_manifest: LOCK });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });

  it("empty object (no packages, no dependencies) → empty", () => {
    const out = parsePackageLockJson({ body: "{}", source_manifest: LOCK });
    // venv-cross-checked
    expect(out).toEqual({ records: [], rejections: [] });
  });
});
