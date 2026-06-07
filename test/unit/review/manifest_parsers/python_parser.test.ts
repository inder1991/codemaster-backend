// Parity tests for the Python ecosystem dependency parsers — 1:1 with the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_python.py.
//
// EVERY expected vector below was derived by RUNNING the frozen Python parser through its venv on these
// exact fixture bodies (cd vendor/codemaster-py && .venv/bin/python ...) and hardcoding the output.
// Lines tagged `venv-cross-checked` were transcribed verbatim from that run.

import { describe, expect, it } from "vitest";

import {
  parsePipfile,
  parsePipfileLock,
  parsePyproject,
  parseRequirementsTxt,
} from "#backend/review/manifest_parsers/python_parser.js";
import type { ParseOutcome } from "#backend/review/manifest_parsers/parse_outcome.js";
import type { ParsedDependencyV1 } from "#contracts/pr_context.v1.js";

// A compact record-shape for assertions (drops nothing — ParsedDependencyV1 has exactly these fields).
type Rec = {
  ecosystem: ParsedDependencyV1["ecosystem"];
  name: string;
  version_spec: string | null;
  dependency_type: ParsedDependencyV1["dependency_type"];
  source_manifest: string;
  schema_version: number;
};

function recs(outcome: ParseOutcome): Array<Rec> {
  return outcome.records.map((r) => ({
    ecosystem: r.ecosystem,
    name: r.name,
    version_spec: r.version_spec,
    dependency_type: r.dependency_type,
    source_manifest: r.source_manifest,
    schema_version: r.schema_version,
  }));
}

function rejs(outcome: ParseOutcome): Array<{ raw_name: string; reason: string }> {
  return outcome.rejections.map((rj) => ({ raw_name: rj.raw_name, reason: rj.reason }));
}

// Shorthand builder — every record this subsystem emits is ecosystem="pip", schema_version=1.
function pip(
  name: string,
  version_spec: string | null,
  dependency_type: Rec["dependency_type"],
  source_manifest: string,
): Rec {
  return { ecosystem: "pip", name, version_spec, dependency_type, source_manifest, schema_version: 1 };
}

// ─── pyproject.toml ───────────────────────────────────────────────

describe("parsePyproject — PEP 621 + Poetry (full)", () => {
  const body = `
[project]
name = "demo"
dependencies = [
    "fastapi>=0.90",
    "requests[security]>=2.0",
    "Django",
    "PyYAML ~= 6.0",
]

[project.optional-dependencies]
dev = ["pytest>=7", "ruff"]
test = ["coverage"]
docs = ["sphinx>=5"]

[tool.poetry.dependencies]
python = "^3.13"
httpx = "^0.27"
"some.weird/name" = "*"

[tool.poetry.group.dev.dependencies]
black = "^24.0"

[tool.poetry.group.testing.dependencies]
pytest-cov = "^4.0"

[tool.poetry.group.lint.dependencies]
mypy = "^1.0"
`;

  it("emits every record in source order with correct scope + version_spec (venv-cross-checked)", () => {
    const out = parsePyproject({ body, source_manifest: "pyproject.toml" });
    expect(recs(out)).toEqual([
      // PEP 621 [project].dependencies → prod. Extras stripped by normalizer; `requests[security]` → `requests`.
      pip("fastapi", ">=0.90", "prod", "pyproject.toml"),
      pip("requests", ">=2.0", "prod", "pyproject.toml"),
      pip("django", null, "prod", "pyproject.toml"),
      pip("pyyaml", "~= 6.0", "prod", "pyproject.toml"),
      // optional-dependencies groups: dev→dev, test→test, docs→optional (unknown group name).
      pip("pytest", ">=7", "dev", "pyproject.toml"),
      pip("ruff", null, "dev", "pyproject.toml"),
      pip("coverage", null, "test", "pyproject.toml"),
      pip("sphinx", ">=5", "optional", "pyproject.toml"),
      // tool.poetry.dependencies → prod; `python` key skipped; quoted key splits at `/` (PEP508 prefix).
      pip("httpx", null, "prod", "pyproject.toml"),
      pip("some.weird", "/name", "prod", "pyproject.toml"),
      // poetry groups: dev→dev, testing→test, lint→optional.
      pip("black", null, "dev", "pyproject.toml"),
      pip("pytest-cov", null, "test", "pyproject.toml"),
      pip("mypy", null, "optional", "pyproject.toml"),
    ]);
    expect(rejs(out)).toEqual([]);
  });
});

describe("parsePyproject — malformed / empty / missing-section (fail-open)", () => {
  it("malformed TOML → empty ParseOutcome (venv-cross-checked)", () => {
    const out = parsePyproject({ body: "this is = = not toml [[[", source_manifest: "pyproject.toml" });
    expect(recs(out)).toEqual([]);
    expect(rejs(out)).toEqual([]);
  });

  it("empty body → empty ParseOutcome (venv-cross-checked)", () => {
    const out = parsePyproject({ body: "", source_manifest: "pyproject.toml" });
    expect(recs(out)).toEqual([]);
    expect(rejs(out)).toEqual([]);
  });

  it("no dependency sections → empty (venv-cross-checked)", () => {
    const out = parsePyproject({
      body: '[build-system]\nrequires = ["setuptools"]\n',
      source_manifest: "pyproject.toml",
    });
    expect(recs(out)).toEqual([]);
    expect(rejs(out)).toEqual([]);
  });

  it("dependencies field is a string (not a list) → coerced to [] (venv-cross-checked)", () => {
    const out = parsePyproject({
      body: '[project]\ndependencies = "notalist"\n',
      source_manifest: "pyproject.toml",
    });
    expect(recs(out)).toEqual([]);
    expect(rejs(out)).toEqual([]);
  });

  it("non-string list entries are filtered out (venv-cross-checked)", () => {
    const out = parsePyproject({
      body: '[project]\ndependencies = ["valid", 123, "also-valid"]\n',
      source_manifest: "pyproject.toml",
    });
    expect(recs(out)).toEqual([
      pip("valid", null, "prod", "pyproject.toml"),
      pip("also-valid", null, "prod", "pyproject.toml"),
    ]);
    expect(rejs(out)).toEqual([]);
  });

  it("extras-only spec rejects as extras_strip_empty (venv-cross-checked)", () => {
    const out = parsePyproject({
      body: '[project]\ndependencies = ["[extras]"]\n',
      source_manifest: "pyproject.toml",
    });
    expect(recs(out)).toEqual([]);
    expect(rejs(out)).toEqual([{ raw_name: "[extras]", reason: "extras_strip_empty" }]);
  });
});

describe("parsePyproject — un-guarded poetry iteration (Python `for x in (v or {})`)", () => {
  it("tool.poetry.dependencies as a LIST yields its elements (venv-cross-checked)", () => {
    const out = parsePyproject({
      body: '[tool.poetry]\ndependencies = ["x", "y"]\n',
      source_manifest: "p.toml",
    });
    expect(recs(out)).toEqual([
      pip("x", null, "prod", "p.toml"),
      pip("y", null, "prod", "p.toml"),
    ]);
    expect(rejs(out)).toEqual([]);
  });

  it("tool.poetry.dependencies as a STRING iterates its characters (venv-cross-checked)", () => {
    const out = parsePyproject({
      body: '[tool.poetry]\ndependencies = "ab"\n',
      source_manifest: "p.toml",
    });
    expect(recs(out)).toEqual([
      pip("a", null, "prod", "p.toml"),
      pip("b", null, "prod", "p.toml"),
    ]);
    expect(rejs(out)).toEqual([]);
  });

  it("tool.poetry.group.<g>.dependencies as a LIST yields its elements (venv-cross-checked)", () => {
    const out = parsePyproject({
      body: '[tool.poetry.group.dev]\ndependencies = ["x"]\n',
      source_manifest: "p.toml",
    });
    expect(recs(out)).toEqual([pip("x", null, "dev", "p.toml")]);
    expect(rejs(out)).toEqual([]);
  });
});

// ─── requirements.txt / requirements-dev.txt ──────────────────────

describe("parseRequirementsTxt — line grammar", () => {
  const body = `# top comment
requests==2.31.0
fastapi[all]>=0.90,<1.0  # inline comment
Django

-r other.txt
-e git+https://github.com/x/y.git#egg=z
--hash=sha256:abc
  pyyaml ~= 6.0
flask >= 2.0
[brokenname]
réquests==1.0
`;

  it("prod scope: skips comments/directives/blank lines; weird PEP508 splits (venv-cross-checked)", () => {
    const out = parseRequirementsTxt({ body, source_manifest: "requirements.txt", isDev: false });
    expect(recs(out)).toEqual([
      pip("requests", "==2.31.0", "prod", "requirements.txt"),
      // `fastapi[all]` extras stripped by normalizer; inline `# comment` removed.
      pip("fastapi", ">=0.90,<1.0", "prod", "requirements.txt"),
      pip("django", null, "prod", "requirements.txt"),
      pip("pyyaml", "~= 6.0", "prod", "requirements.txt"),
      pip("flask", ">= 2.0", "prod", "requirements.txt"),
      // `réquests==1.0`: PEP508 prefix matches only `r`; rest `équests==1.0` becomes the version_spec.
      pip("r", "équests==1.0", "prod", "requirements.txt"),
    ]);
    // `[brokenname]` has no PEP508 prefix → passed whole to normalizer → extras strip empties it.
    expect(rejs(out)).toEqual([{ raw_name: "[brokenname]", reason: "extras_strip_empty" }]);
  });

  it("dev scope tags dependency_type=dev (venv-cross-checked)", () => {
    const out = parseRequirementsTxt({
      body: "pytest\ncoverage>=7\n",
      source_manifest: "requirements-dev.txt",
      isDev: true,
    });
    expect(recs(out)).toEqual([
      pip("pytest", null, "dev", "requirements-dev.txt"),
      pip("coverage", ">=7", "dev", "requirements-dev.txt"),
    ]);
    expect(rejs(out)).toEqual([]);
  });

  it("empty body → empty ParseOutcome (venv-cross-checked)", () => {
    const out = parseRequirementsTxt({ body: "", source_manifest: "requirements.txt", isDev: false });
    expect(recs(out)).toEqual([]);
    expect(rejs(out)).toEqual([]);
  });

  it("over-long version_spec is truncated to 256 chars (venv-cross-checked)", () => {
    const longSpec = ">=" + "1".repeat(300);
    const out = parseRequirementsTxt({
      body: `foo${longSpec}\n`,
      source_manifest: "requirements.txt",
      isDev: false,
    });
    expect(out.records).toHaveLength(1);
    const rec = out.records[0];
    expect(rec).toBeDefined();
    expect(rec?.name).toBe("foo");
    // Python truncates `_split_name_and_version` output at _VERSION_SPEC_MAX_LENGTH=256.
    expect(rec?.version_spec).toBe(">=" + "1".repeat(254));
    expect(rec?.version_spec?.length).toBe(256);
    expect(rejs(out)).toEqual([]);
  });
});

// ─── Pipfile (TOML) ───────────────────────────────────────────────

describe("parsePipfile — [packages] + [dev-packages]", () => {
  const body = `
[[source]]
url = "https://pypi.org/simple"

[packages]
requests = "*"
flask = ">=2.0"
"Django" = "==4.2"

[dev-packages]
pytest = "*"
black = "==24.1"
`;

  it("prod from [packages], dev from [dev-packages]; version_spec always null (keys only) (venv-cross-checked)", () => {
    const out = parsePipfile({ body, source_manifest: "Pipfile" });
    expect(recs(out)).toEqual([
      pip("requests", null, "prod", "Pipfile"),
      pip("flask", null, "prod", "Pipfile"),
      pip("django", null, "prod", "Pipfile"),
      pip("pytest", null, "dev", "Pipfile"),
      pip("black", null, "dev", "Pipfile"),
    ]);
    expect(rejs(out)).toEqual([]);
  });

  it("malformed TOML → empty ParseOutcome (venv-cross-checked)", () => {
    const out = parsePipfile({ body: "[[[ not toml", source_manifest: "Pipfile" });
    expect(recs(out)).toEqual([]);
    expect(rejs(out)).toEqual([]);
  });

  it("empty body → empty ParseOutcome (venv-cross-checked)", () => {
    const out = parsePipfile({ body: "", source_manifest: "Pipfile" });
    expect(recs(out)).toEqual([]);
    expect(rejs(out)).toEqual([]);
  });

  it("[packages] as a LIST yields its elements (un-guarded iteration) (venv-cross-checked)", () => {
    const out = parsePipfile({ body: 'packages = ["x", "y"]\n', source_manifest: "Pipfile" });
    expect(recs(out)).toEqual([
      pip("x", null, "prod", "Pipfile"),
      pip("y", null, "prod", "Pipfile"),
    ]);
    expect(rejs(out)).toEqual([]);
  });

  it("[packages] mixed-type array throws mid-iteration, just like Python's AttributeError (venv-cross-checked)", () => {
    // Python: emits "x", then `123.strip()` raises AttributeError → the whole parse_pipfile call
    // propagates the exception (no partial ParseOutcome). The TS port throws a TypeError equivalently.
    expect(() =>
      parsePipfile({ body: 'packages = ["x", 123, "y"]\n', source_manifest: "Pipfile" }),
    ).toThrow(TypeError);
  });
});

// ─── Pipfile.lock (JSON) ──────────────────────────────────────────

describe("parsePipfileLock — default + develop", () => {
  it("default→prod, develop→dev; version_spec always null (keys only) (venv-cross-checked)", () => {
    const body = JSON.stringify({
      _meta: { hash: { sha256: "x" } },
      default: {
        requests: { version: "==2.31.0" },
        flask: { version: "==2.0" },
      },
      develop: {
        pytest: { version: "==7.0" },
      },
    });
    const out = parsePipfileLock({ body, source_manifest: "Pipfile.lock" });
    expect(recs(out)).toEqual([
      pip("requests", null, "prod", "Pipfile.lock"),
      pip("flask", null, "prod", "Pipfile.lock"),
      pip("pytest", null, "dev", "Pipfile.lock"),
    ]);
    expect(rejs(out)).toEqual([]);
  });

  it("malformed JSON → empty ParseOutcome (venv-cross-checked)", () => {
    const out = parsePipfileLock({ body: "{not json", source_manifest: "Pipfile.lock" });
    expect(recs(out)).toEqual([]);
    expect(rejs(out)).toEqual([]);
  });

  it("non-dict JSON root (array) → empty ParseOutcome (venv-cross-checked)", () => {
    const out = parsePipfileLock({ body: "[1,2,3]", source_manifest: "Pipfile.lock" });
    expect(recs(out)).toEqual([]);
    expect(rejs(out)).toEqual([]);
  });

  it("section that is not a dict is skipped; the other section still parses (venv-cross-checked)", () => {
    const body = JSON.stringify({ default: "notadict", develop: { x: {} } });
    const out = parsePipfileLock({ body, source_manifest: "Pipfile.lock" });
    expect(recs(out)).toEqual([pip("x", null, "dev", "Pipfile.lock")]);
    expect(rejs(out)).toEqual([]);
  });

  it("empty JSON object → empty ParseOutcome (venv-cross-checked)", () => {
    const out = parsePipfileLock({ body: "{}", source_manifest: "Pipfile.lock" });
    expect(recs(out)).toEqual([]);
    expect(rejs(out)).toEqual([]);
  });
});
