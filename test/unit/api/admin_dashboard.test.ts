import { describe, expect, it } from "vitest";

import { DashboardSummaryV1 } from "#contracts/admin.v1.js";

import { buildDashboardSummary } from "#backend/api/admin/admin_routes.js";

describe("buildDashboardSummary (static shim, parity with shipped dashboard.py)", () => {
  it("returns 4 healthy services + zeroed metrics + now; validates against the contract", () => {
    const now = new Date("2026-06-07T12:00:00.000Z");
    const summary = buildDashboardSummary(now);
    expect(() => DashboardSummaryV1.parse(summary)).not.toThrow();
    expect(summary.services.map((s) => s.name)).toEqual(["api", "workers", "postgres", "bedrock"]);
    expect(summary.services.every((s) => s.state === "healthy")).toBe(true);
    expect(summary.reviews_this_hour).toBe(0);
    expect(summary.latency_p95_ms).toBe(0);
    expect(summary.in_flight_reviews).toBe(0);
    expect(summary.last_updated_at).toBe("2026-06-07T12:00:00.000Z");
  });
});
