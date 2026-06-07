// Taxonomy-suggestion write — 1:1 port of postgres_taxonomy_repo.py insert. Pure DB, no audit, no
// Temporal. Operators propose curating an `unrecognized:*` label; the IDP team triages out-of-band.
//
// 1:1-DIVERGENCE (mint): the Python mints suggestion_id app-side (uuid.uuid4) because the PK has no
// default; the port uses gen_random_uuid() in the INSERT + RETURNING instead (HTTP handler, no replay
// concern) — same outcome, no app-side CSPRNG seam needed.

import { type Kysely, sql } from "kysely";

import type { TaxonomySuggestionAcceptedV1, TaxonomySuggestionV1 } from "#contracts/admin.v1.js";

export async function insertTaxonomySuggestion(
  db: Kysely<unknown>,
  args: { suggestion: TaxonomySuggestionV1; actorUserId: string; now: Date },
): Promise<TaxonomySuggestionAcceptedV1> {
  const s = args.suggestion;
  const r = await sql<{ suggestion_id: string; submitted_at: Date }>`
    INSERT INTO core.taxonomy_suggestions
      (suggestion_id, label, proposed_canonical_label, rationale, suggester_email, submitted_by_user_id, submitted_at)
    VALUES (gen_random_uuid(), ${s.label}, ${s.proposed_canonical_label}, ${s.rationale}, ${s.suggester_email},
            ${args.actorUserId}, ${args.now})
    RETURNING suggestion_id, submitted_at
  `.execute(db);
  const row = r.rows[0]!;
  return {
    schema_version: 1,
    suggestion_id: row.suggestion_id,
    queued_at: row.submitted_at.toISOString(), // queued_at == submitted_at
  };
}
