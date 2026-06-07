// Parity tests for the Rust (Cargo) manifest parsers — 1:1 with the frozen Python
//   vendor/codemaster-py/codemaster/review/manifest_parsers/_cargo.py
//   ::parse_cargo_toml / parse_cargo_lock.
//
// Every expected vector below was derived by RUNNING the frozen Python parser through its venv
// (vendor/codemaster-py/.venv/bin/python) on the exact same fixture bodies, then transcribing the
// model_dump(mode="json") output. Markers: "venv-cross-checked".
//
// Branch coverage: Cargo.toml [dependencies]/[dev-dependencies]/[build-dependencies]/[target.*] sections,
// prod/dev/unknown dependency types, string vs inline-table dep values, table-without-version (path/git),
// numeric version (→ null), normalization rejection, over-long version_spec truncation, malformed TOML
// (→ empty, fail-open), empty body, missing sections, non-table section, non-table target triple;
// Cargo.lock [[package]] array, missing version, missing name, name rejection, package-not-a-list,
// missing package key, numeric version, malformed lock.

import { describe, expect, it } from "vitest";

import {
  parseCargoLock,
  parseCargoToml,
} from "#backend/review/manifest_parsers/cargo_parser.js";
import type { ParsedDependencyV1 } from "#contracts/pr_context.v1.js";

// Helper: build the fully-defaulted record shape the Python model_dump emits (schema_version always 1).
function dep(
  name: string,
  version_spec: string | null,
  dependency_type: ParsedDependencyV1["dependency_type"],
  source_manifest: string,
): ParsedDependencyV1 {
  return {
    schema_version: 1,
    ecosystem: "cargo",
    name,
    version_spec,
    dependency_type,
    source_manifest,
  };
}

describe("parseCargoToml — full manifest, all sections + value shapes", () => {
  // venv-cross-checked
  it("emits prod/dev records, unpacks inline tables, returns null for path/git tables, walks targets", () => {
    const body = [
      "",
      "[dependencies]",
      'serde = "1.0"',
      'tokio = { version = "1", features = ["full"] }',
      'local-crate = { path = "../local" }',
      'git-crate = { git = "https://github.com/foo/bar" }',
      "",
      "[dev-dependencies]",
      'pretty_assertions = "1.4.0"',
      'mockall = { version = "0.11" }',
      "",
      "[build-dependencies]",
      'cc = "1.0"',
      "",
      "[target.'cfg(unix)'.dependencies]",
      'nix = "0.26"',
      "",
      "[target.x86_64-pc-windows-msvc.dependencies]",
      'winapi = { version = "0.3.9", features = ["winuser"] }',
      "",
    ].join("\n");

    const outcome = parseCargoToml({ body, source_manifest: "Cargo.toml" });

    expect(outcome.rejections).toEqual([]);
    expect(outcome.records).toEqual([
      dep("serde", "1.0", "prod", "Cargo.toml"),
      dep("tokio", "1", "prod", "Cargo.toml"),
      dep("local-crate", null, "prod", "Cargo.toml"),
      dep("git-crate", null, "prod", "Cargo.toml"),
      dep("pretty_assertions", "1.4.0", "dev", "Cargo.toml"),
      dep("mockall", "0.11", "dev", "Cargo.toml"),
      dep("cc", "1.0", "dev", "Cargo.toml"),
      dep("nix", "0.26", "prod", "Cargo.toml"),
      dep("winapi", "0.3.9", "prod", "Cargo.toml"),
    ]);
  });
});

describe("parseCargoToml — normalization", () => {
  // venv-cross-checked
  it("rejects an invalid name (regex_validation) and lowercases the valid one", () => {
    const body = ["", "[dependencies]", '"bad name!" = "1.0"', '"Good-Name" = "2.0"', ""].join("\n");

    const outcome = parseCargoToml({ body, source_manifest: "Cargo.toml" });

    expect(outcome.records).toEqual([dep("good-name", "2.0", "prod", "Cargo.toml")]);
    expect(outcome.rejections).toEqual([{ raw_name: "bad name!", reason: "regex_validation" }]);
  });

  // venv-cross-checked
  it("truncates an over-long version_spec to 256 chars (not rejected)", () => {
    // input version is 257 chars: "1." + "x"*255 → truncated to "1." + "x"*254.
    const longVer = "1." + "x".repeat(255);
    expect(longVer.length).toBe(257);
    const body = ["", "[dependencies]", `foo = "${longVer}"`, ""].join("\n");

    const outcome = parseCargoToml({ body, source_manifest: "Cargo.toml" });

    const truncated = "1." + "x".repeat(254);
    expect(truncated.length).toBe(256);
    expect(outcome.records).toEqual([dep("foo", truncated, "prod", "Cargo.toml")]);
    expect(outcome.rejections).toEqual([]);
  });
});

describe("parseCargoToml — degraded / edge inputs", () => {
  // venv-cross-checked
  it("malformed TOML → empty ParseOutcome (fail-open)", () => {
    const outcome = parseCargoToml({ body: "[dependencies\nserde = ", source_manifest: "Cargo.toml" });
    expect(outcome).toEqual({ records: [], rejections: [] });
  });

  // venv-cross-checked
  it("empty body → empty ParseOutcome", () => {
    const outcome = parseCargoToml({ body: "", source_manifest: "Cargo.toml" });
    expect(outcome).toEqual({ records: [], rejections: [] });
  });

  // venv-cross-checked
  it("no dependency sections (only [package] metadata) → empty records", () => {
    const body = ["", "[package]", 'name = "mycrate"', 'version = "0.1.0"', ""].join("\n");
    const outcome = parseCargoToml({ body, source_manifest: "Cargo.toml" });
    expect(outcome).toEqual({ records: [], rejections: [] });
  });

  // venv-cross-checked
  it("a non-table section value (dependencies = \"oops\") is skipped; a real section still parses", () => {
    const body = ['dependencies = "oops"', "[dev-dependencies]", 'real = "1"'].join("\n");
    const outcome = parseCargoToml({ body, source_manifest: "Cargo.toml" });
    expect(outcome.records).toEqual([dep("real", "1", "dev", "Cargo.toml")]);
    expect(outcome.rejections).toEqual([]);
  });

  // venv-cross-checked
  it("[target.*] edges: non-table triple + triple without .dependencies are skipped; real target dep parses", () => {
    const body = [
      "[target]",
      '"weird" = "notatable"',
      "[target.'cfg(foo)']",
      'nodeps = "here"',
      "[target.'cfg(bar)'.dependencies]",
      'realdep = "1.2"',
    ].join("\n");
    const outcome = parseCargoToml({ body, source_manifest: "Cargo.toml" });
    expect(outcome.records).toEqual([dep("realdep", "1.2", "prod", "Cargo.toml")]);
    expect(outcome.rejections).toEqual([]);
  });

  // venv-cross-checked
  it("numeric version (table {version=1} and bare int) → version_spec null", () => {
    const body = ["", "[dependencies]", "foo = { version = 1 }", "bar = 2", ""].join("\n");
    const outcome = parseCargoToml({ body, source_manifest: "Cargo.toml" });
    expect(outcome.records).toEqual([
      dep("foo", null, "prod", "Cargo.toml"),
      dep("bar", null, "prod", "Cargo.toml"),
    ]);
    expect(outcome.rejections).toEqual([]);
  });
});

describe("parseCargoLock — [[package]] array", () => {
  // venv-cross-checked
  it("walks packages; dependency_type unknown; missing version → null", () => {
    const body = [
      "",
      "version = 3",
      "",
      "[[package]]",
      'name = "serde"',
      'version = "1.0.197"',
      "",
      "[[package]]",
      'name = "tokio"',
      'version = "1.36.0"',
      "",
      "[[package]]",
      'name = "no-version-pkg"',
      "",
    ].join("\n");

    const outcome = parseCargoLock({ body, source_manifest: "Cargo.lock" });

    expect(outcome.rejections).toEqual([]);
    expect(outcome.records).toEqual([
      dep("serde", "1.0.197", "unknown", "Cargo.lock"),
      dep("tokio", "1.36.0", "unknown", "Cargo.lock"),
      dep("no-version-pkg", null, "unknown", "Cargo.lock"),
    ]);
  });

  // venv-cross-checked
  it("package value not a list → empty ParseOutcome", () => {
    const outcome = parseCargoLock({ body: 'package = "oops"', source_manifest: "Cargo.lock" });
    expect(outcome).toEqual({ records: [], rejections: [] });
  });

  // venv-cross-checked
  it("missing package key → empty ParseOutcome", () => {
    const outcome = parseCargoLock({ body: "version = 3", source_manifest: "Cargo.lock" });
    expect(outcome).toEqual({ records: [], rejections: [] });
  });

  // venv-cross-checked
  it("entry missing name is skipped; the named entry still parses", () => {
    const body = [
      "[[package]]",
      'version = "1.0"',
      "",
      "[[package]]",
      'name = "valid"',
      'version = "2.0"',
    ].join("\n");
    const outcome = parseCargoLock({ body, source_manifest: "Cargo.lock" });
    expect(outcome.records).toEqual([dep("valid", "2.0", "unknown", "Cargo.lock")]);
    expect(outcome.rejections).toEqual([]);
  });

  // venv-cross-checked
  it("name normalization rejection is collected; the valid one is lowercased", () => {
    const body = [
      "[[package]]",
      'name = "bad name!"',
      'version = "1.0"',
      "",
      "[[package]]",
      'name = "GoodName"',
      'version = "2.0"',
    ].join("\n");
    const outcome = parseCargoLock({ body, source_manifest: "Cargo.lock" });
    expect(outcome.records).toEqual([dep("goodname", "2.0", "unknown", "Cargo.lock")]);
    expect(outcome.rejections).toEqual([{ raw_name: "bad name!", reason: "regex_validation" }]);
  });

  // venv-cross-checked
  it("malformed lock → empty ParseOutcome (fail-open)", () => {
    const outcome = parseCargoLock({ body: "[[package\n", source_manifest: "Cargo.lock" });
    expect(outcome).toEqual({ records: [], rejections: [] });
  });

  // venv-cross-checked
  it("numeric version → version_spec null", () => {
    const body = ["[[package]]", 'name = "foo"', "version = 123"].join("\n");
    const outcome = parseCargoLock({ body, source_manifest: "Cargo.lock" });
    expect(outcome.records).toEqual([dep("foo", null, "unknown", "Cargo.lock")]);
    expect(outcome.rejections).toEqual([]);
  });
});
