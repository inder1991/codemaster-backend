import { z } from "zod";

// Zod port of contracts/analysis_findings/v1.py (frozen Python). Parity-validated in
// analysis_findings.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - Tool             (Python Literal)               → z.enum
//  - AnalysisFindingV1(ConfigDict extra=forbid, frozen) → .strict() + one
//    @model_validator(mode="after") re-authored as .superRefine(): _check_line_range.
//
// NOTE on `finding_id`: the Python contract types it as a REQUIRED `uuid.UUID` (no
// default_factory — ADR-0031 workflow-boundary contract purity removed the
// `default_factory=uuid.uuid4` that tripped the Temporal sandbox). Pydantic
// `model_dump(mode="json")` emits the canonical LOWERCASE UUID string, so the wire shape is a
// UUID string. Zod `.uuid()` accepts upper/lower but does NOT lowercase on parse — keep parity
// payloads canonical-lowercase to avoid a spurious diff.

// Tool = Literal[...] — locked set of supported static-analysis tool identifiers.
export const Tool = z.enum([
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
]);
export type Tool = z.infer<typeof Tool>;

// AnalysisFindingV1 — ConfigDict(extra="forbid", frozen=True) → .strict().
// One @model_validator(mode="after") re-authored below as .superRefine(): _check_line_range.
export const AnalysisFindingV1 = z
  .object({
    // schema_version is a bare `int` defaulting to 1 — NOT a z.literal (that would false-reject
    // a future schema_version=2 envelope).
    schema_version: z.number().int().default(1),
    // finding_id: uuid.UUID — REQUIRED (no default). uuid.UUID → canonical lowercase string.
    finding_id: z.string().uuid(),
    tool: Tool,
    rule_id: z.string().min(1).max(200),
    file: z.string().min(1),
    start_line: z.number().int().gte(1),
    end_line: z.number().int().gte(1),
    severity_raw: z.string().min(1).max(50),
    message: z.string().min(1).max(2000),
    fix_suggestion: z.string().nullable().default(null),
  })
  .strict()
  // @model_validator(mode="after") _check_line_range: end_line >= start_line.
  .superRefine((v, ctx) => {
    if (v.end_line < v.start_line) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_line"],
        message: `end_line (${v.end_line}) must be >= start_line (${v.start_line})`,
      });
    }
  });
export type AnalysisFindingV1 = z.infer<typeof AnalysisFindingV1>;
