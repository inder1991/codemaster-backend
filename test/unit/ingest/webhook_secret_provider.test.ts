// Unit tests for VaultWebhookSecretProvider — 1:1 with
// codemaster/ingest/webhook_secret_provider.py (reads `webhook_secret` from Vault `codemaster/github/app`,
// UTF-8 encodes it, no in-process cache).

import { describe, expect, it } from "vitest";

import {
  VaultWebhookSecretProvider,
  type VaultKvReadPort,
} from "#backend/ingest/webhook_secret_provider.js";

function stubVault(data: Record<string, string>, calls?: { n: number }): VaultKvReadPort {
  return {
    kvRead: async (args) => {
      if (calls) calls.n += 1;
      expect(args.path).toBe("codemaster/github/app");
      return data;
    },
  };
}

describe("VaultWebhookSecretProvider", () => {
  it("reads webhook_secret from codemaster/github/app and returns its UTF-8 bytes", async () => {
    const provider = new VaultWebhookSecretProvider({ vault: stubVault({ webhook_secret: "s3cr3t-café" }) });
    const secret = await provider.currentSecret();
    expect(Buffer.from(secret).toString("utf-8")).toBe("s3cr3t-café");
  });

  it("re-reads on every call (no in-process cache — rotations take effect immediately)", async () => {
    const calls = { n: 0 };
    const provider = new VaultWebhookSecretProvider({ vault: stubVault({ webhook_secret: "s" }, calls) });
    await provider.currentSecret();
    await provider.currentSecret();
    expect(calls.n).toBe(2);
  });

  it("throws a helpful error when the key is missing", async () => {
    const provider = new VaultWebhookSecretProvider({ vault: stubVault({}) });
    await expect(provider.currentSecret()).rejects.toThrow(/webhook_secret/);
  });
});
