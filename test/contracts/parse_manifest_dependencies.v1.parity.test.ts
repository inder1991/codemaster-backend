import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  ParseManifestDependenciesInputV1,
  ParseManifestDependenciesOutputV1,
} from "../../libs/contracts/src/parse_manifest_dependencies.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `<Model>(**payload).model_dump(mode="json")`) and through Zod
// (`<Model>.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
// The embedded `manifests` / `parsed_manifests` entries are real `ManifestSnapshot` payloads
// (see contracts/retrieval/pr_context/v1.py::ManifestSnapshot for the field list).
const PY = "contracts.parse_manifest_dependencies.v1";

// A valid, fully-populated ManifestSnapshot sub-payload (every field set explicitly so the dump
// is fully determined). Mirrors pr_context.v1.parity.test.ts's ManifestSnapshot fixture.
const FULL_MANIFEST = {
  path: "pyproject.toml",
  raw_body: "[project]\nname = \"codemaster\"\n",
  parsed_dependencies: ["requests", "pydantic"],
  parsed_dependency_records: [
    {
      schema_version: 1,
      ecosystem: "pip",
      name: "requests",
      version_spec: ">=2.31.0",
      dependency_type: "prod",
      source_manifest: "pyproject.toml",
    },
  ],
  fetch_status: "success",
  content_type: "text",
  byte_length: 1024,
  sha256: "e".repeat(64),
  truncated: false,
  detected_ecosystem: "python",
  dependency_parsing_state: "parsed",
} as const;

// A minimal ManifestSnapshot (only the required `path`; everything else defaulted) — exercises that
// the nested-model defaults flow through the wrapper identically on both sides.
const MINIMAL_MANIFEST = { path: "go.mod" } as const;

describe("ParseManifestDependenciesInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload (nested manifests) identically", async () => {
    const payload = {
      schema_version: 1,
      manifests: [FULL_MANIFEST, MINIMAL_MANIFEST],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParseManifestDependenciesInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ParseManifestDependenciesInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version/manifests) when omitted", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "ParseManifestDependenciesInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ParseManifestDependenciesInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("preserves a non-default schema_version (int default, NOT Literal)", async () => {
    const payload = { schema_version: 2, manifests: [] };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParseManifestDependenciesInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ParseManifestDependenciesInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT more than 50 manifests (max_length=50)", async () => {
    const bad = { manifests: Array.from({ length: 51 }, () => MINIMAL_MANIFEST) };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParseManifestDependenciesInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ParseManifestDependenciesInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a malformed nested manifest (missing required path)", async () => {
    const bad = { manifests: [{ raw_body: "x" }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParseManifestDependenciesInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ParseManifestDependenciesInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { manifests: [], bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParseManifestDependenciesInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ParseManifestDependenciesInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("ParseManifestDependenciesOutputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload (nested parsed_manifests) identically", async () => {
    const payload = {
      schema_version: 1,
      parsed_manifests: [FULL_MANIFEST, MINIMAL_MANIFEST],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParseManifestDependenciesOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ParseManifestDependenciesOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version/parsed_manifests) when omitted", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "ParseManifestDependenciesOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(ParseManifestDependenciesOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT more than 50 parsed_manifests (max_length=50)", async () => {
    const bad = { parsed_manifests: Array.from({ length: 51 }, () => MINIMAL_MANIFEST) };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParseManifestDependenciesOutputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ParseManifestDependenciesOutputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { parsed_manifests: [], bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "ParseManifestDependenciesOutputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => ParseManifestDependenciesOutputV1.parse(bad)).toThrow();
  }, 30_000);
});
