// Cost-caps read — 1:1 with cost_caps.build_cost_caps_page + postgres_cost_cap_repo. Platform-scope
// governance: four reads assembled into one page (settings, active overrides, pending changes, today's
// global spend) + two computed fields (hard ceiling constant, linear end-of-day spend projection).

import { type Kysely, sql } from "kysely";

import type {
  CostCapOverrideV1,
  CostCapPageV1,
  CostCapPendingChangeV1,
} from "#contracts/admin.v1.js";

const HARD_CEILING_CENTS = 5000000;
const SECONDS_PER_DAY = 86400;

/** Raised when either the 'global' or 'per_org_default' settings row is missing (→ 500, matches Python). */
export class CostCapSettingsMissingError extends Error {
  public constructor() {
    super("cost_cap_settings is missing the global or per_org_default row");
    this.name = "CostCapSettingsMissingError";
  }
}

function iso(d: Date): string {
  return new Date(d).toISOString();
}
function isoOrNull(d: Date | null): string | null {
  return d === null ? null : iso(d);
}

export async function buildCostCapsPage(db: Kysely<unknown>, now: Date): Promise<CostCapPageV1> {
  // (1) settings — the two scope rows.
  const s = await sql<{
    scope: "global" | "per_org_default";
    cap_cents: string | number;
    updated_at: Date;
    updated_by_user_id: string | null;
  }>`SELECT scope, cap_cents, updated_at, updated_by_user_id FROM core.cost_cap_settings WHERE scope IN ('global', 'per_org_default')`.execute(
    db,
  );
  const globalRow = s.rows.find((r) => r.scope === "global");
  const perOrgRow = s.rows.find((r) => r.scope === "per_org_default");
  if (globalRow === undefined || perOrgRow === undefined) {
    throw new CostCapSettingsMissingError();
  }
  const moreRecent =
    new Date(globalRow.updated_at).getTime() >= new Date(perOrgRow.updated_at).getTime()
      ? globalRow
      : perOrgRow;

  // (2) active (non-expired) overrides, name resolved via COALESCE.
  const o = await sql<{
    installation_id: string;
    installation_name: string;
    cap_cents: string | number;
    expires_at: Date | null;
    updated_at: Date;
    updated_by_user_id: string | null;
  }>`
    SELECT o.installation_id,
           COALESCE(i.account_login, 'installation:' || o.installation_id::text) AS installation_name,
           o.cap_cents, o.expires_at, o.updated_at, o.updated_by_user_id
    FROM core.cost_cap_overrides o
    LEFT JOIN core.installations i ON i.installation_id = o.installation_id
    WHERE o.expires_at IS NULL OR o.expires_at > now()
    ORDER BY o.updated_at DESC
  `.execute(db);
  const overrides: Array<CostCapOverrideV1> = o.rows.map((row) => ({
    schema_version: 1 as const,
    installation_id: row.installation_id,
    installation_name: row.installation_name,
    cap_cents: Number(row.cap_cents),
    expires_at: isoOrNull(row.expires_at),
    updated_at: iso(row.updated_at),
    updated_by_user_id: row.updated_by_user_id,
  }));

  // (3) pending changes (state='pending'), newest first.
  const p = await sql<{
    pending_change_id: string;
    target_kind: CostCapPendingChangeV1["target_kind"];
    target_id: string | null;
    new_cap_cents: string | number;
    expires_at: Date | null;
    requested_at: Date;
    requested_by_user_id: string;
    approved_at: Date | null;
    approved_by_user_id: string | null;
    applied_at: Date | null;
    state: CostCapPendingChangeV1["state"];
  }>`
    SELECT pending_change_id, target_kind, target_id, new_cap_cents, expires_at, requested_at,
           requested_by_user_id, approved_at, approved_by_user_id, applied_at, state
    FROM core.cost_cap_pending_changes WHERE state = 'pending' ORDER BY requested_at DESC
  `.execute(db);
  const pendingChanges: Array<CostCapPendingChangeV1> = p.rows.map((row) => ({
    schema_version: 1 as const,
    pending_change_id: row.pending_change_id,
    target_kind: row.target_kind,
    target_id: row.target_id,
    new_cap_cents: Number(row.new_cap_cents),
    expires_at: isoOrNull(row.expires_at),
    requested_at: iso(row.requested_at),
    requested_by_user_id: row.requested_by_user_id,
    approved_at: isoOrNull(row.approved_at),
    approved_by_user_id: row.approved_by_user_id,
    applied_at: isoOrNull(row.applied_at),
    state: row.state,
  }));

  // (4) today's global spend (0 when no row).
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const d = await sql<{ daily_total_cents: string | number | null }>`
    SELECT COALESCE(daily_total_cents, 0) AS daily_total_cents
    FROM telemetry.cost_daily WHERE today = ${today} AND scope = 'global'
  `.execute(db);
  const spend = d.rows[0] === undefined ? 0 : Number(d.rows[0].daily_total_cents);

  // Linear end-of-day projection: raw spend until 60s into the day, then extrapolate by elapsed fraction.
  const elapsedSeconds =
    (now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 1000;
  const projected =
    elapsedSeconds < 60 ? spend : Math.floor(spend / (elapsedSeconds / SECONDS_PER_DAY));

  return {
    schema_version: 1,
    settings: {
      schema_version: 1,
      global_cap_cents: Number(globalRow.cap_cents),
      per_org_default_cap_cents: Number(perOrgRow.cap_cents),
      hard_ceiling_cents: HARD_CEILING_CENTS,
      updated_at: iso(moreRecent.updated_at),
      updated_by_user_id: moreRecent.updated_by_user_id,
    },
    overrides,
    todays_spend_global_cents: spend,
    todays_projected_global_cents: projected,
    pending_changes: pendingChanges,
  };
}
