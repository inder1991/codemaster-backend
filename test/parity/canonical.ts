// Canonical JSON: recursively key-sorted, stable separators, with EXPLICIT numeric/temporal
// normalization so Python model_dump(mode="json") and JS JSON.stringify don't diff spuriously.
//
// Normalization rules (head-of-arch review item g):
//  - Decimal: Pydantic emits Decimal as a STRING ("1.50"); preserve string form, do NOT coerce to number.
//  - float: Python repr vs JS Number.toString differ (1.0 vs "1"). Bare floats are REJECTED — contracts
//    must use Decimal-as-string or int, so a parity payload never carries a lossy float.
//  - datetime: Python isoformat keeps microseconds + explicit offset ("2026-06-03T10:00:00.000000+00:00");
//    JS Date.toISOString uses milliseconds + "Z". Both normalize to RFC3339 microsecond-precision UTC.
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(normalizeScalars(value)));
}

function normalizeScalars(v: unknown): unknown {
  if (typeof v === "number") {
    if (!Number.isInteger(v)) {
      throw new Error(`canonicalize: bare float ${v} — emit Decimal as string or int; see review item g`);
    }
    return v;
  }
  if (typeof v === "string") {
    // Datetime instant-parity: normalize RFC3339 to `.ffffff+00:00` via STRING ops (NOT JS Date,
    // which is millisecond-only and would drop Python's microseconds). The Python ref runner
    // (tools/parity/run_python_ref.py::_norm_dt) applies the IDENTICAL transform, so datetime fields
    // compare as the same instant regardless of Z/+00:00 or fractional-digit count. Pydantic emits
    // `str` datetime fields verbatim (often Z) but `datetime` fields as `.ffffff+00:00`; this reconciles
    // both. Non-datetime strings pass through verbatim. (UTC assumed; non-UTC offsets kept as-is.)
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored, no nested/ambiguous quantifiers (no ReDoS)
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(v);
    if (m) {
      const frac = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
      const offset = m[3] === "Z" ? "+00:00" : m[3];
      return `${m[1]}.${frac}${offset}`;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(normalizeScalars);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      o[k] = normalizeScalars((v as Record<string, unknown>)[k]);
    }
    return o;
  }
  return v;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
