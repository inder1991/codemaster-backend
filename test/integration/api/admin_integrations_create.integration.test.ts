/**
 * Integration test for POST /api/admin/integrations/confluence-spaces against the DISPOSABLE Postgres
 * (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN is set.
 *
 * 1:1 port of integrations.py add_confluence_space: platform_owner+; dedup → validate (injected Confluence
 * validator stub) → INSERT → audit (installation_id=NULL). core.integrations is platform-shared with the
 * GLOBAL unique index integrations_kind_space_key, so every space_key here is namespaced FWCREATE* and
 * cleaned by that prefix; integration_ids use the dd-free cc00cc00- namespace (both verified tree-unique).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";
import type { ConfluenceValidatorPort } from "#backend/integrations/confluence/confluence_validator.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const URL = "/api/admin/integrations/confluence-spaces";
const DUP_ID = "cc00cc00-0000-0000-0000-000000000001";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.integrations WHERE config_json ->> 'space_key' LIKE 'FWCREATE%'`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function cookie(role: Role): Record<string, string> {
  return {
    [SESSION_COOKIE_NAME]: issueCookie({
      user_id: "cc00cc00-0000-0000-0000-0000000000aa",
      email: "u@x",
      role,
      auth_source: "local",
      ldap_groups: [],
      now: NOW,
      signing_key: SIGNING_KEY,
      installation_id: null,
    }),
  };
}

type AuditEvent = { action: string; targetId: string; installationId: string | null; before: unknown; after: unknown };

/** A stub ConfluenceValidatorPort with a call counter (to assert dedup short-circuits validation). */
function makeStub(result: { ok: boolean; detail: string }): { validator: ConfluenceValidatorPort; calls: { n: number } } {
  const calls = { n: 0 };
  return {
    calls,
    validator: {
      validateSpace: async () => {
        calls.n += 1;
        return { ok: result.ok, detail: result.detail, validatedAt: NOW };
      },
    },
  };
}

async function makeApp(args?: { audited?: Array<AuditEvent>; validator?: ConfluenceValidatorPort }) {
  const app = buildApp({});
  await registerAdminRoutes(app, {
    db,
    signingKey: SIGNING_KEY,
    clock: new FakeClock({ now: NOW }),
    ...(args?.validator ? { getConfluenceValidator: () => args.validator! } : {}),
    ...(args?.audited
      ? {
          audit: async (e: AuditEvent) => {
            args.audited!.push(e);
          },
        }
      : {}),
  });
  await app.ready();
  return app;
}

const okBody = (spaceKey: string) => ({
  space_key: spaceKey,
  space_name: "Engineering",
  scope: "page_tree",
  page_tree_root_id: "123",
  trust_tier: "semi",
  governance_ack: true,
  visibility: "org:eng",
  strict_label_mode: true,
});

describeDb("admin integrations CREATE (disposable :5434)", () => {
  it("happy → 201 + sorted config_json + governance fields + audit (installation_id NULL)", async () => {
    const audited: Array<AuditEvent> = [];
    const { validator } = makeStub({ ok: true, detail: "ok" });
    const app = await makeApp({ audited, validator });
    try {
      const res = await app.inject({ method: "POST", url: URL, cookies: cookie("platform_owner"), payload: okBody("FWCREATEOK") });
      expect(res.statusCode).toBe(201);
      const item = res.json<{
        integration_id: string;
        kind: string;
        enabled: boolean;
        last_validated_at: string | null;
        last_validation_error: string | null;
        trust_tier: string | null;
        default_governance_ack_at: string | null;
        visibility: string;
        strict_label_mode: boolean;
      }>();
      expect(item.kind).toBe("confluence_space");
      expect(item.enabled).toBe(true);
      expect(item.last_validated_at).toBe(NOW.toISOString());
      expect(item.last_validation_error).toBeNull();
      expect(item.trust_tier).toBe("semi");
      expect(item.default_governance_ack_at).toBe(NOW.toISOString()); // governance_ack=true → now()
      expect(item.visibility).toBe("org:eng");
      expect(item.strict_label_mode).toBe(true);
      // config_json content (all 4 keys + values). NB: jsonb reorders keys by (length, bytes) on storage, so
      // the read-back KEY ORDER is jsonb's, not the alphabetical json.dumps(sort_keys=True) string order —
      // assert content, not order.
      const row = await sql<{ config_json: string }>`SELECT config_json::text AS config_json FROM core.integrations WHERE integration_id = ${item.integration_id}`.execute(db);
      expect(JSON.parse(row.rows[0]!.config_json)).toEqual({
        space_key: "FWCREATEOK",
        space_name: "Engineering",
        scope: "page_tree",
        page_tree_root_id: "123",
      });
      // audit
      expect(audited).toHaveLength(1);
      expect(audited[0]!.action).toBe("integration.added");
      expect(audited[0]!.installationId).toBeNull();
      expect(audited[0]!.before).toBeNull();
      expect((audited[0]!.after as Record<string, unknown>)["space_key"]).toBe("FWCREATEOK");
      expect((audited[0]!.after as Record<string, unknown>)["trust_tier"]).toBe("semi");
    } finally {
      await app.close();
    }
  });

  it("409 duplicate (same kind+space_key) — validator NOT called, no audit", async () => {
    await sql`INSERT INTO core.integrations (integration_id, kind, config_json)
              VALUES (${DUP_ID}, 'confluence_space', CAST(${JSON.stringify({ space_key: "FWCREATEDUP" })} AS jsonb))`.execute(db);
    const audited: Array<AuditEvent> = [];
    const { validator, calls } = makeStub({ ok: true, detail: "ok" });
    const app = await makeApp({ audited, validator });
    try {
      const res = await app.inject({ method: "POST", url: URL, cookies: cookie("platform_owner"), payload: okBody("FWCREATEDUP") });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ detail: { code: string; space_key: string } }>().detail).toEqual({ code: "duplicate", space_key: "FWCREATEDUP" });
      expect(calls.n).toBe(0); // dedup precedes validation
      expect(audited).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("validator failures map to stable codes: 422 auth_error / not_found / validation_failed; 503 rate_limited", async () => {
    const cases: Array<{ detail: string; code: string; status: number; key: string }> = [
      { detail: "HTTP 401 unauthorized", code: "auth_error", status: 422, key: "FWCREATEAUTH" },
      { detail: "HTTP 404 space not found", code: "not_found", status: 422, key: "FWCREATENF" },
      { detail: "schema invalid", code: "validation_failed", status: 422, key: "FWCREATEVAL" },
      { detail: "HTTP 429 too many requests", code: "rate_limited", status: 503, key: "FWCREATERATE" },
    ];
    for (const c of cases) {
      const audited: Array<AuditEvent> = [];
      const { validator } = makeStub({ ok: false, detail: c.detail });
      const app = await makeApp({ audited, validator });
      try {
        const res = await app.inject({ method: "POST", url: URL, cookies: cookie("platform_owner"), payload: okBody(c.key) });
        expect(res.statusCode).toBe(c.status);
        expect(res.json<{ detail: { code: string; detail: string } }>().detail).toEqual({ code: c.code, detail: c.detail });
        if (c.code === "rate_limited") {
          expect(res.headers["retry-after"]).toBe("60");
        }
        // no row inserted, no audit
        const row = await sql`SELECT 1 FROM core.integrations WHERE config_json ->> 'space_key' = ${c.key}`.execute(db);
        expect(row.rows).toHaveLength(0);
        expect(audited).toHaveLength(0);
      } finally {
        await app.close();
      }
    }
  });

  it("422 schema (bad space_key / visibility / scope); 503 seam unwired; 403 non-owner", async () => {
    const { validator } = makeStub({ ok: true, detail: "ok" });
    const app = await makeApp({ validator });
    try {
      const bad = [
        { ...okBody("FWCREATEOK"), space_key: "bad key!" }, // lowercase + space + !
        { ...okBody("FWCREATEOK"), visibility: "ORG:Eng" }, // uppercase fails the visibility regex
        { ...okBody("FWCREATEOK"), scope: "subtree" }, // not in the enum
      ];
      for (const payload of bad) {
        expect((await app.inject({ method: "POST", url: URL, cookies: cookie("platform_owner"), payload })).statusCode).toBe(422);
      }
      // 403 — reader / operator / org_owner cannot create
      for (const role of ["reader", "platform_operator", "org_owner"] as const) {
        expect((await app.inject({ method: "POST", url: URL, cookies: cookie(role), payload: okBody("FWCREATEOK") })).statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
    // 503 — no validator wired
    const bare = await makeApp();
    try {
      const res = await bare.inject({ method: "POST", url: URL, cookies: cookie("platform_owner"), payload: okBody("FWCREATEOK") });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ detail: string }>().detail).toBe("confluence validator unwired");
    } finally {
      await bare.close();
    }
  });
});
