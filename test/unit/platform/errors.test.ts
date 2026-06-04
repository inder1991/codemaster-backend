// Behavior test for the exception-formatting seam (libs/platform/src/errors.ts) — the 1:1 TS analogue
// of the frozen Python `codemaster/infra/errors.py::format_exception`. Asserts the exact format string
// `"<TypeName>: <message>"`, one-level (and ONLY one-level) cause chaining via the ES2022 `cause`,
// the includeCause toggle, the empty-message marker, and defensive handling of non-Error throws.
import { describe, expect, it } from "vitest";

import { formatException } from "#platform/errors.js";

describe("formatException", () => {
  it("formats a plain Error as '<TypeName>: <message>'", () => {
    expect(formatException(new Error("boom"))).toBe("Error: boom");
  });

  it("uses the runtime name of a built-in subclass", () => {
    expect(formatException(new TypeError("nope"))).toBe("TypeError: nope");
  });

  it("uses a custom error name (this.name)", () => {
    class GitHubAppUnauthorized extends Error {
      public constructor(message: string) {
        super(message);
        this.name = "GitHubAppUnauthorized";
      }
    }
    expect(formatException(new GitHubAppUnauthorized("401 from app jwt"))).toBe(
      "GitHubAppUnauthorized: 401 from app jwt",
    );
  });

  it("appends ONE level of cause via the ES2022 `cause`", () => {
    const inner = new Error("inner");
    const outer = new Error("outer", { cause: inner });
    expect(formatException(outer)).toBe("Error: outer [caused by Error: inner]");
  });

  it("matches the documented cause-chain format string exactly", () => {
    class Outer extends Error {
      public constructor(message: string, cause: unknown) {
        super(message, { cause });
        this.name = "Outer";
      }
    }
    class Inner extends Error {
      public constructor(message: string) {
        super(message);
        this.name = "Inner";
      }
    }
    const e = new Outer("outer", new Inner("inner"));
    expect(formatException(e)).toBe("Outer: outer [caused by Inner: inner]");
  });

  it("does NOT walk deeper than one cause level", () => {
    const deepest = new Error("deepest");
    const middle = new Error("middle", { cause: deepest });
    const top = new Error("top", { cause: middle });
    // Only the FIRST cause appears; "deepest" must not leak in.
    expect(formatException(top)).toBe("Error: top [caused by Error: middle]");
  });

  it("drops the cause when includeCause:false", () => {
    const e = new Error("outer", { cause: new Error("inner") });
    expect(formatException(e, { includeCause: false })).toBe("Error: outer");
  });

  it("emits no '[caused by ...]' when there is no cause", () => {
    expect(formatException(new Error("solo"))).toBe("Error: solo");
  });

  it("substitutes the empty-marker for an empty message", () => {
    expect(formatException(new Error(""))).toBe("Error: <empty>");
  });

  it("handles a thrown string defensively (non-Error)", () => {
    expect(formatException("raw failure")).toBe("string: raw failure");
  });

  it("handles a thrown object with a throwing toString defensively", () => {
    const hostile = {
      toString(): string {
        throw new Error("kaboom");
      },
    };
    expect(formatException(hostile)).toBe("object: <toString raised>");
  });

  it("handles a thrown number (non-Error)", () => {
    expect(formatException(42)).toBe("number: 42");
  });
});
