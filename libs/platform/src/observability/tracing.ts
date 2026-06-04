/**
 * Observability tracer seam — sibling of {@link file://./metrics.ts} (the meter seam), the single
 * sanctioned entry point for OpenTelemetry tracing across the backend. Subsystems get a {@link Tracer}
 * from here and start spans through it, rather than importing `@opentelemetry/api` directly — so there
 * is one place to evolve the tracing surface and one registry hook for the (deferred) end-of-migration
 * span-name-parity gate.
 *
 * Like `metrics.getMeter`, `@opentelemetry/api`'s `trace.getTracer` ALWAYS returns a Tracer — a no-op
 * Tracer when no TracerProvider is registered. So span emission is safe BEFORE the exporter/collector
 * is wired (the exporter wiring is deferred to the end-of-migration observability task):
 * `tracer.startActiveSpan(...)` / `span.setAttribute(...)` / `span.end()` are no-ops until a provider
 * is installed, with no null-checks and no `TODO`s in the emit path — subsystem code can emit spans
 * unconditionally.
 *
 * Tracer name argument: pass the dotted module path the Python uses (e.g.
 * `"codemaster.integrations.github"`), so the deferred name-parity gate passes and existing
 * traces/dashboards map unchanged.
 */
import { trace, type Tracer } from "@opentelemetry/api";

/** Return an OTel {@link Tracer} bound to `name` (a no-op Tracer when no TracerProvider is registered). */
export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

// Re-export the span + tracer types (and the status-code enum) so subsystem tracing modules import
// everything tracing-related from this one seam rather than reaching into `@opentelemetry/api` directly.
export { SpanStatusCode } from "@opentelemetry/api";
export type { Span, Tracer } from "@opentelemetry/api";
