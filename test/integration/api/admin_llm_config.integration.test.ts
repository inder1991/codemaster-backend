/**
 * Integration test for the LLM-config admin reads (llm-models, llm-purpose-routing, llm-provider-config)
 * against the DISPOSABLE Postgres (localhost:5434 — NEVER the cluster). Runs ONLY when CODEMASTER_PG_CORE_DSN
 * is set; SKIPS otherwise. All three are platform-scope (no installation filtering).
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import {
  getLlmProviderConfig,
  listLlmModels,
  listLlmPurposeModels,
} from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const M1 = "itest-llm-aaa"; // anthropic_direct
const M2 = "itest-llm-bbb"; // bedrock
const ROTATOR = "abababab-1111-2222-3333-444444444444";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.llm_models WHERE model_id IN (${M1}, ${M2})`.execute(db);
  await sql`DELETE FROM core.llm_provider_settings WHERE scope = 'platform' AND role = 'primary' AND model_id = 'itest-prov-model'`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await sql`INSERT INTO core.llm_models (provider, model_id) VALUES ('anthropic_direct', ${M1}), ('bedrock', ${M2})`.execute(db);
  await sql`INSERT INTO core.llm_provider_settings
              (role, provider, model_id, api_key_ciphertext, api_key_fingerprint, last_rotated_by_user_id, scope)
            VALUES ('primary', 'bedrock', 'itest-prov-model', 'kms2:1:x', 'ab12', ${ROTATOR}, 'platform')`.execute(db);
});

afterAll(async () => {
  if (INTEGRATION_DSN) await cleanup();
  await db?.destroy();
});

function mintCookie(role: Role): string {
  return issueCookie({
    user_id: "00000000-0000-0000-0000-0000000000aa",
    email: "u@x",
    role,
    auth_source: "local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: null,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describeDb("admin llm-config (disposable :5434)", () => {
  it("listLlmModels: ordered by (provider, model_id)", async () => {
    const mine = (await listLlmModels(db)).filter((m) => m.model_id.startsWith("itest-llm-"));
    expect(mine.map((m) => m.model_id)).toEqual([M1, M2]); // anthropic_direct < bedrock
    expect(mine[0]?.provider).toBe("anthropic_direct");
    expect(mine[0]?.last_validation_status).toBe("untested");
  });

  it("listLlmPurposeModels: sorted ascending by purpose", async () => {
    const purposes = (await listLlmPurposeModels(db)).map((a) => a.purpose);
    expect(purposes).toEqual([...purposes].sort());
  });

  it("getLlmProviderConfig: primary returns the row; an unconfigured role → null", async () => {
    const primary = await getLlmProviderConfig(db);
    expect(primary?.provider).toBe("bedrock");
    expect(primary?.api_key_fingerprint).toBe("ab12");
    expect(primary?.last_rotated_by_user_id).toBe(ROTATOR);
    expect(await getLlmProviderConfig(db, "secondary")).toBeNull();
  });

  it("routes: 200 for reader; 403 for org_owner; 404 when provider unconfigured", async () => {
    const app = await makeApp();
    const reader = { [SESSION_COOKIE_NAME]: mintCookie("reader") };
    expect((await app.inject({ method: "GET", url: "/api/admin/llm-models", cookies: reader })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/admin/llm-purpose-routing", cookies: reader })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/admin/llm-provider-config", cookies: reader })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/admin/llm-models", cookies: { [SESSION_COOKIE_NAME]: mintCookie("org_owner") } })).statusCode,
    ).toBe(403);
    await app.close();
  });
});
