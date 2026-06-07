// precedence — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/precedence.py (Sub-spec B T7).
//
// Pure-function module. Three responsibilities:
//   1. `priorityTier(chunk)`  — classify a retrieved chunk into one of five priority tiers
//      (SECURITY_POLICY < REPO_ADR < FRAMEWORK_GUIDANCE < LANG_GUIDANCE < DEFAULT_ONLY).
//   2. `deriveAuthority(tier)` — map tier → authority class for the `<knowledge authority="...">`
//      prompt attribute. SECURITY_POLICY is mandatory; REPO_ADR authoritative; everything else advisory.
//   3. `deriveDocType(labels, source, docKind)` — derive the `<knowledge doc_type="...">` attribute.
//
// All three are deterministic. The LLM does NOT see priorityTier (consumed by the orchestrator); it
// DOES see authority + docType via the prompt wrapper.
//
// Consumer shape: precedence works on any object with the structural shape
// `(labels: ReadonlyArray<string>, source: string, doc_kind: string | null)`. KnowledgeChunkV1 (after
// T11) satisfies it; the confluence-retrieval row shape satisfies it too.

/**
 * Tier ordering: lower wins (1 = highest priority). Python `PriorityTier(IntEnum)` — the numeric
 * values are load-bearing (floors iterates `_FLOOR_TIERS` and consumers compare by ordinal), so the
 * TS port preserves them as a `const` object of numeric ordinals (NOT a string enum).
 */
export const PriorityTier = {
  SECURITY_POLICY: 1,
  REPO_ADR: 2,
  FRAMEWORK_GUIDANCE: 3,
  LANG_GUIDANCE: 4,
  DEFAULT_ONLY: 5,
} as const;
export type PriorityTier = (typeof PriorityTier)[keyof typeof PriorityTier];

/** Reverse map ordinal → name (Python `PriorityTier.name`). Used for the starvation-tier rendering. */
export const PRIORITY_TIER_NAME: Readonly<Record<PriorityTier, string>> = {
  [PriorityTier.SECURITY_POLICY]: "SECURITY_POLICY",
  [PriorityTier.REPO_ADR]: "REPO_ADR",
  [PriorityTier.FRAMEWORK_GUIDANCE]: "FRAMEWORK_GUIDANCE",
  [PriorityTier.LANG_GUIDANCE]: "LANG_GUIDANCE",
  [PriorityTier.DEFAULT_ONLY]: "DEFAULT_ONLY",
};

/** Python `Authority = Literal["mandatory", "authoritative", "advisory"]`. */
export type Authority = "mandatory" | "authoritative" | "advisory";

/** Python `DocType` literal. */
export type DocType =
  | "security_policy"
  | "adr"
  | "framework_guidance"
  | "language_guidance"
  | "general_best_practice";

/**
 * Structural shape precedence operates on (Python `_PriorityClassifiable` Protocol).
 * KnowledgeChunkV1 (after T11) satisfies it; the confluence-retrieval row dataclass also satisfies it.
 */
export type PriorityClassifiable = {
  labels: ReadonlyArray<string>;
  source: string;
  doc_kind: string | null;
};

/**
 * Classify a chunk into a priority tier (1:1 with the Python `priority_tier`).
 *
 * Spec §3.4 line 638-651 verbatim:
 *   1. If `topic:security_policy` in labels → SECURITY_POLICY.
 *   2. Else if source == 'repo_knowledge' AND doc_kind == 'adr' → REPO_ADR.
 *   3. Else if any label starts with `framework:` → FRAMEWORK_GUIDANCE.
 *   4. Else if any label starts with `lang:` → LANG_GUIDANCE.
 *   5. Else → DEFAULT_ONLY.
 */
export function priorityTier(chunk: PriorityClassifiable): PriorityTier {
  const labels = chunk.labels;
  if (labels.includes("topic:security_policy")) {
    return PriorityTier.SECURITY_POLICY;
  }
  if (chunk.source === "repo_knowledge" && chunk.doc_kind === "adr") {
    return PriorityTier.REPO_ADR;
  }
  if (labels.some((label) => label.startsWith("framework:"))) {
    return PriorityTier.FRAMEWORK_GUIDANCE;
  }
  if (labels.some((label) => label.startsWith("lang:"))) {
    return PriorityTier.LANG_GUIDANCE;
  }
  return PriorityTier.DEFAULT_ONLY;
}

/** Tier → authority static mapping (Python `_TIER_TO_AUTHORITY`). */
const TIER_TO_AUTHORITY: Readonly<Record<PriorityTier, Authority>> = {
  [PriorityTier.SECURITY_POLICY]: "mandatory",
  [PriorityTier.REPO_ADR]: "authoritative",
  [PriorityTier.FRAMEWORK_GUIDANCE]: "advisory",
  [PriorityTier.LANG_GUIDANCE]: "advisory",
  [PriorityTier.DEFAULT_ONLY]: "advisory",
};

/** Map `PriorityTier` → authority class for the prompt frame (1:1 with `derive_authority`). */
export function deriveAuthority(tier: PriorityTier): Authority {
  // eslint-disable-next-line security/detect-object-injection -- read-only lookup in a frozen const map keyed by the typed PriorityTier enum (a closed numeric set), not user input
  return TIER_TO_AUTHORITY[tier];
}

/**
 * Derive the doc_type attribute the LLM sees for a chunk (1:1 with `derive_doc_type`).
 *
 * Decision order (first match wins):
 *   1. `topic:security_policy` in labels → `security_policy`
 *   2. doc_kind == 'adr' → `adr`
 *   3. any framework:* label → `framework_guidance`
 *   4. any lang:* label → `language_guidance`
 *   5. otherwise → `general_best_practice`
 *
 * `source` is currently unused for derivation (reserved for future doc_type families) — matches the
 * Python `_ = source`.
 */
export function deriveDocType(
  labels: Iterable<string>,
  source: string,
  docKind: string | null = null,
): DocType {
  void source;
  const labelSet = new Set(labels);
  if (labelSet.has("topic:security_policy")) {
    return "security_policy";
  }
  if (docKind === "adr") {
    return "adr";
  }
  for (const label of labelSet) {
    if (label.startsWith("framework:")) {
      return "framework_guidance";
    }
  }
  for (const label of labelSet) {
    if (label.startsWith("lang:")) {
      return "language_guidance";
    }
  }
  return "general_best_practice";
}
