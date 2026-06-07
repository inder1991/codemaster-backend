// Fail-closed LdapClientPort shim — 1:1 port of codemaster/api/auth/noop_ldap.py.
//
// The live LDAP wiring until real LDAP ships. Refuses every authentication attempt with LdapBindError, so
// any username NOT in a local repo (which would otherwise fall through to LDAP) is denied rather than
// silently authenticated against an unconfigured backend. Local admins authenticate via the local repos;
// the LDAP path is never invoked for them (the dispatch routes by presence-in-local-repo).

import { type AuthenticatedUser, LdapBindError, type LdapClientPort } from "#backend/api/auth/ldap_client.js";

export class NoOpLdapClient implements LdapClientPort {
  public async authenticate(args: {
    username: string;
    password: string;
  }): Promise<AuthenticatedUser> {
    // Do NOT echo username/password — bind-failure logs are aggregated; never leak credential material.
    void args;
    throw new LdapBindError("ldap not configured (NoOpLdapClient)");
  }
}
