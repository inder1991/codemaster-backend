# ADR-0069 — `smol-toml` for manifest TOML parsing

**Status:** Accepted (2026-06-06)
**Context:** TS port of the review orchestrator's manifest-dependency-parsing track (#4).

## Context

The frozen Python manifest parsers (`codemaster/review/manifest_parsers/`) parse `pyproject.toml`,
`Pipfile`, and `Cargo.toml` with the **Python 3.11 stdlib `tomllib`**. Node has **no built-in TOML
parser**, and none was present in the repo's dependencies. The other manifest formats need nothing new:
`package*.json` / `composer*.json` / `Pipfile.lock` use built-in `JSON.parse`, and `go.mod` / `go.sum`
are custom line-based text parsers.

## Decision

Add **`smol-toml`** (`^1.6.1`) as a runtime dependency, accessed **only** through a thin adapter
`apps/backend/src/review/manifest_parsers/toml_adapter.ts::parseTomlManifest(text)`.

### Why `smol-toml`
- Tiny (~30 KB), **zero runtime dependencies**, TOML 1.0.0 spec-focused, actively maintained.
- Better fit for the migration posture than the older/larger `@iarna/toml` — which remains the fallback
  if `smol-toml` ever fails the parity fixtures against the Python `tomllib` corpus.
- Hand-rolling a TOML parser was rejected: `pyproject.toml` / `Pipfile` / `Cargo.toml` use enough TOML
  surface (nested tables, arrays, quoted keys, literal/multiline strings) that a partial parser would
  create silent dependency/context gaps.

## Guardrails (all enforced)

1. **Justification:** manifest enrichment of the review context. **Fail-open, non-security-critical** —
   a TOML parse failure degrades only that one manifest's dependency records, never the review.
2. **Single seam:** smol-toml is imported in exactly one file (`toml_adapter.ts`), so the library is
   swappable without touching any ecosystem parser.
3. **Per-manifest isolation:** the adapter throws `TomlParseError`; each parser catches it and returns an
   empty `ParseOutcome` for that manifest (1:1 with the Python `except tomllib.TOMLDecodeError`).
4. **Parity fixtures:** the TOML parsers are tested against the Python `tomllib` corpus
   (`pyproject.toml`, `Pipfile`, `Cargo.toml`, malformed TOML, nested tables/arrays, quoted keys).
5. **Size cap:** `MAX_TOML_PARSE_BYTES` (1 MB) before parsing — defense-in-depth on top of the
   fetch activity's 32 KB per-manifest truncation.

## Sandbox boundary

The parsers run **only in the `parse_manifest_dependencies` activity** (worker), never in the Temporal
workflow sandbox. `smol-toml` therefore never enters the workflow bundle (`check_workflow_bundle.ts`
stays clean). This mirrors ADR-0067's tree-sitter-wasm activity-only posture.

## Consequences

- One small, well-scoped dependency added; isolated behind one adapter; reversible.
- The manifest track gains accurate `pyproject.toml` / `Pipfile` / `Cargo.toml` dependency extraction at
  byte-parity with the frozen Python.
