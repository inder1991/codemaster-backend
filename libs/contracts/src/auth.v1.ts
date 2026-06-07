import { z } from "zod";

// Zod port of contracts/auth/v1.py — the operator-console auth wire contracts. `.strict()` (Pydantic
// extra="forbid") on all: the login surface rejects unknown keys.

/** POST /api/auth/login request. */
export const LoginRequestV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    username: z.string().min(1).max(200),
    password: z.string().min(1).max(1024),
  })
  .strict();
export type LoginRequestV1 = z.infer<typeof LoginRequestV1>;

/** POST /api/auth/login success response (the session cookie is set via Set-Cookie, not the body). */
export const LoginResponseV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    user_id: z.string().min(1).max(512),
    role: z.string(),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type LoginResponseV1 = z.infer<typeof LoginResponseV1>;

/** GET /api/auth/me — the current principal. `installation_id` null for super_admin / global scope. */
export const MeResponseV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    user_id: z.string().min(1).max(512),
    role: z.string(),
    email: z.string(),
    installation_id: z.string().uuid().nullable().default(null),
  })
  .strict();
export type MeResponseV1 = z.infer<typeof MeResponseV1>;

/** GET /api/auth/csrf — the double-submit CSRF token. */
export const CsrfTokenResponseV1 = z
  .object({
    schema_version: z.literal(1).default(1),
    token: z.string().min(32).max(512),
  })
  .strict();
export type CsrfTokenResponseV1 = z.infer<typeof CsrfTokenResponseV1>;
