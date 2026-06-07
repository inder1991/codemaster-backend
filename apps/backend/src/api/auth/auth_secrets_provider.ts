// Auth-secrets provider — the session HMAC signing key + CSRF double-submit secret, read from Vault.
//
// The frozen Python read these from AdminBootstrapConfig (Vault Agent → env from
// `secret/codemaster/api/session_signing_key`). The TS port follows ADR-0071's Vault-read seam instead of
// env (invariant 3: no secrets in env vars), reusing the same source selector as the webhook secret:
// CODEMASTER_VAULT_SECRET_SOURCE=agent-file reads the Vault-Agent-rendered file (FileKvReader), else the
// lazy Vault HTTP API. Both secrets are flat strings, so the agent-file path works (unlike the nested
// field-encryption keyset).
//
// Expected Vault layout (to be seeded — these are NOT in the dev seed-vault.sh yet):
//   secret/codemaster/api/auth  { session_signing_key: "<>=32 chars>", csrf_secret: "<>=32 chars>" }

import { FileKvReader } from "#backend/adapters/vault_file_kv.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";

import type { VaultKvReadPort } from "#backend/ingest/webhook_secret_provider.js";

export const AUTH_SECRETS_VAULT_PATH = "codemaster/api/auth";
const SIGNING_KEY = "session_signing_key";
const CSRF_KEY = "csrf_secret";
// Matches the Python AdminBootstrapConfig `Field(min_length=32)` on both secrets.
const MIN_SECRET_LENGTH = 32;

function readKey(data: Record<string, string>, key: string): Uint8Array {
  // `key` here is one of two hardcoded module constants, never request-derived.
  // eslint-disable-next-line security/detect-object-injection
  const value = data[key];
  if (value === undefined) {
    throw new Error(
      `Vault path '${AUTH_SECRETS_VAULT_PATH}' missing key '${key}'; seed it (>=${MIN_SECRET_LENGTH} chars)`,
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `Vault '${AUTH_SECRETS_VAULT_PATH}.${key}' is ${value.length} chars; must be >= ${MIN_SECRET_LENGTH}`,
    );
  }
  return new TextEncoder().encode(value);
}

/** Reads the session signing key + CSRF secret from one Vault KV secret. */
export class VaultAuthSecretsProvider {
  readonly #vault: VaultKvReadPort;

  public constructor(args: { vault: VaultKvReadPort }) {
    this.#vault = args.vault;
  }

  public async sessionSigningKey(): Promise<Uint8Array> {
    return readKey(await this.#vault.kvRead({ path: AUTH_SECRETS_VAULT_PATH }), SIGNING_KEY);
  }

  public async csrfSecret(): Promise<Uint8Array> {
    return readKey(await this.#vault.kvRead({ path: AUTH_SECRETS_VAULT_PATH }), CSRF_KEY);
  }
}

/**
 * Source-select the auth-secrets provider by env (ADR-0071), mirroring makeWebhookSecretProvider.
 * `agent-file` reads the Vault-Agent-rendered file; anything else lazily builds the Vault HTTP port (so the
 * server boots without VAULT_ADDR and only the first read touches Vault).
 */
export function makeAuthSecretsProvider(): VaultAuthSecretsProvider {
  const source = process.env["CODEMASTER_VAULT_SECRET_SOURCE"] ?? "vault-api";
  if (source === "agent-file") {
    return new VaultAuthSecretsProvider({ vault: new FileKvReader() });
  }
  // Lazy Vault HTTP: defer building the port until the first read.
  let port: VaultHttpPort | undefined;
  const lazy: VaultKvReadPort = {
    kvRead: async (args) => {
      port ??= VaultHttpPort.fromEnv();
      return port.kvRead(args);
    },
  };
  return new VaultAuthSecretsProvider({ vault: lazy });
}
