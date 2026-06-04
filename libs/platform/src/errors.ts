/**
 * Exception-formatting helper — 1:1 port of `codemaster/infra/errors.py`
 * (`format_exception` + `_format_one`, frozen Python, Sprint 16 / NOW.3).
 *
 * The empty-error-message anti-pattern
 * ====================================
 * Template-interpolating an error directly (`` `...: ${err}` ``) produces an EMPTY string when the
 * error stringifies to `""` — the JS analogue of Python's `str(err) == ""` (e.g. some re-raised /
 * arg-less errors). That yields a log line with no type and no diagnostic between the colon and the
 * period. {@link formatException} produces `"<TypeName>: <message>"` so the type name is always
 * present, with an optional ONE-level `cause` chain (`raise X from Y` → ES2022 `err.cause`).
 *
 * Use at outermost wrap-and-re-raise sites — where we catch, wrap with operational context, and
 * `throw new XxxError(msg, { cause: err })`. Operators read those wrapped messages in logs/alerts.
 */

const EMPTY_MARKER = "<empty>";

/**
 * Format an exception for operator-facing log + error messages.
 *
 * @param err - The thrown value to format. Need not be an `Error` (JS can throw anything); non-Error
 *   throws are stringified defensively.
 * @param opts.includeCause - When `true` (default), append one level of the ES2022 `cause` chain.
 *   Multi-level chains are NOT walked (depth > 1 indicates deeper wrapping that needs its own
 *   formatter call, or a bug). When `false`, only the top-level value is formatted.
 * @returns `"<TypeName>: <message-or-empty-marker> [caused by <CauseType>: <cause-msg>]"`.
 *
 * @example
 * ```ts
 * const inner = new Error("inner");
 * const outer = new Error("outer", { cause: inner });
 * formatException(outer); // "Error: outer [caused by Error: inner]"
 * ```
 */
export function formatException(err: unknown, opts?: { includeCause?: boolean }): string {
  const includeCause = opts?.includeCause ?? true;
  const head = formatOne(err);
  const cause = causeOf(err);
  if (!includeCause || cause === undefined) {
    return head;
  }
  return `${head} [caused by ${formatOne(cause)}]`;
}

/** Format a single value (no chain walk). 1:1 with the Python `_format_one`. */
function formatOne(err: unknown): string {
  const typeName = typeNameOf(err);
  let message: string;
  try {
    message = err instanceof Error ? String(err.message) : String(err);
  } catch {
    // Defensive: a misbehaving `toString` / `Symbol.toPrimitive` shouldn't crash the formatter that
    // is trying to surface the original error (the JS analogue of Python's `<__str__ raised>`).
    message = "<toString raised>";
  }
  if (message === "") {
    message = EMPTY_MARKER;
  }
  return `${typeName}: ${message}`;
}

/**
 * Resolve the type name. For `Error`s prefer the runtime `name` (subclasses set it, e.g.
 * `TypeError`, or a custom `this.name = "GitHubAppUnauthorized"`), falling back to the constructor
 * name. For non-Error throws (strings, plain objects, …) use the JS `typeof`, mirroring the Python
 * `type(err).__name__` for arbitrary raised objects.
 */
function typeNameOf(err: unknown): string {
  if (err instanceof Error) {
    return err.name !== "" ? err.name : err.constructor.name;
  }
  if (err === null) {
    return "null";
  }
  return typeof err;
}

/**
 * The ES2022 `cause` — the analogue of Python's `__cause__` (set by `raise X from Y`). Read defensively
 * (a getter could throw); a `null`/absent cause yields `undefined` so no `[caused by ...]` is appended.
 */
function causeOf(err: unknown): unknown {
  if (err instanceof Error) {
    try {
      const c = (err as { cause?: unknown }).cause;
      return c === undefined || c === null ? undefined : c;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
