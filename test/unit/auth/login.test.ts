import { describe, expect, it, vi } from "vitest";

import {
  type CoreLocalCredentialedUser,
  InMemoryCoreUserRepo,
} from "#backend/api/auth/core_user_repo.js";
import {
  type AuthenticatedUser,
  LdapBindError,
  type LdapClientPort,
} from "#backend/api/auth/ldap_client.js";
import { InMemoryLocalUserRepo, type LocalUser } from "#backend/api/auth/local_user_repo.js";
import { NoOpLdapClient } from "#backend/api/auth/noop_ldap.js";
import { InMemoryRoleResolver, type RoleResolver } from "#backend/api/auth/role_resolver.js";
import { type AuditCallbackFactory, authenticate } from "#backend/api/auth/login.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const INSTALL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// Pinned Python argon2-cffi hash that verifies "test-password-123" (see password_hasher.test.ts). Reused
// so the dispatch tests don't pay a hashing cost per fixture.
const PW = "test-password-123";
const PW_HASH = "$argon2id$v=19$m=65536,t=3,p=4$B5QfWyYH3WdHYy1TH9rkoA$SomedFZGU2en2csfxEl+WOEJNowVbJjN0AIxtQoavN4";

function localUser(over: Partial<LocalUser> = {}): LocalUser {
  return {
    user_id: "00000000-0000-0000-0000-0000000000aa",
    username: "root",
    email: "root@internal",
    full_name: "Root",
    password_hash: PW_HASH,
    role: "super_admin",
    state: "active",
    last_password_change: NOW,
    last_login_at: null,
    failed_attempts: 0,
    locked_until: null,
    created_at: NOW,
    created_by_user_id: null,
    ...over,
  };
}

function coreUser(over: Partial<CoreLocalCredentialedUser> = {}): CoreLocalCredentialedUser {
  return {
    user_id: "00000000-0000-0000-0000-0000000000c1",
    installation_id: INSTALL,
    username: "alice",
    email: "alice@org.com",
    display_name: "Alice",
    password_hash: PW_HASH,
    password_changed_at: NOW,
    last_login_at: null,
    failed_attempts: 0,
    locked_until: null,
    ...over,
  };
}

/** Configurable LDAP stub: returns a user, throws LdapBindError, or throws an unexpected error. */
class StubLdap implements LdapClientPort {
  public calls = 0;
  public constructor(private readonly behavior: { user?: AuthenticatedUser; error?: Error }) {}
  public async authenticate(args: { username: string; password: string }): Promise<AuthenticatedUser> {
    void args;
    this.calls++;
    if (this.behavior.error) throw this.behavior.error;
    return this.behavior.user!;
  }
}

/** An LDAP stub that FAILS the test if it is ever invoked (asserts the precedence invariant). */
const ldapNeverCalled: LdapClientPort = {
  authenticate: () => {
    throw new Error("LDAP must NOT be called when the username is owned by a higher tier");
  },
};

describe("authenticate — three-stage dispatch (parity with login.py)", () => {
  describe("LOCAL tier (super_admin, highest precedence)", () => {
    it("ok on correct password", async () => {
      const repo = new InMemoryLocalUserRepo();
      await repo.insert(localUser());
      const r = await authenticate({ username: "root", password: PW, localRepo: repo, ldap: ldapNeverCalled, now: NOW });
      expect(r.outcome).toBe("ok");
      expect(r.role).toBe("super_admin");
      expect(r.auth_source).toBe("local");
      expect(r.user_id).toBe("00000000-0000-0000-0000-0000000000aa");
      expect(r.installation_id).toBeNull(); // super_admin is global
    });

    it("bad_credentials on wrong password (and records a failed attempt, no LDAP fallthrough)", async () => {
      const repo = new InMemoryLocalUserRepo();
      await repo.insert(localUser());
      const r = await authenticate({ username: "root", password: "wrong", localRepo: repo, ldap: ldapNeverCalled, now: NOW });
      expect(r.outcome).toBe("bad_credentials");
      expect((await repo.getById({ userId: "00000000-0000-0000-0000-0000000000aa" }))?.failed_attempts).toBe(1);
    });

    it("locked without checking the password", async () => {
      const repo = new InMemoryLocalUserRepo();
      await repo.insert(localUser({ locked_until: new Date(NOW.getTime() + 60_000) }));
      const r = await authenticate({ username: "root", password: "wrong", localRepo: repo, ldap: ldapNeverCalled, now: NOW });
      expect(r.outcome).toBe("locked");
    });

    it("disabled", async () => {
      const repo = new InMemoryLocalUserRepo();
      await repo.insert(localUser({ state: "disabled" }));
      const r = await authenticate({ username: "root", password: PW, localRepo: repo, ldap: ldapNeverCalled, now: NOW });
      expect(r.outcome).toBe("disabled");
    });
  });

  describe("CORE.USERS tier (active only when coreRepo + roleResolver wired)", () => {
    function wired(over: Partial<CoreLocalCredentialedUser> = {}, grants = [{ userId: "00000000-0000-0000-0000-0000000000c1", installationId: null, scope: "platform" as const, role: "platform_owner" as const }]) {
      const localRepo = new InMemoryLocalUserRepo();
      const coreRepo = new InMemoryCoreUserRepo();
      const resolver: RoleResolver = new InMemoryRoleResolver(grants);
      return { localRepo, coreRepo, resolver, seed: () => coreRepo.insert(coreUser(over)) };
    }

    it("ok on correct password + a resolvable role (carries installation_id)", async () => {
      const { localRepo, coreRepo, resolver, seed } = wired();
      await seed();
      const r = await authenticate({ username: "alice", password: PW, localRepo, ldap: ldapNeverCalled, now: NOW, coreRepo, roleResolver: resolver });
      expect(r.outcome).toBe("ok");
      expect(r.role).toBe("platform_owner");
      expect(r.auth_source).toBe("core_local");
      expect(r.installation_id).toBe(INSTALL);
    });

    it("no_role when the resolver returns null (still carries installation_id, no auth_source)", async () => {
      const { localRepo, coreRepo, resolver, seed } = wired({}, []);
      await seed();
      const r = await authenticate({ username: "alice", password: PW, localRepo, ldap: ldapNeverCalled, now: NOW, coreRepo, roleResolver: resolver });
      expect(r.outcome).toBe("no_role");
      expect(r.installation_id).toBe(INSTALL);
      expect(r.auth_source).toBeNull();
    });

    it("bad_credentials on wrong password", async () => {
      const { localRepo, coreRepo, resolver, seed } = wired();
      await seed();
      const r = await authenticate({ username: "alice", password: "wrong", localRepo, ldap: ldapNeverCalled, now: NOW, coreRepo, roleResolver: resolver });
      expect(r.outcome).toBe("bad_credentials");
    });

    it("locked", async () => {
      const { localRepo, coreRepo, resolver, seed } = wired({ locked_until: new Date(NOW.getTime() + 60_000) });
      await seed();
      const r = await authenticate({ username: "alice", password: "wrong", localRepo, ldap: ldapNeverCalled, now: NOW, coreRepo, roleResolver: resolver });
      expect(r.outcome).toBe("locked");
    });

    it("SKIPS the core tier entirely when coreRepo/roleResolver are not wired (flag off) → falls to LDAP", async () => {
      const localRepo = new InMemoryLocalUserRepo();
      const r = await authenticate({ username: "alice", password: PW, localRepo, ldap: new NoOpLdapClient(), now: NOW });
      expect(r.outcome).toBe("bad_credentials"); // NoOp LDAP refuses
    });

    it("an UNCAUGHT resolver exception propagates WITHOUT resetting the counter", async () => {
      const localRepo = new InMemoryLocalUserRepo();
      const coreRepo = new InMemoryCoreUserRepo();
      await coreRepo.insert(coreUser({ failed_attempts: 2 }));
      const resolver: RoleResolver = {
        resolve: () => Promise.reject(new Error("contract violation: resolver threw")),
      };
      await expect(
        authenticate({ username: "alice", password: PW, localRepo, ldap: ldapNeverCalled, now: NOW, coreRepo, roleResolver: resolver }),
      ).rejects.toThrow("contract violation");
      // counter NOT reset (recordLoginAttempt success never ran)
      expect((await coreRepo.getById({ userId: "00000000-0000-0000-0000-0000000000c1" }))?.failed_attempts).toBe(2);
    });
  });

  describe("LDAP tier (fallthrough)", () => {
    const localRepo = new InMemoryLocalUserRepo();

    it("ok when LDAP returns a user whose groups map to a role", async () => {
      const ldap = new StubLdap({
        user: { user_id: "cn=bob", email: "bob@corp", full_name: "Bob", groups: ["codemaster-admin-reader"] },
      });
      const r = await authenticate({ username: "bob", password: "p", localRepo, ldap, now: NOW });
      expect(r.outcome).toBe("ok");
      expect(r.role).toBe("reader");
      expect(r.auth_source).toBe("ldap");
      expect(r.ldap_groups).toEqual(["codemaster-admin-reader"]);
    });

    it("no_role when LDAP groups map to nothing", async () => {
      const ldap = new StubLdap({
        user: { user_id: "cn=bob", email: "bob@corp", full_name: "Bob", groups: ["some-other-group"] },
      });
      const r = await authenticate({ username: "bob", password: "p", localRepo, ldap, now: NOW });
      expect(r.outcome).toBe("no_role");
    });

    it("bad_credentials when LDAP raises LdapBindError", async () => {
      const ldap = new StubLdap({ error: new LdapBindError("bind failed") });
      const r = await authenticate({ username: "bob", password: "p", localRepo, ldap, now: NOW });
      expect(r.outcome).toBe("bad_credentials");
    });

    it("rethrows an UNEXPECTED (non-bind) LDAP error", async () => {
      const ldap = new StubLdap({ error: new Error("connection reset") });
      await expect(
        authenticate({ username: "bob", password: "p", localRepo, ldap, now: NOW }),
      ).rejects.toThrow("connection reset");
    });
  });

  describe("audit callback factory", () => {
    it("is invoked with (outcome, auth_source, user_id) and sets audit_emitted on local ok", async () => {
      const repo = new InMemoryLocalUserRepo();
      await repo.insert(localUser());
      const factory: AuditCallbackFactory = vi.fn(() => async () => {});
      const r = await authenticate({ username: "root", password: PW, localRepo: repo, ldap: ldapNeverCalled, now: NOW, auditCallbackFactory: factory });
      expect(r.audit_emitted).toBe(true);
      expect(factory).toHaveBeenCalledWith("ok", "local", "00000000-0000-0000-0000-0000000000aa");
    });

    it("audit_emitted is false when no factory is supplied", async () => {
      const repo = new InMemoryLocalUserRepo();
      await repo.insert(localUser());
      const r = await authenticate({ username: "root", password: PW, localRepo: repo, ldap: ldapNeverCalled, now: NOW });
      expect(r.audit_emitted).toBe(false);
    });
  });
});
