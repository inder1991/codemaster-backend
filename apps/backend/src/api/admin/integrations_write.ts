// Integrations write — 1:1 port of integrations.py delete_integration + add_confluence_space +
// postgres_integrations_repo (get / delete / find_duplicate / insert). core.integrations is PLATFORM-SHARED
// (migration 0062 dropped installation_id), so writes are keyed without installation_id and audit rows carry
// installation_id=NULL.

import { randomUUID } from "node:crypto";

import { type Kysely, sql } from "kysely";

import { type ConfluenceValidatorPort } from "#backend/integrations/confluence/confluence_validator.js";

import { type IntegrationListItemV1 } from "#contracts/admin.v1.js";

/** The integration_id does not resolve to a row → route 404. */
export class IntegrationNotFoundError extends Error {}

/** Same kind+space_key already exists → route 409. 1:1 with integrations.py IntegrationDuplicateError. */
export class IntegrationDuplicateError extends Error {}

/** Confluence service-account validation failed before persistence → route 422 / 503. Carries the stable
 *  code (auth_error | rate_limited | not_found | validation_failed) the route maps to HTTP. 1:1 with
 *  integrations.py IntegrationValidationError. */
export class IntegrationValidationError extends Error {
  public constructor(
    public readonly code: string,
    public readonly validationDetail: string,
  ) {
    super(validationDetail);
  }
}

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

/** Row shape of the insertConfluenceSpace INSERT ... RETURNING (config_json cast to text). Mirrors the
 *  read-repo's IntegrationDbRow; declared locally to keep the write module self-contained. */
type IntegrationInsertRow = {
  integration_id: string;
  kind: "confluence_space";
  config_json: string;
  enabled: boolean;
  last_validated_at: Date | null;
  last_validation_error: string | null;
  created_at: Date;
  updated_at: Date;
  trust_tier: "trusted" | "semi" | null;
  default_governance_ack_at: Date | null;
  visibility: string;
  strict_label_mode: boolean;
};

/**
 * Register a Confluence space — 1:1 port of integrations.py::add_confluence_space: app-level dedup →
 * validate against Confluence → INSERT → audit. App-mints integration_id (uuid v4, matching the Python
 * uuid.uuid4()) because the audit + 201 response need the id before commit. Throws IntegrationDuplicateError
 * (same kind+space_key → 409) and IntegrationValidationError (probe failed → 422/503). Returns the persisted
 * IntegrationListItemV1.
 */
export async function insertConfluenceSpace(
  db: Kysely<unknown>,
  args: {
    spaceKey: string;
    spaceName: string;
    scope: "whole_space" | "page_tree";
    pageTreeRootId: string | null;
    trustTier: "trusted" | "semi";
    governanceAck: boolean;
    visibility: string;
    strictLabelMode: boolean;
    actorUserId: string;
    now: Date;
    validator: ConfluenceValidatorPort;
    audit?: IntegrationAuditEmitter | undefined;
  },
): Promise<IntegrationListItemV1> {
  // 1. App-level dedup (cheaper than burning a Confluence call on a duplicate). config_json is jsonb → ->>.
  const dup = await sql<{ integration_id: string }>`
    SELECT integration_id FROM core.integrations
    WHERE kind = 'confluence_space' AND config_json ->> 'space_key' = ${args.spaceKey}
    LIMIT 1
  `.execute(db);
  if (dup.rows.length > 0) {
    throw new IntegrationDuplicateError();
  }

  // 2. Validate against Confluence BEFORE any write. Map the free-form detail to a stable code — the
  //    auth → rate → not_found → validation_failed precedence is a literal port (do not "improve" it).
  const result = await args.validator.validateSpace({ spaceKey: args.spaceKey, now: args.now });
  if (!result.ok) {
    const d = result.detail;
    const lower = d.toLowerCase();
    const code =
      d.includes("401") || lower.includes("auth")
        ? "auth_error"
        : d.includes("429") || lower.includes("rate")
          ? "rate_limited"
          : d.includes("404") || lower.includes("not found")
            ? "not_found"
            : "validation_failed";
    throw new IntegrationValidationError(code, d);
  }

  // 3. Persist. config_json keys ALPHABETICAL (1:1 with the Python json.dumps(..., sort_keys=True)).
  const integrationId = randomUUID();
  const configJson = JSON.stringify({
    page_tree_root_id: args.pageTreeRootId,
    scope: args.scope,
    space_key: args.spaceKey,
    space_name: args.spaceName,
  });
  const inserted = await sql<IntegrationInsertRow>`
    INSERT INTO core.integrations
      (integration_id, kind, config_json, enabled, last_validated_at, last_validation_error,
       created_at, updated_at, trust_tier, default_governance_ack_at, visibility, strict_label_mode)
    VALUES (${integrationId}, 'confluence_space', CAST(${configJson} AS JSONB), TRUE,
            ${result.validatedAt}, NULL, ${args.now}, ${args.now}, ${args.trustTier},
            ${args.governanceAck ? args.now : null}, ${args.visibility}, ${args.strictLabelMode})
    RETURNING integration_id, kind, config_json::text AS config_json, enabled, last_validated_at,
              last_validation_error, created_at, updated_at, trust_tier, default_governance_ack_at,
              visibility, strict_label_mode
  `.execute(db);
  const row = inserted.rows[0]!;

  // 4. Audit. installationId=null for platform-scope (1:1 with the Python emit installation_id=None).
  await args.audit?.({
    actorUserId: args.actorUserId,
    installationId: null,
    action: "integration.added",
    targetKind: "integration",
    targetId: integrationId,
    before: null,
    after: {
      kind: "confluence_space",
      space_key: args.spaceKey,
      space_name: args.spaceName,
      scope: args.scope,
      trust_tier: args.trustTier,
      governance_ack: args.governanceAck,
      visibility: args.visibility,
      strict_label_mode: args.strictLabelMode,
    },
    now: args.now,
  });

  return {
    integration_id: row.integration_id,
    kind: "confluence_space",
    config_json: row.config_json,
    enabled: row.enabled,
    last_validated_at: row.last_validated_at === null ? null : new Date(row.last_validated_at).toISOString(),
    last_validation_error: row.last_validation_error,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    trust_tier: row.trust_tier,
    default_governance_ack_at:
      row.default_governance_ack_at === null ? null : new Date(row.default_governance_ack_at).toISOString(),
    visibility: row.visibility,
    strict_label_mode: row.strict_label_mode,
  };
}
