/**
 * `post_review_results` activity — 1:1 TypeScript port of the frozen Python
 * `vendor/codemaster-py/codemaster/activities/post_review_results.py` (the `_do_post` state machine +
 * its publication ladder + the per-finding renderers + the activity entry point).
 *
 * THE core durable-mutation seam of the spine: the CLAUDE.md invariant-12 publication-outcome state
 * machine layered over the Sprint-14.D 2-phase atomic-claim flow (closes audit B1.5 TOCTOU).
 *
 * ## The 2-phase atomic-claim flow (Sprint 14 / S14.D)
 *
 *  - PHASE 1 (claim). Open ONE transaction: run the AD-4 stale-write guard ({@link assertCurrentRun})
 *    so a superseded run cannot win the claim (a violation RAISES `StaleWriteError`), then
 *    `INSERT INTO core.posted_reviews (pr_id, marker) ... ON CONFLICT (pr_id) DO NOTHING RETURNING
 *    pr_id` and commit. At most one caller sees a non-empty RETURNING ⇒ wins the claim. The Phase-1
 *    INSERT intentionally OMITS `github_review_id` + `publication_outcome` — relying on the column
 *    DEFAULTs (`NULL` / `'degraded_unposted'`), which satisfy the IFF CHECK as a placeholder.
 *  - IF WON → {@link attemptCreateWithBodyOnlyFallback}: POST the review with inline comments; on a
 *    GitHub 422 retry body-only (no comments) → `BODY_ONLY_POSTED`; on a DOUBLE 422 return
 *    `DEGRADED_UNPOSTED` WITHOUT raising (the row keeps `github_review_id` NULL = the degraded marker).
 *    Then PHASE 2: `UPDATE core.posted_reviews SET github_review_id=…, publication_outcome=…` — the IFF
 *    CHECK enforces (inline/body_only ⇒ review_id NOT NULL ; degraded ⇒ NULL). Success ladder sets
 *    `INLINE_POSTED` (comments accepted) vs `BODY_ONLY_POSTED`.
 *  - IF LOST → SELECT `github_review_id`, row age, and the persisted `publication_outcome`. NON-NULL
 *    review_id ⇒ a prior winner published: dispatch `updateReview` (idempotent body refresh) and INHERIT
 *    that row's `publication_outcome` (read from the row — NOT hardcoded INLINE_POSTED). NULL review_id ⇒
 *    the winner is still in-flight: if within {@link IN_FLIGHT_WINDOW_SECONDS} (now − posted_at) RAISE
 *    {@link PostReviewTransientError} (Temporal retries); if PAST the window, treat the NULL row as the
 *    terminal degraded marker and return inherited `DEGRADED_UNPOSTED` WITHOUT mutating the row.
 *
 * ## Invariants (load-bearing — CLAUDE.md invariant 12)
 *
 *  1. The activity NEVER raises on `DEGRADED_UNPOSTED` — it is a typed `PostedReviewV1.publication_outcome`
 *     value, NOT an exception. Activity-level RAISE is reserved for: the stale-write guard violation, the
 *     per-call cap breach, GitHub auth/permission errors (propagated from the client), the comment_ids
 *     length-mismatch data-quality invariant, and the in-flight {@link PostReviewTransientError}.
 *  2. comment_ids LENGTH-MISMATCH: `created.commentIds.length` MUST equal the number of kept inline
 *     findings — RAISE if GitHub returned a partial set (a misaligned envelope is a correctness bug;
 *     losing the link is a data-quality regression).
 *  3. The IFF: `publication_outcome === 'degraded_unposted'` ⇔ `github_review_id IS NULL` — enforced
 *     BOTH by the DB CHECK (migration 0061) and the {@link PostedReviewV1} superRefine.
 *  4. `event` is ALWAYS `COMMENT` (hard-coded inside {@link GhReviewClient}; structurally unreachable here).
 *  5. The lost-claim path reads the persisted `publication_outcome` to emit the INHERITED outcome.
 *
 * ## Clock-and-Random Protocol
 *
 * The lost-claim age computation lives in the SELECT (`EXTRACT(EPOCH FROM (now() − posted_at))`) so there
 * is NO JS clock primitive to inject — Postgres `now()` is the source of truth (the same one the Phase-1
 * INSERT's `posted_at DEFAULT now()` used). Faithful to the Python, and replay-safe by construction.
 *
 * ## Runtime context
 *
 * Activities run in the NORMAL Node runtime (NOT the workflow sandbox): real I/O (the ADR-0062 shared
 * pool via {@link tenantKysely}) + the injected {@link GhReviewClient} are available here. The Temporal
 * activity wrapper {@link postReviewResults} resolves the DSN + constructs the production client; the
 * pure state machine {@link doPost} takes both as INJECTED dependencies so the integration test can drive
 * it with a disposable PG + a stub client.
 */

import { sql, type Transaction } from "kysely";

import { ApplicationFailure } from "@temporalio/common";

import { tenantKysely } from "#platform/db/database.js";
import { type Clock, WallClock } from "#platform/clock.js";
import { getMeter, type Counter } from "#platform/observability/metrics.js";

import {
  type CreatedReviewV1,
  type GhReviewClient,
  GitHubApiReviewClient,
  type ReviewComment,
} from "#backend/integrations/github/review_client.js";
import {
  FetchGitHubHttpClient,
  GitHubApiClient,
  GitHubUnprocessableError,
} from "#backend/integrations/github/api_client.js";
import { GitHubAppTokenProvider } from "#backend/integrations/github/token_provider.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";
import { assertCurrentRun } from "#backend/domain/stale_write_guard.js";
import { PendingEmits } from "#backend/infra/post_commit_emit.js";
import { POST_REVIEW_FAILED_WITH_DROPPED_STATE } from "#backend/review/pipeline/posting.js";

import { type CitationV1, type ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import { type PrMetaV1 } from "#contracts/walkthrough.v1.js";
import { type DroppedClassificationV1 } from "#contracts/dropped_classification.v1.js";
import { PostReviewInputV1 } from "#contracts/post_review_input.v1.js";
import { PostedReviewV1, PublicationOutcome } from "#contracts/posted_review.v1.js";

// ─── constants ──────────────────────────────────────────────────────────────────────────────────

/** Per-review inline-comment cap (matches Sprint-8's S8.3.4a per-review cap; the aggregator caps
 *  upstream — this activity asserts the contract on the KEPT (post-filter) set). 1:1 with the Python
 *  `MAX_INLINE_COMMENTS_PER_REVIEW`. */
export const MAX_INLINE_COMMENTS_PER_REVIEW = 50;

/**
 * IN_FLIGHT_WINDOW for the lost-claim path's NULL-row disambiguation (v7-A3). A `core.posted_reviews`
 * row with `github_review_id IS NULL` overloads two meanings: in-flight (winner between Phase 1 and
 * Phase 2 → raise so Temporal retries) vs terminal-degraded (winner double-422'd, left the row NULL by
 * design → return DEGRADED_UNPOSTED). The age cutoff defaults to 300s (5 min); MUST be ≥ the activity's
 * start_to_close_timeout. 1:1 with the Python `_IN_FLIGHT_WINDOW_SECONDS_DEFAULT`.
 */
export const IN_FLIGHT_WINDOW_SECONDS_DEFAULT = 300;

/** The hidden HTML-comment marker embedded in the review body for idempotent re-post lookup. 1:1 with
 *  the Python `_marker_for`. */
export function markerFor(prId: string): string {
  return `<!-- codemaster:review-marker:${prId} -->`;
}

// ─── severity + review-type prefix mapping (Phase 1 PR-1a) ──────────────────────────────────────
// 1:1 with the Python `_SEVERITY_PREFIX` / `_CATEGORY_REVIEW_TYPE` / `_finding_prefix_line`.

const SEVERITY_PREFIX: Readonly<Record<string, string>> = {
  blocker: "🔴 Critical",
  issue: "🟠 Major",
  suggestion: "🟡 Minor",
  nit: "🔵 Trivial",
};

const CATEGORY_REVIEW_TYPE: Readonly<Record<string, string>> = {
  bug: "⚠️ Potential issue",
  security: "⚠️ Potential issue",
  context_breaks_consumer: "⚠️ Potential issue",
  performance: "🛠️ Refactor suggestion",
  style: "🛠️ Refactor suggestion",
  test: "🛠️ Refactor suggestion",
  docs: "🛠️ Refactor suggestion",
  config: "🛠️ Refactor suggestion",
  other: "🛠️ Refactor suggestion",
};

/** The two-token italic header that opens every inline comment. `severity === "nit"` always renders as
 *  "🧹 Nitpick" regardless of category. Defensive lookups keep posting on a future enum bump. 1:1 with
 *  the Python `_finding_prefix_line`. */
function findingPrefixLine(f: ReviewFindingV1): string {
  let reviewType: string;
  if (f.severity === "nit") {
    reviewType = "🧹 Nitpick";
  } else {
    reviewType = CATEGORY_REVIEW_TYPE[f.category] ?? "🛠️ Refactor suggestion";
    if (f.category === "other") {
      console.warn(
        `codemaster.review.category_other finding category='other' (renderer fallback); ` +
          `file=${f.file} start_line=${f.start_line} title=${f.title.slice(0, 80)}`,
      );
    }
  }
  const severityLabel = SEVERITY_PREFIX[f.severity] ?? "🟡 Minor";
  return `_${reviewType}_ | _${severityLabel}_`;
}

// ─── inline source citation (Phase 1 PR-1b) ─────────────────────────────────────────────────────
// 1:1 with the Python `_AUTHORITY_RANK` / `_inline_source_line`.

const AUTHORITY_RANK: Readonly<Record<string, number>> = {
  knowledge_chunk: 0,
  repo_path: 1,
  linter_rule: 2,
};

/** The blockquote inline-citation line for the highest-authority source, or "" when no sources. Shape
 *  `"\n\n> 📎 Source: \`<locator>\`"` so callers can unconditionally concatenate. 1:1 with the Python
 *  `_inline_source_line`. */
function inlineSourceLine(sources: ReadonlyArray<CitationV1>): string {
  if (sources.length === 0) {
    return "";
  }
  // min by authority rank — first occurrence wins ties (matches Python `min(..., key=...)`).
  let top = sources[0]!;
  let topRank = AUTHORITY_RANK[top.kind] ?? 99;
  for (const s of sources) {
    const rank = AUTHORITY_RANK[s.kind] ?? 99;
    if (rank < topRank) {
      top = s;
      topRank = rank;
    }
  }
  return `\n\n> 📎 Source: \`${top.locator}\``;
}

// ─── citation footnote block (render_sources_block — ported inline; Sprint 10 / S10.1.3) ─────────
// 1:1 with the frozen `codemaster/review/citation_renderer.py::render_sources_block`. Ported inline here
// (its sole consumer) rather than as a separate module — the only call site is the inline-comment body.

const KIND_LABEL: Readonly<Record<string, string>> = {
  repo_path: "repo",
  knowledge_chunk: "knowledge",
  linter_rule: "linter",
  policy_rule: "policy",
};

/** Wrap the excerpt in double quotes; escape internal `"` so the markdown stays balanced. */
function formatExcerpt(excerpt: string): string {
  const escaped = excerpt.split('"').join('\\"');
  return `"${escaped}"`;
}

function formatOneCitation(idx: number, c: CitationV1): string {
  const label = KIND_LABEL[c.kind] ?? c.kind;
  let line = `${idx}. **${label}** — \`${c.locator}\``;
  if (c.excerpt) {
    line += `: ${formatExcerpt(c.excerpt)}`;
  }
  return line;
}

/** Render the per-finding footnote block. Returns "" when `sources` is empty (callers concatenate
 *  unconditionally). 1:1 with `render_sources_block`. */
function renderSourcesBlock(sources: ReadonlyArray<CitationV1>): string {
  if (sources.length === 0) {
    return "";
  }
  const body = sources.map((c, i) => formatOneCitation(i + 1, c)).join("\n");
  return `\n\n---\n**Sources:**\n\n${body}`;
}

// ─── inline-comment construction ────────────────────────────────────────────────────────────────
// 1:1 with the Python `_InlineComment` / `_suggestion_block` / `_finding_to_inline_comment` /
// `_serialise_inline`.

/** One inline comment payload before serialisation. `startLine` is only set for multi-line comments. */
type InlineComment = {
  path: string;
  line: number;
  body: string;
  side: "RIGHT";
  startLine: number | null;
  startSide: "RIGHT" | null;
};

/** Wrap a suggestion string in GitHub's suggestion-code-block syntax (renders an apply button). */
function suggestionBlock(suggestion: string): string {
  return `\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
}

function findingToInlineComment(f: ReviewFindingV1): InlineComment {
  const prefix = findingPrefixLine(f);
  let body = `${prefix}\n\n**${f.title}**\n\n${f.body}`;
  body += inlineSourceLine(f.sources);
  if (f.suggestion) {
    body += suggestionBlock(f.suggestion);
  }
  body += renderSourcesBlock(f.sources);
  if (f.start_line === f.end_line) {
    return { path: f.file, line: f.end_line, body, side: "RIGHT", startLine: null, startSide: null };
  }
  return {
    path: f.file,
    line: f.end_line,
    body,
    side: "RIGHT",
    startLine: f.start_line,
    startSide: "RIGHT",
  };
}

/** Serialise an {@link InlineComment} to the GitHub `comments` array shape (a {@link ReviewComment}). */
function serialiseInline(c: InlineComment): ReviewComment {
  const out: Record<string, unknown> = { path: c.path, line: c.line, side: c.side, body: c.body };
  if (c.startLine !== null) {
    out["start_line"] = c.startLine;
    out["start_side"] = c.startSide ?? "RIGHT";
  }
  return out;
}

/** Embed the marker into the walkthrough body. Idempotent (a re-post finds the same marker). 1:1 with
 *  the Python `_build_review_body`. `droppedSectionMd` defaults to "" — when present it begins with the
 *  leading horizontal-rule separator so concatenation is unconditional. */
export function buildReviewBody(args: {
  walkthroughMd: string;
  prId: string;
  droppedSectionMd?: string;
}): string {
  const marker = markerFor(args.prId);
  return `${args.walkthroughMd}\n\n${marker}\n${args.droppedSectionMd ?? ""}`;
}

// ─── finding classifier (diff-window containment) ───────────────────────────────────────────────
// 1:1 with the Python `_classify_findings_against_diff` and its helper predicates. The TS port pins the
// production-default STRICT_CONTAINMENT mode (the OVERLAP_LEGACY emergency-revert env override is not
// wired here — STRICT is the only production-legitimate predicate; restoring the smoke-#82 failure mode
// on a running cluster has no operational use case).

/** EligibilityReason drop-reason vocabulary (1:1 with `codemaster/domain/review_findings/
 *  eligibility_reasons.py::EligibilityReason` .value strings). */
const DROP_FILE_NOT_IN_DIFF = "file_not_in_diff";
const DROP_LINE_AFTER_LAST_HUNK = "line_after_last_hunk";
const DROP_LINE_BEFORE_FIRST_HUNK = "line_before_first_hunk";
const DROP_LINE_SPANS_HUNKS = "line_spans_hunks";
const DROP_LINE_IN_UNCHANGED_GAP = "line_in_unchanged_gap";

type Hunk = readonly [number, number];

type Classification = {
  outcome: "valid" | "dropped";
  finding: ReviewFindingV1;
  dropReason: string | null;
};

/** A finding "spans multiple hunks" iff it overlaps at least this many (two is the minimum span). */
const MIN_HUNKS_FOR_SPAN = 2;

function isBeforeFirstHunk(f: ReviewFindingV1, ranges: ReadonlyArray<Hunk>): boolean {
  return f.start_line < Math.min(...ranges.map(([lo]) => lo));
}

function isAfterLastHunk(f: ReviewFindingV1, ranges: ReadonlyArray<Hunk>): boolean {
  return f.end_line > Math.max(...ranges.map(([, hi]) => hi));
}

function spansMultipleHunks(f: ReviewFindingV1, ranges: ReadonlyArray<Hunk>): boolean {
  const overlaps = ranges.filter(([lo, hi]) => !(f.end_line < lo || f.start_line > hi)).length;
  return overlaps >= MIN_HUNKS_FOR_SPAN;
}

/** Pick the drop reason for a finding that failed strict containment. Priority order is LOAD-BEARING
 *  (before-first → after-last → spans-hunks → in-gap catch-all). 1:1 with `_classify_drop_reason`. */
function classifyDropReason(f: ReviewFindingV1, ranges: ReadonlyArray<Hunk>): string {
  if (isBeforeFirstHunk(f, ranges)) {
    return DROP_LINE_BEFORE_FIRST_HUNK;
  }
  if (isAfterLastHunk(f, ranges)) {
    return DROP_LINE_AFTER_LAST_HUNK;
  }
  if (spansMultipleHunks(f, ranges)) {
    return DROP_LINE_SPANS_HUNKS;
  }
  return DROP_LINE_IN_UNCHANGED_GAP;
}

/** STRICT_CONTAINMENT accept predicate: some `(lo, hi)` satisfies `lo <= start AND end <= hi`. 1:1 with
 *  the Python `_finding_accepted` STRICT_CONTAINMENT branch (the production default). */
function findingAccepted(f: ReviewFindingV1, ranges: ReadonlyArray<Hunk>): boolean {
  return ranges.some(([lo, hi]) => lo <= f.start_line && f.end_line <= hi);
}

/** Classify each finding by whether its coordinates lie fully inside a single diff hunk. Files absent
 *  from `changedLineRanges` → every finding for them is dropped FILE_NOT_IN_DIFF. 1:1 with
 *  `_classify_findings_against_diff` under the default STRICT_CONTAINMENT mode. */
function classifyFindingsAgainstDiff(
  findings: ReadonlyArray<ReviewFindingV1>,
  changedLineRanges: Readonly<Record<string, ReadonlyArray<Hunk>>>,
): Array<Classification> {
  const results: Array<Classification> = [];
  for (const f of findings) {
    // `Object.hasOwn` guards against inherited prototype keys (e.g. a finding whose `file` is
    // "__proto__"/"constructor") resolving to an inherited member — only OWN entries count as a real
    // per-file hunk window. The subsequent access is then a safe own-property read.
    const ranges = Object.hasOwn(changedLineRanges, f.file) ? changedLineRanges[f.file] : undefined;
    if (ranges === undefined || ranges.length === 0) {
      results.push({ outcome: "dropped", finding: f, dropReason: DROP_FILE_NOT_IN_DIFF });
      continue;
    }
    if (findingAccepted(f, ranges)) {
      results.push({ outcome: "valid", finding: f, dropReason: null });
      continue;
    }
    results.push({ outcome: "dropped", finding: f, dropReason: classifyDropReason(f, ranges) });
  }
  return results;
}

// ─── "Additional findings detected" walkthrough section ─────────────────────────────────────────
// 1:1 with the Python dropped-findings section renderer (bucket classifier + caps + char-cap).

type Bucket = "security" | "correctness" | "nits";

const SECURITY_RULE_PREFIXES: ReadonlyArray<string> = [
  "gitleaks:",
  "ruff:S",
  "eslint:security/",
  "eslint:no-eval",
];
const CORRECTNESS_RULE_PREFIXES: ReadonlyArray<string> = [
  "ruff:F",
  "ruff:E9",
  "ruff:B",
  "eslint:no-undef",
  "eslint:no-unused-vars",
];

const BUCKET_HEADERS: Readonly<Record<Bucket, string>> = {
  security: "**Security & secrets**",
  correctness: "**Correctness**",
  nits: "Style & nits",
};

const PER_BUCKET_CAP = 15;
const SECTION_CAP = 30;
const SECTION_CHAR_CAP = 8 * 1024;
const SECTION_CHAR_CAP_SLACK = 256;

/** First `linter_rule` citation's locator, or "" if none. 1:1 with `_rule_id_from_sources`. */
function ruleIdFromSources(sources: ReadonlyArray<CitationV1>): string {
  for (const s of sources) {
    if (s.kind === "linter_rule") {
      return s.locator;
    }
  }
  return "";
}

/** Map a finding to its walkthrough-section bucket (category signal beats rule-id heuristic). 1:1 with
 *  `_finding_bucket`. */
function findingBucket(finding: ReviewFindingV1): Bucket {
  if (finding.category === "security") {
    return "security";
  }
  if (finding.category === "bug" || finding.category === "context_breaks_consumer") {
    return "correctness";
  }
  const ruleId = ruleIdFromSources(finding.sources);
  if (SECURITY_RULE_PREFIXES.some((p) => ruleId.startsWith(p))) {
    return "security";
  }
  if (CORRECTNESS_RULE_PREFIXES.some((p) => ruleId.startsWith(p))) {
    return "correctness";
  }
  return "nits";
}

/** Minimal markdown escape for link-text / code-span content. 1:1 with `_md_escape_text`. */
function mdEscapeText(s: string): string {
  return s
    .split("\\")
    .join("\\\\")
    .split("]")
    .join("\\]")
    .split("`")
    .join("\\`")
    .split("\n")
    .join(" ");
}

/** GitHub blob URL anchoring at `path#Lline`; falls back to HEAD when `headSha` is empty. 1:1 with
 *  `_deep_link`. */
function deepLink(args: {
  owner: string;
  repo: string;
  headSha: string;
  path: string;
  line: number;
}): string {
  const ref = args.headSha !== "" ? args.headSha : "HEAD";
  return `https://github.com/${args.owner}/${args.repo}/blob/${ref}/${args.path}#L${args.line}`;
}

/** One bullet line for a dropped finding. 1:1 with `_render_bullet_line`. */
function renderBulletLine(
  finding: ReviewFindingV1,
  ctx: { owner: string; repo: string; headSha: string },
): string {
  const link = deepLink({
    owner: ctx.owner,
    repo: ctx.repo,
    headSha: ctx.headSha,
    path: finding.file,
    line: finding.start_line,
  });
  const ruleId = ruleIdFromSources(finding.sources);
  const ruleSegment = ruleId !== "" ? ` · ${ruleId}` : "";
  const safeFile = mdEscapeText(finding.file);
  const safeTitle = mdEscapeText(finding.title);
  return `- [\`${safeFile}:${finding.start_line}\`](${link})${ruleSegment} — ${safeTitle}`;
}

/** Render SECURITY or CORRECTNESS bucket lines. 1:1 with `_render_top_bucket_lines`. */
function renderTopBucketLines(args: {
  bucket: Bucket;
  items: ReadonlyArray<ReviewFindingV1>;
  truncationCount: number;
  owner: string;
  repo: string;
  headSha: string;
}): Array<string> {
  const ctx = { owner: args.owner, repo: args.repo, headSha: args.headSha };
  const out: Array<string> = [`${BUCKET_HEADERS[args.bucket]} (${args.items.length})`, ""];
  for (const f of args.items.slice(0, PER_BUCKET_CAP)) {
    out.push(renderBulletLine(f, ctx));
  }
  if (args.truncationCount > 0) {
    out.push(`- _… and ${args.truncationCount} more in the database_`);
  }
  out.push("");
  return out;
}

/** Render the NITS bucket (collapsed `<details>` block, or a one-line overflow notice under section-cap
 *  pressure). 1:1 with `_render_nits_lines`. */
function renderNitsLines(args: {
  nits: ReadonlyArray<ReviewFindingV1>;
  suppressItems: boolean;
  truncationCount: number;
  owner: string;
  repo: string;
  headSha: string;
}): Array<string> {
  if (args.suppressItems) {
    return [
      `_${BUCKET_HEADERS["nits"]} (${args.nits.length}) — ${args.nits.length} more in the database_`,
      "",
    ];
  }
  const ctx = { owner: args.owner, repo: args.repo, headSha: args.headSha };
  const out: Array<string> = [
    `<details><summary>${BUCKET_HEADERS["nits"]} (${args.nits.length}) — click to expand</summary>`,
    "",
  ];
  for (const f of args.nits.slice(0, PER_BUCKET_CAP)) {
    out.push(renderBulletLine(f, ctx));
  }
  if (args.truncationCount > 0) {
    out.push(`- _… and ${args.truncationCount} more in the database_`);
  }
  out.push("");
  out.push("</details>");
  out.push("");
  return out;
}

/** Hard byte-truncate when over the section char cap; re-balances any unclosed `<details>`. 1:1 with
 *  `_apply_character_cap` (measures UTF-8 BYTES, not chars). */
function applyCharacterCap(rendered: string): string {
  const encoded = Buffer.from(rendered, "utf-8");
  if (encoded.length <= SECTION_CHAR_CAP) {
    return rendered;
  }
  const budget = SECTION_CHAR_CAP - SECTION_CHAR_CAP_SLACK;
  // Decode with the lossy default (errors="ignore" analogue): slicing mid-codepoint yields U+FFFD; we
  // strip trailing replacement chars to mirror Python's "drop the partial trailing codepoint".
  let truncated = encoded.subarray(0, budget).toString("utf-8");
  truncated = truncated.replace(/�+$/u, "");
  let footer =
    "\n\n_… section truncated; remaining findings recorded in the review database._";
  const openCount =
    (truncated.match(/<details>/g) ?? []).length - (truncated.match(/<\/details>/g) ?? []).length;
  if (openCount > 0) {
    footer += "\n</details>".repeat(openCount);
  }
  return truncated + footer;
}

/** Render the 'Additional findings detected' walkthrough section from DROPPED classifications. Returns
 *  "" when zero are dropped (caller omits both the rule and the section). 1:1 with
 *  `_render_dropped_findings_section`. */
function renderDroppedFindingsSection(args: {
  classifications: ReadonlyArray<Classification>;
  owner: string;
  repo: string;
  headSha: string;
}): string {
  const dropped = args.classifications.filter((c) => c.outcome === "dropped");
  if (dropped.length === 0) {
    return "";
  }

  const byBucket: Record<Bucket, Array<ReviewFindingV1>> = {
    security: [],
    correctness: [],
    nits: [],
  };
  for (const c of dropped) {
    byBucket[findingBucket(c.finding)].push(c.finding);
  }

  const truncations: Record<Bucket, number> = {
    security: Math.max(0, byBucket.security.length - PER_BUCKET_CAP),
    correctness: Math.max(0, byBucket.correctness.length - PER_BUCKET_CAP),
    nits: Math.max(0, byBucket.nits.length - PER_BUCKET_CAP),
  };

  const total = byBucket.security.length + byBucket.correctness.length + byBucket.nits.length;
  const suppressNitsItems = total > SECTION_CAP;

  const lines: Array<string> = [
    "\n---\n",
    `### Additional findings detected (${dropped.length})`,
    "",
    "These findings were detected during review but could not be attached to inline comments automatically.",
    "",
  ];

  for (const bucket of ["security", "correctness"] as const) {
    // eslint-disable-next-line security/detect-object-injection -- bucket is a bounded const literal union.
    const bucketFindings = byBucket[bucket];
    if (bucketFindings.length === 0) {
      continue;
    }
    lines.push(
      ...renderTopBucketLines({
        bucket,
        items: bucketFindings,
        // eslint-disable-next-line security/detect-object-injection -- bucket is a bounded const literal union.
        truncationCount: truncations[bucket],
        owner: args.owner,
        repo: args.repo,
        headSha: args.headSha,
      }),
    );
  }

  const nits = byBucket.nits;
  if (nits.length > 0) {
    lines.push(
      ...renderNitsLines({
        nits,
        suppressItems: suppressNitsItems,
        truncationCount: truncations.nits,
        owner: args.owner,
        repo: args.repo,
        headSha: args.headSha,
      }),
    );
  }

  return applyCharacterCap(lines.join("\n"));
}

// ─── typed errors ───────────────────────────────────────────────────────────────────────────────

/** The PR was closed between workflow start + this post (GitHub 422). 1:1 with `PrClosedError`. */
export class PrClosedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PrClosedError";
  }
}

/** codemaster lacks pull_requests:write on this repo (GitHub 403/401). 1:1 with
 *  `PostReviewPermissionError`. */
export class PostReviewPermissionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PostReviewPermissionError";
  }
}

/** GitHub 5xx / lost-claim in-flight / DB-inconsistency; caller (Temporal) should retry. 1:1 with
 *  `PostReviewTransientError`. */
export class PostReviewTransientError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PostReviewTransientError";
  }
}

// ─── publication ladder (inline → body-only fallback) ───────────────────────────────────────────

/** Outcome of the publication ladder. `created === null` IFF both attempts raised
 *  GitHubUnprocessableError (the caller then returns DEGRADED_UNPOSTED). 1:1 with `_PublicationAttempt`. */
type PublicationAttempt = {
  created: CreatedReviewV1 | null;
  inlineSucceeded: boolean;
  degradationNotes: ReadonlyArray<string>;
};

/**
 * Publication ladder (v7-A3): POST with inline comments → on GitHub 422 retry body-only (comments=[])
 * → on a SECOND 422 return `{ created: null, … }` so the caller returns DEGRADED_UNPOSTED WITHOUT
 * raising. Non-422 errors (5xx, network, auth) PROPAGATE normally (the caller's `doPost` wraps them per
 * H-2). 1:1 with `_attempt_create_with_body_only_fallback`.
 */
export async function attemptCreateWithBodyOnlyFallback(args: {
  ghClient: GhReviewClient;
  owner: string;
  repoName: string;
  prNumber: number;
  body: string;
  headSha: string;
  inlinePayload: ReadonlyArray<ReviewComment>;
  prMeta: PrMetaV1;
}): Promise<PublicationAttempt> {
  const notes: Array<string> = [];
  try {
    const created = await args.ghClient.createReview({
      owner: args.owner,
      repo: args.repoName,
      prNumber: args.prNumber,
      body: args.body,
      commitId: args.headSha,
      comments: args.inlinePayload,
    });
    return { created, inlineSucceeded: true, degradationNotes: [] };
  } catch (inline422Exc) {
    if (!(inline422Exc instanceof GitHubUnprocessableError)) {
      throw inline422Exc; // non-422 propagates (5xx / network / auth) — caller wraps it.
    }
    console.warn(
      `post_review_results: GitHub 422 on inline-comments POST; retrying body-only (comments=[]) ` +
        `pr_id=${args.prMeta.pr_id} inline_comment_count=${args.inlinePayload.length} ` +
        `error=${String(inline422Exc).slice(0, 200)}`,
    );
    notes.push("github_422_on_inline_post");
  }

  try {
    const created = await args.ghClient.createReview({
      owner: args.owner,
      repo: args.repoName,
      prNumber: args.prNumber,
      body: args.body,
      commitId: args.headSha,
      comments: [],
    });
    return { created, inlineSucceeded: false, degradationNotes: [...notes] };
  } catch (bodyOnly422Exc) {
    if (!(bodyOnly422Exc instanceof GitHubUnprocessableError)) {
      throw bodyOnly422Exc; // non-422 on the retry also propagates.
    }
    console.warn(
      `post_review_results: GitHub 422 on body-only retry; returning DEGRADED_UNPOSTED ` +
        `pr_id=${args.prMeta.pr_id} error=${String(bodyOnly422Exc).slice(0, 200)}`,
    );
    notes.push("github_422_on_body_only_retry");
    return { created: null, inlineSucceeded: false, degradationNotes: [...notes] };
  }
}

// ─── best-effort OTel counters (publication outcome + drop reasons) ──────────────────────────────
// 1:1 with `record_post_review_publication_total` / `record_findings_dropped_outside_diff`. Best-effort:
// failures are swallowed; the activity NEVER blocks on observability. Counters are emitted INLINE (NOT
// via PendingEmits) exactly as the Python does — these are terminal-outcome signals, not txn-coupled.
//
// NOTE: the Python uses `installation_id` + `repo` as labels. The TS metric-seam convention prefers
// bounded-cardinality labels only, but parity with the Python wire-shape is preserved here (faithful
// port). The cardinality tightening is a separate observability concern, not this activity's job.

const POST_REVIEW_PUBLICATION_COUNTER: Counter = getMeter(
  "codemaster.activities.post_review_results",
).createCounter("codemaster_post_review_publication_total", {
  description:
    "Terminal publication outcome of post_review_results. Labels: installation_id, repo, " +
    "outcome ∈ {inline_posted, body_only_posted, degraded_unposted}.",
});

const FINDINGS_DROPPED_OUTSIDE_DIFF_COUNTER: Counter = getMeter(
  "codemaster.activities.post_review_results",
).createCounter("codemaster_findings_dropped_outside_diff_total", {
  description:
    "Findings dropped at the diff-window classifier (would silently 422 at GitHub). " +
    "Labels: installation_id, repo, drop_reason.",
});

/** Best-effort emit of the publication-outcome counter. 1:1 with `_record_publication_outcome`. */
function recordPublicationOutcome(prMeta: PrMetaV1, outcome: PublicationOutcome): void {
  try {
    POST_REVIEW_PUBLICATION_COUNTER.add(1, {
      installation_id: prMeta.installation_id,
      repo: prMeta.repo,
      outcome,
    });
  } catch (metricErr) {
    console.debug("post_review_results: publication metric emit failed", metricErr);
  }
}

/** Dual-emit the dropped-findings counter (legacy aggregated label + per-reason labels). Each emit is
 *  independent best-effort. 1:1 with `_emit_drop_metrics`. */
function emitDropMetrics(args: {
  installationId: string;
  repo: string;
  droppedByReason: ReadonlyMap<string, number>;
}): void {
  if (args.droppedByReason.size === 0) {
    return;
  }
  let total = 0;
  for (const n of args.droppedByReason.values()) {
    total += n;
  }
  try {
    FINDINGS_DROPPED_OUTSIDE_DIFF_COUNTER.add(total, {
      installation_id: args.installationId,
      repo: args.repo,
      drop_reason: "line_outside_hunk_window",
    });
  } catch (metricErr) {
    console.debug("post_review_results: legacy aggregated metric emit failed", metricErr);
  }
  for (const [reason, count] of args.droppedByReason) {
    try {
      FINDINGS_DROPPED_OUTSIDE_DIFF_COUNTER.add(count, {
        installation_id: args.installationId,
        repo: args.repo,
        drop_reason: reason,
      });
    } catch (metricErr) {
      console.debug("post_review_results: per-reason metric emit failed", metricErr);
    }
  }
}

// ─── doPost — the 2-phase atomic-claim state machine ─────────────────────────────────────────────

/**
 * The JSON-safe dropped-state details packed into the {@link ApplicationFailure}.details[0] the publication
 * ladder raises when GitHub fails AFTER the classifier partitioned findings into kept/dropped (H-2). 1:1
 * with the frozen Python `_build_dropped_state_details` return shape: `dropped_classifications` as a list of
 * `{schema_version, index, eligibility_reason}` dicts, `kept_finding_indices` as int[], and
 * `posted_review_pr_id` as a string. The workflow-body handler ({@link extractDroppedStateFromPostFailure}
 * in posting.ts) reads exactly this shape to dispatch `record_delivery_skipped` for the dropped rows.
 */
function buildDroppedStateDetails(args: {
  droppedClassifications: ReadonlyArray<DroppedClassificationV1>;
  keptIndices: ReadonlyArray<number>;
  postedReviewPrId: string;
}): {
  dropped_classifications: Array<DroppedClassificationV1>;
  kept_finding_indices: Array<number>;
  posted_review_pr_id: string;
} {
  return {
    // The DroppedClassificationV1 entries are already JSON-safe Zod objects (= the Python model_dump shape);
    // spread to a fresh array so the details payload is an own-property array Temporal's converter serializes.
    dropped_classifications: [...args.droppedClassifications],
    kept_finding_indices: [...args.keptIndices],
    posted_review_pr_id: args.postedReviewPrId,
  };
}

/** Dependencies injected into {@link doPost} (the production wrapper resolves these; the test stubs them). */
export type DoPostDeps = {
  /** The GitHub Reviews-API client (production: {@link GitHubApiReviewClient}; test: a scripted stub). */
  ghClient: GhReviewClient;
  /** The DSN for the ADR-0062 shared pool the claim/persist transactions run against. */
  dsn: string;
  /** Injected clock — only threaded into {@link assertCurrentRun}'s forensic emit (the lost-claim age
   *  computation uses Postgres `now()`, NOT this clock — Clock-and-Random Protocol). */
  clock?: Clock;
  /** Override the IN_FLIGHT_WINDOW (seconds). Defaults to {@link IN_FLIGHT_WINDOW_SECONDS_DEFAULT}. */
  inFlightWindowSeconds?: number;
};

/**
 * Post (or update) the review on GitHub, atomically claiming the PR so two concurrent Temporal retries
 * cannot both POST. The full Sprint-14.D 2-phase flow + the v7 publication-outcome state machine. 1:1
 * with the frozen Python `_do_post`.
 */
export async function doPost(input: PostReviewInputV1, deps: DoPostDeps): Promise<PostedReviewV1> {
  const {
    aggregated,
    pr_meta: prMeta,
    head_sha: headSha,
    walkthrough_md: walkthroughMd,
    owner,
    repo_name: repoName,
    pr_number: prNumber,
    run_id: runId,
    review_id: reviewId,
    changed_line_ranges: changedLineRanges,
  } = input;
  const ghClient = deps.ghClient;
  const inFlightWindow = deps.inFlightWindowSeconds ?? IN_FLIGHT_WINDOW_SECONDS_DEFAULT;
  const db = tenantKysely<unknown>(deps.dsn);

  // D2 — line-in-diff guard. Drop findings whose lines fall outside the PR's post-image hunk window
  // BEFORE the cap check and BEFORE the inline_payload build. `keptIndices` is the rfid → comment_id
  // pairing key the workflow body reads to construct the finalize payload.
  const classifications = classifyFindingsAgainstDiff(
    aggregated.findings,
    changedLineRanges as Readonly<Record<string, ReadonlyArray<Hunk>>>,
  );
  const keptFindings = classifications.filter((c) => c.outcome === "valid").map((c) => c.finding);
  const keptIndices = classifications
    .map((c, i) => (c.outcome === "valid" ? i : -1))
    .filter((i) => i >= 0);

  const droppedByReason = new Map<string, number>();
  for (const c of classifications) {
    if (c.outcome === "dropped" && c.dropReason !== null) {
      droppedByReason.set(c.dropReason, (droppedByReason.get(c.dropReason) ?? 0) + 1);
    }
  }
  let droppedCount = 0;
  for (const n of droppedByReason.values()) {
    droppedCount += n;
  }

  // B.9 — additive lifecycle surface. Build the DroppedClassificationV1 tuple ONCE; it flows into every
  // PostedReviewV1 return path below.
  const droppedClassifications: Array<DroppedClassificationV1> = classifications
    .map((c, i): DroppedClassificationV1 | null =>
      c.outcome === "dropped" && c.dropReason !== null
        ? { schema_version: 1, index: i, eligibility_reason: c.dropReason }
        : null,
    )
    .filter((dc): dc is DroppedClassificationV1 => dc !== null);

  if (droppedCount > 0) {
    console.warn(
      `post_review_results: dropped ${droppedCount} finding(s) outside PR hunk window ` +
        `(would silently 422 at GitHub) kept_count=${keptFindings.length} ` +
        `aggregated_count=${aggregated.findings.length} repo=${prMeta.repo} pr_id=${prMeta.pr_id}`,
    );
    emitDropMetrics({
      installationId: prMeta.installation_id,
      repo: prMeta.repo,
      droppedByReason,
    });
  }

  // R4 — cap check runs on KEPT findings (post-filter), NOT raw aggregated.findings.
  if (keptFindings.length > MAX_INLINE_COMMENTS_PER_REVIEW) {
    throw new Error(
      `kept_findings (${keptFindings.length}) exceeds per-review cap ` +
        `${MAX_INLINE_COMMENTS_PER_REVIEW}; the aggregator (S8.3.4a) was supposed to cap upstream.`,
    );
  }

  // Render the 'Additional findings detected' section. Defensive try/catch: a renderer fault logs WARN
  // and posts the review WITHOUT the section (bookkeeping failures don't pre-empt the user-visible post).
  let droppedSectionMd: string;
  try {
    droppedSectionMd = renderDroppedFindingsSection({
      classifications,
      owner,
      repo: repoName,
      headSha,
    });
  } catch (e) {
    console.warn(
      `post_review_results: dropped-section render failed; posting review WITHOUT section ` +
        `error_class=${e instanceof Error ? e.name : typeof e} pr_id=${prMeta.pr_id} repo=${prMeta.repo}`,
    );
    droppedSectionMd = "";
  }

  const marker = markerFor(prMeta.pr_id);
  const body = buildReviewBody({ walkthroughMd, prId: prMeta.pr_id, droppedSectionMd });
  const inlinePayload: Array<ReviewComment> = keptFindings.map((f) =>
    serialiseInline(findingToInlineComment(f)),
  );

  // ── Phase 1: atomic claim. assertCurrentRun (AD-4 guard, in a SAVEPOINT) THEN the ON CONFLICT INSERT,
  //    in ONE transaction. The Phase-1 INSERT omits github_review_id + publication_outcome → relies on
  //    the column DEFAULTs (NULL / 'degraded_unposted'), which satisfy the IFF CHECK as a placeholder. ──
  const pending = new PendingEmits();
  let wonClaim = false;
  await db.transaction().execute(async (txTyped) => {
    const tx = txTyped as unknown as Transaction<unknown>;

    // AD-4 stale-write guard inside a raw SAVEPOINT (1:1 with the Python begin_nested + sp.commit on
    // error). RELEASE — not ROLLBACK TO — on a throw so the guard's STALE_WRITE_BLOCKED INSERT is merged
    // into the outer transaction, then the throw propagates out of .execute() → outer rollback (so a
    // superseded run wins NEITHER the claim NOR — at the outer level — the merged forensic row).
    await sql`SAVEPOINT sp_post_review_claim`.execute(tx);
    try {
      await assertCurrentRun({
        tx,
        runId,
        reviewId,
        site: "post_review_results._do_post",
        pending,
        ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
      });
    } catch (err) {
      await sql`RELEASE SAVEPOINT sp_post_review_claim`.execute(tx);
      throw err; // StaleWriteError → outer rollback; no claim won.
    }
    await sql`RELEASE SAVEPOINT sp_post_review_claim`.execute(tx);

    // tenant:exempt reason=posted-reviews-keyed-by-pr-id-pk follow_up=FOLLOW-UP-gf3-error-mode
    const claim = await sql<{ pr_id: string }>`
      INSERT INTO core.posted_reviews (pr_id, marker)
      VALUES (${prMeta.pr_id}, ${marker})
      ON CONFLICT (pr_id) DO NOTHING
      RETURNING pr_id
    `.execute(tx);
    wonClaim = claim.rows[0] !== undefined;
  });
  // Drain the guard's queued counter (no-op on the happy path; it only queues on a mismatch, which would
  // have thrown above and never reached here).
  pending.drain();

  if (wonClaim) {
    // ── WON the claim: run the publication ladder (HTTP, no DB tx held). ──
    // H-2 (1:1 with the Python `_do_post` won-claim try/except): wrap ONLY the publication ladder so a
    // non-422 failure (5xx after retries, network error, auth error, etc.) converts into a typed
    // ApplicationFailure carrying the classifier output. The workflow body's `postReviewResults` closure
    // reads `appErr.details[0]` (via extractDroppedStateFromPostFailure) to dispatch
    // record_delivery_skipped for the dropped findings — without this payload-preservation the
    // classifier-dropped findings stay stuck at PERSISTED with delivery_outcome IS NULL forever.
    // The narrow win is the STRUCTURAL guarantee that any ladder failure carries classifier state — NOT
    // an exception-type whitelist. `droppedClassifications`, `keptIndices`, and `prMeta.pr_id` were all
    // computed BEFORE the atomic claim INSERT above, so they're in scope on every code path here.
    // Boundary: the double-422 DEGRADED case is a RETURN value (`attempt.created === null`), NOT a throw,
    // so it falls OUTSIDE this try — only a thrown non-422 ladder error is wrapped (matching Python).
    let attempt: PublicationAttempt;
    try {
      attempt = await attemptCreateWithBodyOnlyFallback({
        ghClient,
        owner,
        repoName,
        prNumber,
        body,
        headSha,
        inlinePayload,
        prMeta,
      });
    } catch (e) {
      throw ApplicationFailure.create({
        message: "post-review failed; classifier state preserved for skip-dispatch",
        type: POST_REVIEW_FAILED_WITH_DROPPED_STATE,
        // nonRetryable LEFT DEFAULT (false): the contract we OWN is the payload-preservation, NOT the
        // retry semantics; the workflow's retry policy controls the retry decision (1:1 with Python).
        nonRetryable: false,
        details: [
          buildDroppedStateDetails({
            droppedClassifications,
            keptIndices,
            postedReviewPrId: prMeta.pr_id,
          }),
        ],
        ...(e instanceof Error ? { cause: e } : {}),
      });
    }

    if (attempt.created === null) {
      // Double 422 — return DEGRADED_UNPOSTED WITHOUT raising. The row keeps github_review_id NULL (the
      // degraded marker); a single-column UPDATE sets publication_outcome='degraded_unposted' so the
      // lost-claim path can emit the inherited outcome. The IFF CHECK enforces degraded ↔ review_id NULL,
      // so this metadata UPDATE is a no-op for invariant purposes (ownership stays with the owner).
      await db.transaction().execute(async (txTyped) => {
        const tx = txTyped as unknown as Transaction<unknown>;
        // tenant:exempt reason=posted-reviews-keyed-by-pr-id-pk follow_up=FOLLOW-UP-gf3-error-mode
        await sql`
          UPDATE core.posted_reviews
             SET publication_outcome = ${PublicationOutcome.enum.degraded_unposted},
                 updated_at = now()
           WHERE pr_id = ${prMeta.pr_id}
        `.execute(tx);
      });
      recordPublicationOutcome(prMeta, PublicationOutcome.enum.degraded_unposted);
      return PostedReviewV1.parse({
        review_id: null,
        marker_comment_id: null,
        was_update: false,
        inline_comment_count: 0,
        // F1: emit kept_finding_indices so the workflow body's degraded sweep has rfids to flip. No
        // comments were posted (both attempts 422'd) so comment_ids stays empty.
        kept_finding_indices: keptIndices,
        publication_outcome: PublicationOutcome.enum.degraded_unposted,
        degradation_notes: attempt.degradationNotes,
        dropped_classifications: droppedClassifications,
      });
    }

    const created = attempt.created;
    const inlineSucceeded = attempt.inlineSucceeded;
    const degradationNotes = [...attempt.degradationNotes];

    let outcome: PublicationOutcome;
    let responseInlineCount: number;
    let responseCommentIds: ReadonlyArray<number>;
    const responseKeptIndices = keptIndices;

    if (inlineSucceeded) {
      // D1 — pairing invariant. GitHub returns one comment object per inline comment sent (in payload
      // order). A partial response is a data-quality regression but shipping a misaligned envelope is a
      // correctness bug — fail fast. (No publication-outcome emit here: this raise reaches the workflow
      // body's stage_outcome surface; the publication metric is reserved for terminal outcomes.)
      if (created.commentIds.length !== keptFindings.length) {
        throw new Error(
          `comment_ids length mismatch: GitHub returned ${created.commentIds.length} comment IDs ` +
            `for ${keptFindings.length} inline comments sent`,
        );
      }
      outcome = PublicationOutcome.enum.inline_posted;
      responseInlineCount = inlinePayload.length;
      responseCommentIds = created.commentIds;
    } else {
      outcome = PublicationOutcome.enum.body_only_posted;
      responseInlineCount = 0;
      responseCommentIds = [];
    }

    // ── Phase 2: persist github_review_id + publication_outcome so subsequent callers dispatch the
    //    update path AND emit the inherited outcome. The UPDATE is idempotent (single-PK row). ──
    await db.transaction().execute(async (txTyped) => {
      const tx = txTyped as unknown as Transaction<unknown>;
      // tenant:exempt reason=posted-reviews-keyed-by-pr-id-pk follow_up=FOLLOW-UP-gf3-error-mode
      await sql`
        UPDATE core.posted_reviews
           SET github_review_id = ${created.reviewId},
               publication_outcome = ${outcome},
               updated_at = now()
         WHERE pr_id = ${prMeta.pr_id}
      `.execute(tx);
    });
    recordPublicationOutcome(prMeta, outcome);
    return PostedReviewV1.parse({
      review_id: created.reviewId,
      marker_comment_id: null,
      was_update: false,
      inline_comment_count: responseInlineCount,
      comment_ids: responseCommentIds,
      kept_finding_indices: responseKeptIndices,
      publication_outcome: outcome,
      degradation_notes: degradationNotes,
      dropped_classifications: droppedClassifications,
    });
  }

  // ── LOST the claim: read the existing github_review_id, row age, and persisted publication_outcome. ──
  // The age computation lives in the SELECT (Postgres now() − posted_at) so there is no JS clock primitive
  // to inject (Clock-and-Random Protocol — same now() the INSERT's posted_at DEFAULT used).
  // tenant:exempt reason=posted-reviews-keyed-by-pr-id-pk follow_up=FOLLOW-UP-gf3-error-mode
  const existing = await sql<{
    github_review_id: string | number | null;
    age_seconds: string | number | null;
    publication_outcome: string | null;
  }>`
    SELECT github_review_id,
           EXTRACT(EPOCH FROM (now() - posted_at)) AS age_seconds,
           publication_outcome
      FROM core.posted_reviews
     WHERE pr_id = ${prMeta.pr_id}
  `.execute(db);
  const row = existing.rows[0];

  if (row === undefined) {
    // Row vanished between INSERT and SELECT — operator cleanup, RLS misconfig, or test flake. Fail
    // closed so Temporal retries rather than silently no-op.
    throw new PostReviewTransientError(
      `core.posted_reviews row for pr_id=${prMeta.pr_id} not found after losing the atomic claim — ` +
        `DB inconsistency`,
    );
  }

  // github_review_id is bigint → pg may surface it as a string; normalize to number | null.
  const githubReviewId: number | null =
    row.github_review_id === null ? null : Number(row.github_review_id);
  const ageSeconds: number = Number(row.age_seconds ?? 0);
  const persistedOutcomeStr: string | null = row.publication_outcome;

  if (githubReviewId === null) {
    // v7-A3: disambiguate in-flight from terminal-degraded by row age. Within window → legitimate winner
    // in flight (raise; Temporal retries). Past window → the prior winner double-422'd and left the row
    // NULL by design → return degraded WITHOUT raising and WITHOUT mutating the row.
    if (ageSeconds < inFlightWindow) {
      throw new PostReviewTransientError(
        `core.posted_reviews row for pr_id=${prMeta.pr_id} is still NULL ` +
          `(age=${ageSeconds.toFixed(0)}s < window=${inFlightWindow}s) — concurrent caller is ` +
          `creating the review; Temporal will retry`,
      );
    }
    console.warn(
      `post_review_results: lost-claim path observed terminal-degraded row ` +
        `(age=${ageSeconds.toFixed(0)}s >= window=${inFlightWindow}s); returning DEGRADED_UNPOSTED ` +
        `without mutating the row (ownership preserved on original owner) pr_id=${prMeta.pr_id}`,
    );
    recordPublicationOutcome(prMeta, PublicationOutcome.enum.degraded_unposted);
    return PostedReviewV1.parse({
      review_id: null,
      marker_comment_id: null,
      was_update: false,
      inline_comment_count: 0,
      // C-3: emit kept_finding_indices so the workflow body's degraded sweep has rfids to flip.
      kept_finding_indices: keptIndices,
      publication_outcome: PublicationOutcome.enum.degraded_unposted,
      degradation_notes: ["prior_workflow_terminal_uncertainty"],
      dropped_classifications: droppedClassifications,
    });
  }

  // A prior winner published. Dispatch the idempotent body-refresh update. H-2 (1:1 with the Python
  // lost-claim try/except): wrap ONLY the update_review call so a GitHub-side failure on the update path
  // ALSO preserves classifier state via ApplicationFailure.details — same shape + same payload as the
  // won-claim wrap above. The classifier output is IDENTICAL here: this branch uses the SAME
  // `keptIndices` + `droppedClassifications` computed at the top of doPost (BEFORE the atomic claim), so
  // the state survives both publication paths. The message carries the "(update path)" variant per Python.
  try {
    await ghClient.updateReview({
      owner,
      repo: repoName,
      prNumber,
      reviewId: githubReviewId,
      body,
    });
  } catch (e) {
    throw ApplicationFailure.create({
      message: "post-review failed (update path); classifier state preserved for skip-dispatch",
      type: POST_REVIEW_FAILED_WITH_DROPPED_STATE,
      // nonRetryable LEFT DEFAULT (false) — same rationale as the won-claim wrap (1:1 with Python).
      nonRetryable: false,
      details: [
        buildDroppedStateDetails({
          droppedClassifications,
          keptIndices,
          postedReviewPrId: prMeta.pr_id,
        }),
      ],
      ...(e instanceof Error ? { cause: e } : {}),
    });
  }

  // v7-rem R-10: emit the INHERITED outcome the prior workflow persisted on the row (NOT a hardcoded
  // INLINE_POSTED — a body-only fallback that succeeded earlier persists 'body_only_posted'). Defensive
  // fallback to INLINE_POSTED if the column is somehow NULL (NOT NULL in production).
  const inheritedOutcome: PublicationOutcome =
    persistedOutcomeStr !== null
      ? PublicationOutcome.parse(persistedOutcomeStr)
      : PublicationOutcome.enum.inline_posted;
  recordPublicationOutcome(prMeta, inheritedOutcome);
  return PostedReviewV1.parse({
    review_id: githubReviewId,
    marker_comment_id: null,
    was_update: true,
    inline_comment_count: inlinePayload.length,
    // C-3: emit kept_finding_indices so the workflow body's degraded sweep has rfids to flip when the
    // inherited outcome is body_only_posted.
    kept_finding_indices: keptIndices,
    publication_outcome: inheritedOutcome,
    dropped_classifications: droppedClassifications,
  });
}

// ─── Temporal activity entry point ───────────────────────────────────────────────────────────────

/**
 * Read + validate `CODEMASTER_GITHUB_INSTALLATION_ID` (the numeric GitHub App installation id this pod
 * authenticates as). 1:1 with the sibling `post_check_run.activity.ts::readGithubInstallationId` (which
 * mirrors the frozen Python `_read_github_installation_id`). Static `process.env.X` access (no dynamic
 * indexing) so no object-injection sink is introduced.
 */
function readGithubInstallationId(): number {
  const raw = process.env.CODEMASTER_GITHUB_INSTALLATION_ID;
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "CODEMASTER_GITHUB_INSTALLATION_ID env var is required for the post_review_results activity. " +
        "Set it to the numeric GitHub App installation id this pod authenticates as.",
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(
      `CODEMASTER_GITHUB_INSTALLATION_ID must be an integer; got ${JSON.stringify(raw)}`,
    );
  }
  if (value <= 0) {
    throw new Error(`CODEMASTER_GITHUB_INSTALLATION_ID must be >= 1; got ${value}`);
  }
  return value;
}

/**
 * The registered `post_review_results` Temporal activity (single typed-input envelope per CLAUDE.md
 * invariant 11). Resolves the DSN from `CODEMASTER_PG_CORE_DSN` + the numeric GitHub installation id from
 * `CODEMASTER_GITHUB_INSTALLATION_ID`, constructs the production {@link GitHubApiReviewClient} over a
 * {@link GitHubApiClient} (Vault token provider + the shared GitHub HTTP transport), and delegates to
 * {@link doPost}. Mirrors the sibling `postCheckRun` wiring (ONE token provider → ONE GitHubApiClient →
 * wrapped client) and is 1:1 in intent with the frozen Python `PostReviewActivity.post_review_results`.
 */
export async function postReviewResults(input: PostReviewInputV1): Promise<PostedReviewV1> {
  const parsed = PostReviewInputV1.parse(input);
  const dsn = process.env.CODEMASTER_PG_CORE_DSN;
  if (dsn === undefined || dsn === "") {
    throw new Error(
      "CODEMASTER_PG_CORE_DSN is not set; cannot run the post_review_results atomic claim",
    );
  }
  const installationId = readGithubInstallationId();
  const clock = new WallClock();
  // One GitHub HTTP transport shared by the token-provider's JWT→installation-token mint AND the
  // GitHubApiClient's review calls (mirrors the frozen-Python worker passing one `_http_client` to both).
  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({ vault, http: githubHttp, clock });
  const api = new GitHubApiClient({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    http: githubHttp,
    clock,
  });
  const ghClient = new GitHubApiReviewClient({ api, installationId });

  return doPost(parsed, { ghClient, dsn });
}
