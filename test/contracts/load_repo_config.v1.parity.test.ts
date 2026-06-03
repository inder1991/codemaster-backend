import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "../parity/canonical.js";
import { pyRef, shutdownRef } from "../parity/oracle.js";
import { LoadRepoConfigInputV1 } from "../../libs/contracts/src/load_repo_config.v1.js";

afterAll(() => shutdownRef());

// Round-trip the SAME payload through Pydantic (via the oracle —
// `LoadRepoConfigInputV1(**payload).model_dump(mode="json")`) and through Zod
// (`LoadRepoConfigInputV1.parse(payload)`), then diff canonical JSON. Accept/reject must agree.
const PY = "contracts.load_repo_config.v1";

describe("LoadRepoConfigInputV1 parity (Pydantic ↔ Zod)", () => {
  it("validates + dumps a valid payload identically", async () => {
    const payload = { schema_version: 1, workspace_path: "/workspace/clone/abc123" };
    const r = await pyRef({ pyModule: PY, pyCallable: "LoadRepoConfigInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(LoadRepoConfigInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("applies the same schema_version default (1) when omitted", async () => {
    const payload = { workspace_path: "/workspace/clone/abc123" };
    const r = await pyRef({ pyModule: PY, pyCallable: "LoadRepoConfigInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(LoadRepoConfigInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("accepts schema_version=2 (bare int, NOT a Literal) — no false-reject", async () => {
    const payload = { schema_version: 2, workspace_path: "/workspace/clone/abc123" };
    const r = await pyRef({ pyModule: PY, pyCallable: "LoadRepoConfigInputV1", kwargs: payload });
    expect(r.ok, r.err).toBe(true);
    expect(canonicalize(LoadRepoConfigInputV1.parse(payload))).toBe(r.out);
  }, 30_000);

  it("both REJECT an empty workspace_path (min_length=1)", async () => {
    const bad = { schema_version: 1, workspace_path: "" };
    const r = await pyRef({ pyModule: PY, pyCallable: "LoadRepoConfigInputV1", kwargs: bad });
    expect(r.ok).toBe(false); // Pydantic ValidationError
    expect(() => LoadRepoConfigInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT a non-integer schema_version (int constraint)", async () => {
    const bad = { schema_version: 1.5, workspace_path: "/ws" };
    const r = await pyRef({ pyModule: PY, pyCallable: "LoadRepoConfigInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LoadRepoConfigInputV1.parse(bad)).toThrow();
  }, 30_000);

  it("both REJECT an unknown extra field (extra=forbid ↔ .strict())", async () => {
    const bad = { schema_version: 1, workspace_path: "/ws", bogus: 1 };
    const r = await pyRef({ pyModule: PY, pyCallable: "LoadRepoConfigInputV1", kwargs: bad });
    expect(r.ok).toBe(false);
    expect(() => LoadRepoConfigInputV1.parse(bad)).toThrow();
  }, 30_000);
});
