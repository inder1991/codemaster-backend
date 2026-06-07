import { describe, expect, it } from "vitest";

import {
  SESSION_LIFETIME_MS,
  SessionCookieInvalid,
  issueCookie,
  verifyCookie,
} from "#backend/api/auth/session.js";

// Cross-stack byte-parity anchors: cookies minted by the frozen Python session.issue_cookie with these
// exact inputs. The TS issueCookie MUST reproduce them byte-for-byte (else a Python-issued cookie would
// fail TS verification during the migration window, and vice-versa).
const SIGNING_KEY = Buffer.from("test-signing-key-0123456789abcdef");
const ISSUED_AT = new Date("2026-06-07T12:00:00.000Z");
const PY_COOKIE =
  "eyJ1c2VyX2lkIjoidS0xIiwiZW1haWwiOiJvcHNAZXhhbXBsZS5jb20iLCJyb2xlIjoicGxhdGZvcm1fb3duZXIiLCJhdXRoX3NvdXJjZSI6ImxvY2FsIiwibGRhcF9ncm91cHMiOltdLCJpc3N1ZWRfYXQiOiIyMDI2LTA2LTA3VDEyOjAwOjAwKzAwOjAwIiwiZXhwaXJlc19hdCI6IjIwMjYtMDYtMDhUMDA6MDA6MDArMDA6MDAifQ.gMYUMduNbO9W563lQgwckujkkKjMhrzgCO8Y7QOzzH4";
const PY_COOKIE_SCOPED =
  "eyJ1c2VyX2lkIjoidS0xIiwiZW1haWwiOiJvcHNAZXhhbXBsZS5jb20iLCJyb2xlIjoib3JnX293bmVyIiwiYXV0aF9zb3VyY2UiOiJsb2NhbCIsImxkYXBfZ3JvdXBzIjpbXSwiaXNzdWVkX2F0IjoiMjAyNi0wNi0wN1QxMjowMDowMCswMDowMCIsImV4cGlyZXNfYXQiOiIyMDI2LTA2LTA4VDAwOjAwOjAwKzAwOjAwIiwiaW5zdGFsbGF0aW9uX2lkIjoiMTExMTExMTEtMTExMS0xMTExLTExMTEtMTExMTExMTExMTExIn0.aY1L_bx4FRHcm9L5Q8MrGb7jYX9gPM_z5m4gwi-Igr0";

describe("session cookie — HMAC envelope (parity with session.py)", () => {
  it("reproduces the Python-issued cookie byte-for-byte (global scope, installation_id omitted)", () => {
    const cookie = issueCookie({
      user_id: "u-1",
      email: "ops@example.com",
      role: "platform_owner",
      auth_source: "local",
      ldap_groups: [],
      now: ISSUED_AT,
      signing_key: SIGNING_KEY,
      installation_id: null,
    });
    expect(cookie).toBe(PY_COOKIE);
  });

  it("reproduces the Python-issued cookie byte-for-byte (org scope, installation_id present)", () => {
    const cookie = issueCookie({
      user_id: "u-1",
      email: "ops@example.com",
      role: "org_owner",
      auth_source: "local",
      ldap_groups: [],
      now: ISSUED_AT,
      signing_key: SIGNING_KEY,
      installation_id: "11111111-1111-1111-1111-111111111111",
    });
    expect(cookie).toBe(PY_COOKIE_SCOPED);
  });

  it("verifies a Python-issued cookie and decodes every field", () => {
    const s = verifyCookie(PY_COOKIE_SCOPED, {
      signing_key: SIGNING_KEY,
      now: new Date("2026-06-07T13:00:00.000Z"),
    });
    expect(s.user_id).toBe("u-1");
    expect(s.email).toBe("ops@example.com");
    expect(s.role).toBe("org_owner");
    expect(s.auth_source).toBe("local");
    expect(s.ldap_groups).toEqual([]);
    expect(s.installation_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(s.expires_at.toISOString()).toBe("2026-06-08T00:00:00.000Z");
  });

  it("round-trips its own cookie and sets expires_at = issued_at + 12h", () => {
    const cookie = issueCookie({
      user_id: "u-2",
      email: "a@b.c",
      role: "reader",
      auth_source: "ldap",
      ldap_groups: ["codemaster-admin-reader"],
      now: ISSUED_AT,
      signing_key: SIGNING_KEY,
    });
    const s = verifyCookie(cookie, { signing_key: SIGNING_KEY, now: new Date("2026-06-07T13:00:00Z") });
    expect(s.ldap_groups).toEqual(["codemaster-admin-reader"]);
    expect(s.installation_id).toBeNull();
    expect(s.expires_at.getTime() - s.issued_at.getTime()).toBe(SESSION_LIFETIME_MS);
  });

  it("rejects a tampered body (signature mismatch)", () => {
    const [body, sig] = PY_COOKIE.split(".") as [string, string];
    // flip the first body char to a different valid base64url char
    const tampered = `${body[0] === "A" ? "B" : "A"}${body.slice(1)}.${sig}`;
    expect(() => verifyCookie(tampered, { signing_key: SIGNING_KEY, now: ISSUED_AT })).toThrow(
      SessionCookieInvalid,
    );
  });

  it("rejects a cookie signed with a different key", () => {
    expect(() =>
      verifyCookie(PY_COOKIE, { signing_key: Buffer.from("a-totally-different-key-xxxxxxxx"), now: ISSUED_AT }),
    ).toThrow(SessionCookieInvalid);
  });

  it("rejects an expired cookie (now >= expires_at)", () => {
    expect(() =>
      verifyCookie(PY_COOKIE, { signing_key: SIGNING_KEY, now: new Date("2026-06-08T00:00:01Z") }),
    ).toThrow(SessionCookieInvalid);
  });

  it("rejects a malformed cookie (no '.' separator)", () => {
    expect(() => verifyCookie("not-a-cookie", { signing_key: SIGNING_KEY, now: ISSUED_AT })).toThrow(
      SessionCookieInvalid,
    );
  });
});
