// Integrations write — 1:1 port of integrations.py delete_integration + postgres_integrations_repo
// (get / delete). core.integrations is PLATFORM-SHARED (migration 0062 dropped installation_id), so delete
// is keyed by integration_id alone and the audit row carries installation_id=NULL.
//
// add_confluence_space (CREATE) is intentionally NOT ported here — it requires a live ConfluenceValidatorPort
// (validate_space against the Atlassian API) + the credential seam, which belongs with the Vault-cluster
// admin-write batch. delete needs neither.

import { type Kysely, sql } from "kysely";

/** The integration_id does not resolve to a row → route 404. */
export class IntegrationNotFoundError extends Error {}

/** Audit-emit seam. installationId is `string | null` — platform-scope actions emit NULL (1:1 with the
 *  Python emit installation_id=None). Structurally compatible with AdminRoutesOptions.audit. */
export type IntegrationAuditEmitter = (e: {
  actorUserId: string;
  installationId: string | null;
  action: string;
  targetKind: string;
  targetId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  now: Date;
}) => Promise<void>;

type IntegrationCore = { kind: string; config_json: string };

/** Delete an integration by id, then audit (integration.removed). Throws IntegrationNotFoundError when the
 *  id does not exist OR was deleted by a concurrent request between the existence check and the DELETE
 *  (race → stable 404). 1:1 with delete_integration. */
export async function deleteIntegration(
  db: Kysely<unknown>,
  args: {
    integrationId: string;
    actorUserId: string;
    now: Date;
    audit?: IntegrationAuditEmitter | undefined;
  },
): Promise<void> {
  const removed = await db.transaction().execute(async (tx) => {
    // config_json::text — migration 0112 made the column jsonb; the str contract holds via the text cast
    // (same idiom as listIntegrationsPage). Captured for the audit before-image.
    const got = await sql<IntegrationCore>`
      SELECT kind, config_json::text AS config_json
      FROM core.integrations
      WHERE integration_id = ${args.integrationId}
      LIMIT 1
    `.execute(tx);
    if (got.rows.length === 0) {
      return null;
    }
    const del = await sql<{ integration_id: string }>`
      DELETE FROM core.integrations
      WHERE integration_id = ${args.integrationId}
      RETURNING integration_id
    `.execute(tx);
    if (del.rows.length === 0) {
      return null; // race: row vanished between SELECT and DELETE → treat as not-found
    }
    return got.rows[0]!;
  });

  if (removed === null) {
    throw new IntegrationNotFoundError();
  }
  await args.audit?.({
    actorUserId: args.actorUserId,
    installationId: null, // platform-shared table → NULL installation_id on the audit row
    action: "integration.removed",
    targetKind: "integration",
    targetId: args.integrationId,
    before: { kind: removed.kind, config_json: removed.config_json },
    after: null,
    now: args.now,
  });
}
