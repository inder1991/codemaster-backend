// Session cookie — 1:1 port of codemaster/api/auth/session.py (Sprint 12 / S12.1.2).
//
// HMAC-SHA256-signed JSON envelope: `<b64url(body)>.<b64url(sig)>`. The body is compact
// `JSON.stringify` (Python `json.dumps(separators=(",",":"))`) with the keys in the SAME insertion order
// the Python builds them, and non-ASCII escaped to `\uXXXX` to mirror `ensure_ascii=True` — so the signed
// bytes match the Python byte-for-byte. verify re-hashes the LITERAL decoded body bytes (never re-serializes),
// so issue/verify are self-consistent regardless. Signing key: Vault Transit in prod, injected raw in tests.

import { createHmac, timingSafeEqual } from "node:crypto";

import type { Role } from "#backend/api/auth/roles.js";

/** Spec line 1825: "Sessions: 12 hr, 1 hr idle." (X.9 bumped lifetime 8h→12h.) */
export const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** Idle detection is client-side (frontend use-idle-timer); server-side idle enforcement deferred to v1. */
export const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export type AuthSource = "local" | "core_local" | "ldap";

/** Decoded session principal. Field names mirror the frozen Python dataclass (the signed wire shape). */
export type AuthSession = {
  user_id: string;
  email: string;
  role: Role;
  auth_source: AuthSource;
  ldap_groups: ReadonlyArray<string>;
  issued_at: Date;
  expires_at: Date;
  /** Per-tenant scope (Sprint X.6). null for super_admin / global-scoped roles; a UUID for org-scoped grants. */
  installation_id: string | null;
}

/** Raised on any verify failure: tampered / expired / malformed / wrong format. */
export class SessionCookieInvalid extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionCookieInvalid";
  }
}

/** Standard base64url WITHOUT padding (Python `urlsafe_b64encode(...).rstrip(b"=")`). */
function b64uEncode(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64uDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** Compact JSON with non-ASCII escaped to `\uXXXX` — matches CPython `json.dumps(ensure_ascii=True)`. */
function jsonEnsureAscii(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Python `datetime.isoformat()` for a tz-aware UTC instant: `+00:00` offset; fractional second omitted
 *  when zero (matching CPython, which only renders microseconds when nonzero). */
function pyIsoFormat(d: Date): string {
  const iso = d.toISOString(); // 2026-06-07T12:00:00.000Z
  const base = d.getUTCMilliseconds() === 0 ? iso.slice(0, 19) : iso.slice(0, 23);
  return `${base}+00:00`;
}

export type IssueCookieOptions = {
  user_id: string;
  email: string;
  role: Role;
  auth_source: AuthSource;
  ldap_groups: ReadonlyArray<string>;
  now: Date;
  signing_key: Buffer | Uint8Array;
  installation_id?: string | null;
}

/** Return the signed cookie value. `installation_id` is OMITTED from the payload when null, so cookies
 *  stay shape-compatible with pre-X.6 verifiers. */
export function issueCookie(opts: IssueCookieOptions): string {
  const expiresAt = new Date(opts.now.getTime() + SESSION_LIFETIME_MS);
  // Insertion order is load-bearing for byte-parity with the Python json.dumps.
  const payload: Record<string, unknown> = {
    user_id: opts.user_id,
    email: opts.email,
    role: opts.role,
    auth_source: opts.auth_source,
    ldap_groups: [...opts.ldap_groups],
    issued_at: pyIsoFormat(opts.now),
    expires_at: pyIsoFormat(expiresAt),
  };
  if (opts.installation_id !== undefined && opts.installation_id !== null) {
    payload.installation_id = opts.installation_id;
  }
  const body = Buffer.from(jsonEnsureAscii(payload), "utf-8");
  const sig = createHmac("sha256", opts.signing_key).update(body).digest();
  return `${b64uEncode(body)}.${b64uEncode(sig)}`;
}

export type VerifyCookieOptions = {
  signing_key: Buffer | Uint8Array;
  now: Date;
}

/** Decode + verify a cookie. Throws {@link SessionCookieInvalid} on any failure. */
export function verifyCookie(cookie: string, opts: VerifyCookieOptions): AuthSession {
  const dot = cookie.indexOf(".");
  if (dot < 0) {
    throw new SessionCookieInvalid("malformed cookie");
  }
  const bodyB64 = cookie.slice(0, dot);
  const sigB64 = cookie.slice(dot + 1);

  const body = b64uDecode(bodyB64);
  const sig = b64uDecode(sigB64);

  const expectedSig = createHmac("sha256", opts.signing_key).update(body).digest();
  // timingSafeEqual throws on unequal lengths; guard first (Python compare_digest returns False instead).
  if (sig.length !== expectedSig.length || !timingSafeEqual(sig, expectedSig)) {
    throw new SessionCookieInvalid("signature mismatch");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString("utf-8")) as Record<string, unknown>;
  } catch (e) {
    throw new SessionCookieInvalid("payload decode failed", { cause: e });
  }

  const expiresRaw = payload.expires_at;
  const issuedRaw = payload.issued_at;
  if (typeof expiresRaw !== "string" || typeof issuedRaw !== "string") {
    throw new SessionCookieInvalid("missing time fields");
  }
  const expiresAt = new Date(expiresRaw);
  const issuedAt = new Date(issuedRaw);
  if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(issuedAt.getTime())) {
    throw new SessionCookieInvalid("missing time fields");
  }
  if (opts.now.getTime() >= expiresAt.getTime()) {
    throw new SessionCookieInvalid("cookie expired");
  }

  const installField = payload.installation_id;
  const ldapGroups = Array.isArray(payload.ldap_groups)
    ? (payload.ldap_groups as Array<unknown>).map((g) => String(g))
    : [];

  return {
    user_id: String(payload.user_id),
    email: String(payload.email),
    role: payload.role as Role,
    auth_source: payload.auth_source as AuthSource,
    ldap_groups: ldapGroups,
    issued_at: issuedAt,
    expires_at: expiresAt,
    installation_id: installField === undefined || installField === null ? null : String(installField),
  };
}
