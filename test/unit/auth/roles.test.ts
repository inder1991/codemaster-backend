import { describe, expect, it } from "vitest";

import {
  ROLES,
  hasAtLeast,
  resolveRoleFromLdapGroups,
  rolePrecedence,
} from "#backend/api/auth/roles.js";

describe("roles — precedence + LDAP resolution (parity with roles.py)", () => {
  it("locks the 7-role vocabulary and ordering", () => {
    expect([...ROLES]).toEqual([
      "super_admin",
      "platform_owner",
      "platform_operator",
      "knowledge_curator",
      "security_auditor",
      "org_owner",
      "reader",
    ]);
  });

  it("orders precedence super_admin (0) → reader (6)", () => {
    expect(rolePrecedence("super_admin")).toBe(0);
    expect(rolePrecedence("platform_owner")).toBe(1);
    expect(rolePrecedence("reader")).toBe(6);
  });

  it("hasAtLeast is true when actual is equal-or-higher privilege", () => {
    expect(hasAtLeast("super_admin", "reader")).toBe(true);
    expect(hasAtLeast("platform_operator", "reader")).toBe(true);
    expect(hasAtLeast("reader", "reader")).toBe(true);
    expect(hasAtLeast("reader", "platform_owner")).toBe(false);
    expect(hasAtLeast("org_owner", "platform_operator")).toBe(false);
  });

  it("resolves the HIGHEST-precedence role from an LDAP group set", () => {
    expect(
      resolveRoleFromLdapGroups([
        "codemaster-admin-reader",
        "codemaster-admin-platform_owner",
        "codemaster-admin-org_owner",
      ]),
    ).toBe("platform_owner");
  });

  it("ignores unknown cns and returns null when none match", () => {
    expect(resolveRoleFromLdapGroups(["cn=some-other-group", "unrelated"])).toBeNull();
    expect(resolveRoleFromLdapGroups([])).toBeNull();
  });

  it("does NOT grant super_admin via LDAP (local-DB-only role)", () => {
    expect(resolveRoleFromLdapGroups(["codemaster-admin-super_admin"])).toBeNull();
  });
});
