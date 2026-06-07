# ADR-0070 — Output-safety audit `before` stored UNENCRYPTED (`plain:v1:`)

**Status:** Accepted (2026-06-06) — project-owner decision
**Context:** TS port of the review orchestrator; the output-safety audit emit on the review hot path.

## Context

The `emitOutputSafetyAuditEvent` activity writes one `audit.audit_events` row whenever an LLM activity
returns a populated `sanitization_event` (a secret/PII was detected and redacted from the model output).
The row's `before` payload includes `original_text` — the **pre-redaction** model output, which
**contains the detected secret**. Per the CLAUDE.md encrypt-at-rest invariant, `audit.audit_events.before`
is an AES-256-GCM field-encrypted column (AAD-bound), and the codec **fails closed** (refuses to write)
when no field-encryption key is installed.

That fail-closed behavior sat on the **synchronous review path**: the orchestrator dispatches the audit
emit with a bare `await`, so on a key-less worker (dev / dual-run with no Vault and no
`CODEMASTER_FIELD_ENCRYPTION_KEY_B64`) the first PR whose output trips sanitization would throw
`LocalKeyEncryptionError` and **fail an otherwise-successful review** — fail-closed on exactly the
security-relevant PRs. (Python loads a key at boot via `InMemoryVault`; the TS port wired no boot loader.)

Options considered: (A) skip the emit when no key; (B) stop capturing `original_text` so nothing sensitive
needs a key; (C) store `before` unencrypted. The project owner chose **C** with the trade-off understood.

## Decision

The output-safety audit `before` payload is written via a new **`plain:v1:`** codec format
(`encodeAuditJsonPlaintext`) — canonical JSON with a `plain:v1:` marker prefix, **no key, no AAD, no
encryption**. The read path (`decryptAuditJsonBytea`) detects the prefix and parses the JSON tail without
a key, keeping the documented dual-format read scheme (`vault:v1:` / `kms:vN:` / `kms2:vN:` / now
`plain:v1:`) coherent rather than choking on bare bytes.

**Scope:** the output-safety audit emit ONLY. Every other encrypted column (`core.users.email`,
`audit.audit_events.*` written by the canonical `emitAuditEvent`, etc.) keeps AES-256-GCM unchanged.

## Consequences

- **No field-encryption key / Vault is required** for the output-safety audit emit; it never fails closed,
  so reviews are never blocked by audit-key state.
- **The detected secret is stored in CLEARTEXT** in `audit.audit_events.before`. Anyone with read access
  to that table can read every secret the bot has ever caught, across all repos. This is a deliberate,
  owner-accepted deviation from the encrypt-at-rest invariant — **not** a default to copy elsewhere.
- The encrypt/decrypt round-trip still works (the reader handles `plain:v1:`), so existing readers are
  unaffected.

## Reversibility

Fully reversible. To restore encryption: switch the activity back to `encryptAuditJsonBytea(..., AUDIT_BEFORE_AAD)`
and install a key at boot (Option A/B), or adopt Option B (drop `original_text` so no key is ever needed).
The `plain:v1:` reader branch can stay (back-compat for already-written rows) or be retired once no
`plain:v1:` rows remain. No migration is required to switch new writes back to encrypted.

## Enforcement / visibility

The deviation is loud at every site: `PLAINTEXT_FORMAT_PREFIX` in `audit_field_codec.ts`, the activity's
`encBefore` comment, and this ADR. The codec test asserts the cleartext-by-design property so the trade-off
is visible in the suite, not silent.
