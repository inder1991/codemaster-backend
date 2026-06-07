import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  pyBuildUserMessage,
  pyConstants,
  shutdownReviewPromptRef,
} from "./review_prompt_oracle.js";
import { ReviewContextV1 } from "#contracts/review_context.v1.js";
import {
  ARBITRATION_INTENT_TOOL_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TOOL_SCHEMA,
} from "#backend/llm/review_prompt.js";
import { buildUserMessage } from "#backend/review/prompt_builder.js";

// PARITY-CRITICAL: the review-chunk prompt builder produces the LLM INPUT for bedrock_review_chunk.
// The dual-run replays the recorded LLM interaction keyed on these exact bytes, so a single-char
// drift = a different recorded interaction. This suite proves the TS port is CHAR-FOR-CHAR identical
// to the frozen Python (vendor/codemaster-py) over:
//   1. the static REVIEW_SYSTEM_PROMPT + REVIEW_TOOL_SCHEMA + ARBITRATION_INTENT_TOOL_SCHEMA;
//   2. buildUserMessage over representative ReviewContextV1 inputs — a clean chunk; a rich chunk with
//      retrieved_knowledge + evidence + a multi-file pr_topology manifest exercising all 3 compression
//      tiers; and a chunk whose evidence manifest EXCEEDS the token budget (truncation + footer).
// Both sides operate on the IDENTICAL wire dict: the TS fixture is parsed through the Zod
// ReviewContextV1 (producing the wire shape), serialized to JSON, and `model_validate`d on the Python
// side. The fixtures live ONLY here.

afterAll(() => shutdownReviewPromptRef());

// Canonical lowercase UUIDs (Pydantic lowercases input; Zod .uuid() passes through — keep lowercase).
const PR_ID = "11111111-1111-4111-8111-111111111111";
const INST_ID = "22222222-2222-4222-8222-222222222222";
const REPO_ID = "33333333-3333-4333-8333-333333333333";
const SHA64 = "a".repeat(64);

/** Parse a fixture through the Zod ReviewContextV1 and return the JSON-safe wire dict. */
function wire(input: unknown): unknown {
  const parsed = ReviewContextV1.parse(input);
  // Round-trip through JSON so the object the Python side receives is exactly the wire shape (no
  // Map/Set/undefined; explicit nulls preserved) — identical to what the dual-run transmits.
  return JSON.parse(JSON.stringify(parsed));
}

function chunk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chunk_id: "44444444-4444-4444-8444-444444444444",
    path: "src/app/handler.ts",
    language: "typescript",
    start_line: 10,
    end_line: 22,
    body: "export function handler(req: Request): Response {\n  return new Response('ok');\n}",
    chunk_kind: "function",
    token_estimate: 42,
    ...overrides,
  };
}

// ── Static constants ────────────────────────────────────────────────────────────────────────────

// Warm up the long-lived Python ref process ONCE before any assertion: the cold venv import + first
// request can exceed the default 5s test timeout, and that spawn latency would otherwise land on
// whichever test runs first (a cold-cache flake). Absorbing it here keeps each per-test assertion fast.
beforeAll(async () => {
  await pyConstants();
}, 30_000);

describe("review prompt constants — byte-exact vs frozen Python", () => {
  it("REVIEW_SYSTEM_PROMPT matches char-for-char", async () => {
    const { systemPrompt } = await pyConstants();
    expect(REVIEW_SYSTEM_PROMPT).toBe(systemPrompt);
  });

  it("REVIEW_TOOL_SCHEMA matches (deep structural + key order via JSON)", async () => {
    const { toolSchema } = await pyConstants();
    // Deep-equal (structural). Key ORDER parity is additionally pinned by the JSON.stringify compare
    // below — Python json.dumps + JS JSON.stringify both emit insertion order, so identical byte
    // output proves the property declaration order matches.
    expect(REVIEW_TOOL_SCHEMA).toEqual(toolSchema);
    expect(JSON.stringify(REVIEW_TOOL_SCHEMA)).toBe(JSON.stringify(toolSchema));
  });

  it("ARBITRATION_INTENT_TOOL_SCHEMA matches (deep structural + key order via JSON)", async () => {
    const { arbitrationToolSchema } = await pyConstants();
    expect(ARBITRATION_INTENT_TOOL_SCHEMA).toEqual(arbitrationToolSchema);
    expect(JSON.stringify(ARBITRATION_INTENT_TOOL_SCHEMA)).toBe(JSON.stringify(arbitrationToolSchema));
  });
});

// ── buildUserMessage parity ──────────────────────────────────────────────────────────────────────

describe("buildUserMessage — char-for-char vs frozen _build_user_message", () => {
  it("clean chunk (no knowledge / evidence / manifest / policy / tier1)", async () => {
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Add request handler",
      pr_description: "Introduces the top-level handler.",
      chunk: chunk(),
      policy_revision: 0,
    });
    const [tsOut, pyOut] = await Promise.all([
      Promise.resolve(buildUserMessage(ReviewContextV1.parse(ctx))),
      pyBuildUserMessage(ctx),
    ]);
    expect(tsOut).toBe(pyOut);
  });

  it("clean chunk with language=null (renders 'unknown') + prior findings", async () => {
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Tweak",
      pr_description: "desc",
      chunk: chunk({ language: null }),
      policy_revision: 3,
      prior_findings: [
        {
          file: "src/app/handler.ts",
          start_line: 11,
          end_line: 12,
          severity: "issue",
          category: "bug",
          title: "Missing null check",
          body: "Body text.",
          confidence: 0.9,
        },
      ],
      matched_path_instructions: [
        { path: "src/**", instructions: "Prefer Response.json over new Response." },
      ],
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("rich chunk: knowledge + evidence + tier-1 manifest (tier-1 compression, <=30 paths)", async () => {
    const knowledge = [
      knowledgeChunk("docs/architecture.md", ["Overview", "Goals"], "Architectural overview body."),
      knowledgeChunk("src/app/handler.ts", [], "Handler conventions doc."),
    ];
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Refactor",
      pr_description: "Multi-file refactor.",
      chunk: chunk(),
      policy_revision: 1,
      retrieved_knowledge: knowledge,
      retrieved_evidence: [
        evidence("chunk_body", "src/app/handler.ts", "The handler returns a bare Response."),
        evidence("retrieved_knowledge", "docs/architecture.md", "Goals section excerpt."),
      ],
      pr_topology_manifest: topology([
        ["src/app/handler.ts", "code", 10, 22],
        ["src/app/router.ts", "code", 1, 40],
        ["docs/architecture.md", "doc", 1, 200],
        ["tests/handler.test.ts", "test", 1, 30],
      ]),
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("confluence chunk: locator + full r3 attribute set + inner-<doc>-wrapper strip (T16)", async () => {
    // A security-policy + lang confluence chunk whose body carries the redactor's <doc trust="untrusted">
    // wrapper. Exercises: confluence:<space>/<page> locator, the <knowledge trust="semi" …> attrs
    // (authority=mandatory via topic:security_policy, doc_type, match_specificity=high score 9, freshness),
    // and the inner-wrapper strip. Mixed with a repo chunk to confirm both branches render in one block.
    const knowledge = [
      confluenceChunk(
        "ENG",
        "918273",
        ["topic:security_policy", "lang:python"],
        '<doc trust="untrusted">\nRotate service-account keys every 90 days.\n</doc>',
        { docKind: "adr", matchSpecificityScore: 9, ageDays: 7 },
      ),
      knowledgeChunk("docs/architecture.md", ["Goals"], "Repo architectural overview."),
    ];
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Add auth",
      pr_description: "Auth changes.",
      chunk: chunk(),
      policy_revision: 1,
      retrieved_knowledge: knowledge,
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("tier-2 compression: 31..80 chunks → file inventory", async () => {
    const entries: Array<[string, string, number, number]> = [];
    for (let i = 0; i < 40; i += 1) {
      entries.push([`src/mod_${String(i).padStart(2, "0")}.ts`, "code", 1, 5]);
    }
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Big PR",
      pr_description: "40 files.",
      chunk: chunk({ path: "src/mod_07.ts", chunk_id: "55555555-5555-4555-8555-555555555555" }),
      policy_revision: 0,
      pr_topology_manifest: topology(entries),
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("tier-3 compression: >80 chunks → directory aggregation + cited-path retention", async () => {
    const entries: Array<[string, string, number, number]> = [];
    for (let i = 0; i < 100; i += 1) {
      const dir = i % 3 === 0 ? "src" : i % 3 === 1 ? "lib" : "pkg";
      entries.push([`${dir}/file_${String(i).padStart(3, "0")}.ts`, "code", 1, 5]);
    }
    // A path cited by retrieved knowledge that must survive directory aggregation.
    const citedPath = "lib/file_001.ts";
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Huge PR",
      pr_description: "100 files.",
      chunk: chunk({ path: "src/file_000.ts", chunk_id: "66666666-6666-4666-8666-666666666666" }),
      policy_revision: 0,
      retrieved_knowledge: [knowledgeChunk(citedPath, [], "Cited library doc.")],
      pr_topology_manifest: topology(entries),
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("evidence manifest EXCEEDS token budget → truncation + footer", async () => {
    // ~40 entries each with a long excerpt; the 1500-token budget drops the lower-priority tail and
    // appends the truncation footer. Priority ordering: tool_status entries (lowest) drop first.
    const ev: Array<Record<string, unknown>> = [];
    const longExcerpt = "x".repeat(580);
    for (let i = 0; i < 30; i += 1) {
      ev.push(evidence("chunk_body", `src/file_${i}.ts`, `${longExcerpt} a${i}`));
    }
    for (let i = 0; i < 10; i += 1) {
      ev.push(evidence("tool_status", null, `${longExcerpt} t${i}`));
    }
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Evidence-heavy",
      pr_description: "Big manifest.",
      chunk: chunk(),
      policy_revision: 0,
      retrieved_evidence: ev,
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("tool statuses + tier-1 findings appendix (coverage_fraction float formatting)", async () => {
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Linted",
      pr_description: "With tier-1.",
      chunk: chunk(),
      policy_revision: 0,
      tier1_findings: [
        {
          finding_id: "77777777-7777-4777-8777-777777777777",
          tool: "ruff",
          rule_id: "E501",
          file: "src/app/handler.ts",
          start_line: 11,
          end_line: 11,
          severity_raw: "warning",
          message: "line too long",
        },
        // Different file — filtered out by chunk_file_path.
        {
          finding_id: "88888888-8888-4888-8888-888888888888",
          tool: "eslint",
          rule_id: "no-unused",
          file: "other.ts",
          start_line: 1,
          end_line: 1,
          severity_raw: "error",
          message: "unused",
        },
      ],
      tool_statuses: [
        toolStatus("ruff", "completed", 3, 7), // coverage 0.43
        toolStatus("eslint", "timed_out", 1, 8), // coverage 0.12
        toolStatus("gitleaks", "skipped", 0, 0), // coverage 1.0 (empty set)
        toolStatus("trivy", "completed", 1, 2), // coverage 0.5
      ],
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("coverage_fraction rounding sweep — round(x,2) on the true double, ties-to-even (regression)", async () => {
    // The default fixtures all land on non-divergent ratios; this sweep hits the n/40, n/200 class
    // (where the old x*100 rounding diverged from Python round(x,2)) plus the exact dyadic ties k/8.
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Coverage sweep",
      pr_description: "Exercise round(x,2).",
      chunk: chunk(),
      policy_revision: 0,
      tool_statuses: [
        toolStatus("t_025", "completed", 1, 40), // 0.025 → 0.03 (true double just above midpoint)
        toolStatus("t_075", "completed", 3, 40), // 0.075 → 0.07 (just below)
        toolStatus("t_005", "completed", 1, 200), // 0.005 → 0.01
        toolStatus("t_175", "completed", 7, 40), // 0.175 → 0.17
        toolStatus("t_225", "completed", 9, 40), // 0.225 → 0.23
        toolStatus("t_125", "completed", 1, 8), // 0.125 → 0.12 (dyadic tie, even)
        toolStatus("t_375", "completed", 3, 8), // 0.375 → 0.38 (dyadic tie, odd)
        toolStatus("t_625", "completed", 5, 8), // 0.625 → 0.62 (tie, even)
        toolStatus("t_875", "completed", 7, 8), // 0.875 → 0.88 (tie, odd)
      ],
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  }, 30_000);

  it("consumers block + retrieval degraded", async () => {
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Symbol change",
      pr_description: "Removes a public symbol.",
      chunk: chunk(),
      policy_revision: 0,
      retrieval_degraded: true,
      retrieval_degradation_reason: "dense index timed out",
      removed_or_changed_symbols: [
        {
          target_symbol_id: "99999999-9999-4999-8999-999999999999",
          qualified_name: "app.handler",
          change_kind: "signature_changed",
          new_signature: "(req: Request, ctx: Ctx) => Response",
        },
      ],
      consumer_hits: [
        {
          consumer_repo_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          consumer_relative_path: "svc/caller.ts",
          consumer_line: 14,
          confidence: "high",
          excerpt: "handler(req)",
        },
      ],
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("project manifests block (success + non-success status lines)", async () => {
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Deps",
      pr_description: "Manifest changes.",
      chunk: chunk(),
      policy_revision: 0,
      manifests: [
        {
          path: "package.json",
          raw_body: '{\n  "name": "widgets"\n}',
          fetch_status: "success",
          detected_ecosystem: "npm",
          byte_length: 24,
        },
        {
          path: "go.mod",
          fetch_status: "not_found",
          detected_ecosystem: "go",
        },
        {
          path: "Cargo.toml",
          raw_body: "[package]\nname = \"w\"",
          fetch_status: "truncated",
          byte_length: 1024,
          truncated: true,
        },
      ],
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("policy block (<knowledge trust=semi> + <policy> with html-escaped body + sources footer)", async () => {
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Policy",
      pr_description: "Repo guideline applies.",
      chunk: chunk({ path: "src/app/handler.ts" }),
      policy_revision: 2,
      applicable_policy: {
        changed_path: "src/app/handler.ts",
        applicable_rules: [
          {
            rule: rule("R-1", "src/app", "Never use <eval> & raw new Response().", ["Rules", "Handlers"]),
            sources: [
              rule("R-1", "src/app", "Never use <eval> & raw new Response().", ["Rules", "Handlers"]),
              rule("R-1b", "src", "Duplicate source rule.", ["Other"]),
            ],
          },
          {
            rule: rule("R-2", "", "Root-scoped rule body.", []),
            sources: [rule("R-2", "", "Root-scoped rule body.", [])],
          },
        ],
        resolution_explanation: ["R-1 nearest-ancestor", "R-2 root"],
      },
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  // ── budget_enforcement=true (prompt-budget-enforcement-v1 collapse-on) ──────────────────────────
  // These exercise the now-ported assemble_prompt budget subsystem THROUGH buildUserMessage: the same
  // _apply_budget chain runs on the frozen Python side (the oracle drives _build_user_message, which
  // calls _apply_budget), so a budgeted prompt on both sides must be char-for-char identical. Also
  // proves budget_enforcement=true NO LONGER THROWS (the old stub raised).
  it("budget_enforcement=true: droppable style rule dropped, security/forbid force-included", async () => {
    // A tight per-chunk budget: the policy_max default (3000) is generous, so make the droppable rule
    // huge enough to drop AND a security rule that force-includes. With the default 3000 cap, two
    // ~3900-char bodies can't both fit; the style/recommend one drops, the security/forbid one is
    // force-included over the cap. resolution_explanation projects to the kept rule_ids.
    const securityRule = budgetRule({
      ruleId: "SEC-1",
      scopeDir: "src/app",
      body: "Never call eval() on untrusted input. " + "s".repeat(3800),
      headingPath: ["Security"],
      category: "security",
      intent: "forbid",
      priority: 100,
    });
    const styleRule = budgetRule({
      ruleId: "STY-1",
      scopeDir: "src",
      body: "Prefer composition over inheritance. " + "t".repeat(3800),
      headingPath: ["Style"],
      category: "style",
      intent: "recommend",
      priority: 20,
    });
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Budgeted policy",
      pr_description: "Two large rules; one drops under budget.",
      chunk: chunk({ path: "src/app/handler.ts" }),
      policy_revision: 5,
      budget_enforcement: true,
      applicable_policy: {
        changed_path: "src/app/handler.ts",
        applicable_rules: [
          { rule: securityRule, sources: [securityRule] },
          { rule: styleRule, sources: [styleRule] },
        ],
        resolution_explanation: ["SEC-1 nearest-ancestor", "STY-1 ancestor"],
      },
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("budget_enforcement=true: knowledge starvation (huge policy fills the budget, chunks drop)", async () => {
    // One ~3900-char security/forbid rule (~975 tokens) sits well under the 3000 policy cap, but the
    // knowledge chunks compete for the residual 4000-3000-policy_used budget; large chunks drop.
    const bigRule = budgetRule({
      ruleId: "SEC-FILL",
      scopeDir: "src/app",
      body: "Forbid raw SQL. " + "q".repeat(3800),
      headingPath: ["Security"],
      category: "security",
      intent: "forbid",
      priority: 100,
    });
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Budgeted knowledge",
      pr_description: "Large knowledge chunks compete for residual budget.",
      chunk: chunk({ path: "src/app/handler.ts" }),
      policy_revision: 6,
      budget_enforcement: true,
      applicable_policy: {
        changed_path: "src/app/handler.ts",
        applicable_rules: [{ rule: bigRule, sources: [bigRule] }],
        resolution_explanation: ["SEC-FILL nearest-ancestor"],
      },
      retrieved_knowledge: [
        knowledgeChunk("docs/a.md", ["A"], "a".repeat(5000)),
        knowledgeChunk("docs/b.md", ["B"], "b".repeat(5000)),
        knowledgeChunk("docs/c.md", ["C"], "small chunk that fits"),
      ],
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("budget_enforcement=true with null policy + knowledge (assembler runs, no policy blocks)", async () => {
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "Budget no policy",
      pr_description: "Null policy; knowledge fills the budget.",
      chunk: chunk(),
      policy_revision: 0,
      budget_enforcement: true,
      retrieved_knowledge: [
        knowledgeChunk("docs/x.md", [], "knowledge body one"),
        knowledgeChunk("docs/y.md", [], "knowledge body two"),
      ],
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });

  it("non-ASCII body + excerpt (token estimate safety factor + ensure_ascii JSON)", async () => {
    const ctx = wire({
      pr_id: PR_ID,
      installation_id: INST_ID,
      repo: "acme/widgets",
      pr_title: "国际化",
      pr_description: "日本語の説明 — handles unicode.",
      chunk: chunk({ body: "const 名前 = 'こんにちは世界';\n// 絵文字 🎉🚀" }),
      policy_revision: 0,
      tier1_findings: [
        {
          finding_id: "77777777-7777-4777-8777-777777777777",
          tool: "ruff",
          rule_id: "X",
          file: "src/app/handler.ts",
          start_line: 10,
          end_line: 10,
          severity_raw: "warning",
          message: "メッセージ with 日本語 and emoji 🎉",
        },
      ],
      retrieved_evidence: [evidence("chunk_body", "src/app/handler.ts", "抜粋 — excerpt with 漢字 🚀")],
    });
    const tsOut = buildUserMessage(ReviewContextV1.parse(ctx));
    const pyOut = await pyBuildUserMessage(ctx);
    expect(tsOut).toBe(pyOut);
  });
});

// ── fixture builders ──────────────────────────────────────────────────────────────────────────

function knowledgeChunk(
  relativePath: string,
  headingPath: ReadonlyArray<string>,
  body: string,
): Record<string, unknown> {
  return {
    chunk_id: deterministicUuid(`kc:${relativePath}:${headingPath.join("/")}`),
    installation_id: INST_ID,
    repo_id: REPO_ID,
    relative_path: relativePath,
    chunk_index: 0,
    heading_path: headingPath,
    body,
    doc_kind: "other",
  };
}

/** A source="confluence" KnowledgeChunkV1 — exercises the T16 confluence rendering (locator + r3 attrs +
 *  inner-<doc>-wrapper strip). The body carries the redactor's `<doc trust="untrusted">` wrapper the
 *  renderer must strip. */
function confluenceChunk(
  spaceKey: string,
  pageId: string,
  labels: ReadonlyArray<string>,
  body: string,
  opts: { docKind?: string; matchSpecificityScore?: number; ageDays?: number } = {},
): Record<string, unknown> {
  return {
    chunk_id: deterministicUuid(`cc:${spaceKey}:${pageId}`),
    installation_id: INST_ID,
    repo_id: REPO_ID,
    relative_path: `confluence/${spaceKey}/${pageId}`,
    chunk_index: 0,
    heading_path: [],
    body,
    doc_kind: opts.docKind ?? "adr",
    source: "confluence",
    space_key: spaceKey,
    page_id: pageId,
    labels,
    match_specificity_score: opts.matchSpecificityScore ?? 6,
    age_days: opts.ageDays ?? 12,
  };
}

function evidence(
  sourceType: string,
  path: string | null,
  excerpt: string,
): Record<string, unknown> {
  // Deterministic ev_ id matching ^ev_[0-9a-f]{16}$ — content does not matter for the prompt render.
  const hex = sha1Hex(`${sourceType}:${path}:${excerpt}`).slice(0, 16);
  return {
    evidence_id: `ev_${hex}`,
    source_type: sourceType,
    path,
    excerpt,
  };
}

function topology(
  entries: ReadonlyArray<[string, string, number, number]>,
): Array<Record<string, unknown>> {
  return entries.map(([path, kind, start, end]) => ({
    chunk_id: deterministicUuid(`top:${path}:${start}:${end}`),
    path,
    start_line: start,
    end_line: end,
    kind,
  }));
}

function toolStatus(
  toolName: string,
  status: string,
  scanned: number,
  total: number,
): Record<string, unknown> {
  return {
    tool_name: toolName,
    status,
    files_scanned: scanned,
    files_total: total,
    started_at: "2026-01-01T00:00:00+00:00",
    finished_at: "2026-01-01T00:00:01+00:00",
    duration_ms: 1000,
    findings_produced: 0,
    error_class: null,
  };
}

function rule(
  ruleId: string,
  scopeDir: string,
  body: string,
  headingPath: ReadonlyArray<string>,
): Record<string, unknown> {
  return {
    rule_id: ruleId,
    normalized_hash: SHA64,
    source_file: `${scopeDir || "."}/CLAUDE.md`,
    source_file_sha256: SHA64,
    scope_dir: scopeDir,
    heading_path: headingPath,
    rule_index: 0,
    title: `${ruleId} title`,
    body,
    category: "security",
    intent: "forbid",
    priority: 100,
  };
}

// Parametrizable rule builder for the budget cases — `rule()` above hardcodes security/forbid (always
// never-drop), so a droppable rule needs explicit category/intent/priority.
function budgetRule(args: {
  ruleId: string;
  scopeDir: string;
  body: string;
  headingPath: ReadonlyArray<string>;
  category: string;
  intent: string;
  priority: number;
}): Record<string, unknown> {
  return {
    rule_id: args.ruleId,
    normalized_hash: SHA64,
    source_file: `${args.scopeDir || "."}/CLAUDE.md`,
    source_file_sha256: SHA64,
    scope_dir: args.scopeDir,
    heading_path: args.headingPath,
    rule_index: 0,
    title: `${args.ruleId} title`,
    body: args.body,
    category: args.category,
    intent: args.intent,
    priority: args.priority,
  };
}

// Deterministic UUID (v4-shaped) from a seed — replay-safe, lowercase, valid for Zod .uuid(). Uses a
// SHA-1 of the seed (this is TEST code; check_clock_random does NOT scan test files, and there is no
// randomness — fully deterministic).
function deterministicUuid(seed: string): string {
  const h = sha1Hex(seed);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

import { createHash } from "node:crypto";
function sha1Hex(s: string): string {
  return createHash("sha1").update(Buffer.from(s, "utf-8")).digest("hex");
}
