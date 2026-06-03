import { z } from "zod";

// Zod port of contracts/codemaster_config/v1.py (frozen Python). Parity-validated in
// codemaster_config.v1.parity.test.ts.
//
// Source models / enums / constants / helpers ported (every public one):
//  - Severity   (Python Literal)                       → z.enum
//  - ToolName   (Python Literal — locked tool list)    → z.enum
//  - ModelOverridesV1        (ConfigDict extra=forbid, frozen)  → .strict()
//  - ConfluenceKnowledgeBlockV1 (extra=forbid, frozen) → .strict() + @field_validator(mode="before")
//      `_canonicalize` re-authored as a .transform() that runs the ported `canonicalizeLabel`.
//  - KnowledgeConfigV1       (extra=forbid, frozen)     → .strict() + @field_validator
//      `_reject_path_escape` re-authored as .superRefine().
//  - PathInstructionV1       (extra=forbid, frozen)     → .strict()
//  - CodemasterConfigV1      (extra=forbid, frozen)     → .strict() + @field_validator
//      `_validate_path_filters` re-authored as .superRefine().
//  - Module constants: _MAX_KNOWLEDGE_FILE_PATTERNS / _MAX_KNOWLEDGE_PATTERN_CHARS /
//    _MAX_PATH_FILTERS / _MAX_PATH_FILTER_PATTERN_CHARS.
//
// The Confluence-label canonicalization is the one non-obvious dependency: the Python
// `@field_validator(mode="before")` calls `codemaster.retrieval.label_taxonomy.canonicalize`.
// That function lives in an application module (NOT contracts/), so it is NOT an already-ported
// sibling contract — its logic is ported inline below as `canonicalizeLabel` to reach byte-parity
// on the dumped labels. The Python `__contract_internal__ = True` class attr is a marker, not a
// Pydantic field, so it never appears in `model_dump` and has no Zod counterpart.
//
// NOTE on numerics: every field in this contract is bool / int / str / nested-model — there is NO
// bare `float`, so the canonicalizer's bare-float rejection never trips and no column is stripped
// from the canonical compare.

// ── module-level caps (ported verbatim) ──────────────────────────────────────
export const MAX_KNOWLEDGE_FILE_PATTERNS = 50 as const;
export const MAX_KNOWLEDGE_PATTERN_CHARS = 200 as const;
export const MAX_PATH_FILTERS = 50 as const;
export const MAX_PATH_FILTER_PATTERN_CHARS = 200 as const;

// Severity = Literal["nit", "suggestion", "issue", "blocker"]
export const Severity = z.enum(["nit", "suggestion", "issue", "blocker"]);
export type Severity = z.infer<typeof Severity>;

// ToolName — locked Sprint-9..13 tool roster (rejects typos at config-load time).
export const ToolName = z.enum([
  "eslint",
  "ruff",
  "gitleaks",
  "semgrep",
  "trivy",
  "checkov",
  "kube-linter",
  "golangci-lint",
  "clippy",
  "rubocop",
  "shellcheck",
  "hadolint",
  "tsc",
  "mypy",
  "prettier",
  "black",
  "gofmt",
  "rustfmt",
  "pytest-coverage",
  "trufflehog",
]);
export type ToolName = z.infer<typeof ToolName>;

// ── Confluence label canonicalization ────────────────────────────────────────
// Port of codemaster/retrieval/label_taxonomy.py::canonicalize (TAXONOMY_VERSION 1).
// Runs at parse time inside ConfluenceKnowledgeBlockV1 (Python @field_validator mode="before").
const CANONICAL_LABEL_REGEX =
  /^(default|(lang|framework|infra|topic|org|version|unrecognized):[a-z][a-z0-9_-]*)$/;

const RECOGNITION_MAP: Readonly<Record<string, string>> = {
  // Languages
  python: "lang:python",
  py: "lang:python",
  typescript: "lang:typescript",
  ts: "lang:typescript",
  javascript: "lang:javascript",
  js: "lang:javascript",
  go: "lang:go",
  golang: "lang:go",
  rust: "lang:rust",
  java: "lang:java",
  kotlin: "lang:kotlin",
  kt: "lang:kotlin",
  ruby: "lang:ruby",
  scala: "lang:scala",
  // Frameworks
  fastapi: "framework:fastapi",
  django: "framework:django",
  flask: "framework:flask",
  react: "framework:react",
  nextjs: "framework:nextjs",
  next: "framework:nextjs",
  preact: "framework:preact",
  solid: "framework:solid",
  spring: "framework:spring",
  springboot: "framework:spring",
  // Infrastructure
  terraform: "infra:terraform",
  tf: "infra:terraform",
  helm: "infra:helm",
  kubernetes: "infra:kubernetes",
  k8s: "infra:kubernetes",
  docker: "infra:docker",
  argocd: "infra:argocd",
  // Topics
  security: "topic:security",
  security_policy: "topic:security_policy",
  securitypolicy: "topic:security_policy",
  performance: "topic:performance",
  accessibility: "topic:accessibility",
  a11y: "topic:accessibility",
  observability: "topic:observability",
  compliance: "topic:compliance",
  // Sentinel
  default: "default",
};

const KNOWN_CANONICAL: ReadonlySet<string> = new Set(Object.values(RECOGNITION_MAP));

/**
 * Confluence raw label → canonical form. Byte-for-byte port of the frozen Python
 * `label_taxonomy.canonicalize`. Lookup order:
 *   1. empty / whitespace-only → "unrecognized:empty"
 *   2. already-canonical (in RECOGNITION_MAP values, or matches CANONICAL_LABEL_REGEX) → passthrough
 *   3. known raw key in RECOGNITION_MAP → mapped value
 *   4. version heuristic ("pythonv1", "k8s_v1", …) → "version:<lowered>"
 *   5. anything else → "unrecognized:<sanitized>"
 */
export function canonicalizeLabel(rawLabel: string): string {
  if (rawLabel === null || rawLabel === undefined || rawLabel.trim() === "") {
    return "unrecognized:empty";
  }
  const lowered = rawLabel.trim().toLowerCase();
  if (KNOWN_CANONICAL.has(lowered) || CANONICAL_LABEL_REGEX.test(lowered)) {
    return lowered;
  }
  // eslint-disable-next-line security/detect-object-injection -- read-only lookup in a frozen const map; `lowered` is a normalized label, guarded by the `!== undefined` check below
  const mapped = RECOGNITION_MAP[lowered];
  if (mapped !== undefined) {
    return mapped;
  }
  // Python: re.match(r"^([a-z][a-z0-9_]*?)v(\d+)$", lowered)
  if (/^[a-z][a-z0-9_]*?v\d+$/.test(lowered)) {
    return `version:${lowered}`;
  }
  // Python: re.sub(r"[^a-z0-9_-]", "_", lowered)
  let safe = lowered.replace(/[^a-z0-9_-]/g, "_");
  // Python: `not safe or not safe[0].isalpha()` — first char must be an ASCII letter.
  if (safe === "" || !/^[a-z]/.test(safe)) {
    safe = safe !== "" ? `x_${safe}` : "x";
  }
  return `unrecognized:${safe}`;
}

function canonicalizeLabelTuple(labels: ReadonlyArray<string>): Array<string> {
  return labels.map((label) => canonicalizeLabel(String(label)));
}

// ── ModelOverridesV1 ─────────────────────────────────────────────────────────
// Per-purpose model selection overrides. ConfigDict(extra="forbid", frozen=True) → .strict().
export const ModelOverridesV1 = z
  .object({
    review_finding: z.string().max(80).nullable().default(null),
    walkthrough: z.string().max(80).nullable().default(null),
    curate_finding: z.string().max(80).nullable().default(null),
  })
  .strict();
export type ModelOverridesV1 = z.infer<typeof ModelOverridesV1>;

// ── ConfluenceKnowledgeBlockV1 ───────────────────────────────────────────────
// include_labels can only NARROW the platform set; exclude_labels removes. Both are
// canonicalized at parse time (Python @field_validator mode="before"). .strict() = extra=forbid.
//
// The Python validator runs BEFORE field validation, accepts None → (), and rejects non-list/tuple
// input with "must be a list of strings". We model that as: preprocess None→[], reject non-arrays,
// canonicalize each element, then cap at 50.
const labelField = z.preprocess(
  (raw) => {
    if (raw === null || raw === undefined) return [];
    if (!Array.isArray(raw)) return raw; // let the inner array schema raise (mirrors "must be a list")
    return canonicalizeLabelTuple(raw as ReadonlyArray<string>);
  },
  z.array(z.string()).max(50),
);

export const ConfluenceKnowledgeBlockV1 = z
  .object({
    include_labels: labelField.default([]),
    exclude_labels: labelField.default([]),
  })
  .strict();
export type ConfluenceKnowledgeBlockV1 = z.infer<typeof ConfluenceKnowledgeBlockV1>;

// ── KnowledgeConfigV1 ────────────────────────────────────────────────────────
// Customer-supplied policy-file discovery patterns (Sprint 25 / A-7). extra=forbid → .strict().
// @field_validator `_reject_path_escape` re-authored as .superRefine().
export const KnowledgeConfigV1 = z
  .object({
    enabled: z.boolean().default(true),
    file_patterns: z.array(z.string()).max(MAX_KNOWLEDGE_FILE_PATTERNS).default([]),
    // Shared frozen default instance ModelOverridesV1()/ConfluenceKnowledgeBlockV1() → nested default.
    confluence: ConfluenceKnowledgeBlockV1.default({ include_labels: [], exclude_labels: [] }),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Port of _reject_path_escape: reject absolute / ".."-segment / over-long patterns.
    v.file_patterns.forEach((pattern, i) => {
      if (pattern.startsWith("/")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["file_patterns", i],
          message: `absolute pattern not allowed: ${JSON.stringify(pattern)}`,
        });
      }
      if (pattern.split("/").includes("..")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["file_patterns", i],
          message: `pattern with '..' segment not allowed: ${JSON.stringify(pattern)}`,
        });
      }
      if (pattern.length > MAX_KNOWLEDGE_PATTERN_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["file_patterns", i],
          message: `pattern exceeds ${MAX_KNOWLEDGE_PATTERN_CHARS}-char limit (${pattern.length} chars)`,
        });
      }
    });
  });
export type KnowledgeConfigV1 = z.infer<typeof KnowledgeConfigV1>;

// ── PathInstructionV1 ────────────────────────────────────────────────────────
// One per-glob team-rule entry (ADR-0001 / S10.0.1). extra=forbid → .strict().
export const PathInstructionV1 = z
  .object({
    path: z.string().min(1).max(200),
    instructions: z.string().min(1).max(2000),
  })
  .strict();
export type PathInstructionV1 = z.infer<typeof PathInstructionV1>;

// ── CodemasterConfigV1 ───────────────────────────────────────────────────────
// Frozen .codemaster.yaml configuration (per repo / org / global). extra=forbid → .strict().
// @field_validator `_validate_path_filters` re-authored as .superRefine().
//
// schema_version is a plain Python `int` (default 1), NOT Literal[1]: it accepts e.g. 2 and
// re-emits it, so z.literal(1) would FALSELY reject and break parity → z.number().int().default(1).
export const CodemasterConfigV1 = z
  .object({
    schema_version: z.number().int().default(1),
    enabled: z.boolean().default(true),
    severity_min: Severity.default("nit"),
    // DEPRECATED — superseded by path_filters. default_factory=tuple → .default([]).
    ignore_paths: z.array(z.string()).default([]),
    path_filters: z.array(z.string()).max(MAX_PATH_FILTERS).default([]),
    max_findings_per_file: z.number().int().gte(1).lte(100).default(10),
    max_findings_per_review: z.number().int().gte(1).lte(500).default(50),
    // Shared frozen default instance ModelOverridesV1() → nested default.
    model_overrides: ModelOverridesV1.default({
      review_finding: null,
      walkthrough: null,
      curate_finding: null,
    }),
    enabled_tools: z.array(ToolName).default([]),
    path_instructions: z.array(PathInstructionV1).default([]),
    // Shared frozen default instance KnowledgeConfigV1() → nested default.
    knowledge: KnowledgeConfigV1.default({
      enabled: true,
      file_patterns: [],
      confluence: { include_labels: [], exclude_labels: [] },
    }),
    // policy: dict[str, Any] | None = None — reserved-for-v2 opaque block.
    policy: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Port of _validate_path_filters: strip a leading '!' (exclude marker), then reject
    // ".."-segment patterns and over-long raw entries.
    v.path_filters.forEach((raw, i) => {
      const pattern = raw.startsWith("!") ? raw.slice(1) : raw;
      if (pattern.split("/").includes("..")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["path_filters", i],
          message: `path_filter with '..' segment not allowed: ${JSON.stringify(raw)}`,
        });
      }
      if (raw.length > MAX_PATH_FILTER_PATTERN_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["path_filters", i],
          message: `path_filter exceeds ${MAX_PATH_FILTER_PATTERN_CHARS}-char limit (${raw.length} chars)`,
        });
      }
    });
  });
export type CodemasterConfigV1 = z.infer<typeof CodemasterConfigV1>;
