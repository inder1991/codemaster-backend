import { describe, expect, it } from "vitest";

import {
  PLATFORM_SCOPE_AUDIT_INSTALLATION_ID,
  SUPER_ADMIN_SESSION_INSTALLATION_ID,
} from "#backend/infra/sentinels.js";

describe("sentinels (1:1 with sentinels.py)", () => {
  it("pins the reserved UUIDs verbatim", () => {
    expect(SUPER_ADMIN_SESSION_INSTALLATION_ID).toBe("00000000-0000-0000-0000-000000000000");
    expect(PLATFORM_SCOPE_AUDIT_INSTALLATION_ID).toBe("00000000-0000-0000-0000-000000000001");
  });
});
