// Unit tests for the outbox sink registry — 1:1 with the registry portion of
// codemaster/activities/outbox.py (register_sink / get_sink / registered_sinks + the error classes).

import { afterEach, describe, expect, it } from "vitest";

import {
  PermanentSinkError,
  RetryableSinkError,
  SinkAlreadyRegisteredError,
  UnknownSinkError,
  getSink,
  registerSink,
  registeredSinks,
  resetRegistryForTesting,
  type SinkHandler,
} from "#backend/outbox/sink_registry.js";

const noop: SinkHandler = async () => {};

afterEach(() => {
  resetRegistryForTesting();
});

describe("outbox sink registry", () => {
  it("register then get round-trips the handler", () => {
    registerSink("temporal_workflow_start", noop);
    expect(getSink("temporal_workflow_start")).toBe(noop);
  });

  it("registering the same name twice throws SinkAlreadyRegisteredError", () => {
    registerSink("dup", noop);
    expect(() => registerSink("dup", noop)).toThrow(SinkAlreadyRegisteredError);
  });

  it("getting an unregistered sink throws UnknownSinkError", () => {
    expect(() => getSink("nope")).toThrow(UnknownSinkError);
  });

  it("registeredSinks returns the names sorted", () => {
    registerSink("zebra", noop);
    registerSink("alpha", noop);
    registerSink("mango", noop);
    expect(registeredSinks()).toEqual(["alpha", "mango", "zebra"]);
  });

  it("resetRegistryForTesting clears the registry", () => {
    registerSink("x", noop);
    resetRegistryForTesting();
    expect(registeredSinks()).toEqual([]);
  });

  it("RetryableSinkError and PermanentSinkError are distinct, identifiable Error subclasses", () => {
    const r = new RetryableSinkError("transient");
    const p = new PermanentSinkError("fatal");
    expect(r).toBeInstanceOf(Error);
    expect(p).toBeInstanceOf(Error);
    expect(r.name).toBe("RetryableSinkError");
    expect(p.name).toBe("PermanentSinkError");
    expect(r).not.toBeInstanceOf(PermanentSinkError);
  });
});
