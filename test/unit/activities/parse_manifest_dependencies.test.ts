/**
 * Unit + parity tests for the `parseManifestDependencies` activity — the 1:1 port of the frozen Python
 * `codemaster/activities/parse_manifest_dependencies.py`.
 *
 * EVERY expected vector in this file was derived by RUNNING the frozen Python parser via its venv
 *   (cd vendor/codemaster-py && .venv/bin/python -c "... _parse_one(ManifestSnapshot(...)) ...")
 * on the exact same fixture body, then transcribing the `model_dump(mode="json")` output verbatim. Each
 * such literal is annotated `venv-cross-checked`.
 *
 * Coverage — mirrors every branch the Python `_parse_one` / `_dispatch` has:
 *   STATES
 *     - UNSUPPORTED_FORMAT (basename matched but no parser: Gemfile)
 *     - PARSED (clean) — package.json prod/dev/optional/peer→unknown
 *     - FAILED (non-empty body, zero records — malformed JSON; valid-but-empty JSON object)
 *     - PARSED (empty body → zero records is NOT a failure)
 *     - PARTIAL (rejections present alongside records)
 *     - PARTIAL (over the MAX_MANIFEST_PARSE_MS time budget — clock-driven)
 *     - TRUNCATED (over the dependency cap — cap lowered via the maxDependencies seam, mirroring the
 *       Python monkeypatch since the 32KB raw_body cap makes a real 5001-entry body unconstructable)
 *   DISPATCH — all 13 supported basenames route + nested-path basename extraction
 *   DEPENDENCY TYPES — prod / dev / optional / test / unknown (pyproject optional-dependency groups)
 *   ECOSYSTEMS — pip / npm / go / cargo / composer (each ecosystem's main + lock parser)
 *   CAPS constants
 *   ACTIVITY end-to-end — per-manifest isolation, mixed ecosystems, empty input
 */

import { describe, expect, it } from "vitest";

import {
  MAX_DEPENDENCIES_PER_MANIFEST,
  MAX_MANIFEST_PARSE_MS,
  ParseManifestDependenciesActivity,
  dispatch,
  parseOne,
} from "#backend/activities/parse_manifest_dependencies.activity.js";

import { ParseManifestDependenciesInputV1 } from "#contracts/parse_manifest_dependencies.v1.js";
import { ManifestSnapshot, ParsedDependencyV1 } from "#contracts/pr_context.v1.js";

import { FakeClock, type Clock } from "#platform/clock.js";

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────

/** Build a contract-validated input ManifestSnapshot the way the fetch activity does. */
function snap(args: { path: string; body?: string; ecosystem?: string | null }): ManifestSnapshot {
  return ManifestSnapshot.parse({
    path: args.path,
    raw_body: args.body ?? "",
    detected_ecosystem: args.ecosystem ?? null,
  });
}

/**
 * Build the expected fully-validated record the way the parsers do, so contract defaults (schema_version,
 * etc.) match exactly. Mirrors the venv `model_dump(mode="json")` shape.
 */
function rec(fields: {
  ecosystem: ParsedDependencyV1["ecosystem"];
  name: string;
  version_spec: string | null;
  dependency_type: ParsedDependencyV1["dependency_type"];
  source_manifest: string;
}): ParsedDependencyV1 {
  return ParsedDependencyV1.parse(fields);
}

/**
 * A clock whose `monotonic()` returns a fixed SEQUENCE of values, one per call. `parseOne` calls
 * `monotonic()` exactly twice (start, then after dispatch); a [0, 0.5] sequence yields a 500 ms duration,
 * driving the over-budget PARTIAL branch deterministically without any banned wall-clock primitive.
 */
function sequenceClock(monotonics: ReadonlyArray<number>): Clock {
  let i = 0;
  return {
    monotonic(): number {
      const v = monotonics[Math.min(i, monotonics.length - 1)] ?? 0;
      i += 1;
      return v;
    },
    now(): Date {
      return new Date(0);
    },
    async sleep(): Promise<void> {
      // no-op
    },
  };
}

// A non-advancing FakeClock: monotonic() is constant ⇒ durationMs is always 0 (well under the budget).
function frozenClock(): Clock {
  return new FakeClock();
}

// ── STATE: UNSUPPORTED_FORMAT ──────────────────────────────────────────────────────────────────────────

describe("dispatch + UNSUPPORTED_FORMAT", () => {
  it("returns null for a basename with no parser (Gemfile)", () => {
    expect(dispatch(snap({ path: "Gemfile", body: 'gem "rails"', ecosystem: "ruby" }))).toBeNull();
  });

  it("classifies UNSUPPORTED_FORMAT when no parser exists", () => {
    // venv-cross-checked: state=unsupported_format, records=[]
    const out = parseOne(snap({ path: "Gemfile", body: 'gem "rails"', ecosystem: "ruby" }), {
      clock: frozenClock(),
    });
    expect(out.dependency_parsing_state).toBe("unsupported_format");
    expect(out.parsed_dependency_records).toEqual([]);
  });

  it("UNSUPPORTED_FORMAT for a known-matcher-no-parser pattern (Dockerfile)", () => {
    const out = parseOne(snap({ path: "Dockerfile", body: "FROM python:3.13", ecosystem: "docker" }), {
      clock: frozenClock(),
    });
    expect(out.dependency_parsing_state).toBe("unsupported_format");
  });
});

// ── STATE: PARSED (clean), package.json with all 4 sections ──────────────────────────────────────────────

describe("PARSED state + dependency-type coverage", () => {
  it("package.json — prod / dev / optional / peer→unknown", () => {
    const body = JSON.stringify({
      dependencies: { express: "^4.18.0", lodash: "4.17.21" },
      devDependencies: { vitest: "^1.0.0" },
      optionalDependencies: { fsevents: "*" },
      peerDependencies: { react: ">=18" },
    });
    const out = parseOne(snap({ path: "package.json", body, ecosystem: "npm" }), { clock: frozenClock() });
    expect(out.dependency_parsing_state).toBe("parsed");
    // venv-cross-checked (frozen Python _parse_one model_dump(mode="json")):
    expect(out.parsed_dependency_records).toEqual([
      rec({ ecosystem: "npm", name: "express", version_spec: "^4.18.0", dependency_type: "prod", source_manifest: "package.json" }),
      rec({ ecosystem: "npm", name: "lodash", version_spec: "4.17.21", dependency_type: "prod", source_manifest: "package.json" }),
      rec({ ecosystem: "npm", name: "vitest", version_spec: "^1.0.0", dependency_type: "dev", source_manifest: "package.json" }),
      rec({ ecosystem: "npm", name: "fsevents", version_spec: "*", dependency_type: "optional", source_manifest: "package.json" }),
      rec({ ecosystem: "npm", name: "react", version_spec: ">=18", dependency_type: "unknown", source_manifest: "package.json" }),
    ]);
  });

  it("pyproject.toml — prod + test + dev + optional dependency-type groups", () => {
    const body = [
      "[project]",
      'name = "x"',
      'dependencies = ["requests>=2.0"]',
      "",
      "[project.optional-dependencies]",
      'test = ["pytest>=7.0"]',
      'dev = ["ruff"]',
      'extras = ["rich"]',
      "",
    ].join("\n");
    const out = parseOne(snap({ path: "pyproject.toml", body, ecosystem: "python" }), {
      clock: frozenClock(),
    });
    expect(out.dependency_parsing_state).toBe("parsed");
    // venv-cross-checked:
    expect(out.parsed_dependency_records).toEqual([
      rec({ ecosystem: "pip", name: "requests", version_spec: ">=2.0", dependency_type: "prod", source_manifest: "pyproject.toml" }),
      rec({ ecosystem: "pip", name: "pytest", version_spec: ">=7.0", dependency_type: "test", source_manifest: "pyproject.toml" }),
      rec({ ecosystem: "pip", name: "ruff", version_spec: null, dependency_type: "dev", source_manifest: "pyproject.toml" }),
      rec({ ecosystem: "pip", name: "rich", version_spec: null, dependency_type: "optional", source_manifest: "pyproject.toml" }),
    ]);
  });
});

// ── STATE: FAILED ────────────────────────────────────────────────────────────────────────────────────────

describe("FAILED state", () => {
  it("non-empty body, malformed JSON → zero records → FAILED", () => {
    // venv-cross-checked: state=failed, records=[]
    const out = parseOne(snap({ path: "package.json", body: "{ this is not json", ecosystem: "npm" }), {
      clock: frozenClock(),
    });
    expect(out.dependency_parsing_state).toBe("failed");
    expect(out.parsed_dependency_records).toEqual([]);
  });

  it("non-empty body, valid-but-empty JSON object → zero records → FAILED", () => {
    // venv-cross-checked: state=failed, records=[]
    const out = parseOne(snap({ path: "package.json", body: "{}", ecosystem: "npm" }), {
      clock: frozenClock(),
    });
    expect(out.dependency_parsing_state).toBe("failed");
  });
});

// ── STATE: PARSED for empty body (zero records is NOT a failure) ─────────────────────────────────────────

describe("PARSED for empty/absent body", () => {
  it("empty body → zero records → PARSED (fetch side flags via fetch_status)", () => {
    // venv-cross-checked: state=parsed, records=[]
    const out = parseOne(snap({ path: "package.json", body: "", ecosystem: "npm" }), {
      clock: frozenClock(),
    });
    expect(out.dependency_parsing_state).toBe("parsed");
    expect(out.parsed_dependency_records).toEqual([]);
  });

  it("whitespace-only body → PARSED (body_present uses .trim())", () => {
    const out = parseOne(snap({ path: "package.json", body: "   \n\t ", ecosystem: "npm" }), {
      clock: frozenClock(),
    });
    expect(out.dependency_parsing_state).toBe("parsed");
  });
});

// ── STATE: PARTIAL ───────────────────────────────────────────────────────────────────────────────────────

describe("PARTIAL state", () => {
  it("rejections present alongside records → PARTIAL", () => {
    // requirements.txt with one good name + one control-char name that normalization rejects.
    const body = "requests==2.31.0\n\x01\x02==1.0\n";
    const out = parseOne(snap({ path: "requirements.txt", body, ecosystem: "pip" }), {
      clock: frozenClock(),
    });
    // venv-cross-checked: state=partial, records=[requests]
    expect(out.dependency_parsing_state).toBe("partial");
    expect(out.parsed_dependency_records).toEqual([
      rec({ ecosystem: "pip", name: "requests", version_spec: "==2.31.0", dependency_type: "prod", source_manifest: "requirements.txt" }),
    ]);
  });

  it("over the MAX_MANIFEST_PARSE_MS time budget → PARTIAL (clean records, no rejections)", () => {
    // A clean body that yields records + zero rejections; the only thing pushing it to PARTIAL is the
    // clock-driven 500 ms duration (monotonic returns 0 then 0.5 → durationMs=500 > 250).
    const body = JSON.stringify({ dependencies: { react: "^18" } });
    const out = parseOne(snap({ path: "package.json", body, ecosystem: "npm" }), {
      clock: sequenceClock([0, 0.5]),
    });
    expect(out.dependency_parsing_state).toBe("partial");
    expect(out.parsed_dependency_records).toEqual([
      rec({ ecosystem: "npm", name: "react", version_spec: "^18", dependency_type: "prod", source_manifest: "package.json" }),
    ]);
  });

  it("exactly at the time budget (250 ms) is NOT over budget → PARSED (strict > comparison)", () => {
    const body = JSON.stringify({ dependencies: { react: "^18" } });
    const out = parseOne(snap({ path: "package.json", body, ecosystem: "npm" }), {
      clock: sequenceClock([0, 0.25]), // durationMs = 250, not > 250
    });
    expect(out.dependency_parsing_state).toBe("parsed");
  });
});

// ── STATE: TRUNCATED ─────────────────────────────────────────────────────────────────────────────────────

describe("TRUNCATED state", () => {
  it("over the dependency cap → truncate to first N + TRUNCATED (cap lowered, mirrors Python monkeypatch)", () => {
    // The 32KB raw_body cap makes a real 5001-entry body unconstructable; lower the cap to 5 via the
    // maxDependencies seam (the TS analogue of the Python test's monkeypatch on the module constant).
    const lines = ["[packages]"];
    for (let i = 0; i < 10; i += 1) {
      lines.push(`pkg${i} = "*"`);
    }
    const out = parseOne(snap({ path: "Pipfile", body: lines.join("\n"), ecosystem: "python" }), {
      clock: frozenClock(),
      maxDependencies: 5,
    });
    expect(out.dependency_parsing_state).toBe("truncated");
    // venv-cross-checked (cap=5): first 5 records, names pkg0..pkg4
    expect(out.parsed_dependency_records).toEqual([
      rec({ ecosystem: "pip", name: "pkg0", version_spec: null, dependency_type: "prod", source_manifest: "Pipfile" }),
      rec({ ecosystem: "pip", name: "pkg1", version_spec: null, dependency_type: "prod", source_manifest: "Pipfile" }),
      rec({ ecosystem: "pip", name: "pkg2", version_spec: null, dependency_type: "prod", source_manifest: "Pipfile" }),
      rec({ ecosystem: "pip", name: "pkg3", version_spec: null, dependency_type: "prod", source_manifest: "Pipfile" }),
      rec({ ecosystem: "pip", name: "pkg4", version_spec: null, dependency_type: "prod", source_manifest: "Pipfile" }),
    ]);
  });

  it("TRUNCATED takes priority over PARTIAL even with rejections present", () => {
    // 2 good names + 1 control-char name (a REAL normalization rejection). Untruncated this body is
    // PARTIAL (rejection present); with the cap binding it must promote to TRUNCATED. venv-cross-checked:
    // untruncated→partial(recs good0,good1); cap=1→truncated(count=1, name=good0).
    const body = "good0==1\ngood1==2\n\x01\x02==3\n";
    const out = parseOne(snap({ path: "requirements.txt", body, ecosystem: "pip" }), {
      clock: frozenClock(),
      maxDependencies: 1,
    });
    expect(out.dependency_parsing_state).toBe("truncated");
    expect(out.parsed_dependency_records).toEqual([
      rec({ ecosystem: "pip", name: "good0", version_spec: "==1", dependency_type: "prod", source_manifest: "requirements.txt" }),
    ]);
  });
});

// ── DISPATCH: all 13 supported basenames route + ecosystem coverage ─────────────────────────────────────

describe("dispatch — all supported basenames + ecosystems", () => {
  it("go.mod — go ecosystem prod records", () => {
    const body = "module example.com/foo\n\ngo 1.21\n\nrequire (\n    github.com/pkg/errors v0.9.1\n    golang.org/x/sync v0.5.0\n)\n";
    const out = parseOne(snap({ path: "go.mod", body, ecosystem: "go" }), { clock: frozenClock() });
    expect(out.dependency_parsing_state).toBe("parsed");
    // venv-cross-checked:
    expect(out.parsed_dependency_records).toEqual([
      rec({ ecosystem: "go", name: "github.com/pkg/errors", version_spec: "v0.9.1", dependency_type: "prod", source_manifest: "go.mod" }),
      rec({ ecosystem: "go", name: "golang.org/x/sync", version_spec: "v0.5.0", dependency_type: "prod", source_manifest: "go.mod" }),
    ]);
  });

  it("Cargo.toml — cargo ecosystem prod + dev", () => {
    const body = [
      "[package]",
      'name = "app"',
      "",
      "[dependencies]",
      'serde = "1.0"',
      'tokio = { version = "1.35", features = ["full"] }',
      "",
      "[dev-dependencies]",
      'criterion = "0.5"',
      "",
    ].join("\n");
    const out = parseOne(snap({ path: "Cargo.toml", body, ecosystem: "cargo" }), { clock: frozenClock() });
    expect(out.dependency_parsing_state).toBe("parsed");
    // venv-cross-checked:
    expect(out.parsed_dependency_records).toEqual([
      rec({ ecosystem: "cargo", name: "serde", version_spec: "1.0", dependency_type: "prod", source_manifest: "Cargo.toml" }),
      rec({ ecosystem: "cargo", name: "tokio", version_spec: "1.35", dependency_type: "prod", source_manifest: "Cargo.toml" }),
      rec({ ecosystem: "cargo", name: "criterion", version_spec: "0.5", dependency_type: "dev", source_manifest: "Cargo.toml" }),
    ]);
  });

  it("composer.json — composer ecosystem prod + dev (php excluded by normalization? no — kept)", () => {
    const body = JSON.stringify({
      require: { "monolog/monolog": "^3.0", php: ">=8.1" },
      "require-dev": { "phpunit/phpunit": "^10.0" },
    });
    const out = parseOne(snap({ path: "composer.json", body, ecosystem: "composer" }), {
      clock: frozenClock(),
    });
    expect(out.dependency_parsing_state).toBe("parsed");
    // venv-cross-checked (note: the "php" platform requirement is dropped by the composer parser):
    expect(out.parsed_dependency_records).toEqual([
      rec({ ecosystem: "composer", name: "monolog/monolog", version_spec: "^3.0", dependency_type: "prod", source_manifest: "composer.json" }),
      rec({ ecosystem: "composer", name: "phpunit/phpunit", version_spec: "^10.0", dependency_type: "dev", source_manifest: "composer.json" }),
    ]);
  });

  it("every supported basename dispatches to a parser (non-null _dispatch)", () => {
    const supported = [
      ["pyproject.toml", '[project]\ndependencies = ["requests>=2.0"]\n'],
      ["requirements.txt", "requests==2.31.0\n"],
      ["requirements-dev.txt", "pytest==7.4.0\n"],
      ["Pipfile", '[packages]\nrequests = "*"\n'],
      ["Pipfile.lock", JSON.stringify({ default: { requests: { version: "==2.31.0" } } })],
      ["package.json", JSON.stringify({ dependencies: { express: "^4" } })],
      ["package-lock.json", JSON.stringify({ packages: { "": { dependencies: { express: "^4" } } } })],
      ["go.mod", "require example.com/foo v0.1.0\n"],
      ["go.sum", "github.com/pkg/errors v0.9.1 h1:abc=\n"],
      ["Cargo.toml", '[dependencies]\nserde = "1"\n'],
      ["Cargo.lock", '[[package]]\nname = "serde"\nversion = "1.0.0"\n'],
      ["composer.json", JSON.stringify({ require: { "monolog/monolog": "^3.0" } })],
      ["composer.lock", JSON.stringify({ packages: [{ name: "monolog/monolog", version: "3.0.0" }] })],
    ] as const;
    for (const [path, body] of supported) {
      const outcome = dispatch(snap({ path, body, ecosystem: "x" }));
      expect(outcome, `dispatch(${path}) must not be null`).not.toBeNull();
    }
  });

  it("requirements.txt is prod, requirements-dev.txt is dev (isDev flag wiring)", () => {
    const prodOut = parseOne(snap({ path: "requirements.txt", body: "requests==2.31.0\n", ecosystem: "pip" }), {
      clock: frozenClock(),
    });
    const devOut = parseOne(snap({ path: "requirements-dev.txt", body: "pytest==7.4.0\n", ecosystem: "pip" }), {
      clock: frozenClock(),
    });
    // venv-cross-checked:
    expect(prodOut.parsed_dependency_records).toEqual([
      rec({ ecosystem: "pip", name: "requests", version_spec: "==2.31.0", dependency_type: "prod", source_manifest: "requirements.txt" }),
    ]);
    expect(devOut.parsed_dependency_records).toEqual([
      rec({ ecosystem: "pip", name: "pytest", version_spec: "==7.4.0", dependency_type: "dev", source_manifest: "requirements-dev.txt" }),
    ]);
  });

  it("nested-path basename extraction (services/api/package.json → package.json parser)", () => {
    const body = JSON.stringify({ dependencies: { express: "^4.18.0" } });
    const out = parseOne(snap({ path: "services/api/package.json", body, ecosystem: "npm" }), {
      clock: frozenClock(),
    });
    expect(out.dependency_parsing_state).toBe("parsed");
    // venv-cross-checked: source_manifest carries the full nested path
    expect(out.parsed_dependency_records).toEqual([
      rec({ ecosystem: "npm", name: "express", version_spec: "^4.18.0", dependency_type: "prod", source_manifest: "services/api/package.json" }),
    ]);
  });
});

// ── CAPS constants ───────────────────────────────────────────────────────────────────────────────────────

describe("resource cap constants", () => {
  it("MAX_DEPENDENCIES_PER_MANIFEST is 5000", () => {
    expect(MAX_DEPENDENCIES_PER_MANIFEST).toBe(5000);
  });
  it("MAX_MANIFEST_PARSE_MS is 250", () => {
    expect(MAX_MANIFEST_PARSE_MS).toBe(250);
  });
});

// ── ACTIVITY end-to-end ──────────────────────────────────────────────────────────────────────────────────

describe("ParseManifestDependenciesActivity end-to-end", () => {
  it("per-manifest isolation: one valid + one malformed → both emitted, independent states", async () => {
    const activity = new ParseManifestDependenciesActivity({ clock: frozenClock() });
    const result = await activity.parseManifestDependencies(
      ParseManifestDependenciesInputV1.parse({
        manifests: [
          snap({ path: "package.json", body: JSON.stringify({ dependencies: { react: "^18" } }), ecosystem: "npm" }),
          snap({ path: "pyproject.toml", body: "[project not valid", ecosystem: "python" }),
        ],
      }),
    );
    expect(result.parsed_manifests).toHaveLength(2);
    const byPath = new Map(result.parsed_manifests.map((m) => [m.path, m.dependency_parsing_state]));
    expect(byPath.get("package.json")).toBe("parsed");
    expect(byPath.get("pyproject.toml")).toBe("failed");
  });

  it("per-manifest isolation: a parser THROW on one manifest does not abort the others (exceeds Python)", async () => {
    // A Pipfile [packages] written as an ARRAY with a non-string element makes parsePipfile's emit()
    // throw a TypeError mid-iteration (faithful to Python's AttributeError). Python ALSO aborts the whole
    // batch on this throw; the TS activity isolates it — the throwing manifest → FAILED, the rest parse.
    const activity = new ParseManifestDependenciesActivity({ clock: frozenClock() });
    const result = await activity.parseManifestDependencies(
      ParseManifestDependenciesInputV1.parse({
        manifests: [
          snap({ path: "Pipfile", body: 'packages = ["x", 123, "y"]\n', ecosystem: "python" }),
          snap({ path: "package.json", body: JSON.stringify({ dependencies: { react: "^18" } }), ecosystem: "npm" }),
        ],
      }),
    );
    expect(result.parsed_manifests).toHaveLength(2);
    const byPath = new Map(result.parsed_manifests.map((m) => [m.path, m.dependency_parsing_state]));
    expect(byPath.get("Pipfile")).toBe("failed");
    expect(byPath.get("package.json")).toBe("parsed");
  });

  it("mixed ecosystems: pyproject(parsed) + Cargo(parsed) + Dockerfile(unsupported)", async () => {
    const activity = new ParseManifestDependenciesActivity({ clock: frozenClock() });
    const result = await activity.parseManifestDependencies(
      ParseManifestDependenciesInputV1.parse({
        manifests: [
          snap({ path: "pyproject.toml", body: '[project]\ndependencies = ["fastapi"]', ecosystem: "python" }),
          snap({ path: "Cargo.toml", body: '[dependencies]\nserde = "1"', ecosystem: "rust" }),
          snap({ path: "Dockerfile", body: "FROM python:3.13", ecosystem: "docker" }),
        ],
      }),
    );
    const byPath = new Map(result.parsed_manifests.map((m) => [m.path, m.dependency_parsing_state]));
    expect(byPath.get("pyproject.toml")).toBe("parsed");
    expect(byPath.get("Cargo.toml")).toBe("parsed");
    expect(byPath.get("Dockerfile")).toBe("unsupported_format");
  });

  it("empty input → empty output", async () => {
    const activity = new ParseManifestDependenciesActivity({ clock: frozenClock() });
    const result = await activity.parseManifestDependencies(
      ParseManifestDependenciesInputV1.parse({ manifests: [] }),
    );
    expect(result.parsed_manifests).toEqual([]);
  });
});
