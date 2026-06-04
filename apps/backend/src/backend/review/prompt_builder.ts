// Byte-exact port of the codemaster review-chunk USER-MESSAGE builder
// (vendor/codemaster-py/codemaster/review/activities.py::_build_user_message and its pure render
// helpers, plus codemaster/llm/review_prompt.py::build_linter_aware_review_prompt and
// codemaster/policy/prompt_renderer.py::render_policy_blocks).
//
// PARITY-CRITICAL: buildUserMessage produces the LLM INPUT for bedrock_review_chunk. The dual-run
// replays the recorded LLM interaction, so a single-char drift here = a different recorded
// interaction. Every space, newline, markdown header, truncation boundary, ordering and number
// format mirrors the frozen Python EXACTLY. The review_prompt.parity.test.ts oracle asserts
// char-for-char equality against the live frozen Python over representative ReviewContextV1 inputs.
//
// PURE FUNCTION: no clock, no random, no IO. (check_clock_random scans this file.)
//
// TOKEN COUNTING: the manifest/evidence truncation boundaries use the codebase's `estimateTokens`
// 4-chars-per-token heuristic with the non-ASCII safety factor (port of
// codemaster/chunking/token_budget.py::estimate_tokens). This is a DETERMINISTIC char heuristic — NOT
// a real tokenizer — so it ports to TS byte-for-byte with no tokenizer-equivalence risk. See the
// per-function notes + the parity test's over-budget fixtures.
//
// BUDGET ENFORCEMENT: `_apply_budget` in Python trims policy + knowledge through the
// `assemble_prompt` budget subsystem ONLY when `context.budget_enforcement` (or the
// CODEMASTER_PROMPT_BUDGET_ENFORCEMENT env var) is truthy. That budget subsystem is NOT in scope for
// this port; `applyBudget` below faithfully reproduces the budget-OFF path (the default — returns the
// context fields unchanged) and THROWS if budget enforcement is requested, so a caller that enables
// it gets a loud, traceable blocker rather than a silent divergence. The off-path is byte-exact.

import type { ManifestSnapshot } from "#contracts/pr_context.v1.js";
import { ManifestFetchStatus } from "#contracts/pr_context.v1.js";
import type { DiffChunkV1 } from "#contracts/diff_chunking.v1.js";
import type { KnowledgeChunkV1 } from "#contracts/knowledge_chunks.v1.js";
import type { PathInstructionV1 } from "#contracts/codemaster_config.v1.js";
import type { PRTopologyEntryV1 } from "#contracts/pr_topology.v1.js";
import type { ResolvedGuidanceBundleV1, DedupedRuleV1 } from "#contracts/resolved_guidance.v1.js";
import type { RetrievedEvidenceV1, EvidenceSourceType } from "#contracts/retrieved_evidence.v1.js";
import { EVIDENCE_PRIORITY } from "#contracts/retrieved_evidence.v1.js";
import type { ReviewContextV1 } from "#contracts/review_context.v1.js";
import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import type { AnalysisFindingV1 } from "#contracts/analysis_findings.v1.js";
import type { ToolStatusV1 } from "#contracts/tool_status.v1.js";
import type { ConsumerHitV1, RemovedOrChangedSymbolV1 } from "#contracts/symbol_graph.v1.js";
import { wrapUntrusted, wrapUntrustedManifest } from "#backend/security/trust_tier_wrapping.js";

// ── token-budget heuristic ─────────────────────────────────────────────────────────────────────
// Port of codemaster/chunking/token_budget.py::estimate_tokens (4-chars-per-token proxy with a 2.5x
// safety factor when >10% of the body is non-ASCII). Deterministic char heuristic; no tokenizer.

const ASCII_MAX = 127;
const NON_ASCII_FACTOR_THRESHOLD = 0.1;

/**
 * 4-chars-per-token proxy. Matches the frozen Python `estimate_tokens` exactly.
 *
 * Python iterates Unicode CODE POINTS (`for c in body`) and tests `ord(c) > 127`; the share is over
 * `len(body)` (code-point count). JS `[...body]` iterates code points too, and `s.length` here is the
 * code-UNIT count — but the divisor used in BOTH the share and the 4-char estimate must be the same
 * unit Python uses, namely code-point count. We therefore use the spread length for both, so an
 * astral char (counted once in Python) is counted once here too. `Math.trunc` mirrors Python `int()`.
 */
export function estimateTokens(body: string): number {
  if (!body) {
    return 1;
  }
  const codePoints = [...body];
  const total = codePoints.length;
  let nonAscii = 0;
  for (const c of codePoints) {
    if (c.codePointAt(0)! > ASCII_MAX) {
      nonAscii += 1;
    }
  }
  const nonAsciiShare = nonAscii / total;
  const factor = nonAsciiShare > NON_ASCII_FACTOR_THRESHOLD ? 2.5 : 1.0;
  return Math.max(1, Math.trunc((total / 4) * factor));
}

// ── per-prompt section caps (ported verbatim) ───────────────────────────────────────────────────
const MAX_PATH_INSTRUCTIONS_CHARS = 5_000;
const MAX_KNOWLEDGE_CHARS = 12_000;
const MAX_CONSUMERS_CHARS = 12_000;

// v8 R-6 — three-tier compression thresholds for the PR-topology manifest.
const PATH_LEVEL_THRESHOLD = 30;
const DIRECTORY_LEVEL_THRESHOLD = 80;

// v10 R-10 — hard token cap on the rendered evidence-manifest section.
export const MAX_EVIDENCE_MANIFEST_TOKENS = 1500;

// ── string-length helper ─────────────────────────────────────────────────────────────────────────
// Python `len(str)` counts UNICODE CODE POINTS. JS `String.length` counts UTF-16 code units, which
// diverges on astral chars. The char-budget caps below compare against Python `len(...)`, so we use
// code-point length to stay byte-exact on the truncation boundary.
function pyLen(s: string): number {
  return [...s].length;
}

// Slice the first `n` CODE POINTS (mirrors Python `s[:n]`, which is code-point indexed).
function pySlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

// ── html.escape(quote=False) ──────────────────────────────────────────────────────────────────────
// Port of CPython `html.escape(s, quote=False)`: replaces `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;` in that
// order (ampersand FIRST so the inserted `&` of later replacements isn't re-escaped). quote=False, so
// `"` and `'` are NOT escaped. Used by the policy-block renderer to neutralize attacker-authored
// `</policy>` / `<system>` inside rule bodies.
function htmlEscapeNoQuote(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── path instructions ──────────────────────────────────────────────────────────────────────────
// Port of `_render_path_instructions`. Returns the lines to append, with a 5K-code-point total cap.
function renderPathInstructions(rules: ReadonlyArray<PathInstructionV1>): Array<string> {
  if (rules.length === 0) {
    return [];
  }
  const out: Array<string> = ["", "## team-specific guidance for this file"];
  let charsSoFar = 0;
  let truncated = false;
  for (const r of rules) {
    const line = `- ${r.instructions}`;
    if (charsSoFar + pyLen(line) > MAX_PATH_INSTRUCTIONS_CHARS) {
      truncated = true;
      break;
    }
    out.push(line);
    charsSoFar += pyLen(line);
  }
  if (truncated) {
    out.push("- (... team rules truncated)");
  }
  return out;
}

// ── retrieved-knowledge block (repo_knowledge path) ───────────────────────────────────────────────
// Port of `_render_retrieved_knowledge` for the repo_knowledge branch + degraded handling.
//
// NOTE — Confluence branch (source="confluence") is NOT ported here: it depends on the Confluence
// precedence machinery (priority_tier / derive_authority / derive_doc_type / specificity_bucket) +
// the inner-<doc>-wrapper strip, none of which are in this task's scope. The frozen Python renders
// confluence chunks with the full r3 attribute set; the parity fixtures here exercise repo_knowledge
// chunks only. A `source="confluence"` chunk reaching this builder throws a loud blocker.
function renderRetrievedKnowledge(
  chunks: ReadonlyArray<KnowledgeChunkV1>,
  opts: { degraded: boolean; degradationReason: string },
): string {
  if (chunks.length === 0 && !opts.degraded) {
    return "";
  }
  const lines: Array<string> = ['<knowledge trust="trusted">'];
  if (opts.degraded) {
    const reasonText =
      opts.degradationReason !== ""
        ? opts.degradationReason
        : "dense index unavailable; results below come from lexical search only";
    lines.push(`<!-- retrieval degraded: ${reasonText} -->`);
  }
  let charsSoFar = 0;
  let truncated = false;
  for (const c of chunks) {
    if (c.source === "confluence") {
      throw new Error(
        "prompt_builder: confluence knowledge rendering is not ported (out of scope); " +
          "see renderRetrievedKnowledge NOTE",
      );
    }
    const path = c.relative_path;
    const heading = c.heading_path.length > 0 ? c.heading_path.join(" › ") : "";
    const header = `### chunk_id=${c.chunk_id} — ${path}` + (heading ? ` — § ${heading}` : "");
    const block = `\n${header}\n${c.body}\n`;
    if (charsSoFar + pyLen(block) > MAX_KNOWLEDGE_CHARS) {
      truncated = true;
      break;
    }
    lines.push(block);
    charsSoFar += pyLen(block);
  }
  if (truncated) {
    lines.push("<!-- (... additional chunks truncated to fit cap) -->");
  }
  lines.push("</knowledge>");
  return lines.join("\n");
}

// ── cross-repo consumers block ─────────────────────────────────────────────────────────────────
// Port of `_render_consumers_block` (S11.3.2).
function renderConsumersBlock(
  symbols: ReadonlyArray<RemovedOrChangedSymbolV1>,
  hits: ReadonlyArray<ConsumerHitV1>,
  opts: { truncated: boolean },
): string {
  if (symbols.length === 0 && hits.length === 0) {
    return "";
  }
  const lines: Array<string> = ['<knowledge trust="trusted">'];
  lines.push("# cross-repo consumers");
  if (symbols.length > 0) {
    lines.push("");
    lines.push("## removed or signature-changed public symbols");
    for (const s of symbols) {
      const change =
        s.change_kind === "signature_changed" && s.new_signature
          ? `signature_changed → ${s.new_signature}`
          : s.change_kind;
      lines.push(`- \`${s.qualified_name}\` (target_symbol_id=${s.target_symbol_id}) — ${change}`);
    }
  }
  if (hits.length > 0) {
    lines.push("");
    lines.push("## consumer sites");
    let charsSoFar = 0;
    let truncatedLocal = false;
    for (const h of hits) {
      const excerpt = h.excerpt ? ` — ${h.excerpt}` : "";
      const line =
        `- [${h.confidence}] consumer_repo_id=${h.consumer_repo_id} ` +
        `\`${h.consumer_relative_path}:${h.consumer_line}\`${excerpt}`;
      if (charsSoFar + pyLen(line) > MAX_CONSUMERS_CHARS) {
        truncatedLocal = true;
        break;
      }
      lines.push(line);
      charsSoFar += pyLen(line);
    }
    if (opts.truncated || truncatedLocal) {
      lines.push("<!-- (... additional consumers truncated to fit cap) -->");
    }
  }
  lines.push("</knowledge>");
  return lines.join("\n");
}

// ── PR-topology manifest (`## PR scope`) — 3-tier compression ──────────────────────────────────
// Port of `_render_pr_scope_section`. Tier chosen by manifest size; tier-3 adaptively retains paths
// the retrieval pipeline cited (via KnowledgeChunkV1.relative_path) so semantically-critical files
// survive directory aggregation.
function renderPrScopeSection(
  manifest: ReadonlyArray<PRTopologyEntryV1>,
  currentChunk: DiffChunkV1,
  retrievedKnowledge: ReadonlyArray<KnowledgeChunkV1>,
): string {
  if (manifest.length === 0) {
    return "";
  }

  const chunksTotal = manifest.length;
  const pathsToEntries = new Map<string, Array<PRTopologyEntryV1>>();
  // Python dict preserves insertion order; Map does too. Tier 1/2/3 all sort by path before render,
  // so insertion order only affects entries[0].kind selection (first-seen entry per path) — matched.
  for (const entry of manifest) {
    const existing = pathsToEntries.get(entry.path);
    if (existing) {
      existing.push(entry);
    } else {
      pathsToEntries.set(entry.path, [entry]);
    }
  }

  const distinctPathsCount = pathsToEntries.size;
  const citedPaths = new Set<string>(retrievedKnowledge.map((kc) => kc.relative_path));

  let lines: Array<string>;

  if (chunksTotal <= PATH_LEVEL_THRESHOLD) {
    // Tier 1: per-path listing with chunk count + kind.
    lines = [
      `## PR scope (you are reviewing 1 chunk of ${chunksTotal}; ` +
        "others reviewed by parallel LLM calls)",
    ];
    for (const path of sortedStrings([...pathsToEntries.keys()])) {
      const entries = pathsToEntries.get(path)!;
      const kind = entries[0]!.kind;
      const count = entries.length;
      const marker = path === currentChunk.path ? "  ← THIS CHUNK" : "";
      const countSuffix = count > 1 ? ` (${count} chunks)` : "";
      lines.push(`- ${path} [${kind}]${countSuffix}${marker}`);
    }
  } else if (chunksTotal <= DIRECTORY_LEVEL_THRESHOLD) {
    // Tier 2: file inventory (path-only).
    lines = [
      `## PR scope (you are reviewing 1 chunk of ${chunksTotal}; ` +
        "others reviewed by parallel LLM calls)",
      "",
      "File inventory:",
    ];
    for (const path of sortedStrings([...pathsToEntries.keys()])) {
      const marker = path === currentChunk.path ? "  ← contains THIS CHUNK" : "";
      lines.push(`- ${path}${marker}`);
    }
  } else {
    // Tier 3: directory aggregation + adaptive retention of retrieval-cited paths.
    const manifestPaths = new Set<string>(pathsToEntries.keys());
    let retainedPaths = new Set<string>([...citedPaths].filter((p) => manifestPaths.has(p)));
    // Always retain the current-chunk path explicitly too.
    retainedPaths = new Set<string>([...retainedPaths, currentChunk.path]);
    const residualPaths = new Set<string>([...manifestPaths].filter((p) => !retainedPaths.has(p)));

    const byDirExt = new Map<string, number>();
    for (const path of residualPaths) {
      const top = path.includes("/") ? path.split("/")[0]! : ".";
      const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "noext";
      const key = `${top}/*.${ext}`;
      byDirExt.set(key, (byDirExt.get(key) ?? 0) + 1);
    }

    lines = [
      `## PR scope (you are reviewing 1 chunk of ${chunksTotal}; ` +
        "others reviewed by parallel LLM calls)",
      "",
      `Current chunk: ${currentChunk.path} ` +
        `(lines ${currentChunk.start_line}-${currentChunk.end_line})`,
    ];
    const retainedMinusCurrent = new Set<string>(
      [...retainedPaths].filter((p) => p !== currentChunk.path),
    );
    if (retainedMinusCurrent.size > 0) {
      lines.push("");
      lines.push("Files cited by retrieved knowledge (always explicit, never compressed):");
      for (const path of sortedStrings([...retainedPaths])) {
        const marker = path === currentChunk.path ? "  ← THIS CHUNK" : "";
        lines.push(`- ${path}${marker}`);
      }
    }
    if (byDirExt.size > 0) {
      lines.push("");
      lines.push(
        `Other files in PR (${residualPaths.size} of ` +
          `${distinctPathsCount} total, grouped by directory + ` +
          "extension for prompt budget):",
      );
      for (const key of sortedStrings([...byDirExt.keys()])) {
        lines.push(`- ${key} — ${byDirExt.get(key)!} files`);
      }
    }
  }

  lines.push("");
  lines.push(
    "Do NOT infer absence of code, files, or PR scope from the " +
      "bounds of YOUR chunk. Other chunks may carry the code your " +
      "knowledge citations reference. The inventory above is " +
      "authoritative for PR file existence.",
  );
  return lines.join("\n");
}

// Python `sorted(iterable_of_str)` orders by Unicode code point. JS default Array.sort on strings is
// by UTF-16 code unit, which diverges on astral chars. Sort by code point to match Python exactly.
function sortedStrings(items: Array<string>): Array<string> {
  return [...items].sort((a, b) => codePointCompare(a, b));
}

function codePointCompare(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded numeric loop index into a local code-point array (no prototype-chain read).
    const da = ca[i]!.codePointAt(0)!;
    // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded numeric loop index into a local code-point array (no prototype-chain read).
    const db = cb[i]!.codePointAt(0)!;
    if (da !== db) {
      return da - db;
    }
  }
  return ca.length - cb.length;
}

// ── project-manifests block ────────────────────────────────────────────────────────────────────
// Port of `_render_manifests_block` (FOLLOW-UP-manifest-prompt-rendering). MAX_MANIFEST_BLOCK_TOKENS
// budget; SUCCESS/TRUNCATED entries render their body, non-success entries render only the status
// line. Whole section wrapped by wrapUntrustedManifest.
export const MAX_MANIFEST_BLOCK_TOKENS = 3000;

function renderManifestsBlock(manifests: ReadonlyArray<ManifestSnapshot>): string {
  if (manifests.length === 0) {
    return "";
  }

  const heading = "## Project manifests";
  const bodyLines: Array<string> = [heading];
  let runningTokens = estimateTokens(heading);
  let renderedCount = 0;

  for (const m of manifests) {
    const ecosystemTag = m.detected_ecosystem ? ` (${m.detected_ecosystem})` : "";
    let entryLines: Array<string>;
    if (m.fetch_status === ManifestFetchStatus.enum.success) {
      entryLines = ["", `### ${m.path}${ecosystemTag}`, m.raw_body];
    } else if (m.fetch_status === ManifestFetchStatus.enum.truncated || m.truncated) {
      entryLines = [
        "",
        `### ${m.path}${ecosystemTag} — fetch_status: ${m.fetch_status}, ` +
          `original_byte_length=${m.byte_length}`,
        m.raw_body,
      ];
    } else {
      // NOT_FOUND / FETCH_FAILED / DECODE_FAILED — status line only.
      entryLines = ["", `### ${m.path}${ecosystemTag} — fetch_status: ${m.fetch_status}`];
    }

    const entryText = entryLines.join("\n");
    const entryTokens = estimateTokens(entryText);

    // Reserve ~30 tokens for the truncation footer in case more entries follow.
    if (runningTokens + entryTokens + 30 > MAX_MANIFEST_BLOCK_TOKENS) {
      break;
    }
    bodyLines.push(entryText);
    runningTokens += entryTokens;
    renderedCount += 1;
  }

  const dropped = manifests.length - renderedCount;
  if (dropped > 0) {
    bodyLines.push("");
    bodyLines.push(
      `_(${renderedCount} of ${manifests.length} manifests shown; ` +
        `${dropped} dropped due to token budget)_`,
    );
  }

  const body = bodyLines.join("\n");
  return wrapUntrustedManifest(body);
}

// ── evidence manifest (`## Evidence manifest`) ──────────────────────────────────────────────────
// Port of `_render_evidence_manifest` (v10 R-10). Stable-sort by EVIDENCE_PRIORITY; adaptive
// truncation under MAX_EVIDENCE_MANIFEST_TOKENS with a footer reporting dropped entries.
export function renderEvidenceManifest(
  retrievedEvidence: ReadonlyArray<RetrievedEvidenceV1>,
): string {
  if (retrievedEvidence.length === 0) {
    return "";
  }

  // priority_index: source_type → index; unknown source_type sorts last (== len(EVIDENCE_PRIORITY)).
  const priorityIndex = new Map<EvidenceSourceType, number>();
  EVIDENCE_PRIORITY.forEach((st, idx) => priorityIndex.set(st, idx));
  const unknownRank = EVIDENCE_PRIORITY.length;

  // Python `sorted(..., key=...)` is STABLE — preserve input order within each priority bucket.
  const ordered = stableSortBy(retrievedEvidence, (ev) => priorityIndex.get(ev.source_type) ?? unknownRank);

  const heading = "## Evidence manifest";
  const lines: Array<string> = [heading, ""];
  let runningTokens = estimateTokens(heading);
  let renderedCount = 0;

  for (const ev of ordered) {
    const detailsParts: Array<string> = [];
    if (ev.path !== null) {
      detailsParts.push(ev.path);
    }
    if (ev.chunk_id !== null) {
      detailsParts.push(`chunk=${ev.chunk_id}`);
    }
    if (ev.knowledge_chunk_id !== null) {
      detailsParts.push(`knowledge=${ev.knowledge_chunk_id}`);
    }
    const details = detailsParts.length > 0 ? detailsParts.join(" ") : "(no locator)";

    // Truncate the excerpt to ~600 code points so one huge excerpt can't monopolize the budget.
    let excerptSnippet = pySlice(ev.excerpt, 600);
    if (pyLen(ev.excerpt) > 600) {
      excerptSnippet += "…";
    }
    const line = `[${ev.evidence_id}] (${ev.source_type}) ${details} — ${excerptSnippet}`;
    const lineTokens = estimateTokens(line);
    // Reserve ~30 tokens for the truncation footer in case more entries follow.
    if (runningTokens + lineTokens + 30 > MAX_EVIDENCE_MANIFEST_TOKENS) {
      break;
    }
    lines.push(line);
    runningTokens += lineTokens;
    renderedCount += 1;
  }

  const dropped = ordered.length - renderedCount;
  if (dropped > 0) {
    lines.push("");
    lines.push(
      `_(${renderedCount} of ${ordered.length} evidence entries shown; ` +
        `${dropped} dropped due to token budget — lower-priority entries ` +
        `dropped first)_`,
    );
  }

  return lines.join("\n");
}

// Stable sort by an integer key (mirrors Python's stable `sorted(key=...)`). Decorate-sort-undecorate
// with the original index as the tiebreaker so equal-key elements keep input order.
function stableSortBy<T>(items: ReadonlyArray<T>, key: (item: T) => number): Array<T> {
  return items
    .map((item, idx) => ({ item, idx, k: key(item) }))
    .sort((a, b) => (a.k !== b.k ? a.k - b.k : a.idx - b.idx))
    .map((d) => d.item);
}

// ── policy blocks (`<knowledge trust="semi">` / `<policy>`) ────────────────────────────────────
// Port of codemaster/policy/prompt_renderer.py::render_policy_blocks + its helpers. Pure; rule bodies
// are html.escape(quote=False)-escaped so attacker-authored CLAUDE.md can't inject </policy>.
function precedenceLabel(ruleScopeDir: string, changedPath: string): string {
  if (ruleScopeDir === "") {
    return "root";
  }
  const parts = changedPath.split("/");
  parts.pop();
  const parent = parts.join("/");
  if (ruleScopeDir === parent) {
    return "nearest-ancestor";
  }
  return "ancestor";
}

function renderSourcesFooter(
  sources: ReadonlyArray<DedupedRuleV1["sources"][number]>,
  canonicalRule: DedupedRuleV1["rule"],
): string {
  if (sources.length <= 1) {
    return "";
  }
  const lines: Array<string> = ["Sources:"];
  for (const s of sources) {
    const headingStr = s.heading_path.length > 0 ? s.heading_path.join(" > ") : "(no heading)";
    // Identity-compare AND rule_id-compare (R-22).
    const isCanonical = s === canonicalRule || s.rule_id === canonicalRule.rule_id;
    const marker = isCanonical ? "" : "            [deduped]";
    lines.push(`  - ${s.source_file} (${headingStr})${marker}`);
  }
  return lines.join("\n");
}

function renderPolicyBlock(deduped: DedupedRuleV1, changedPath: string): string {
  const rule = deduped.rule;
  const precedence = precedenceLabel(rule.scope_dir, changedPath);
  const scopeAttr = rule.scope_dir ? rule.scope_dir : "**";
  const escapedBody = htmlEscapeNoQuote(rule.body);

  const sourcesFooter = renderSourcesFooter(deduped.sources, rule);
  let bodySection = escapedBody;
  if (sourcesFooter) {
    bodySection = `${escapedBody}\n\n${sourcesFooter}`;
  }

  return (
    `<policy rule_id="${rule.rule_id}" ` +
    `category="${rule.category}" ` +
    `intent="${rule.intent}" ` +
    `priority="${rule.priority}" ` +
    `scope="${scopeAttr}" ` +
    `precedence="${precedence}">\n` +
    `${bodySection}\n` +
    `</policy>`
  );
}

export function renderPolicyBlocks(bundle: ResolvedGuidanceBundleV1): string {
  if (bundle.applicable_rules.length === 0) {
    return "";
  }
  const policyBlocks = bundle.applicable_rules.map((deduped) =>
    renderPolicyBlock(deduped, bundle.changed_path),
  );
  const inner = policyBlocks.join("\n\n");
  return `<knowledge trust="semi">\n${inner}\n</knowledge trust="semi">`;
}

// ── Tier-1 linter-aware appendix ───────────────────────────────────────────────────────────────
// Port of codemaster/llm/review_prompt.py::{render_tier1_findings_block,render_tool_statuses_block,
// render_arbitration_instructions,build_linter_aware_review_prompt}.

function renderTier1FindingsBlock(findings: ReadonlyArray<AnalysisFindingV1>): string {
  if (findings.length === 0) {
    return "";
  }
  const payload = findings.map((f) => ({
    finding_id: f.finding_id,
    tool: f.tool,
    rule_id: f.rule_id,
    file: f.file,
    start_line: f.start_line,
    end_line: f.end_line,
    severity_raw: f.severity_raw,
    message: f.message,
  }));
  const body =
    "Static analysis has already produced the following findings on " +
    "this file. DO NOT duplicate them. You may produce complementary " +
    "findings (different lines, different concerns) OR arbitration " +
    "intents proposing to suppress a specific finding (see the " +
    "arbitration_instructions block below).\n\n" +
    jsonDumpsIndent2(payload);
  return wrapUntrusted(body);
}

function renderToolStatusesBlock(statuses: ReadonlyArray<ToolStatusV1>): string {
  if (statuses.length === 0) {
    return "";
  }
  const payload: Record<string, JsonObject> = {};
  // coverage_fraction is a Python FLOAT — json.dumps renders 1.0 / 0.0 / 0.5 with a trailing decimal,
  // but JS JSON.stringify renders whole-valued floats as `1` / `0`. We therefore serialize a unique
  // sentinel string per tool and splice the Python-float repr in afterward (a JSON replacer cannot
  // emit a raw numeric token — it would quote it).
  const floatTokens = new Map<string, string>();
  for (const s of statuses) {
    const token = `__COVFRAC_${floatTokens.size}__`;
    floatTokens.set(token, pyFloatRepr(roundHalfEven2(coverageFraction(s))));
    payload[s.tool_name] = {
      status: s.status,
      files_scanned: s.files_scanned,
      files_total: s.files_total,
      coverage_fraction: token,
      duration_ms: s.duration_ms,
      findings_produced: s.findings_produced,
      error_class: s.error_class,
    };
  }
  let encoded = jsonDumpsIndent2(payload);
  for (const [token, repr] of floatTokens) {
    // The sentinel is a JSON string value (`"__COVFRAC_N__"`); replace the QUOTED form with the raw
    // numeric token so the slot becomes a JSON number matching Python's float repr.
    encoded = encoded.replace(`"${token}"`, repr);
  }
  return `<tool_statuses>\n${encoded}\n</tool_statuses>`;
}

// Python ToolStatusV1.coverage_fraction @property: files_scanned / files_total, or 1.0 when
// files_total == 0 ("full coverage of an empty set" per the contract). Re-authored here since the
// property is absent from the wire dump.
function coverageFraction(s: ToolStatusV1): number {
  if (s.files_total === 0) {
    return 1.0;
  }
  return s.files_scanned / s.files_total;
}

function renderArbitrationInstructions(statuses: ReadonlyArray<ToolStatusV1>): string {
  if (statuses.length === 0) {
    return "";
  }
  return (
    "<arbitration_instructions>\n" +
    "Some analyzers may be partial or absent. Adapt your review focus:\n" +
    "\n" +
    "- For tools with status='completed': treat their findings as ground " +
    "truth. Do not duplicate. You MAY arbitrate AGAINST a finding above " +
    "ONLY IF you provide:\n" +
    "  (a) explicit reasoning,\n" +
    "  (b) high confidence (>= 0.85),\n" +
    "  (c) target_finding_id from the linter_findings JSON.\n" +
    "  Use the `report_arbitration_intent` tool to emit each suppression: " +
    "it accepts target_finding_id (must match a finding_id from " +
    "<linter_findings>), action ('SUPPRESS'), confidence (0.0-1.0), and " +
    "reason.\n" +
    "\n" +
    "- For tools with status='timed_out' AND coverage_fraction >= 0.5:\n" +
    "  Treat findings as partial. Pay extra attention to the patterns " +
    "this tool normally catches, on the files the tool did NOT reach.\n" +
    "\n" +
    "- For tools with status='timed_out' AND coverage_fraction < 0.5:\n" +
    "  Treat the tool as effectively absent. Compensate broadly.\n" +
    "\n" +
    "- For tools with status in {'failed_startup', 'failed_runtime', " +
    "'oom', 'auth_failed'}: treat as absent. Apply compensating " +
    "heuristics for the entire review.\n" +
    "\n" +
    "Focus on what static analysis cannot see: architectural issues, " +
    "intent mismatch, business logic, security reasoning, race " +
    "conditions, API misuse, missing invariants.\n" +
    "</arbitration_instructions>"
  );
}

function buildLinterAwareReviewPrompt(args: {
  chunkSection: string;
  tier1Findings: ReadonlyArray<AnalysisFindingV1>;
  toolStatuses: ReadonlyArray<ToolStatusV1>;
  chunkFilePath: string;
}): string {
  let tier1 = args.tier1Findings;
  if (args.tier1Findings.length > 0) {
    tier1 = args.tier1Findings.filter((f) => f.file === args.chunkFilePath);
  }

  const sections: Array<string> = [args.chunkSection];

  const tier1Block = renderTier1FindingsBlock(tier1);
  if (tier1Block) {
    sections.push(tier1Block);
  }
  const statusesBlock = renderToolStatusesBlock(args.toolStatuses);
  if (statusesBlock) {
    sections.push(statusesBlock);
  }
  const arbBlock = renderArbitrationInstructions(args.toolStatuses);
  if (arbBlock) {
    sections.push(arbBlock);
  }
  return sections.join("\n\n");
}

// ── budget enforcement (off-path only) ──────────────────────────────────────────────────────────
function applyBudget(
  context: ReviewContextV1,
): { policyForRender: ResolvedGuidanceBundleV1 | null; knowledgeForRender: ReadonlyArray<KnowledgeChunkV1> } {
  // Python: prefer context.budget_enforcement (workflow-body-resolved); else the env var truthy
  // vocabulary {"1","true","yes"}. The env var is read in the worker; this pure builder has no
  // process env access (and must not, per replay determinism), so we honor only the contract flag.
  if (context.budget_enforcement) {
    throw new Error(
      "prompt_builder: budget_enforcement=true requires the assemble_prompt budget subsystem, " +
        "which is not ported (out of scope). Off-path (budget_enforcement=false) is byte-exact.",
    );
  }
  return {
    policyForRender: context.applicable_policy,
    knowledgeForRender: context.retrieved_knowledge,
  };
}

// ── buildUserMessage (1:1 with _build_user_message) ─────────────────────────────────────────────
export function buildUserMessage(context: ReviewContextV1): string {
  const chunk = context.chunk;
  const parts: Array<string> = [
    `# pull request: ${context.repo}`,
    `## title\n${context.pr_title}`,
    `## description\n${context.pr_description}`,
    "",
    `## chunk: ${chunk.path} (lines ${chunk.start_line}-${chunk.end_line}, ` +
      `language=${chunk.language ?? "unknown"}, kind=${chunk.chunk_kind})`,
    chunk.body,
  ];
  const scopeSection = renderPrScopeSection(
    context.pr_topology_manifest,
    chunk,
    context.retrieved_knowledge,
  );
  if (scopeSection) {
    parts.push("");
    parts.push(scopeSection);
  }
  parts.push(...renderPathInstructions(context.matched_path_instructions));
  if (context.prior_findings.length > 0) {
    parts.push("");
    parts.push("## prior findings (do not repeat)");
    for (const f of context.prior_findings) {
      parts.push(priorFindingLine(f));
    }
  }
  const untrusted = wrapUntrusted(parts.join("\n"));

  const { policyForRender, knowledgeForRender } = applyBudget(context);

  const knowledgeBlock = renderRetrievedKnowledge(knowledgeForRender, {
    degraded: context.retrieval_degraded,
    degradationReason: context.retrieval_degradation_reason,
  });
  const consumersBlock = renderConsumersBlock(
    context.removed_or_changed_symbols,
    context.consumer_hits,
    { truncated: context.consumer_hits_truncated },
  );
  const partsOut: Array<string> = [untrusted];
  if (knowledgeBlock) {
    partsOut.push(knowledgeBlock);
  }
  const manifestBlock = renderManifestsBlock(context.manifests);
  if (manifestBlock) {
    partsOut.push(manifestBlock);
  }
  if (policyForRender !== null) {
    const policyBlock = renderPolicyBlocks(policyForRender);
    if (policyBlock) {
      partsOut.push(policyBlock);
    }
  }
  if (consumersBlock) {
    partsOut.push(consumersBlock);
  }
  const evidenceBlock = renderEvidenceManifest(context.retrieved_evidence);
  if (evidenceBlock) {
    partsOut.push(evidenceBlock);
  }
  const baseSection = partsOut.join("\n\n");

  return buildLinterAwareReviewPrompt({
    chunkSection: baseSection,
    tier1Findings: context.tier1_findings,
    toolStatuses: context.tool_statuses,
    chunkFilePath: chunk.path,
  });
}

// Prior-findings line — mirrors the f-string in _build_user_message exactly.
// `f.title` is the field name in ReviewFindingV1 (Python uses `f.title`).
function priorFindingLine(f: ReviewFindingV1): string {
  return `- [${f.severity}] ${f.file}:${f.start_line}-${f.end_line}: ${f.title}`;
}

// ── JSON encoding helpers (mirror Python json.dumps semantics) ──────────────────────────────────
type JsonObject = Record<string, JsonValue>;
type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [k: string]: JsonValue };

// Python `json.dumps(obj, indent=2)`: 2-space indent, ", " item separator collapses to ",\n" under
// indent, ": " key separator, keys in INSERTION order (dict order), ensure_ascii defaults to True
// (non-ASCII escaped as \uXXXX). JS JSON.stringify(obj, null, 2) matches indent + insertion order +
// separators, but does NOT escape non-ASCII — so we post-escape to reproduce ensure_ascii=True.
function jsonDumpsIndent2(obj: JsonValue): string {
  return ensureAscii(JSON.stringify(obj, null, 2));
}

// Reproduce CPython json.dumps ensure_ascii=True: every code unit >= 0x80 becomes \uXXXX (lowercase
// hex, 4 digits), astral chars as the natural UTF-16 surrogate pair (each unit escaped). Control
// chars < 0x20 are already escaped by JSON.stringify identically to json.dumps (\n,\t,\uXXXX form).
function ensureAscii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0x80) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      // eslint-disable-next-line security/detect-object-injection -- `i` is a bounded numeric loop index into the input string (no prototype-chain read).
      out += s[i];
    }
  }
  return out;
}

// Python `round(x, 2)` → integer number of hundredths (so pyFloatRepr reconstructs the repr without
// re-introducing binary-float noise). CRITICAL: Python rounds the EXACT IEEE-754 double, NOT an
// idealized `x*100`. The old `x*100` form introduced binary error AND snapped every non-dyadic ".xx5"
// to a FALSE exact tie — diverging for the whole class of n/40, n/200, … coverage ratios (0.025 →
// Python 0.03 not 0.02; 0.075 → 0.07 not 0.08). The true double of 0.025 is stored just ABOVE the
// midpoint (…0250000000000000139) so it rounds UP; 0.075 just BELOW so it rounds DOWN. Only the dyadic
// midpoints k/8 (0.125/0.375/0.625/0.875) are genuine ties → ties-to-even (0.125 → 0.12). We read a
// long exact decimal expansion (toFixed(30) captures the ~17th-place deviation that decides non-dyadic
// cases) and round the digit string. Domain: coverage_fraction ∈ [0, 1].
function roundHalfEven2(x: number): number {
  if (!Number.isFinite(x)) {
    return 0;
  }
  const s = x.toFixed(30); // "0.DDDD…" or "1.000…" — never exponential for x ∈ [0,1]
  const dot = s.indexOf(".");
  const frac = s.slice(dot + 1);
  const d0 = frac.charCodeAt(0) - 48;
  const d1 = frac.charCodeAt(1) - 48; // the kept (2nd) decimal
  const d2 = frac.charCodeAt(2) - 48; // the rounding (3rd) decimal
  let hundredths = Number(s.slice(0, dot)) * 100 + d0 * 10 + d1;
  let roundUp: boolean;
  if (d2 < 5) {
    roundUp = false;
  } else if (d2 > 5) {
    roundUp = true;
  } else {
    // d2 === 5: an EXACT tie only if every following digit is zero; else the true value is just past
    // the midpoint and rounds up. On an exact tie, round to even (round up iff the kept digit is odd).
    roundUp = /^0*$/.test(frac.slice(3)) ? d1 % 2 === 1 : true;
  }
  return roundUp ? hundredths + 1 : hundredths;
}

// Render a coverage_fraction (passed as an integer count of hundredths from roundHalfEven2) the way
// CPython `repr(float)` / json.dumps does for a 2-decimal value: integer-valued → `N.0`; one
// significant decimal → `N.D`; two → `N.DD` with no trailing-zero trim beyond Python's own
// (Python: 0.5 not 0.50, 0.3 stays 0.3, but round(x,2) only ever yields 0/1/2-place decimals).
function pyFloatRepr(hundredths: number): string {
  const whole = Math.trunc(hundredths / 100);
  const frac = Math.abs(hundredths % 100);
  if (frac === 0) {
    return `${whole}.0`;
  }
  if (frac % 10 === 0) {
    // e.g. 50 hundredths → "0.5" (Python repr drops the trailing zero).
    return `${whole}.${frac / 10}`;
  }
  // e.g. 33 hundredths → "0.33"; 5 hundredths → "0.05".
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}
