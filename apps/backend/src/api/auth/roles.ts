// Roles + precedence + LDAP group→role mapping (1:1 with codemaster/api/auth/roles.py).
//
// Locked precedence (high → low): super_admin > platform_owner > platform_operator > knowledge_curator
// > security_auditor > org_owner > reader. super_admin is the implicit highest-privilege role and exists
// ONLY as a core.local_users row (never an LDAP group, never a role_grants row).

export const ROLES = [
  "super_admin",
  "platform_owner",
  "platform_operator",
  "knowledge_curator",
  "security_auditor",
  "org_owner",
  "reader",
] as const;
export type Role = (typeof ROLES)[number];

/** Lower number = higher privilege (Map-keyed lookup, lint-clean vs computed object access). */
const PRECEDENCE = new Map<Role, number>([
  ["super_admin", 0],
  ["platform_owner", 1],
  ["platform_operator", 2],
  ["knowledge_curator", 3],
  ["security_auditor", 4],
  ["org_owner", 5],
  ["reader", 6],
]);

/** Numeric precedence of a role (0 = highest). */
export function rolePrecedence(role: Role): number {
  return PRECEDENCE.get(role) ?? Number.MAX_SAFE_INTEGER;
}

/** True iff `actual` is at least as privileged as `required` (lower-or-equal precedence number). */
export function hasAtLeast(actual: Role, required: Role): boolean {
  return rolePrecedence(actual) <= rolePrecedence(required);
}

/** LDAP cn → role. NOTE: no `super_admin` mapping — super_admin is local-DB-only. */
const LDAP_GROUP_TO_ROLE = new Map<string, Role>([
  ["codemaster-admin-platform_owner", "platform_owner"],
  ["codemaster-admin-platform_operator", "platform_operator"],
  ["codemaster-admin-knowledge_curator", "knowledge_curator"],
  ["codemaster-admin-security_auditor", "security_auditor"],
  ["codemaster-admin-org_owner", "org_owner"],
  ["codemaster-admin-reader", "reader"],
]);

/** Highest-precedence role from an LDAP group set (bare cns); null when none match. */
export function resolveRoleFromLdapGroups(groupCns: ReadonlyArray<string>): Role | null {
  const matched = groupCns
    .map((cn) => LDAP_GROUP_TO_ROLE.get(cn))
    .filter((r): r is Role => r !== undefined);
  if (matched.length === 0) {
    return null;
  }
  return matched.reduce((a, b) => (rolePrecedence(a) <= rolePrecedence(b) ? a : b));
}
