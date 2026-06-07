// Outbox sink registry — 1:1 with the registry portion of codemaster/activities/outbox.py.
//
// A sink is a named handler that delivers an outbox row's payload to its destination (e.g.
// `temporal_workflow_start` starts a workflow, `vault_credential_write` writes a secret). Sink modules
// register their handler at startup; the dispatcher looks them up by the row's `sink` column and invokes
// them. A module-level singleton registry (mirrors the Python module-global `_SINK_REGISTRY`).

/** Context the dispatcher threads to a sink handler alongside the row payload. */
export type SinkContext = {
  deliveryId: string | null;
  installationId: string | null;
  runId: string | null;
};

/** A sink handler: deliver `payload` to the sink's destination. Throw {@link RetryableSinkError} for a
 *  transient failure (the dispatcher retries) or {@link PermanentSinkError} to dead-letter immediately. */
export type SinkHandler = (args: { payload: unknown; context: SinkContext }) => Promise<void>;

/** A handler is already registered for this sink name. */
export class SinkAlreadyRegisteredError extends Error {
  public constructor(name: string) {
    super(name);
    this.name = "SinkAlreadyRegisteredError";
  }
}

/** No handler is registered for this sink name. */
export class UnknownSinkError extends Error {
  public constructor(name: string) {
    super(name);
    this.name = "UnknownSinkError";
  }
}

/** A sink handler raised this — the dispatcher should RETRY the row. */
export class RetryableSinkError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RetryableSinkError";
  }
}

/** A sink handler raised this — the dispatcher should NOT retry; mark the row dead. */
export class PermanentSinkError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PermanentSinkError";
  }
}

const REGISTRY = new Map<string, SinkHandler>();

/** Register a sink handler (called at startup by sink modules). Throws if `name` is already registered. */
export function registerSink(name: string, handler: SinkHandler): void {
  if (REGISTRY.has(name)) {
    throw new SinkAlreadyRegisteredError(name);
  }
  REGISTRY.set(name, handler);
}

/** Look up a registered sink handler. Throws {@link UnknownSinkError} if none is registered for `name`. */
export function getSink(name: string): SinkHandler {
  const handler = REGISTRY.get(name);
  if (handler === undefined) {
    throw new UnknownSinkError(name);
  }
  return handler;
}

/** Test-only: clear the registry so each test starts fresh. */
export function resetRegistryForTesting(): void {
  REGISTRY.clear();
}

/** The currently-registered sink names, sorted. */
export function registeredSinks(): Array<string> {
  return [...REGISTRY.keys()].sort();
}
