// Auth metrics — 1:1 port of codemaster/api/auth/metrics.py (F1 / Task 7).
//
// Per-auth-source OTel telemetry so operators can distinguish "LDAP is down" from "core_local can't log in"
// from "rate-limit storm" at a glance:
//   * codemaster_login_attempts_total  — counter {auth_source, outcome}
//   * codemaster_login_latency_seconds — histogram {auth_source}
//
// Fail-safe: a metric-recording failure NEVER blocks login. `getMeter` always returns a Meter (a no-op
// Meter when no provider is registered), so the instruments are safe to create at module load.

import { type Counter, type Histogram, getMeter } from "#platform/observability/metrics.js";

import type { AuthSource } from "#backend/api/auth/session.js";

const METER = getMeter("codemaster.api.auth");

const ATTEMPTS_COUNTER: Counter = METER.createCounter("codemaster_login_attempts_total", {
  description:
    "Total login attempts, labeled by auth_source and outcome. Used by ops dashboards to distinguish " +
    "LDAP outages from core_local failures from rate-limit storms.",
});

const LATENCY_HISTOGRAM: Histogram = METER.createHistogram("codemaster_login_latency_seconds", {
  description:
    "Login latency by auth_source. core_local includes Argon2id verify + field decrypt + role-grants " +
    "query; LDAP is a single bind round-trip.",
});

/** Record one login attempt + its latency. `authSource` null → the "unknown" label (pre-dispatch
 *  rejections such as rate-limiting). Fail-safe: swallows any meter error. */
export function recordLoginAttempt(args: {
  authSource: AuthSource | null;
  outcome: string;
  latencySeconds: number;
}): void {
  try {
    const authSource = args.authSource ?? "unknown";
    ATTEMPTS_COUNTER.add(1, { auth_source: authSource, outcome: args.outcome });
    LATENCY_HISTOGRAM.record(args.latencySeconds, { auth_source: authSource });
  } catch {
    // Fail-safe: telemetry must never block login.
  }
}
