// HTTP server entrypoint (F1·a) — the ingest/api pod. Builds the app factory, mounts routers, and
// listens. The analogue of worker/main.ts for the HTTP side. Routers (the GitHub webhook, auth, admin)
// register onto the app here as they land in subsequent slices.

import { VaultHttpPort } from "#backend/adapters/vault_http.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { registerAuthRoutes } from "#backend/api/auth/auth_routes.js";
import { makeAuthSecretsProvider } from "#backend/api/auth/auth_secrets_provider.js";
import { PostgresLocalUserRepo } from "#backend/api/auth/local_user_repo.js";
import { NoOpLdapClient } from "#backend/api/auth/noop_ldap.js";
import { persistWebhook } from "#backend/ingest/github_webhook_persistence.js";
import { makeWebhookSecretProvider } from "#backend/ingest/webhook_secret_provider.js";
import { setAuditKeyRegistry } from "#backend/security/audit_field_codec.js";
import { loadFieldEncryptionKeyRegistry } from "#backend/security/field_encryption_keys_loader.js";

import { tenantKysely } from "#platform/db/database.js";
import { WallClock } from "#platform/clock.js";

import { buildApp } from "./app.js";
import { registerGithubWebhookRoutes } from "./github_webhook_routes.js";

/** Build the app, register routers, and listen. Resolves when the server is listening. */
export async function runServer(): Promise<void> {
  const app = buildApp();

  // F1·b — POST /v1/github/webhook (verification edge). The secret provider is source-selected per
  // ADR-0071 (CODEMASTER_VAULT_SECRET_SOURCE): the default lazy Vault provider OR the Vault Agent
  // file-rendered secret. Either way nothing is read until the first webhook, so the server boots clean.
  // The persist seam (W3) is wired lazily: the DSN is read per-webhook (tenantKysely caches the engine),
  // so the server still boots without CODEMASTER_PG_CORE_DSN — only the first webhook needs the core pool.
  await registerGithubWebhookRoutes(app, {
    secretProvider: makeWebhookSecretProvider(),
    persist: (args) => {
      const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
      if (dsn === undefined || dsn === "") {
        throw new Error("CODEMASTER_PG_CORE_DSN is not set; the webhook persistence path requires the core pool.");
      }
      return persistWebhook({
        db: tenantKysely(dsn),
        body: args.body,
        headers: args.headers,
        signatureValid: args.signatureValid,
        clock: new WallClock(),
      });
    },
  });

  // D1 — auth routes (admin login surface). Opt-in via CODEMASTER_AUTH_ROUTES_ENABLED so webhook-only
  // deploys still boot without the auth secrets. When enabled, EAGERLY load the field-encryption key
  // registry + session signing key + CSRF secret from Vault at startup (ADR-0033: field keys fetched at
  // pod startup) and fail loud if Vault / the DSN is unavailable — the admin API can't run without them.
  // The field keyset loads via the Vault HTTP API (its nested payload can't be agent-file-rendered as flat
  // strings); the signing key + CSRF secret follow the agent-file-or-API selector (ADR-0071).
  if ((process.env["CODEMASTER_AUTH_ROUTES_ENABLED"] ?? "false") === "true") {
    const dsn = process.env["CODEMASTER_PG_CORE_DSN"];
    if (dsn === undefined || dsn === "") {
      throw new Error(
        "CODEMASTER_AUTH_ROUTES_ENABLED=true requires CODEMASTER_PG_CORE_DSN (the core.local_users pool).",
      );
    }
    const registry = await loadFieldEncryptionKeyRegistry(VaultHttpPort.fromEnv());
    // The audit-events READ endpoint decrypts before/after via the shared field-encryption registry.
    setAuditKeyRegistry(registry);
    const authSecrets = makeAuthSecretsProvider();
    const [signingKey, csrfSecret] = await Promise.all([
      authSecrets.sessionSigningKey(),
      authSecrets.csrfSecret(),
    ]);
    const coreDb = tenantKysely(dsn);
    const clock = new WallClock();
    await registerAuthRoutes(app, {
      localRepo: new PostgresLocalUserRepo({ db: coreDb, registry }),
      ldap: new NoOpLdapClient(),
      clock,
      signingKey,
      csrfSecret,
      secureCookies: (process.env["CODEMASTER_SECURE_COOKIES"] ?? "true") !== "false",
    });
    // D2 — admin READ endpoints (operator visibility), behind the same makeRequireRole gate + signing key.
    await registerAdminRoutes(app, { db: coreDb, signingKey, clock, registry });
  }

  // ── More routers register here as they land ──
  // D2: admin routes · F-b: feedback

  const port = Number(process.env.CODEMASTER_API_PORT ?? "8080");
  const host = process.env.CODEMASTER_API_HOST ?? "0.0.0.0";
  await app.listen({ port, host });
}

// Main-module entrypoint guard — the ESM analogue of `if __name__ == "__main__":` (same pattern as
// worker/main.ts). When executed directly, run the server and fail loudly on any startup error.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runServer().catch((err: unknown) => {
    process.stderr.write(
      `api server FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
