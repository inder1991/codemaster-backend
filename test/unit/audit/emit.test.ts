/**
 * Unit tests for the audit-emit helper's PURE surface — TS port of
 * vendor/codemaster-py/codemaster/audit/emit.py. The SQL INSERT path is covered by the DB-integration
 * tier (test/integration/audit/emit.integration.test.ts); here we cover the context binding + the
 * fail-closed tenancy guard + actor-kind validation WITHOUT a live DB, using a fake client that records
 * the bound SQL + params.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ACTOR_KINDS,
  AuditContextMissing,
  bindAuditContext,
  emitAuditEvent,
  getAuditContextForTesting,
} from "#backend/audit/emit.js";

import { setAuditKeyRegistry, resetAuditKeyRegistryForTesting } from "#backend/security/audit_field_codec.js";

import { FakeClock } from "#platform/clock.js";
import { KeyRegistry, makeKeySet } from "#platform/crypto/key_registry.js";

const IID = "11111111-1111-4111-8111-111111111111";

/** A minimal client double: records every query() call; returns an empty result. */
function fakeClient(): { query: ReturnType<typeof vi.fn>; calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> } {
  const calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
  const query = vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
    calls.push({ sql, params: params ?? [] });
    return { rows: [], rowCount: 0 };
  });
  return { query, calls };
}

function devRegistry(): KeyRegistry {
  const r = new KeyRegistry();
  r.set(makeKeySet({ currentVersion: "1", keys: new Map([["1", new Uint8Array(32).fill(0x42)]]) }));
  return r;
}

describe("ACTOR_KINDS", () => {
  it("is exactly the Python tuple ('user', 'system', 'bot')", () => {
    expect([...ACTOR_KINDS]).toEqual(["user", "system", "bot"]);
  });
});

describe("bindAuditContext / getAuditContext", () => {
  it("binds the installation_id onto the client and reads it back", () => {
    const client = fakeClient();
    bindAuditContext(client, { installationId: IID });
    expect(getAuditContextForTesting(client)).toBe(IID);
  });

  it("re-binding the same id is a no-op; re-binding a different id replaces it", () => {
    const client = fakeClient();
    bindAuditContext(client, { installationId: IID });
    bindAuditContext(client, { installationId: IID });
    expect(getAuditContextForTesting(client)).toBe(IID);
    const other = "22222222-2222-4222-8222-222222222222";
    bindAuditContext(client, { installationId: other });
    expect(getAuditContextForTesting(client)).toBe(other);
  });
});

describe("emitAuditEvent — fail-closed tenancy guard", () => {
  it("throws AuditContextMissing when no context is bound (no SQL issued)", async () => {
    resetAuditKeyRegistryForTesting();
    setAuditKeyRegistry(devRegistry());
    const client = fakeClient();
    await expect(
      emitAuditEvent({
        client,
        actorKind: "system",
        actorId: null,
        action: "pr.accepted",
        targetKind: "pull_request",
        targetId: "1",
        after: { head_sha: "deadbeef" },
        clock: new FakeClock({ now: new Date("2026-06-06T00:00:00Z") }),
      }),
    ).rejects.toBeInstanceOf(AuditContextMissing);
    expect(client.calls.length).toBe(0);
    resetAuditKeyRegistryForTesting();
  });
});

describe("emitAuditEvent — actor_kind validation", () => {
  it("rejects an actor_kind outside ('user','system','bot')", async () => {
    resetAuditKeyRegistryForTesting();
    setAuditKeyRegistry(devRegistry());
    const client = fakeClient();
    bindAuditContext(client, { installationId: IID });
    await expect(
      emitAuditEvent({
        client,
        // @ts-expect-error — deliberately invalid actor_kind to assert the runtime guard fires.
        actorKind: "robot",
        actorId: null,
        action: "x",
        targetKind: "y",
        clock: new FakeClock({ now: new Date("2026-06-06T00:00:00Z") }),
      }),
    ).rejects.toThrow(/actor_kind/);
    resetAuditKeyRegistryForTesting();
  });
});

describe("emitAuditEvent — INSERT shape (fake client)", () => {
  it("issues ONE INSERT into audit.audit_events binding the encrypted before/after + minted uuid", async () => {
    resetAuditKeyRegistryForTesting();
    setAuditKeyRegistry(devRegistry());
    const client = fakeClient();
    bindAuditContext(client, { installationId: IID });
    const res = await emitAuditEvent({
      client,
      actorKind: "system",
      actorId: null,
      action: "pr.accepted",
      targetKind: "pull_request",
      targetId: "7",
      before: null,
      after: { head_sha: "deadbeefcafef00d" },
      clock: new FakeClock({ now: new Date("2026-06-06T00:00:00Z") }),
    });
    // Returns the minted v4 uuid.
    expect(res.audit_event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(client.calls.length).toBe(1);
    const { sql, params } = client.calls[0]!;
    expect(sql).toMatch(/INSERT INTO audit\.audit_events/i);
    // params order: aid, iid, actor_kind, actor_id, action, target_kind, target_id, before, after, now.
    expect(params[1]).toBe(IID); // installation_id bound from context
    expect(params[2]).toBe("system");
    expect(params[3]).toBeNull(); // actor_id
    expect(params[4]).toBe("pr.accepted");
    expect(params[5]).toBe("pull_request");
    expect(params[6]).toBe("7");
    expect(params[7]).toBeNull(); // before is null → DB-NULL
    // after is encrypted bytea (kms2: ASCII bytes), NOT plaintext.
    expect(Buffer.isBuffer(params[8])).toBe(true);
    expect(Buffer.from(params[8] as Buffer).toString("ascii").startsWith("kms2:")).toBe(true);
    resetAuditKeyRegistryForTesting();
  });
});
