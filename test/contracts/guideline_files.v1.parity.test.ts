import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import {
  DiscoveredGuidelineFilesV1,
  GuidelineFileV1,
} from "../../libs/contracts/src/guideline_files.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// contract class via the oracle — `GuidelineFileV1(**payload).model_dump(mode="json")`) and through
// Zod (`GuidelineFileV1.parse(payload)`), then diff canonical JSON. Accept/reject must also agree.
const PY = "contracts.guideline_files.v1";

// A real lowercase 64-char hex SHA-256 digest (sha256 of the empty string).
const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("GuidelineFileV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a fully-specified payload identically", async () => {
    const payload = {
      schema_version: 1,
      relative_path: "services/payments/CLAUDE.md",
      scope_dir: "services/payments",
      source_pattern: "CLAUDE.md",
      body: "# Payments guardrails\nNo direct ledger writes.",
      content_sha256: SHA,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GuidelineFileV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(GuidelineFileV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the schema_version default (1) when omitted", async () => {
    const payload = {
      relative_path: "CLAUDE.md",
      scope_dir: "",
      source_pattern: "CLAUDE.md",
      body: "root rules",
      content_sha256: SHA,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GuidelineFileV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(GuidelineFileV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts an empty scope_dir (repo-root file; no min_length on scope_dir)", async () => {
    const payload = {
      relative_path: "CLAUDE.md",
      scope_dir: "",
      source_pattern: "CLAUDE.md",
      body: "x",
      content_sha256: SHA,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GuidelineFileV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(GuidelineFileV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts a future schema_version (int, not Literal[1])", async () => {
    const payload = {
      schema_version: 2,
      relative_path: "CLAUDE.md",
      scope_dir: "",
      source_pattern: "CLAUDE.md",
      body: "x",
      content_sha256: SHA,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GuidelineFileV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(GuidelineFileV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty relative_path (min_length=1)", async () => {
    const bad = {
      relative_path: "",
      scope_dir: "",
      source_pattern: "CLAUDE.md",
      body: "x",
      content_sha256: SHA,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GuidelineFileV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => GuidelineFileV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a too-short content_sha256 (min_length=64)", async () => {
    const bad = {
      relative_path: "CLAUDE.md",
      scope_dir: "",
      source_pattern: "CLAUDE.md",
      body: "x",
      content_sha256: "abc123",
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GuidelineFileV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GuidelineFileV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a too-long content_sha256 (max_length=64)", async () => {
    const bad = {
      relative_path: "CLAUDE.md",
      scope_dir: "",
      source_pattern: "CLAUDE.md",
      body: "x",
      content_sha256: `${SHA}0`,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GuidelineFileV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GuidelineFileV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = {
      relative_path: "CLAUDE.md",
      scope_dir: "",
      source_pattern: "CLAUDE.md",
      body: "x",
      content_sha256: SHA,
      bogus: 1,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "GuidelineFileV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => GuidelineFileV1.parse(bad)).toThrow();
  }, 30_000);
});

describe("DiscoveredGuidelineFilesV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a populated envelope identically (nested GuidelineFileV1)", async () => {
    const payload = {
      schema_version: 1,
      files: [
        {
          schema_version: 1,
          relative_path: "CLAUDE.md",
          scope_dir: "",
          source_pattern: "CLAUDE.md",
          body: "root rules",
          content_sha256: SHA,
        },
        {
          schema_version: 1,
          relative_path: "docs/policy/auth.md",
          scope_dir: "docs/policy",
          source_pattern: "docs/policy/*.md",
          body: "auth policy",
          content_sha256: SHA,
        },
      ],
      files_cap_hit: true,
      oversize_files_count: 3,
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiscoveredGuidelineFilesV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DiscoveredGuidelineFilesV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies all defaults (files=[], files_cap_hit=false, oversize=0, schema_version=1)", async () => {
    const payload = {};
    const r = await pyRef({ pyModule: PY, pyCallable: "DiscoveredGuidelineFilesV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(DiscoveredGuidelineFilesV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT a negative oversize_files_count (ge=0)", async () => {
    const bad = { oversize_files_count: -1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiscoveredGuidelineFilesV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DiscoveredGuidelineFilesV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a nested file with an invalid member (empty content_sha256)", async () => {
    const bad = {
      files: [
        {
          relative_path: "CLAUDE.md",
          scope_dir: "",
          source_pattern: "CLAUDE.md",
          body: "x",
          content_sha256: "",
        },
      ],
    };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiscoveredGuidelineFilesV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DiscoveredGuidelineFilesV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { bogus: true };
    const r = await pyRef({ pyModule: PY, pyCallable: "DiscoveredGuidelineFilesV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => DiscoveredGuidelineFilesV1.parse(bad)).toThrow();
  }, 30_000);
});
