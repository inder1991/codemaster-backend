import { describe, expect, it } from "vitest";

import {
  CsrfTokenResponseV1,
  LoginRequestV1,
  LoginResponseV1,
  MeResponseV1,
} from "#contracts/auth.v1.js";

describe("auth.v1 contracts (Pydantic extra='forbid' → .strict())", () => {
  describe("LoginRequestV1", () => {
    it("accepts a minimal valid login + defaults schema_version", () => {
      const parsed = LoginRequestV1.parse({ username: "ops", password: "pw" });
      expect(parsed.schema_version).toBe(1);
    });

    it("rejects unknown keys (strict)", () => {
      expect(() => LoginRequestV1.parse({ username: "u", password: "p", extra: 1 })).toThrow();
    });

    it("enforces username 1..200 and password 1..1024 bounds", () => {
      expect(() => LoginRequestV1.parse({ username: "", password: "p" })).toThrow();
      expect(() => LoginRequestV1.parse({ username: "x".repeat(201), password: "p" })).toThrow();
      expect(() => LoginRequestV1.parse({ username: "u", password: "" })).toThrow();
      expect(() => LoginRequestV1.parse({ username: "u", password: "x".repeat(1025) })).toThrow();
      // boundaries pass
      expect(() =>
        LoginRequestV1.parse({ username: "x".repeat(200), password: "x".repeat(1024) }),
      ).not.toThrow();
    });
  });

  describe("LoginResponseV1", () => {
    it("requires an offset datetime for expires_at", () => {
      expect(() =>
        LoginResponseV1.parse({ user_id: "u", role: "reader", expires_at: "not-a-date" }),
      ).toThrow();
      expect(() =>
        LoginResponseV1.parse({
          user_id: "u",
          role: "reader",
          expires_at: "2026-06-07T12:00:00+00:00",
        }),
      ).not.toThrow();
    });
  });

  describe("MeResponseV1", () => {
    it("allows null installation_id (global scope) and validates uuid when present", () => {
      const global = MeResponseV1.parse({ user_id: "u", role: "super_admin", email: "a@b.c" });
      expect(global.installation_id).toBeNull();
      expect(() =>
        MeResponseV1.parse({
          user_id: "u",
          role: "org_owner",
          email: "a@b.c",
          installation_id: "not-a-uuid",
        }),
      ).toThrow();
      expect(() =>
        MeResponseV1.parse({
          user_id: "u",
          role: "org_owner",
          email: "a@b.c",
          installation_id: "11111111-1111-1111-1111-111111111111",
        }),
      ).not.toThrow();
    });
  });

  describe("CsrfTokenResponseV1", () => {
    it("enforces token 32..512", () => {
      expect(() => CsrfTokenResponseV1.parse({ token: "short" })).toThrow();
      expect(() => CsrfTokenResponseV1.parse({ token: "a".repeat(32) })).not.toThrow();
      expect(() => CsrfTokenResponseV1.parse({ token: "a".repeat(513) })).toThrow();
    });
  });
});
