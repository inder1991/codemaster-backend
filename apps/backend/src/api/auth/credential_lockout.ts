// Shared credential-lockout state machine — 1:1 port of codemaster/api/auth/credential_lockout.py
// (F1 / Task 2, 2026-05-17). ONE implementation shared by both the local_users (super_admin bootstrap)
// and core.users (local-credentialed) repos, so the lockout math has a single place to be correct.
//
// Pure functions — no I/O, no side effects. Callers persist the returned state atomically (the Postgres
// adapters use a single atomic UPDATE whose CASE branches mirror applyAttempt's exact semantics).

/** Failures before lockout activates. Anchored by a test so a silent "make it 3" change can't happen. */
export const LOCKOUT_THRESHOLD = 5;
/** Lockout window once the threshold transition fires. */
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/** Pure-data view of a user's lockout state; both user kinds project into this shape. */
export type LockoutState = {
  failed_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
}

/**
 * Compute the next lockout state for a login attempt.
 *
 * 1. Success ⇒ counter reset to 0; `locked_until` cleared; `last_login_at` set to now. A correct password
 *    CLEARS an existing lockout (the user proved possession of the credential).
 * 2. Failure below threshold ⇒ increment; `locked_until` PRESERVED (not cleared).
 * 3. Failure AT the threshold transition (count goes `THRESHOLD-1 → THRESHOLD`) ⇒ set
 *    `locked_until = now + LOCKOUT_DURATION`. Strict equality is the bug fix: re-extending on EVERY
 *    failure past threshold let an attacker keep an account locked forever.
 * 4. Failure above threshold ⇒ increment; `locked_until` preserved (do NOT re-extend).
 */
export function applyAttempt(
  state: LockoutState,
  opts: { success: boolean; now: Date },
): LockoutState {
  if (opts.success) {
    return { failed_attempts: 0, locked_until: null, last_login_at: opts.now };
  }
  const newAttempts = state.failed_attempts + 1;
  const newLockedUntil =
    newAttempts === LOCKOUT_THRESHOLD
      ? new Date(opts.now.getTime() + LOCKOUT_DURATION_MS)
      : state.locked_until;
  return {
    failed_attempts: newAttempts,
    locked_until: newLockedUntil,
    last_login_at: state.last_login_at,
  };
}

/** True iff `lockedUntil > now` (window still active). At the exact boundary the lockout has just expired. */
export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}
