import { afterAll, describe, expect, it } from "vitest";

import { canonicalize } from "./canonical.js";
import {
  pyAssemblePrompt,
  shutdownPromptAssemblerRef,
  type AssembledDict,
  type AssemblePromptInput,
} from "./prompt_assembler_oracle.js";
import { assemblePrompt, resetRankCache } from "#backend/review/prompt_assembler.js";
import { AssembledPromptV1 } from "#contracts/assembled_prompt.v1.js";
import { ResolvedGuidanceBundleV1 } from "#contracts/resolved_guidance.v1.js";
import { ScoredKnowledgeChunkV1 } from "#contracts/knowledge_chunks.v1.js";

afterAll(() => shutdownPromptAssemblerRef());

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Tier-1 parity: prove the TS port of the frozen Python `assemble_prompt`
// (vendor/codemaster-py/codemaster/review/prompt_assembler.py) is byte-equal to the source-of-truth
// over adversarial budget cases.
//
// `assemble_prompt` takes CONSTRUCTED Pydantic models (ResolvedGuidanceBundleV1 + a tuple of
// ScoredKnowledgeChunkV1), so a DEDICATED driver (run_prompt_assembler_ref.py + prompt_assembler_oracle.ts)
// drives the frozen function — mirroring the policy / redact subsystems.
//
// The AssembledPromptV1 envelope embeds ScoredKnowledgeChunkV1 in `knowledge_blocks`, which carries a
// BARE float `score` AND a nested KnowledgeChunkV1.age_days bare float. The repo canonicalizer
// (test/parity/canonical.ts) REJECTS bare floats (Python emits `1.0` / `0.0`; JS emits `1` / `0`
// divergently for integral values), so those nested float columns are STRIPPED before the canonical
// diff (then the structural shape survives). policy_blocks / dropped_policy_rules / forced_rules
// (DedupedRuleV1) are float-free and byte-round-trip fully.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

// Lowercase UUIDs — Pydantic dumps UUIDs lowercase, so the nested-chunk payloads must be lowercase for
// a byte-equal canonical compare.
const IID = "00000000-0000-0000-0000-000000000002";
const RID = "00000000-0000-0000-0000-000000000003";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let ruleSeq = 0;
let chunkSeq = 0;

/** Build a wire-shape ExtractedRuleV1 dict. */
function buildRule(args: {
  rule_id?: string;
  category: string;
  intent: string;
  priority: number;
  scope_dir?: string;
  body?: string;
}): Rec {
  const rid = args.rule_id ?? `rule-${ruleSeq++}`;
  return {
    schema_version: 1,
    rule_id: rid,
    normalized_hash: HASH_A,
    source_file: "CLAUDE.md",
    source_file_sha256: HASH_B,
    scope_dir: args.scope_dir ?? "",
    heading_path: [],
    rule_index: 0,
    title: "t",
    body: args.body ?? "rule body",
    category: args.category,
    intent: args.intent,
    priority: args.priority,
    oversized_rule_warning: false,
  };
}

/** Build a wire-shape DedupedRuleV1 dict (canonical rule is its own single source). */
function buildDeduped(rule: Rec): Rec {
  return { schema_version: 1, rule, sources: [rule] };
}

/** Build a wire-shape ResolvedGuidanceBundleV1 dict. resolution_explanation parallels applicable_rules. */
function buildBundle(rules: ReadonlyArray<Rec>): Rec {
  return {
    schema_version: 1,
    changed_path: "src/x.py",
    applicable_rules: rules.map(buildDeduped),
    resolution_explanation: rules.map((_, i) => `explain ${i}`),
  };
}

/** Build a wire-shape ScoredKnowledgeChunkV1 dict (placeholder score=1.0, stage=rrf, as the budget
 * path wraps bare KnowledgeChunkV1). */
function buildScored(body: string): Rec {
  const cid = `00000000-0000-0000-0000-${String(++chunkSeq).padStart(12, "0")}`;
  return {
    schema_version: 1,
    chunk: {
      chunk_id: cid,
      installation_id: IID,
      repo_id: RID,
      relative_path: `docs/adr/${chunkSeq}.md`,
      chunk_index: 0,
      body,
      doc_kind: "adr",
    },
    score: 1.0,
    stage: "rrf",
  };
}

// Strip the bare-float columns that ride inside each knowledge_blocks ScoredKnowledgeChunkV1 entry: the
// top-level `score` and the nested `chunk.age_days`. Run identically on both sides so only the
// byte-round-trippable columns survive into the canonical diff.
function stripScored(scored: unknown): unknown {
  if (scored && typeof scored === "object") {
    const s = { ...(scored as Rec) };
    delete s.score;
    if (s.chunk && typeof s.chunk === "object") {
      const c = { ...(s.chunk as Rec) };
      delete c.age_days;
      s.chunk = c;
    }
    return s;
  }
  return scored;
}

/** Re-canonicalize an AssembledPromptV1 object after dropping every nested float column. Only the
 * knowledge_blocks tuple carries floats; policy/dropped/forced (DedupedRuleV1) are float-free. */
function stripFloats(o: unknown): string {
  const obj = { ...(o as Rec) };
  if (Array.isArray(obj.knowledge_blocks)) {
    obj.knowledge_blocks = obj.knowledge_blocks.map(stripScored);
  }
  return canonicalize(obj);
}

/** Drive the TS assembler over the SAME wire input the Python driver receives. Parses the wire dicts
 * through the Zod contracts first (mirrors the driver's `ResolvedGuidanceBundleV1(**dict)` /
 * `ScoredKnowledgeChunkV1(**dict)` reconstruction, adding schema_version defaults), then runs the
 * pure assembler, then re-parses the output through AssembledPromptV1 to mirror the Python
 * `model_dump(mode="json")` wire shape. */
function tsAssemble(input: AssemblePromptInput): AssembledDict {
  const bundle =
    input.policy_bundle !== null ? ResolvedGuidanceBundleV1.parse(input.policy_bundle) : null;
  const knowledge = input.knowledge_results.map((k) => ScoredKnowledgeChunkV1.parse(k));
  const assembled = assemblePrompt({
    policyBundle: bundle,
    knowledgeResults: knowledge,
    ...(input.total_budget_tokens !== undefined
      ? { totalBudgetTokens: input.total_budget_tokens }
      : {}),
    ...(input.policy_max_tokens !== undefined
      ? { policyMaxTokens: input.policy_max_tokens }
      : {}),
  });
  // Re-parse to apply contract defaults + match the Python model_dump wire shape exactly.
  return AssembledPromptV1.parse(assembled) as unknown as AssembledDict;
}

// A long body whose estimate_tokens cost exceeds a tight per-rule budget. 1200 ASCII chars → ~300
// tokens + 20 overhead. Used to force budget pressure.
const LONG_BODY = "x".repeat(1200);
// ~975 tokens — capped under MAX_RULE_BODY_CHARS (4000); combined with a tight total budget it fills
// the whole budget so no knowledge fits (the starvation case).
const HUGE_BODY = "y".repeat(3900);

// ─── Adversarial parity cases ─────────────────────────────────────────────────────────────────────
const CASES: ReadonlyArray<{ name: string; input: AssemblePromptInput }> = [
  // Empty bundle — None policy, no knowledge. All-zero counters; empty tuples.
  {
    name: "empty bundle (null policy, no knowledge)",
    input: { policy_bundle: null, knowledge_results: [] },
  },
  // Empty applicable_rules bundle (non-null but empty).
  {
    name: "non-null bundle with zero rules",
    input: { policy_bundle: buildBundle([]), knowledge_results: [] },
  },
  // Happy path within budget — a few rules + a few chunks, nothing drops.
  {
    name: "within budget (no drops)",
    input: {
      policy_bundle: buildBundle([
        buildRule({ category: "style", intent: "recommend", priority: 20, body: "small" }),
        buildRule({ category: "testing", intent: "require", priority: 60, body: "small2" }),
      ]),
      knowledge_results: [buildScored("k1"), buildScored("k2")],
    },
  },
  // Over-budget policy: many security/forbid rules whose combined cost exceeds a TINY policy cap →
  // forced-include path (security/forbid never drop; budget exceeded; forced_include_count rises).
  {
    name: "over-budget policy → forced-include security/forbid rules exceed the cap",
    input: {
      policy_bundle: buildBundle([
        buildRule({ category: "security", intent: "forbid", priority: 100, body: LONG_BODY }),
        buildRule({ category: "security", intent: "require", priority: 100, body: LONG_BODY }),
        buildRule({ category: "architecture", intent: "forbid", priority: 80, body: LONG_BODY }),
        // A droppable rule (style/recommend) that WILL drop under the tiny cap.
        buildRule({ category: "style", intent: "recommend", priority: 20, body: LONG_BODY }),
      ]),
      knowledge_results: [buildScored("k1")],
      policy_max_tokens: 50,
      total_budget_tokens: 100,
    },
  },
  // Knowledge starvation: policy fills the WHOLE total budget (huge rule, ~975 tokens), so no
  // knowledge fits. total budget lowered to 900 < the rule's ~995 cost so remaining goes negative and
  // every chunk drops.
  {
    name: "knowledge starvation (policy fills the whole budget)",
    input: {
      policy_bundle: buildBundle([
        buildRule({ category: "security", intent: "forbid", priority: 100, body: HUGE_BODY }),
      ]),
      knowledge_results: [buildScored("k1"), buildScored("k2"), buildScored("k3")],
      total_budget_tokens: 900,
      policy_max_tokens: 3000,
    },
  },
  // Exactly-at-cap: a single rule whose cost === policy_max_tokens exactly (boundary: kept, not forced).
  // body of 120 ASCII chars → estimate_tokens = trunc(120/4)=30; +20 overhead = 50. Cap = 50.
  {
    name: "exactly-at-cap (rule cost === policy_max_tokens, kept not forced)",
    input: {
      policy_bundle: buildBundle([
        buildRule({ category: "style", intent: "recommend", priority: 20, body: "z".repeat(120) }),
      ]),
      knowledge_results: [],
      policy_max_tokens: 50,
      total_budget_tokens: 60,
    },
  },
  // Knowledge exactly-at-remaining boundary: one chunk fits exactly into remaining; the next is one
  // token over and drops. chunk body 160 chars → trunc(160/4)=40 +10 = 50.
  {
    name: "knowledge boundary (one fits exactly, next drops)",
    input: {
      policy_bundle: null,
      knowledge_results: [buildScored("a".repeat(160)), buildScored("b".repeat(160))],
      total_budget_tokens: 50,
    },
  },
  // Ties in the rank key: two rules with IDENTICAL (intent, category, priority, scope_dir) → stable
  // input order must be preserved. Distinct bodies make order observable in the output tuple.
  {
    name: "rank-key ties preserve stable input order",
    input: {
      policy_bundle: buildBundle([
        buildRule({ rule_id: "tie-first", category: "testing", intent: "require", priority: 60, body: "first" }),
        buildRule({ rule_id: "tie-second", category: "testing", intent: "require", priority: 60, body: "second" }),
        buildRule({ rule_id: "tie-third", category: "testing", intent: "require", priority: 60, body: "third" }),
      ]),
      knowledge_results: [],
    },
  },
  // Full rank ordering across all intents + categories + priorities + scope_dir lengths. Exercises
  // every level of the 4-tuple key. Shuffled input order; output must be the canonical ranked order.
  {
    name: "full rank ordering (intent → category → -priority → -len(scope_dir))",
    input: {
      policy_bundle: buildBundle([
        buildRule({ rule_id: "r-style-rec", category: "style", intent: "recommend", priority: 20 }),
        buildRule({ rule_id: "r-sec-forbid-deep", category: "security", intent: "forbid", priority: 100, scope_dir: "a/b/c/deep" }),
        buildRule({ rule_id: "r-sec-forbid-root", category: "security", intent: "forbid", priority: 100, scope_dir: "" }),
        buildRule({ rule_id: "r-arch-req", category: "architecture", intent: "require", priority: 80 }),
        buildRule({ rule_id: "r-perf-rec", category: "performance", intent: "recommend", priority: 50 }),
        buildRule({ rule_id: "r-test-forbid", category: "testing", intent: "forbid", priority: 60 }),
      ]),
      knowledge_results: [],
    },
  },
  // Explicit budget overrides at non-default values (1000 / 600).
  {
    name: "custom budget overrides (total=1000, policy_max=600)",
    input: {
      policy_bundle: buildBundle([
        buildRule({ category: "security", intent: "forbid", priority: 100, body: "x".repeat(400) }),
        buildRule({ category: "style", intent: "recommend", priority: 20, body: "x".repeat(2000) }),
      ]),
      knowledge_results: [buildScored("k".repeat(400)), buildScored("k".repeat(400))],
      total_budget_tokens: 1000,
      policy_max_tokens: 600,
    },
  },
];

describe("prompt_assembler assemble_prompt parity (Pydantic ↔ TS)", () => {
  it.each(CASES)("byte-matches the frozen Python: $name", async (c) => {
    resetRankCache();
    const py = await pyAssemblePrompt(c.input);
    const ts = tsAssemble(c.input);
    // Strip the nested bare-float columns (knowledge_blocks[*].score + .chunk.age_days) on both sides,
    // then byte-compare the full AssembledPromptV1 envelope (policy_blocks / knowledge_blocks /
    // dropped_policy_rules / forced_rules / all counters).
    expect(stripFloats(ts)).toBe(stripFloats(py));
  }, 30_000);

  // The 256-entry rank cache: feeding the SAME bundle twice must yield byte-identical output (cache
  // hit on the second call), and a third DISTINCT bundle must still rank correctly. The cache is a
  // pure perf memo — it can never change the output value.
  it("256-entry rank cache: repeated bundle yields identical output; distinct bundle still ranks", async () => {
    resetRankCache();
    const bundle = buildBundle([
      buildRule({ rule_id: "c-a", category: "style", intent: "recommend", priority: 20 }),
      buildRule({ rule_id: "c-b", category: "security", intent: "forbid", priority: 100 }),
    ]);
    const input: AssemblePromptInput = { policy_bundle: bundle, knowledge_results: [] };
    const py = await pyAssemblePrompt(input);
    const first = tsAssemble(input);
    const second = tsAssemble(input); // cache HIT — same rule_id tuple key
    expect(stripFloats(first)).toBe(stripFloats(second));
    expect(stripFloats(first)).toBe(stripFloats(py));

    // A distinct bundle (different rule_ids) must still produce the correct ranked order.
    const bundle2 = buildBundle([
      buildRule({ rule_id: "d-x", category: "testing", intent: "require", priority: 60 }),
      buildRule({ rule_id: "d-y", category: "security", intent: "forbid", priority: 100 }),
    ]);
    const input2: AssemblePromptInput = { policy_bundle: bundle2, knowledge_results: [] };
    const py2 = await pyAssemblePrompt(input2);
    const ts2 = tsAssemble(input2);
    expect(stripFloats(ts2)).toBe(stripFloats(py2));
  }, 30_000);
});
