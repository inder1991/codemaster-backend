import { describe, expect, it } from "vitest";

import {
  InMemoryLocalUserRepo,
  LastSuperAdminError,
  type LocalUser,
  LocalUserNotFoundError,
  isLockedNow,
} from "#backend/api/auth/local_user_repo.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");

function makeUser(over: Partial<LocalUser> = {}): LocalUser {
  return {
    user_id: over.user_id ?? "00000000-0000-0000-0000-0000000000aa",
    username: over.username ?? "root",
    email: over.email ?? "root@codemaster.internal",
    full_name: over.full_name ?? "Root Admin",
    password_hash: over.password_hash ?? "$argon2id$x",
    role: "super_admin",
    state: over.state ?? "active",
    last_password_change: over.last_password_change ?? NOW,
    last_login_at: over.last_login_at ?? null,
    failed_attempts: over.failed_attempts ?? 0,
    locked_until: over.locked_until ?? null,
    created_at: over.created_at ?? NOW,
    created_by_user_id: over.created_by_user_id ?? null,
  };
}

describe("InMemoryLocalUserRepo (port parity)", () => {
  it("insert + getByUsername + getById round-trip", async () => {
    const repo = new InMemoryLocalUserRepo();
    const u = makeUser();
    await repo.insert(u);
    expect(await repo.getByUsername({ username: "root" })).toEqual(u);
    expect(await repo.getById({ userId: u.user_id })).toEqual(u);
    expect(await repo.getByUsername({ username: "nope" })).toBeNull();
  });

  it("rejects a duplicate username", async () => {
    const repo = new InMemoryLocalUserRepo();
    await repo.insert(makeUser());
    await expect(
      repo.insert(makeUser({ user_id: "00000000-0000-0000-0000-0000000000bb" })),
    ).rejects.toThrow();
  });

  it("locks on the 5th failure and returns true exactly at the transition", async () => {
    const repo = new InMemoryLocalUserRepo();
    const u = makeUser();
    await repo.insert(u);
    for (let i = 1; i <= 4; i++) {
      expect(await repo.recordLoginAttempt({ userId: u.user_id, success: false, now: NOW })).toBe(
        false,
      );
    }
    expect(await repo.recordLoginAttempt({ userId: u.user_id, success: false, now: NOW })).toBe(
      true,
    );
    const locked = await repo.getById({ userId: u.user_id });
    expect(locked?.failed_attempts).toBe(5);
    expect(locked?.locked_until?.getTime()).toBe(NOW.getTime() + 15 * 60 * 1000);
    expect(isLockedNow(locked!, NOW)).toBe(true);
  });

  it("success clears the counter + lockout and stamps last_login_at", async () => {
    const repo = new InMemoryLocalUserRepo();
    const u = makeUser({ failed_attempts: 5, locked_until: new Date("2030-01-01T00:00:00Z") });
    await repo.insert(u);
    await repo.recordLoginAttempt({ userId: u.user_id, success: true, now: NOW });
    const after = await repo.getById({ userId: u.user_id });
    expect(after?.failed_attempts).toBe(0);
    expect(after?.locked_until).toBeNull();
    expect(after?.last_login_at?.getTime()).toBe(NOW.getTime());
  });

  it("refuses to disable the LAST active super-admin, allows disabling when >1", async () => {
    const repo = new InMemoryLocalUserRepo();
    const a = makeUser({ user_id: "00000000-0000-0000-0000-0000000000a1", username: "a" });
    const b = makeUser({ user_id: "00000000-0000-0000-0000-0000000000b2", username: "b" });
    await repo.insert(a);
    await repo.insert(b);
    await repo.disable({ userId: a.user_id, by: b.user_id }); // ok — b still active
    await expect(repo.disable({ userId: b.user_id, by: a.user_id })).rejects.toThrow(
      LastSuperAdminError,
    );
    expect(await repo.listActiveSuperAdmins()).toHaveLength(1);
  });

  it("updatePassword updates hash + last_password_change; unknown id throws", async () => {
    const repo = new InMemoryLocalUserRepo();
    const u = makeUser();
    await repo.insert(u);
    await repo.updatePassword({ userId: u.user_id, newHash: "$argon2id$new", now: NOW });
    expect((await repo.getById({ userId: u.user_id }))?.password_hash).toBe("$argon2id$new");
    await expect(
      repo.updatePassword({ userId: "ffffffff-ffff-ffff-ffff-ffffffffffff", newHash: "x", now: NOW }),
    ).rejects.toThrow(LocalUserNotFoundError);
  });
});
