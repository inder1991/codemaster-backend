/**
 * Integration test for GET /api/admin/flags + listFlags against the DISPOSABLE Postgres
 * (postgresql://postgres:postgres@localhost:5434/codemaster — NEVER the in-cluster DB). Runs ONLY when
 * CODEMASTER_PG_CORE_DSN is set; SKIPS otherwise.
 *
 * Seeds a global flag + an installation-scoped flag (mine) + a foreign-installation flag, and asserts the
 * session sees global + own-installation (ordered by name) but NOT the foreign one. Plus the route authz.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { FakeClock } from "#platform/clock.js";

import { buildApp } from "#backend/api/app.js";
import { listFlags } from "#backend/api/admin/admin_read_repo.js";
import { registerAdminRoutes } from "#backend/api/admin/admin_routes.js";
import { SESSION_COOKIE_NAME } from "#backend/api/auth/auth_routes.js";
import type { Role } from "#backend/api/auth/roles.js";
import { issueCookie } from "#backend/api/auth/session.js";

import { describeDb, INTEGRATION_DSN } from "../_db.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const INST = "f9f9f9f9-1111-2222-3333-444444444444";
const INST_OTHER = "fafafafa-1111-2222-3333-444444444444";
const GLOBAL_FLAG = "itest-flag-aaa-global";
const MINE_FLAG = "itest-flag-bbb-mine";
const OTHER_FLAG = "itest-flag-ccc-other";

let pool: Pool;
let db: Kysely<unknown>;

async function cleanup(): Promise<void> {
  await sql`DELETE FROM core.flags WHERE flag_name IN (${GLOBAL_FLAG}, ${MINE_FLAG}, ${OTHER_FLAG})`.execute(db);
}

beforeAll(async () => {
  if (!INTEGRATION_DSN) return;
  pool = new Pool({ connectionString: INTEGRATION_DSN, max: 4 });
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  await cleanup();
  await sql`INSERT INTO core.flags (flag_name, scope, scope_id, value_json)
            VALUES (${GLOBAL_FLAG}, 'global', NULL, '{"on":true}')`.execute(db);
  await sql`INSERT INTO core.flags (flag_name, scope, scope_id, value_json)
            VALUES (${MINE_FLAG}, 'installation', ${INST}, '{"on":false}')`.execute(db);
  await sql`INSERT INTO core.flags (flag_name, scope, scope_id, value_json)
            VALUES (${OTHER_FLAG}, 'installation', ${INST_OTHER}, '{"on":true}')`.execute(db);
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
    auth_source: "core_local",
    ldap_groups: [],
    now: NOW,
    signing_key: SIGNING_KEY,
    installation_id: INST,
  });
}

async function makeApp() {
  const app = buildApp({});
  await registerAdminRoutes(app, { db, signingKey: SIGNING_KEY, clock: new FakeClock({ now: NOW }) });
  await app.ready();
  return app;
}

describeDb("admin flags (disposable :5434)", () => {
  it("listFlags: global + own-installation only, ordered by name; foreign install excluded", async () => {
    const names = (await listFlags(db, INST)).map((f) => f.flag_name).filter((n) => n.startsWith("itest-flag-"));
    expect(names).toEqual([GLOBAL_FLAG, MINE_FLAG]); // alpha order; OTHER_FLAG excluded
    const mine = (await listFlags(db, INST)).find((f) => f.flag_name === MINE_FLAG);
    expect(mine?.scope).toBe("installation");
    expect(mine?.scope_id).toBe(INST);
    expect(mine?.value_json).toBe('{"on":false}');
    expect(mine?.pending_second_approver).toBe(false);
  });

  it("GET /api/admin/flags — 200 for reader (returns a bare array), 403 for org_owner", async () => {
    const app = await makeApp();
    const ok = await app.inject({
      method: "GET",
      url: "/api/admin/flags",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("reader") },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json<Array<{ flag_name: string }>>();
    expect(body.map((f) => f.flag_name)).toEqual(expect.arrayContaining([GLOBAL_FLAG, MINE_FLAG]));

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/flags",
      cookies: { [SESSION_COOKIE_NAME]: mintCookie("org_owner") },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
});
