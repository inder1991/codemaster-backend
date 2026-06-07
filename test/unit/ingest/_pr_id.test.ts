// Parity test for derivePrId — the deterministic uuid5 internal PR identity (1:1 with the frozen Python
// codemaster/ingest/_pr_id.py: uuid5(PR_ID_NAMESPACE, "{installation_id}/{repository_id}/{pr_number}")).
// The golden vector below was produced by the LIVE frozen Python (derive_pr_id(...)) so this byte-matches.

import { describe, expect, it } from "vitest";

import { PR_ID_NAMESPACE, derivePrId } from "#backend/ingest/_pr_id.js";

describe("derivePrId", () => {
  it("byte-matches the frozen Python derive_pr_id golden vector", () => {
    // Live Python: derive_pr_id(installation_id=..., repository_id=..., pr_number=42) → this UUID.
    expect(
      derivePrId({
        installationId: "12345678-1234-1234-1234-1234567890ab",
        repositoryId: "abcdef01-2345-6789-abcd-ef0123456789",
        prNumber: 42,
      }),
    ).toBe("949b2f08-2774-562a-9a9d-ea5472e0ccfa");
  });

  it("is deterministic + stable across opened→synchronize (same tuple → same pr_id)", () => {
    const args = {
      installationId: "12345678-1234-1234-1234-1234567890ab",
      repositoryId: "abcdef01-2345-6789-abcd-ef0123456789",
      prNumber: 7,
    };
    expect(derivePrId(args)).toBe(derivePrId(args));
  });

  it("uses the frozen namespace", () => {
    expect(PR_ID_NAMESPACE).toBe("e6c2c4f4-f8e4-4a3b-8e6e-2a8b4f1f9c1d");
  });
});
