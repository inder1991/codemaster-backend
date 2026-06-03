import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  FetchManifestSnapshotsInputV1,
  FetchManifestSnapshotsOutputV1,
} from "../../libs/contracts/src/fetch_manifest_snapshots.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `<Model>(**payload).model_dump(mode="json")`) and through Zod
// (`<Model>.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
// UUIDs are spelled lowercase so Pydantic's lowercasing-on-dump matches Zod's pass-through.
const PY = "contracts.fetch_manifest_snapshots.v1";

describe("FetchManifestSnapshotsInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload identically", async () => {
    const payload = {
      schema_version: 1,
      installation_id: "550e8400-e29b-41d4-a716-446655440000",
      github_installation_id: 12345678,
      repository_id: "123e4567-e89b-12d3-a456-426614174000",
      gh_owner: "inder1991",
      gh_repo_name: "inventory-service",
      head_sha: "a".repeat(40),
      candidate_paths: ["pyproject.toml", "frontend/package.json", "go.mod"],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FetchManifestSnapshotsInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version/candidate_paths) when omitted", async () => {
    const payload = {
      installation_id: "550e8400-e29b-41d4-a716-446655440000",
      github_installation_id: 0,
      repository_id: "123e4567-e89b-12d3-a456-426614174000",
      gh_owner: "acme",
      gh_repo_name: "repo",
      head_sha: "0".repeat(40),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FetchManifestSnapshotsInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative github_installation_id (ge=0)", async () => {
    const bad = {
      installation_id: "550e8400-e29b-41d4-a716-446655440000",
      github_installation_id: -1,
      repository_id: "123e4567-e89b-12d3-a456-426614174000",
      gh_owner: "acme",
      gh_repo_name: "repo",
      head_sha: "0".repeat(40),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FetchManifestSnapshotsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a head_sha that is not exactly 40 chars (min/max=40)", async () => {
    const bad = {
      installation_id: "550e8400-e29b-41d4-a716-446655440000",
      github_installation_id: 1,
      repository_id: "123e4567-e89b-12d3-a456-426614174000",
      gh_owner: "acme",
      gh_repo_name: "repo",
      head_sha: "a".repeat(39),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FetchManifestSnapshotsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-UUID installation_id", async () => {
    const bad = {
      installation_id: "not-a-uuid",
      github_installation_id: 1,
      repository_id: "123e4567-e89b-12d3-a456-426614174000",
      gh_owner: "acme",
      gh_repo_name: "repo",
      head_sha: "a".repeat(40),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FetchManifestSnapshotsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an empty gh_owner (min_length=1)", async () => {
    const bad = {
      installation_id: "550e8400-e29b-41d4-a716-446655440000",
      github_installation_id: 1,
      repository_id: "123e4567-e89b-12d3-a456-426614174000",
      gh_owner: "",
      gh_repo_name: "repo",
      head_sha: "a".repeat(40),
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FetchManifestSnapshotsInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      installation_id: "550e8400-e29b-41d4-a716-446655440000",
      github_installation_id: 1,
      repository_id: "123e4567-e89b-12d3-a456-426614174000",
      gh_owner: "acme",
      gh_repo_name: "repo",
      head_sha: "a".repeat(40),
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FetchManifestSnapshotsInputV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("FetchManifestSnapshotsOutputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-populated payload (nested ManifestSnapshot) identically", async () => {
    const payload = {
      schema_version: 1,
      manifests: [
        {
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
        },
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FetchManifestSnapshotsOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same defaults (schema_version/manifests) when omitted", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FetchManifestSnapshotsOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("dumps a nested manifest relying on its own v2 defaults identically", async () => {
    const payload = { manifests: [{ path: "go.mod" }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsOutputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(FetchManifestSnapshotsOutputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT more than 50 manifests (max_length=50)", async () => {
    const oneManifest = { path: "go.mod" };
    const bad = { manifests: Array.from({ length: 51 }, () => oneManifest) };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsOutputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FetchManifestSnapshotsOutputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a nested manifest with an unknown fetch_status (propagated strictness)", async () => {
    const bad = { manifests: [{ path: "a", fetch_status: "rate_limited" }] };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsOutputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FetchManifestSnapshotsOutputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { manifests: [], bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "FetchManifestSnapshotsOutputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => FetchManifestSnapshotsOutputV1.parse(bad)).toThrow();
  }, 30_000);
});
