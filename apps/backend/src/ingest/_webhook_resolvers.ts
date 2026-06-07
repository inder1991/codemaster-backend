// Internal-id resolvers for the webhook persistence layer (1:1 with the `_resolve_internal_*` functions
// in github_webhook_persistence.py). Both take a Kysely executor (a Transaction inside the webhook tx).

import { type Kysely, sql } from "kysely";

/**
 * Map GitHub's int `installation_id` → our internal UUID PK. This is the cross-tenant IDENTITY edge — it
 * is intentionally NOT installation_id-scoped (it's how we DISCOVER the internal id that scopes everything
 * downstream). Returns null for an unknown / absent GitHub installation.
 */
export async function resolveInternalInstallationId(
  db: Kysely<unknown>,
  githubInstallationId: number | null,
): Promise<string | null> {
  if (githubInstallationId === null) {
    return null;
  }
  // tenant:exempt reason=installation-identity-edge-resolves-internal-iid follow_up=FOLLOW-UP-gf3-error-mode
  const r = await sql<{ installation_id: string }>`
    SELECT installation_id FROM core.installations WHERE github_installation_id = ${githubInstallationId}
  `.execute(db);
  return r.rows[0]?.installation_id ?? null;
}

/**
 * Map GitHub's int repo id → our internal `core.repositories.repository_id` UUID, SCOPED to the resolved
 * internal installation_id (tenancy-safe — the query filters installation_id). Returns null when either
 * input is null or no scoped row exists.
 */
export async function resolveInternalRepositoryId(
  db: Kysely<unknown>,
  githubRepoId: number | null,
  internalInstallId: string | null,
): Promise<string | null> {
  if (githubRepoId === null || internalInstallId === null) {
    return null;
  }
  const r = await sql<{ repository_id: string }>`
    SELECT repository_id FROM core.repositories
     WHERE github_repo_id = ${githubRepoId} AND installation_id = ${internalInstallId}
  `.execute(db);
  return r.rows[0]?.repository_id ?? null;
}
