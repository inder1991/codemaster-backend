import { z } from "zod";

// Zod port of the `InstallationAccessTokenResponseV1` Pydantic model defined in the frozen Python
// module `contracts/integrations/github_app/v1.py` (Sprint 15 / S15.X-token-provider). This is the
// RESPONSE envelope for GitHub's `POST /app/installations/{id}/access_tokens` endpoint — the full
// shape GitHub sends, including `permissions` + `repository_selection` we validate on the wire but
// don't currently cache. (The CACHE envelope — just token + expires_at — is `installation_token.v1`.)
// Parity-validated in installation_access_token_response.v1.parity.test.ts.
//
// Source members ported (every field on the Python model), and the model_config mapping:
//   - model_config = ConfigDict(extra="ignore", frozen=True)
//       → Zod's DEFAULT behavior is `.strip()` (DROP unknown keys), which is the 1:1 analogue of
//         Pydantic `extra="ignore"`. So we use NEITHER `.strict()` (which REJECTS unknowns — that is
//         `extra="forbid"`) NOR `.passthrough()` (which KEEPS unknowns — that is `extra="allow"`).
//         GitHub's real response carries fields we don't consume (single_file_paths,
//         has_multiple_single_files, …); `.strip()` tolerates and drops them exactly like the Python
//         side. (frozen is a Python-only immutability flag with no Zod analogue; the inferred type
//         below is structurally read-only at use sites.)
//   - schema_version: int = 1                  → z.number().int().default(1) (PLAIN int default).
//   - token: str = Field(min_length=1)         → z.string().min(1) (empty-string guard; this model has
//                                                 NO whitespace-only @field_validator, unlike the cache
//                                                 envelope, so we do NOT add a .refine here).
//   - expires_at: datetime                     → z.string().datetime({ offset: true, local: true }).
//     A PLAIN `datetime` field (no `_require_tz` AfterValidator), so the Python side ACCEPTS a naive
//     (offset-less) value too — `{ local: true }` matches that permissiveness. Pydantic dumps the value
//     via isoformat (a Z-bearing aware value dumps as `...Z`); the parity canonicalizer normalizes both
//     `Z` and `+00:00` to `.ffffff+00:00` so the instant compares equal.
//   - permissions: dict[str, str] = Field(default_factory=dict)
//                                              → z.record(z.string(), z.string()).default({}).
//   - repository_selection: Literal["all", "selected"] | None = None
//                                              → z.enum(["all", "selected"]).nullable().default(null).

// InstallationAccessTokenResponseV1 — the GitHub installation-access-token RESPONSE envelope.
export const InstallationAccessTokenResponseV1 = z.object({
  schema_version: z.number().int().default(1),
  token: z.string().min(1),
  expires_at: z.string().datetime({ offset: true, local: true }),
  permissions: z.record(z.string(), z.string()).default({}),
  repository_selection: z.enum(["all", "selected"]).nullable().default(null),
});
// Default Zod object behavior is `.strip()` → drops unknown keys (extra="ignore" parity).
export type InstallationAccessTokenResponseV1 = z.infer<
  typeof InstallationAccessTokenResponseV1
>;
