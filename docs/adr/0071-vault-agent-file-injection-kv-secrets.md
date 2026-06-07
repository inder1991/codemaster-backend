# ADR-0071 — Vault Agent sidecar file-injection for KV secrets

**Status:** Accepted (2026-06-06) — project-owner decision
**Context:** TS backend; how the app obtains its static Vault KV secrets (webhook secret, GitHub App
credentials, field-encryption keys) at runtime.

## Context

The app already runs alongside the **Vault Agent Injector**: `VaultHttpPort` reads the Agent-rendered
**token** from a file (`DEFAULT_TOKEN_PATH = /var/run/secrets/vault/token`) on every call, and `fromEnv()`
prefers that token file in production. Today the flow is *Agent renders the token → the app uses it to make
direct Vault API calls* for both:

- **KV reads** — the GitHub App **webhook secret** (`codemaster/github/app` → key `webhook_secret`), the
  GitHub App credentials (`token_provider.ts`), and the field-encryption keys
  (`codemaster/field-encryption/keys`, ADR-0033); and
- **Transit** — decrypting LLM-provider credentials (`llm_provider_settings_repo.ts` →
  `VaultPort.transitDecrypt`).

The project owner chose to move **secret injection** to the Agent's **file-rendering** mode: the Agent
fetches KV secrets from Vault and writes them to a pod-local file; the app reads the file instead of calling
the Vault KV API. (The pod **can** reach Vault directly — confirmed — so this is a **simplification /
decoupling**, not a connectivity workaround: it removes per-read Vault API calls + the app's reliance on
Vault API availability for static secrets, and the Agent already owns auth + token lifecycle.)

This must **not** weaken CLAUDE.md invariant 3 ("Vault is the only secret store; no secrets in env vars,
OpenShift Secrets, container images, or Postgres rows in cleartext").

## Decision

1. **The Vault Agent renders each KV secret's data map to a memory-backed (tmpfs) file**, templated as the
   secret's `.Data.data` serialized to JSON:

   ```yaml
   # deploy-repo pod annotations (illustrative — the webhook-secret path)
   vault.hashicorp.com/agent-inject: "true"
   vault.hashicorp.com/role: "codemaster"
   vault.hashicorp.com/agent-inject-secret-codemaster_github_app: "codemaster/data/github/app"
   vault.hashicorp.com/agent-inject-template-codemaster_github_app: |
     {{- with secret "codemaster/data/github/app" -}}{{ .Data.data | toJSON }}{{- end -}}
   # + the secrets mount on a memory-backed (medium: Memory) volume so the secret never touches disk.
   ```

2. **A `FileKvReader` (`apps/backend/src/adapters/vault_file_kv.ts`) implements the narrow `kvRead` port**
   (`{ kvRead({ path, version? }): Promise<Record<string,string>> }`) by reading
   `<CODEMASTER_VAULT_SECRETS_DIR>/<sanitize(path)>`, JSON-parsing the data map, and returning it. It
   **re-reads on every call** (matching the existing no-cache token convention — the Agent re-renders on
   rotation, so the next read is always current). `sanitize` replaces every non-`[a-z0-9]` char with `_`
   (`codemaster/github/app` → `codemaster_github_app`); `CODEMASTER_VAULT_SECRETS_DIR` defaults to
   `/vault/secrets`. The **file content format (a JSON object of string values) is the contract** between
   the Agent template and `FileKvReader`.

3. **Selection is env-gated, default-unchanged.** `CODEMASTER_VAULT_SECRET_SOURCE` ∈
   `{ vault-api (default), agent-file }`. `vault-api` keeps today's behaviour (the lazy `VaultHttpPort`);
   `agent-file` wires the `FileKvReader`. Dev / disposable-PG / kind keep `vault-api` (or point
   `CODEMASTER_VAULT_SECRETS_DIR` at a local dir) — nothing breaks by default.

4. **Transit and KV writes stay on the Vault API** (via the Agent token). `transitEncrypt` /
   `transitDecrypt` (LLM-credential crypto) and `kvWrite` / `kvDelete` (the `vault_credential_write` sink)
   are **online operations a static file cannot represent**; per the owner's "use Vault only" call they
   remain Vault API calls. So `FileKvReader` covers **KV reads only**; full-`VaultPort` consumers that also
   need Transit/writes use a composite (KV-read from files, everything else delegated to `VaultHttpPort`) —
   added when those consumers are migrated (rollout below).

**Scope of this ADR's code change:** the `FileKvReader` + the **webhook-secret** consumer wired through it
(the live HMAC-verification path). The GitHub App credentials + field-encryption keys migrate to the same
reader in a follow-up (same pattern, a composite `VaultPort`); Transit is untouched.

## Invariant-3 compatibility

Vault remains the **only secret store and source of truth** — the Agent reads *from* Vault. The secret
lands **only** in a tmpfs file written by the Agent: not an env var, not an OpenShift/K8s Secret, not the
container image, not a Postgres row. The memory-backed volume means it never persists to disk and dies with
the pod. This is a **stronger** posture than today for KV reads: the app no longer holds or presents a Vault
token for them. Invariant 3 holds; no exception is taken (unlike ADR-0070).

## Consequences

- The app is **decoupled from the Vault KV API** for static secrets — resilient to Vault API blips for the
  webhook secret / App creds / field-encryption keys (the rendered file is still present), and one fewer
  authenticated round-trip per HMAC verification.
- **A deploy-side contract is introduced:** the Agent annotations must render each KV path `P` to
  `<CODEMASTER_VAULT_SECRETS_DIR>/<sanitize(P)>` as `.Data.data | toJSON`, and the pod must set
  `CODEMASTER_VAULT_SECRET_SOURCE=agent-file`. These live in the deploy/Helm repo (Helm is not in this
  repo); this ADR is the spec for them. A mismatch (missing file / wrong format) fails closed:
  `FileKvReader` throws `VaultPathNotFound` / `VaultError`, surfaced as a `401`/`503` rather than a silent
  bad secret.
- **Transit still requires Vault API reachability** — unchanged, and fine since the pod can reach Vault.
- **No migration, no schema change.** Pure additive code + an env flag; `vault-api` default keeps every
  existing test + dev path green.

## Rollout

1. `FileKvReader` + the webhook-secret consumer wired through it (this ADR's code). Env-gated; default off.
2. Deploy-repo: add the Agent annotations + the memory volume + `CODEMASTER_VAULT_SECRET_SOURCE=agent-file`;
   flip it on; verify a real webhook verifies against the file-rendered secret (smoke, user-gated).
3. Migrate the GitHub App credentials + field-encryption keys to the same reader via a composite
   `VaultPort` (KV-read from files; Transit/writes delegated to `VaultHttpPort`). Transit unchanged.
