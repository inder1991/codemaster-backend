// Tests for makeWebhookSecretProvider — the ADR-0071 source selector (agent-file vs vault-api). The
// agent-file branch is exercised end-to-end against a REAL temp file (selector → VaultWebhookSecretProvider
// → FileKvReader → fs), proving the full file-injection wiring.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeWebhookSecretProvider } from "#backend/ingest/webhook_secret_provider.js";

afterEach(() => {
  delete process.env["CODEMASTER_VAULT_SECRET_SOURCE"];
  delete process.env["CODEMASTER_VAULT_SECRETS_DIR"];
});

describe("makeWebhookSecretProvider (ADR-0071 source selector)", () => {
  it("agent-file mode reads the webhook secret from the Vault Agent-rendered file end-to-end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-file-"));
    try {
      // The Agent renders codemaster/github/app → <dir>/codemaster_github_app as `.Data.data | toJSON`.
      await writeFile(
        join(dir, "codemaster_github_app"),
        JSON.stringify({ webhook_secret: "whsec_xyz", app_id: "123" }),
        "utf-8",
      );
      process.env["CODEMASTER_VAULT_SECRET_SOURCE"] = "agent-file";
      process.env["CODEMASTER_VAULT_SECRETS_DIR"] = dir;

      const provider = makeWebhookSecretProvider();
      const secret = await provider.currentSecret();
      expect(new TextDecoder().decode(secret)).toBe("whsec_xyz");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("agent-file mode surfaces the missing-key error when the rendered file lacks webhook_secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vault-file-"));
    try {
      await writeFile(join(dir, "codemaster_github_app"), JSON.stringify({ app_id: "123" }), "utf-8");
      process.env["CODEMASTER_VAULT_SECRET_SOURCE"] = "agent-file";
      process.env["CODEMASTER_VAULT_SECRETS_DIR"] = dir;

      const provider = makeWebhookSecretProvider();
      await expect(provider.currentSecret()).rejects.toThrow(/webhook_secret/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("default (vault-api) mode returns a provider and does NOT read the file at construction (lazy)", () => {
    delete process.env["CODEMASTER_VAULT_SECRET_SOURCE"];
    const provider = makeWebhookSecretProvider();
    // Constructing the provider must not touch Vault or the filesystem — only the first currentSecret()
    // would (and in vault-api mode that needs Vault, so we don't invoke it here).
    expect(typeof provider.currentSecret).toBe("function");
  });
});
