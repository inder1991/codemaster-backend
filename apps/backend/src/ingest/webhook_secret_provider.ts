// VaultWebhookSecretProvider — 1:1 port of
// vendor/codemaster-py/codemaster/ingest/webhook_secret_provider.py.
//
// Reads the GitHub App webhook secret from Vault path `codemaster/github/app` key `webhook_secret` on
// EVERY call (no in-process cache — the secret rotates rarely, HMAC verification is once per request, and
// the Vault round-trip is sub-ms same-cluster; add a cache only if telemetry shows a hot path).

import { FileKvReader } from "#backend/adapters/vault_file_kv.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";

import type { WebhookSecretProvider } from "#backend/api/github_webhook_routes.js";

const VAULT_PATH = "codemaster/github/app";
const KEY = "webhook_secret";

/** The narrow Vault read surface the provider needs (Python `_VaultReadPort` Protocol). Both
 *  {@link VaultHttpPort} and the in-memory test vault satisfy it via their `kvRead`. */
export type VaultKvReadPort = {
  kvRead(args: { path: string; version?: number }): Promise<Record<string, string>>;
};

/** Reads + UTF-8-encodes the GitHub webhook secret from Vault. */
export class VaultWebhookSecretProvider implements WebhookSecretProvider {
  readonly #vault: VaultKvReadPort;

  public constructor(args: { vault: VaultKvReadPort }) {
    this.#vault = args.vault;
  }

  public async currentSecret(): Promise<Uint8Array> {
    const data = await this.#vault.kvRead({ path: VAULT_PATH });
    const secret = data[KEY];
    if (secret === undefined) {
      throw new Error(
        `Vault path '${VAULT_PATH}' missing key '${KEY}'; rerun helm/local-kind/seed-vault.sh`,
      );
    }
    return new TextEncoder().encode(secret);
  }
}

/**
 * A {@link WebhookSecretProvider} that lazily builds the real {@link VaultHttpPort} on first use (the
 * deferred-Vault pattern) and memoizes it — so the HTTP server boots without `VAULT_ADDR` and only the
 * FIRST webhook needs Vault reachable.
 */
export function makeLazyVaultWebhookSecretProvider(): WebhookSecretProvider {
  let provider: VaultWebhookSecretProvider | undefined;
  return {
    currentSecret: async () => {
      if (provider === undefined) {
        provider = new VaultWebhookSecretProvider({ vault: VaultHttpPort.fromEnv() });
      }
      return provider.currentSecret();
    },
  };
}

/**
 * Select the webhook-secret source by env (ADR-0071). `CODEMASTER_VAULT_SECRET_SOURCE=agent-file` reads the
 * secret from the Vault Agent-rendered file (via {@link FileKvReader} — no Vault API call, no token held);
 * anything else (default `vault-api`) keeps the lazy Vault HTTP provider. Both reuse
 * {@link VaultWebhookSecretProvider}, which extracts the `webhook_secret` key — only the read surface
 * differs. The file reader is constructed eagerly but reads nothing until the first `currentSecret()`, so
 * the server still boots without touching Vault or the file.
 */
export function makeWebhookSecretProvider(): WebhookSecretProvider {
  const source = process.env["CODEMASTER_VAULT_SECRET_SOURCE"] ?? "vault-api";
  if (source === "agent-file") {
    return new VaultWebhookSecretProvider({ vault: new FileKvReader() });
  }
  return makeLazyVaultWebhookSecretProvider();
}
