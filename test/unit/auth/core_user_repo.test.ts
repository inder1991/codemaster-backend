import { describe, expect, it } from "vitest";

import {
  type CoreLocalCredentialedUser,
  CoreUserNotFoundError,
  InMemoryCoreUserRepo,
  isLockedNow,
} from "#backend/api/auth/core_user_repo.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");

function makeUser(over: Partial<CoreLocalCredentialedUser> = {}): CoreLocalCredentialedUser {
  return {
    user_id: over.user_id ?? "00000000-0000-0000-0000-0000000000c1",
    installation_id: over.installation_id ?? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    username: over.username ?? "alice",
    email: over.email ?? "alice@org.com",
    display_name: over.display_name ?? "Alice",
    password_hash: over.password_hash ?? "$argon2id$x",
    password_changed_at: over.password_changed_at ?? NOW,
    last_login_at: over.last_login_at ?? null,
    failed_attempts: over.failed_attempts ?? 0,
    locked_until: over.locked_until ?? null,
  };
}

describe("InMemoryCoreUserRepo (port parity)", () => {
  it("insert + getByUsername + getById round-trip", async () => {
    const repo = new InMemoryCoreUserRepo();
    const u = makeUser();
    await repo.insert(u);
    expect(await repo.getByUsername({ username: "alice" })).toEqual(u);
    expect(await repo.getById({ userId: u.user_id })).toEqual(u);
    expect(await repo.getByUsername({ username: "ghost" })).toBeNull();
  });

  it("rejects a duplicate local username (global uniqueness)", async () => {
    const repo = new InMemoryCoreUserRepo();
    await repo.insert(makeUser());
    await expect(
      repo.insert(makeUser({ user_id: "00000000-0000-0000-0000-0000000000c2" })),
    ).rejects.toThrow();
  });

  it("locks on the 5th failure; success clears the counter + lockout + stamps last_login_at", async () => {
    const repo = new InMemoryCoreUserRepo();
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
    expect(locked?.locked_until?.getTime()).toBe(NOW.getTime() + 15 * 60 * 1000);
    expect(isLockedNow(locked!, NOW)).toBe(true);

    await repo.recordLoginAttempt({ userId: u.user_id, success: true, now: NOW });
    const cleared = await repo.getById({ userId: u.user_id });
    expect(cleared?.failed_attempts).toBe(0);
    expect(cleared?.locked_until).toBeNull();
    expect(cleared?.last_login_at?.getTime()).toBe(NOW.getTime());
  });

  it("updatePassword unknown id throws CoreUserNotFoundError", async () => {
    const repo = new InMemoryCoreUserRepo();
    await expect(
      repo.updatePassword({ userId: "ffffffff-ffff-ffff-ffff-ffffffffffff", newHash: "x", now: NOW }),
    ).rejects.toThrow(CoreUserNotFoundError);
  });
});
