import { z } from "zod";

// Zod port of contracts/guideline_files/v1.py (frozen Python). Parity-validated in
// guideline_files.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - MAX_GUIDELINE_BYTES            (module-level Final int)   → MAX_GUIDELINE_BYTES
//  - MAX_GUIDELINE_FILES_PER_REPO   (module-level Final int)   → MAX_GUIDELINE_FILES_PER_REPO
//  - DEFAULT_GUIDELINE_PATTERNS     (module-level Final tuple) → DEFAULT_GUIDELINE_PATTERNS (as const)
//  - GuidelineFileV1                (ConfigDict extra=forbid, frozen) → .strict()
//  - DiscoveredGuidelineFilesV1     (ConfigDict extra=forbid, frozen) → .strict()
//
// NOT ported (no wire shape): MalformedPatternError is a Python `ValueError` subclass raised by the
// `discover_guideline_files` ACTIVITY (runtime path), not a Pydantic contract — it has no
// serialized form and no Zod equivalent.
//
// Note on `schema_version`: the Python contract types it as a bare `int` (= 1), NOT a
// `Literal[1]`, so a future schema_version=2 payload must still validate. Ported as
// `z.number().int().default(1)` (NOT z.literal(1), which would false-reject 2).

// Per-file size cap. 256 KiB. Matches Sprint-10's MAX_DOC_BYTES for operational parity.
export const MAX_GUIDELINE_BYTES = 256 * 1024;

// Per-repo cap. 200 — smaller than Sprint-10's 500-file knowledge cap because policy docs
// SHOULD be few. Surfaces as a cap-hit signal in observability.
export const MAX_GUIDELINE_FILES_PER_REPO = 200;

// The 15 default patterns recognized by `discover_guideline_files`. Customer
// `.codemaster.yaml::knowledge.file_patterns` (A-7) is ADDITIVE — adds to this list, never
// replaces. Match semantics: a pattern with '/' matches the full POSIX relative path,
// otherwise it matches the basename only; case-sensitive (POSIX).
export const DEFAULT_GUIDELINE_PATTERNS = [
  // Modern AI-assistant convention files
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  // Long-established convention files (well-known across codebases)
  "STANDARDS.md",
  "DESIGN.md",
  "ARCHITECTURE.md",
  "CONTRIBUTING.md",
  "STYLE.md",
  "STYLE.txt",
  "README.md",
  // Conventional docs directories for policy / standards
  "docs/conventions/*.md",
  "docs/policy/*.md",
  "docs/standards/*.md",
  "docs/architecture/*.md",
  "docs/style/*.md",
] as const;

// GuidelineFileV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// One in-scope policy file discovered in the workspace.
export const GuidelineFileV1 = z
  .object({
    schema_version: z.number().int().default(1),
    relative_path: z.string().min(1).max(500),
    // Python: scope_dir has max_length=500 but NO min_length — empty string is valid
    // (repo-root files render scope_dir="").
    scope_dir: z.string().max(500),
    source_pattern: z.string().min(1).max(200),
    body: z.string().min(1).max(MAX_GUIDELINE_BYTES),
    // Lowercase hex SHA-256 digest: exactly 64 chars (min_length == max_length == 64).
    content_sha256: z.string().min(64).max(64),
  })
  .strict();
export type GuidelineFileV1 = z.infer<typeof GuidelineFileV1>;

// DiscoveredGuidelineFilesV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// Result of `discover_guideline_files` for one workspace.
export const DiscoveredGuidelineFilesV1 = z
  .object({
    schema_version: z.number().int().default(1),
    // tuple[GuidelineFileV1, ...] = default_factory=tuple → z.array(...).default([]).
    files: z.array(GuidelineFileV1).default([]),
    files_cap_hit: z.boolean().default(false),
    oversize_files_count: z.number().int().gte(0).default(0),
  })
  .strict();
export type DiscoveredGuidelineFilesV1 = z.infer<typeof DiscoveredGuidelineFilesV1>;
