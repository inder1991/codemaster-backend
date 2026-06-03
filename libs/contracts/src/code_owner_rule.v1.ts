import { z } from "zod";

// Zod port of contracts/code_owner_rule/v1.py::CodeOwnerRuleV1 (frozen Python).
// Pydantic ConfigDict(extra="forbid", frozen=True) → .strict() (frozen is a TS-side concern, not wire).
// Parity-validated in code_owner_rule.v1.parity.test.ts.
//
// Source models / enums / constants ported (every public one):
//  - CodeOwnerRuleV1 (ConfigDict extra="forbid", frozen=True) → .strict().
// No nested models, enums, helper fns, or module-level constants beyond the single model.
//
// Field mapping notes:
//  - schema_version: int = 1 → z.number().int().default(1) (plain int default, NOT z.literal — a
//    z.literal(1) would false-reject schema_version=2 wire payloads).
//  - code_owner_id / installation_id / repository_id: uuid.UUID → z.string().uuid(); Pydantic
//    model_dump(mode="json") lowercases the UUID string, so parity payloads use lowercase UUIDs.
//  - owner_logins: tuple[str, ...] = Field(min_length=1) → z.array(z.string()).min(1). The Python
//    tuple serializes to a JSON array; min_length on the collection becomes z.array(...).min(1).
//  - source_file_sha: str = Field(pattern=...) → z.string().regex(SOURCE_FILE_SHA_PATTERN).
//  - synced_at: datetime | None = None → z.string().datetime({ offset: true }).nullable().default(null);
//    ISO-8601 string on the wire (a non-null datetime equality-diff is harness-asymmetric — see the
//    parity test's accept-only case, mirroring pr_file.v1's created_at handling).

// Mirrors the Python `source_file_sha` Field(pattern=...) — a 40-char lowercase-hex Git blob SHA-1.
export const SOURCE_FILE_SHA_PATTERN = /^[a-f0-9]{40}$/;

export const CodeOwnerRuleV1 = z
  .object({
    schema_version: z.number().int().default(1),
    code_owner_id: z.string().uuid(),
    installation_id: z.string().uuid(),
    repository_id: z.string().uuid(),
    path_pattern: z.string().min(1).max(1024),
    owner_logins: z.array(z.string()).min(1),
    source_file_sha: z.string().regex(SOURCE_FILE_SHA_PATTERN),
    synced_at: z.string().datetime({ offset: true }).nullable().default(null),
  })
  .strict();

export type CodeOwnerRuleV1 = z.infer<typeof CodeOwnerRuleV1>;
