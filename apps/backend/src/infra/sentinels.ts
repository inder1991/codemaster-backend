// Sentinel UUIDs (1:1 with the frozen Python codemaster/infra/sentinels.py). Stable, reserved values used
// where a real id is structurally required but semantically absent.

/** The session installation_id for a super_admin / global-scoped principal (no per-tenant scope). */
export const SUPER_ADMIN_SESSION_INSTALLATION_ID = "00000000-0000-0000-0000-000000000000";

/** The installation_id stamped on platform-scope audit rows (login events, etc.) that aren't tenant-bound. */
export const PLATFORM_SCOPE_AUDIT_INSTALLATION_ID = "00000000-0000-0000-0000-000000000001";

/** Signals "super_admin viewing platform-aggregated data" in admin read queries (e.g. the orgs filter's
 *  platform-view bypass). NUMERICALLY IDENTICAL to {@link SUPER_ADMIN_SESSION_INSTALLATION_ID} (UUID int=0);
 *  a conceptually-distinct sentinel kept separate to mirror the frozen Python sentinels.py. */
export const SUPER_ADMIN_PLATFORM_VIEW_UUID = "00000000-0000-0000-0000-000000000000";
