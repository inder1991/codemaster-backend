import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { InstallationAccessTokenResponseV1 } from "#contracts/installation_access_token_response.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic (calling the
// `InstallationAccessTokenResponseV1` model in the frozen `contracts/integrations/github_app/v1.py`
// via the oracle — `InstallationAccessTokenResponseV1(**payload).model_dump(mode="json")`) and
// through Zod (`InstallationAccessTokenResponseV1.parse(payload)`), then diff canonical JSON.
// Accept/reject must also agree.
//
// `expires_at` is a PLAIN `datetime` on the Python model: a Z-bearing aware value dumps via isoformat
// as `...Z`; the canonicalizer normalizes both `Z` and `+00:00` to `.ffffff+00:00` so the instant
// compares equal. `model_config = ConfigDict(extra="ignore", frozen=True)` ↔ Zod's DEFAULT `.strip()`:
// extra unknown keys (single_file_paths, has_multiple_single_files) are DROPPED in BOTH validators.
const PY = "contracts.integrations.github_app.v1";

describe("InstallationAccessTokenResponseV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a FULL GitHub response identically, DROPPING extra keys", async () => {
    // A representative GitHub `POST .../access_tokens` response with fields we do NOT consume.
    const payload = {
      token: "ghs_redactedtokenvalue",
      expires_at: "2026-05-02T13:00:00+00:00",
      permissions: { contents: "read", pull_requests: "write" },
      repository_selection: "selected",
      // Extra keys GitHub sends that codemaster ignores (extra="ignore" ↔ .strip()):
      single_file_paths: ["config.yaml", "CODEOWNERS"],
      has_multiple_single_files: true,
      repositories: [{ id: 1, name: "demo" }],
    };
    const r = await pyRef({
      pyModule: PY,
      pyCallable: "InstallationAccessTokenResponseV1",
      kwargs: payload,
    });
    expect(r.ok, r.err).toBe(true);
    const ts = InstallationAccessTokenResponseV1.parse(payload);
    // The extra keys must be ABSENT in the Zod result (mirroring Pydantic's drop).
    expect(Object.keys(ts).sort()).toEqual([
      "expires_at",
      "permissions",
      "repository_selection",
      "schema_version",
      "token",
    ]);
    expect("single_file_paths" in ts).toBe(false);
    expect(canonicalize(ts)).toBe(r.out);
  }, 30_000);

  it("applies identical defaults: permissions {}, repository_selection null, schema_version 1", async () => {
    const payload = {
      token: "ghs_minimal",
      expires_at: "2026-05-02T13:00:00.123456+00:00",
    };
    const r = await pyRef({
      pyModule: PY,
      pyCallable: "InstallationAccessTokenResponseV1",
      kwargs: payload,
    });
    expect(r.ok, r.err).toBe(true);
    const ts = InstallationAccessTokenResponseV1.parse(payload);
    expect(ts.permissions).toEqual({});
    expect(ts.repository_selection).toBeNull();
    expect(ts.schema_version).toBe(1);
    expect(canonicalize(ts)).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty token (min_length=1 ↔ .min(1))", async () => {
    const bad = { token: "", expires_at: "2026-05-02T13:00:00+00:00" };
    const r = await pyRef({
      pyModule: PY,
      pyCallable: "InstallationAccessTokenResponseV1",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => InstallationAccessTokenResponseV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an out-of-vocabulary repository_selection", async () => {
    const bad = {
      token: "ghs_x",
      expires_at: "2026-05-02T13:00:00+00:00",
      repository_selection: "bogus",
    };
    const r = await pyRef({
      pyModule: PY,
      pyCallable: "InstallationAccessTokenResponseV1",
      kwargs: bad,
    });
    expect(r.ok).toBe(false);
    expect(() => InstallationAccessTokenResponseV1.parse(bad)).toThrow();
  }, 30_000);
});
