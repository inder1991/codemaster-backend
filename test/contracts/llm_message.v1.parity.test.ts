import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { LlmMessage } from "#contracts/llm_message.v1.js";

afterAll(() => shutdownRef());

// Contract parity WITHOUT fixtures: round-trip the SAME payload through Pydantic
// (`LlmMessage(**payload).model_dump(mode="json")` via the oracle) and through Zod
// (`LlmMessage.parse(payload)`), then diff canonical JSON. Accept/reject agree.
const PY = "codemaster.integrations.llm.client";

describe("LlmMessage parity (Pydantic ↔ Zod)", () => {
  for (const role of ["user", "assistant", "system"]) {
    it(`validates + dumps a ${role} message identically`, async () => {
      const payload = { role, content: "hello world" };
      const r = await pyRef({ pyModule: PY, pyCallable: "LlmMessage", kwargs: payload });
      expect(r.ok, r.err).toBe(true);
      expect(canonicalize(LlmMessage.parse(payload))).toBe(r.out);
    }, 30_000);
  }

  it("both REJECT an invalid role literal", async () => {
    const bad = { role: "tool", content: "x" };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmMessage", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LlmMessage.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { role: "user", content: "x", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "LlmMessage", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LlmMessage.parse(bad)).toThrow();
  }, 30_000);
});
