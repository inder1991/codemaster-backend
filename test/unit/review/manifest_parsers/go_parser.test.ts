// Parity tests for the Go ecosystem dependency parsers — 1:1 with the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_go.py::{parse_go_mod,parse_go_sum}.
//
// Every `expected` vector below was derived by RUNNING the frozen Python parser through its venv
//   (cd vendor/codemaster-py && .venv/bin/python -c "from codemaster.review.manifest_parsers._go import …")
// on the exact same fixture body and transcribing the result — marked "venv-cross-checked". Covers:
//   - go.mod: single requires, require(...) blocks, // indirect markers, directive skips, full-line and
//     inline comments, trailing-version strip, the optional-`require`-prefix regex quirk (a bare
//     `require <path>` with no version matches name=`require`), normalization rejections (unicode \w),
//     scope-strip-empty, CRLF, empty/whitespace bodies, version_spec truncation.
//   - go.sum: <path> <version> <hash> lines, /go.mod suffix strip, dedup, short-line skip, normalization
//     rejections, extra whitespace, CRLF, version truncation.

import { describe, expect, it } from "vitest";

import { parseGoMod, parseGoSum } from "#backend/review/manifest_parsers/go_parser.js";
import type { ParsedDependencyV1 } from "#contracts/pr_context.v1.js";
import type { NormalizationRejection } from "#backend/review/manifest_parsers/normalize.js";

// Compact shape used to write expected vectors without repeating the schema_version=1 / ecosystem="go"
// constants on every line. `rec(...)` expands to the full ParsedDependencyV1 the parser produces.
type RecLite = {
  name: string;
  version_spec: string | null;
  dependency_type: ParsedDependencyV1["dependency_type"];
  source_manifest: string;
};

function rec(r: RecLite): ParsedDependencyV1 {
  return {
    schema_version: 1,
    ecosystem: "go",
    name: r.name,
    version_spec: r.version_spec,
    dependency_type: r.dependency_type,
    source_manifest: r.source_manifest,
  };
}

function expectOutcome(
  actual: { records: ReadonlyArray<ParsedDependencyV1>; rejections: ReadonlyArray<NormalizationRejection> },
  expected: { records: ReadonlyArray<ParsedDependencyV1>; rejections: ReadonlyArray<NormalizationRejection> },
): void {
  expect(actual.records).toEqual(expected.records);
  expect(actual.rejections).toEqual(expected.rejections);
}

describe("parseGoMod — happy paths (venv-cross-checked)", () => {
  it("parses single require + require(...) block, // indirect → unknown", () => {
    const body =
      "module example.com/myapp\n" +
      "\n" +
      "go 1.21\n" +
      "\n" +
      "require github.com/pkg/errors v0.9.1\n" +
      "\n" +
      "require (\n" +
      "\tgithub.com/stretchr/testify v1.8.4\n" +
      "\tgolang.org/x/sync v0.5.0 // indirect\n" +
      ")\n";
    // venv-cross-checked
    expectOutcome(parseGoMod({ body, source_manifest: "go.mod" }), {
      records: [
        rec({ name: "github.com/pkg/errors", version_spec: "v0.9.1", dependency_type: "prod", source_manifest: "go.mod" }),
        rec({ name: "github.com/stretchr/testify", version_spec: "v1.8.4", dependency_type: "prod", source_manifest: "go.mod" }),
        rec({ name: "golang.org/x/sync", version_spec: "v0.5.0", dependency_type: "unknown", source_manifest: "go.mod" }),
      ],
      rejections: [],
    });
  });

  it("single require with // indirect → unknown", () => {
    // venv-cross-checked
    expectOutcome(parseGoMod({ body: "require github.com/foo/bar v1.2.3 // indirect\n", source_manifest: "go.mod" }), {
      records: [rec({ name: "github.com/foo/bar", version_spec: "v1.2.3", dependency_type: "unknown", source_manifest: "go.mod" })],
      rejections: [],
    });
  });

  it("inline non-indirect comment → still prod, comment stripped", () => {
    // venv-cross-checked
    expectOutcome(parseGoMod({ body: "require github.com/foo/bar v1.0.0 // some note\n", source_manifest: "go.mod" }), {
      records: [rec({ name: "github.com/foo/bar", version_spec: "v1.0.0", dependency_type: "prod", source_manifest: "go.mod" })],
      rejections: [],
    });
  });

  it("mixed //indirect (no space, NOT indirect) vs // indirect inside a block", () => {
    const body = "require (\n" + "\tgithub.com/x/y v1.0.0 //indirect\n" + "\tgithub.com/p/q v2.0.0 // indirect\n" + ")\n";
    // venv-cross-checked
    expectOutcome(parseGoMod({ body, source_manifest: "go.mod" }), {
      records: [
        rec({ name: "github.com/x/y", version_spec: "v1.0.0", dependency_type: "prod", source_manifest: "go.mod" }),
        rec({ name: "github.com/p/q", version_spec: "v2.0.0", dependency_type: "unknown", source_manifest: "go.mod" }),
      ],
      rejections: [],
    });
  });

  it("CRLF line endings parse identically", () => {
    const body = "require github.com/foo/bar v1.0.0 // indirect\r\n" + "require (\r\n" + "\tgithub.com/a/b v2.0.0\r\n" + ")\r\n";
    // venv-cross-checked
    expectOutcome(parseGoMod({ body, source_manifest: "go.mod" }), {
      records: [
        rec({ name: "github.com/foo/bar", version_spec: "v1.0.0", dependency_type: "unknown", source_manifest: "go.mod" }),
        rec({ name: "github.com/a/b", version_spec: "v2.0.0", dependency_type: "prod", source_manifest: "go.mod" }),
      ],
      rejections: [],
    });
  });
});

describe("parseGoMod — directives & comments skipped (venv-cross-checked)", () => {
  it("skips module / go / toolchain / replace / exclude / retract", () => {
    const body =
      "module example.com/x\n" +
      "go 1.22\n" +
      "toolchain go1.22.1\n" +
      "replace example.com/old => example.com/new v1.0.0\n" +
      "exclude github.com/bad/dep v1.0.0\n" +
      "retract v1.0.1\n" +
      "require github.com/good/dep v2.3.4\n";
    // venv-cross-checked
    expectOutcome(parseGoMod({ body, source_manifest: "go.mod" }), {
      records: [rec({ name: "github.com/good/dep", version_spec: "v2.3.4", dependency_type: "prod", source_manifest: "go.mod" })],
      rejections: [],
    });
  });

  it("skips full-line // comments (outer and inside a block)", () => {
    const body = "// this is a comment line\n" + "require (\n" + "\t// inner comment\n" + "\tgithub.com/real/dep v1.0.0\n" + ")\n";
    // venv-cross-checked
    expectOutcome(parseGoMod({ body, source_manifest: "go.mod" }), {
      records: [rec({ name: "github.com/real/dep", version_spec: "v1.0.0", dependency_type: "prod", source_manifest: "go.mod" })],
      rejections: [],
    });
  });

  it("no require lines → empty outcome", () => {
    // venv-cross-checked
    expectOutcome(parseGoMod({ body: "module example.com/x\ngo 1.21\n", source_manifest: "go.mod" }), {
      records: [],
      rejections: [],
    });
  });

  it("bare module-path line outside any block is ignored (no `require ` prefix, not in block)", () => {
    // venv-cross-checked
    expectOutcome(parseGoMod({ body: "github.com/foo/bar v1.0.0\n", source_manifest: "go.mod" }), {
      records: [],
      rejections: [],
    });
  });
});

describe("parseGoMod — version strips & quirks (venv-cross-checked)", () => {
  it("strips Go module trailing-version suffix /vN from the name", () => {
    const body = "require (\n" + "\tgithub.com/foo/bar/v2 v2.0.0\n" + "\tgithub.com/baz/qux/v10 v10.1.0\n" + ")\n";
    // venv-cross-checked
    expectOutcome(parseGoMod({ body, source_manifest: "go.mod" }), {
      records: [
        rec({ name: "github.com/foo/bar", version_spec: "v2.0.0", dependency_type: "prod", source_manifest: "go.mod" }),
        rec({ name: "github.com/baz/qux", version_spec: "v10.1.0", dependency_type: "prod", source_manifest: "go.mod" }),
      ],
      rejections: [],
    });
  });

  it("keeps +incompatible version specs verbatim", () => {
    // venv-cross-checked
    expectOutcome(parseGoMod({ body: "require github.com/foo/bar v2.0.0+incompatible\n", source_manifest: "go.mod" }), {
      records: [rec({ name: "github.com/foo/bar", version_spec: "v2.0.0+incompatible", dependency_type: "prod", source_manifest: "go.mod" })],
      rejections: [],
    });
  });

  it("keeps long pseudo-versions verbatim", () => {
    const body = "require golang.org/x/tools v0.0.0-20210101000000-abcdef123456\n";
    // venv-cross-checked
    expectOutcome(parseGoMod({ body, source_manifest: "go.mod" }), {
      records: [
        rec({ name: "golang.org/x/tools", version_spec: "v0.0.0-20210101000000-abcdef123456", dependency_type: "prod", source_manifest: "go.mod" }),
      ],
      rejections: [],
    });
  });

  it("QUIRK: bare `require <path>` with no version matches name=`require`, version=<path>", () => {
    // The optional `require ` prefix is NOT consumed; the regex binds `require`→name, the path→version.
    // venv-cross-checked
    expectOutcome(parseGoMod({ body: "require github.com/foo/bar\n", source_manifest: "go.mod" }), {
      records: [rec({ name: "require", version_spec: "github.com/foo/bar", dependency_type: "prod", source_manifest: "go.mod" })],
      rejections: [],
    });
  });

  it("QUIRK: `require <path> <version>` inside a block — prefix consumed, path is the name", () => {
    const body = "require (\n" + "\trequire github.com/foo/bar v1.0.0\n" + ")\n";
    // venv-cross-checked
    expectOutcome(parseGoMod({ body, source_manifest: "go.mod" }), {
      records: [rec({ name: "github.com/foo/bar", version_spec: "v1.0.0", dependency_type: "prod", source_manifest: "go.mod" })],
      rejections: [],
    });
  });

  it("uppercase module path lowercased by normalization", () => {
    // venv-cross-checked
    expectOutcome(parseGoMod({ body: "require github.com/Sirupsen/logrus v1.0.0\n", source_manifest: "go.mod" }), {
      records: [rec({ name: "github.com/sirupsen/logrus", version_spec: "v1.0.0", dependency_type: "prod", source_manifest: "go.mod" })],
      rejections: [],
    });
  });

  it("block left open (no closing `)`) still emits everything before EOF", () => {
    const body = "require (\n" + "\tgithub.com/a/b v1.0.0\n" + "\tgithub.com/c/d v2.0.0\n";
    // venv-cross-checked
    expectOutcome(parseGoMod({ body, source_manifest: "go.mod" }), {
      records: [
        rec({ name: "github.com/a/b", version_spec: "v1.0.0", dependency_type: "prod", source_manifest: "go.mod" }),
        rec({ name: "github.com/c/d", version_spec: "v2.0.0", dependency_type: "prod", source_manifest: "go.mod" }),
      ],
      rejections: [],
    });
  });

  it("truncates a >256-char version_spec to 256 (single require)", () => {
    const longVer = "v" + "a".repeat(300);
    const out = parseGoMod({ body: `require github.com/foo/bar ${longVer}\n`, source_manifest: "go.mod" });
    // venv-cross-checked: version_spec is exactly 256 chars ("v" + 255 "a").
    expect(out.records).toHaveLength(1);
    expect(out.records[0]?.version_spec).toBe("v" + "a".repeat(255));
    expect(out.records[0]?.version_spec).toHaveLength(256);
    expect(out.rejections).toEqual([]);
  });
});

describe("parseGoMod — normalization rejections & fail-open (venv-cross-checked)", () => {
  it("rejects a unicode name (Python \\w matches it; normalize ASCII-rejects)", () => {
    // venv-cross-checked: café.com/foo → regex_validation rejection (NO record).
    expectOutcome(parseGoMod({ body: "require café.com/foo v1.0.0\n", source_manifest: "go.mod" }), {
      records: [],
      rejections: [{ raw_name: "café.com/foo", reason: "regex_validation" }],
    });
  });

  it("rejects a name that scope-strips to empty (bare /v2)", () => {
    // venv-cross-checked: `/v2` → trailing-version strip empties it → scope_strip_empty.
    expectOutcome(parseGoMod({ body: "require /v2 v1.0.0\n", source_manifest: "go.mod" }), {
      records: [],
      rejections: [{ raw_name: "/v2", reason: "scope_strip_empty" }],
    });
  });

  it("empty body → empty outcome (fail-open)", () => {
    // venv-cross-checked
    expectOutcome(parseGoMod({ body: "", source_manifest: "go.mod" }), { records: [], rejections: [] });
  });

  it("whitespace-only body → empty outcome (fail-open)", () => {
    // venv-cross-checked
    expectOutcome(parseGoMod({ body: "   \n\t\n\n", source_manifest: "go.mod" }), { records: [], rejections: [] });
  });
});

describe("parseGoSum — happy paths (venv-cross-checked)", () => {
  it("emits one record per unique <path> <version>, dedups /go.mod twins", () => {
    const body =
      "github.com/pkg/errors v0.9.1 h1:hashvalue=\n" +
      "github.com/pkg/errors v0.9.1/go.mod h1:othermod=\n" +
      "github.com/stretchr/testify v1.8.4 h1:abc=\n" +
      "github.com/stretchr/testify v1.8.4/go.mod h1:def=\n";
    // venv-cross-checked
    expectOutcome(parseGoSum({ body, source_manifest: "go.sum" }), {
      records: [
        rec({ name: "github.com/pkg/errors", version_spec: "v0.9.1", dependency_type: "unknown", source_manifest: "go.sum" }),
        rec({ name: "github.com/stretchr/testify", version_spec: "v1.8.4", dependency_type: "unknown", source_manifest: "go.sum" }),
      ],
      rejections: [],
    });
  });

  it("a lone /go.mod entry yields the stripped version", () => {
    // venv-cross-checked
    expectOutcome(parseGoSum({ body: "github.com/foo/bar v1.0.0/go.mod h1:hash=\n", source_manifest: "go.sum" }), {
      records: [rec({ name: "github.com/foo/bar", version_spec: "v1.0.0", dependency_type: "unknown", source_manifest: "go.sum" })],
      rejections: [],
    });
  });

  it("strips the Go trailing-version suffix from the module name", () => {
    // venv-cross-checked
    expectOutcome(parseGoSum({ body: "github.com/foo/bar/v2 v2.0.0 h1:hash=\n", source_manifest: "go.sum" }), {
      records: [rec({ name: "github.com/foo/bar", version_spec: "v2.0.0", dependency_type: "unknown", source_manifest: "go.sum" })],
      rejections: [],
    });
  });

  it("dedups two rows that share (path, version) even with different hashes", () => {
    const body = "github.com/a/b v1.0.0 h1:hash1=\n" + "github.com/a/b v1.0.0 h1:hash2=\n";
    // venv-cross-checked
    expectOutcome(parseGoSum({ body, source_manifest: "go.sum" }), {
      records: [rec({ name: "github.com/a/b", version_spec: "v1.0.0", dependency_type: "unknown", source_manifest: "go.sum" })],
      rejections: [],
    });
  });

  it("lowercases uppercase module names", () => {
    // venv-cross-checked
    expectOutcome(parseGoSum({ body: "github.com/Sirupsen/logrus v1.0.0 h1:hash=\n", source_manifest: "go.sum" }), {
      records: [rec({ name: "github.com/sirupsen/logrus", version_spec: "v1.0.0", dependency_type: "unknown", source_manifest: "go.sum" })],
      rejections: [],
    });
  });

  it("tolerates extra surrounding/internal whitespace (str.split semantics)", () => {
    // venv-cross-checked
    expectOutcome(parseGoSum({ body: "  github.com/foo/bar   v1.0.0    h1:hash=  \n", source_manifest: "go.sum" }), {
      records: [rec({ name: "github.com/foo/bar", version_spec: "v1.0.0", dependency_type: "unknown", source_manifest: "go.sum" })],
      rejections: [],
    });
  });

  it("CRLF line endings parse + dedup identically", () => {
    const body = "github.com/foo/bar v1.0.0 h1:hash=\r\n" + "github.com/foo/bar v1.0.0/go.mod h1:other=\r\n";
    // venv-cross-checked
    expectOutcome(parseGoSum({ body, source_manifest: "go.sum" }), {
      records: [rec({ name: "github.com/foo/bar", version_spec: "v1.0.0", dependency_type: "unknown", source_manifest: "go.sum" })],
      rejections: [],
    });
  });
});

describe("parseGoSum — short-line skip, rejections & truncation (venv-cross-checked)", () => {
  it("skips lines with fewer than 3 whitespace-delimited fields", () => {
    const body =
      "github.com/foo/bar v1.0.0\n" + // 2 fields → skip
      "incomplete\n" + // 1 field → skip
      "\n" + // empty → skip
      "github.com/foo/bar v1.0.0 h1:hash=\n"; // 3 fields → kept
    // venv-cross-checked
    expectOutcome(parseGoSum({ body, source_manifest: "go.sum" }), {
      records: [rec({ name: "github.com/foo/bar", version_spec: "v1.0.0", dependency_type: "unknown", source_manifest: "go.sum" })],
      rejections: [],
    });
  });

  it("empty body → empty outcome", () => {
    // venv-cross-checked
    expectOutcome(parseGoSum({ body: "", source_manifest: "go.sum" }), { records: [], rejections: [] });
  });

  it("rejects a unicode name as regex_validation", () => {
    // venv-cross-checked
    expectOutcome(parseGoSum({ body: "café.com/foo v1.0.0 h1:hash=\n", source_manifest: "go.sum" }), {
      records: [],
      rejections: [{ raw_name: "café.com/foo", reason: "regex_validation" }],
    });
  });

  it("truncates a >256-char version_spec to 256", () => {
    const longVer = "v" + "a".repeat(300);
    const out = parseGoSum({ body: `github.com/foo/bar ${longVer} h1:hash=\n`, source_manifest: "go.sum" });
    // venv-cross-checked: version_spec is exactly 256 chars ("v" + 255 "a").
    expect(out.records).toHaveLength(1);
    expect(out.records[0]?.version_spec).toBe("v" + "a".repeat(255));
    expect(out.records[0]?.version_spec).toHaveLength(256);
    expect(out.rejections).toEqual([]);
  });
});
