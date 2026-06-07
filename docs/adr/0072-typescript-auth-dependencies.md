# ADR-0072 — TypeScript auth dependencies: @node-rs/argon2 + @fastify/cookie

**Status:** Accepted (2026-06-07) — required by the Auth + Admin-API journey
**Context:** porting codemaster's operator-console auth (three-tier login + session) to the TS backend.

## Context

CLAUDE.md: "No new dependencies without justification. Spine paths require a whitelist update + ADR." The
auth journey needs two runtime dependencies the TS backend does not yet have. This ADR justifies both and
records the load-bearing parity proof for the first.

## Decision

Add two `dependencies`:

1. **`@node-rs/argon2`** (Argon2id password hashing/verification). **Critical-path.** `core.local_users`
   (and Tier-2 `core.users`) store password hashes the frozen Python wrote with `argon2-cffi` as standard
   PHC strings (`$argon2id$v=19$m=65536,t=3,p=4$…`). The TS login MUST verify against those exact hashes or
   `super_admin` cannot log in. `@node-rs/argon2` is a native (NAPI-RS, no node-gyp) implementation of
   reference Argon2 that reads the cost params from the encoded PHC string, so it cross-verifies hashes
   written by any RFC-9106 implementation. We choose it over `argon2` (node-gyp build pain) and over a
   pure-JS impl (too slow at OWASP cost params).

   **Parity PROVEN empirically (2026-06-07):** a real `argon2-cffi` hash minted with the production params
   (`PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4, type=ID)`) —
   `$argon2id$v=19$m=65536,t=3,p=4$B5QfWyYH3WdHYy1TH9rkoA$SomedFZGU2en2csfxEl+WOEJNowVbJjN0AIxtQoavN4` for
   `"test-password-123"` — verifies `true` (correct pw) / `false` (wrong pw) under `@node-rs/argon2.verify()`.
   This vector is pinned as a CI parity fixture in `test/unit/auth/password_hasher.test.ts` so a future
   dependency bump can never silently break `super_admin` login.

   The Python `fallback$<salt>$<hmac>` path (used only when `argon2-cffi` is absent in dev) is **NOT**
   ported — production always has real Argon2id.

2. **`@fastify/cookie`** (Cookie parse / Set-Cookie serialize for Fastify v5, which has neither built-in).
   The session is a stateless **HMAC-signed cookie** signed app-side with Node `crypto` (NOT the library's
   signing) — `@fastify/cookie` is used only to parse the inbound `Cookie` header and serialize
   `Set-Cookie`. No JWT library, no `@fastify/jwt`, no `@fastify/auth`, no `bcrypt`: HMAC-SHA256, base64url,
   and the double-submit CSRF are all hand-rolled on Node `crypto`.

## Consequences

- `@node-rs/argon2` ships a prebuilt native binary per platform (linux-x64-gnu in the OpenShift image) — no
  compiler at build time. Verify the image's libc target during the container build.
- The session-cookie HMAC key + CSRF secret come from Vault (per ADR-0071's source-selection), not these
  libs — the libs carry no secrets.
- No spine/whitelist change: these are API-pod (auth) dependencies, not review-pipeline-spine paths.
