import { z } from "zod";

// Zod port of contracts/extracted_rules/v1.py (frozen Python, Sprint 25 / A-2).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in extracted_rules.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - MAX_RULE_BODY_CHARS         (Final int)             → const
//  - MAX_HEADING_PATH_DEPTH      (Final int)             → const
//  - RuleCategory                (Python Literal)        → z.enum
//  - RuleIntent                  (Python Literal)        → z.enum
//  - DEFAULT_PRIORITY_BY_CATEGORY(Final dict)            → as-const record
//  - ExtractedRuleV1             (ConfigDict extra=forbid, frozen) → .strict()
// No @model_validator / @field_validator on the source model — straight field port. No bare floats,
// no UUID fields (rule_id + the two sha256 hashes are plain strings).

// Per-rule body cap. Rules over 4000 chars are flagged with oversized_rule_warning=True.
export const MAX_RULE_BODY_CHARS = 4000;

// Max heading-path depth carried per rule (mirrors chunk_markdown MAX_HEADING_DEPTH).
export const MAX_HEADING_PATH_DEPTH = 3;

// RuleCategory = Literal["security", "architecture", "testing", "performance", "style"]
export const RuleCategory = z.enum(["security", "architecture", "testing", "performance", "style"]);
export type RuleCategory = z.infer<typeof RuleCategory>;

// RuleIntent = Literal["require", "recommend", "forbid"]
export const RuleIntent = z.enum(["require", "recommend", "forbid"]);
export type RuleIntent = z.infer<typeof RuleIntent>;

// DEFAULT_PRIORITY_BY_CATEGORY — hardcoded priority by category (higher = wins at same scope depth).
export const DEFAULT_PRIORITY_BY_CATEGORY: Readonly<Record<RuleCategory, number>> = {
  security: 100,
  architecture: 80,
  testing: 60,
  performance: 50,
  style: 20,
} as const;

// ExtractedRuleV1 — one rule extracted from a GuidelineFileV1.
//  - schema_version: int = 1                → z.number().int().default(1)
//    (Python field is a plain `int` with default 1, NOT Literal[1] — it accepts e.g. 2 and re-emits it;
//     z.literal(1) would FALSELY reject and break parity.)
//  - rule_id: Field(min_length=1, max_length=200)        → z.string().min(1).max(200)
//  - normalized_hash: Field(min_length=64, max_length=64)→ z.string().min(64).max(64)
//  - source_file: Field(min_length=1, max_length=500)    → z.string().min(1).max(500)
//  - source_file_sha256: Field(min_length=64, max_length=64) → z.string().min(64).max(64)
//  - scope_dir: Field(max_length=500)                    → z.string().max(500) (NO min — empty string OK)
//  - heading_path: tuple[str,...] default_factory=tuple, max_length=3 → z.array(z.string()).max(3).default([])
//  - rule_index: Field(ge=0)                             → z.number().int().gte(0)
//  - title: Field(max_length=500)                        → z.string().max(500) (NO min — empty string OK)
//  - body: Field(min_length=1, max_length=MAX_RULE_BODY_CHARS) → z.string().min(1).max(MAX_RULE_BODY_CHARS)
//  - category: RuleCategory                              → RuleCategory enum
//  - intent: RuleIntent                                  → RuleIntent enum
//  - priority: Field(ge=0, le=200)                       → z.number().int().gte(0).lte(200)
//  - oversized_rule_warning: bool = False                → z.boolean().default(false)
export const ExtractedRuleV1 = z
  .object({
    schema_version: z.number().int().default(1),
    rule_id: z.string().min(1).max(200),
    normalized_hash: z.string().min(64).max(64),
    source_file: z.string().min(1).max(500),
    source_file_sha256: z.string().min(64).max(64),
    scope_dir: z.string().max(500),
    heading_path: z.array(z.string()).max(MAX_HEADING_PATH_DEPTH).default([]),
    rule_index: z.number().int().gte(0),
    title: z.string().max(500),
    body: z.string().min(1).max(MAX_RULE_BODY_CHARS),
    category: RuleCategory,
    intent: RuleIntent,
    priority: z.number().int().gte(0).lte(200),
    oversized_rule_warning: z.boolean().default(false),
  })
  .strict();
export type ExtractedRuleV1 = z.infer<typeof ExtractedRuleV1>;
