/**
 * `updatePrDescriptionSummary` activity — 1:1 port of the frozen Python
 * `@activity.defn update_pr_description_summary`
 * (vendor/codemaster-py/codemaster/activities/update_pr_description_summary.py, S19.NOW8.B).
 *
 * The activity GET-modify-PATCHes the PR DESCRIPTION (a metadata field — CLAUDE.md invariant 9: the bot
 * edits the description, NOT the review event; it stays advisory, never APPROVE/REQUEST_CHANGES):
 *
 *   1. GET the current PR body via the GitHub API.
 *   2. Strip any existing codemaster summary block (HTML-comment-delimited).
 *   3. Compose a new summary block from the AggregatedFindingsV1.
 *   4. PATCH the PR body with the original-author content + the new summary block appended.
 *
 * ## Idempotency via HTML-comment markers (byte-for-byte with Python)
 *
 * The {@link SUMMARY_START} / {@link SUMMARY_END} markers make the operation idempotent — re-runs (a
 * Temporal retry) strip the prior block in place via {@link SUMMARY_BLOCK_RE} (DOTALL, non-greedy) and
 * re-emit cleanly rather than duplicating the section. The marker delimiter STRINGS must match the frozen
 * Python EXACTLY (the Tier-1 parity oracle proves this) so a body written by the Python worker and re-read
 * by the TS worker (or vice-versa during a mixed-version deploy) strips correctly.
 *
 * ## Typed-input envelope — CLAUDE.md invariant 11 / ADR-0047 closure
 *
 * The frozen Python activity dispatches with FOUR positional arguments
 * (`update_pr_description_summary(owner, repo, pr_number, aggregated)`) — an invariant-11 violation,
 * sibling to the post_check_run / classify_files / aggregate_findings positional dispatches. This port
 * CLOSES it: the single positional input is the {@link UpdatePrDescriptionInputV1} envelope. There is no
 * Python Pydantic counterpart for the envelope — it is introduced during the port.
 *
 * ## Pure logic vs. real wiring (the stub-vs-real test split)
 *
 * {@link stripExistingSummary} / {@link buildSummaryMarkdown} / {@link composeNewBody} are the pure
 * `strip_existing_summary` / `build_summary_markdown` / `compose_new_body` helpers — the Tier-1 parity
 * oracle drives them against the frozen Python so the strip+recompose + summary RENDER are byte-verifiable
 * WITHOUT any real GitHub round-trip. {@link doUpdatePrDescriptionSummary} is the pure GET-modify-PATCH
 * choreography with the {@link GhPrDescriptionClient} INJECTED (mirrors the frozen
 * `UpdatePrDescriptionSummaryActivity.update_pr_description_summary` over its injected client + fixed
 * installation id). {@link updatePrDescriptionSummary} is the registered activity that constructs the REAL
 * {@link GitHubApiPrDescriptionClient} over a {@link GitHubApiClient} (Vault token provider + env
 * installation id), mirroring the frozen-Python worker wiring (`_update_pr_description_activity =
 * UpdatePrDescriptionSummaryActivity(gh_client=_PrDescriptionGitHubAdapter(api=github_client,
 * installation_id=github_installation_id), installation_id=github_installation_id)`). The real client is
 * CONSTRUCTED but not invoked during the skeleton BUILD (no live GitHub / Vault); the REST round-trip is
 * covered by the cassette test against the GitHubApiClient transport.
 *
 * ## Failure semantics
 *
 * Per the frozen activity's AC3, a failure here does NOT fail the workflow — the workflow body's
 * `stage_outcome` wrapper logs + swallows (the already-posted review is the value; the description
 * appendage is polish). That wrapping lives in the workflow body (the Workflow phase wires this activity
 * in), NOT here: this activity raises on a GitHub error exactly as the Python does, and the caller decides
 * the workflow-liveness posture.
 */

import { FetchGitHubHttpClient, GitHubApiClient } from "#backend/integrations/github/api_client.js";
import {
  GitHubApiPrDescriptionClient,
  type GhPrDescriptionClient,
} from "#backend/integrations/github/pr_description_client.js";
import { GitHubAppTokenProvider } from "#backend/integrations/github/token_provider.js";
import { VaultHttpPort } from "#backend/adapters/vault_http.js";

import { WallClock } from "#platform/clock.js";

import type { ReviewFindingV1 } from "#contracts/review_findings.v1.js";
import type { UpdatePrDescriptionInputV1 } from "#contracts/update_pr_description.v1.js";

// ─── Marker delimiters (byte-for-byte with the frozen Python module-level Finals) ─────────────────

/** HTML-comment markers delimiting the codemaster summary block. MUST match Python byte-for-byte. */
export const SUMMARY_START = "<!-- codemaster-summary-start -->";
export const SUMMARY_END = "<!-- codemaster-summary-end -->";

/**
 * Match the markers + everything between them; DOTALL (`s` flag) so newlines are captured, non-greedy
 * (`.*?`) so a body with two stray blocks strips each independently. Used to strip the prior summary so
 * we re-emit cleanly. 1:1 with the Python `_SUMMARY_BLOCK_RE = re.compile(re.escape(START) + r".*?" +
 * re.escape(END), flags=re.DOTALL)`. The marker strings contain no regex metacharacters once the literal
 * `?`/`!`/`-` are considered — but to mirror Python's `re.escape` faithfully the markers are embedded via
 * an escaped literal here too (the `-`/`!`/`?` inside `<!-- ... -->` are not special outside a class, so
 * the escaped + un-escaped forms compile identically; the test pins the strip behaviour regardless).
 */
// Both operands are re.escape'd module constants (no user input); the pattern is anchored on fixed
// literal markers + a single bounded `.*?`, so there is no ReDoS surface. Derived from the constants
// (not duplicated) to keep the strip regex in lock-step with the delimiter strings.
export const SUMMARY_BLOCK_RE =
  // eslint-disable-next-line security/detect-non-literal-regexp -- see note above (escaped constants only)
  new RegExp(`${escapeRegExp(SUMMARY_START)}.*?${escapeRegExp(SUMMARY_END)}`, "gs");

/** Escape a literal string for embedding in a RegExp (the TS analogue of Python's `re.escape`). */
function escapeRegExp(literal: string): string {
  // Escape every ASCII regex metacharacter; mirrors re.escape's conservatism (it escapes all non
  // word/space chars). The `g` flag on SUMMARY_BLOCK_RE makes `.replace` strip ALL blocks (Python's
  // `re.sub` replaces all occurrences by default), so the non-greedy + global combination matches the
  // Python `re.sub(_SUMMARY_BLOCK_RE, "", body)` semantics.
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Pure helpers (testable without GitHub; Tier-1 parity vs frozen Python) ───────────────────────

/**
 * Remove any prior codemaster summary block in-place. 1:1 with `strip_existing_summary`.
 *
 * Pure helper; safe to call when no block exists (returns `body` with trailing whitespace trimmed).
 * Trims trailing whitespace introduced by the removal so re-emitted blocks don't accumulate blank lines
 * on repeated runs — mirrors the Python `.rstrip()` (which strips ALL trailing Unicode whitespace).
 */
export function stripExistingSummary(body: string): string {
  const cleaned = body.replace(SUMMARY_BLOCK_RE, "");
  // Drop trailing whitespace the strip introduced. Python `str.rstrip()` strips trailing Unicode
  // whitespace; the `\s` class with the `u`-aware default + an explicit Unicode-whitespace set matches
  // it for the bodies this sees (markdown text). `\s` in JS already covers space/tab/newline/CR/FF/VT +
  // the Unicode space separators, matching Python's str.rstrip default whitespace set for this surface.
  return rstrip(cleaned);
}

/** Port of Python `str.rstrip()` (no-arg): strip trailing whitespace per the Unicode whitespace set. */
function rstrip(value: string): string {
  return value.replace(/\s+$/u, "");
}

/**
 * Render the markdown summary block from the aggregated findings. 1:1 with `build_summary_markdown`.
 *
 * Sections are grouped by `finding.category` and counts are sorted descending so the most-frequent
 * category leads; ties break by FIRST-ENCOUNTERED order in the findings tuple (Python `Counter` +
 * `most_common()` are insertion-order-stable for equal counts since 3.7 — {@link mostCommon} ports that
 * exactly). When `findings` is empty the summary still renders — visibility that the bot ran is itself
 * signal.
 */
export function buildSummaryMarkdown(findings: ReadonlyArray<ReviewFindingV1>): string {
  const byCategory = counter(findings.map((f) => f.category));

  const lines: Array<string> = [SUMMARY_START, "", "## 🤖 Summary by codemaster", ""];
  if (findings.length === 0) {
    lines.push("_No findings — looks good!_");
  } else {
    lines.push(`**${findings.length} finding(s) detected.** Breakdown:`);
    lines.push("");
    for (const [category, count] of mostCommon(byCategory)) {
      lines.push(`- **${pyTitle(category)}**: ${count}`);
    }
  }
  lines.push("", SUMMARY_END);
  return lines.join("\n");
}

/**
 * Compose the PATCH'd PR body: original-author content + summary. 1:1 with `compose_new_body`.
 *
 * `originalBody` is what the developer wrote — preserved verbatim above the markers. Existing summary
 * blocks (from prior runs) are stripped first so the appendage stays in place rather than accumulating
 * duplicates. GitHub returns the body as null when the developer left it blank; the GhPrDescriptionClient
 * collapses that to "" upstream so concatenation is safe (the helper also tolerates a literal "").
 */
export function composeNewBody({
  originalBody,
  summaryMarkdown,
}: {
  originalBody: string;
  summaryMarkdown: string;
}): string {
  // Python: `strip_existing_summary(original_body or "")`. `original_body` is already a string here (the
  // client collapses null → ""), and an empty string strips to an empty string, so the `or ""` is a
  // no-op for this typed surface — preserved in intent.
  let base = stripExistingSummary(originalBody);
  if (base !== "" && !base.endsWith("\n")) {
    base = `${base}\n`;
  }
  return `${base}\n${summaryMarkdown}\n`;
}

// ─── Counter / most_common / str.title ports (byte-faithful to the frozen Python primitives) ──────

/**
 * Port of `collections.Counter(iterable)`: count occurrences, preserving FIRST-INSERTION order of keys
 * (a JS `Map` is insertion-ordered, matching CPython's dict ordering that `Counter` inherits).
 */
function counter(values: ReadonlyArray<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

/**
 * Port of `Counter.most_common()`: return [key, count] pairs sorted by count DESCENDING, ties broken by
 * FIRST-INSERTION order. CPython implements this via `heapq.nlargest` / `sorted(..., reverse=True)` over
 * `(count, ...)` but — critically — its tie-break preserves insertion order (it is a STABLE sort over the
 * already-insertion-ordered items). A stable sort by `-count` over the Map's insertion-ordered entries
 * reproduces that exactly.
 */
function mostCommon(counts: Map<string, number>): Array<[string, number]> {
  const entries = [...counts.entries()];
  // Array.prototype.sort is stable (ECMAScript 2019+), so entries with equal counts keep their
  // insertion order — byte-identical to Python's most_common() tie-break.
  entries.sort((a, b) => b[1] - a[1]);
  return entries;
}

/**
 * Port of Python `str.title()`: uppercase the first CASED character of each "word" and lowercase the
 * rest, where a word boundary is any non-cased (non-alphabetic, per Unicode) character. CPython's
 * algorithm walks the string tracking whether the previous char was cased; a cased char following a
 * non-cased char (or string start) is title-cased (≈ uppercased), every other cased char is lowercased.
 *
 * For the constrained `Category` enum (all-lowercase ASCII letters + `_`) the only boundary is `_`, so
 * e.g. `context_breaks_consumer` → `Context_Breaks_Consumer` (verified against the frozen interpreter).
 * The general algorithm is ported faithfully so the render stays correct if the category vocabulary ever
 * widens.
 */
export function pyTitle(value: string): string {
  let previousIsCased = false;
  let out = "";
  for (const ch of value) {
    if (isCased(ch)) {
      out += previousIsCased ? ch.toLowerCase() : ch.toUpperCase();
      previousIsCased = true;
    } else {
      out += ch;
      previousIsCased = false;
    }
  }
  return out;
}

/**
 * Whether a single-codepoint string is "cased" in the Python sense — i.e. it has a distinct upper- and
 * lower-case form (so applying `.toUpperCase()` / `.toLowerCase()` actually changes it). This is the
 * boundary predicate `str.title()` uses to decide where words begin. Caseless letters (e.g. CJK) and
 * non-letters (digits, `_`, space, punctuation) are NOT cased and act as word separators.
 */
function isCased(ch: string): boolean {
  return ch.toUpperCase() !== ch.toLowerCase();
}

// ─── GET-modify-PATCH choreography (pure; client INJECTED) ────────────────────────────────────────

/**
 * The frozen `UpdatePrDescriptionSummaryActivity.update_pr_description_summary` choreography, ported
 * EXACTLY: GET the current body, build the summary from the aggregated findings, compose the new body
 * (strip-prior + append), PATCH it back. The {@link GhPrDescriptionClient} is INJECTED so the activity's
 * read-modify-write LOGIC is testable against a recording stub / cassette transport without a real GitHub
 * round-trip. `installationId` is threaded into both client calls (mirrors the frozen activity's fixed
 * `self._installation_id`).
 */
export async function doUpdatePrDescriptionSummary({
  owner,
  repo,
  prNumber,
  aggregated,
  ghClient,
  installationId,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  aggregated: UpdatePrDescriptionInputV1["aggregated"];
  ghClient: GhPrDescriptionClient;
  installationId: number;
}): Promise<void> {
  const originalBody = await ghClient.getPullRequestBody({
    installationId,
    owner,
    repo,
    prNumber,
  });
  const summary = buildSummaryMarkdown(aggregated.findings);
  const newBody = composeNewBody({ originalBody, summaryMarkdown: summary });
  await ghClient.patchPullRequestBody({
    installationId,
    owner,
    repo,
    prNumber,
    body: newBody,
  });
}

// ─── Env wiring + registered activity ─────────────────────────────────────────────────────────────

/**
 * The registered activity. Takes the single typed {@link UpdatePrDescriptionInputV1} envelope
 * (invariant 11), constructs the REAL {@link GitHubApiPrDescriptionClient} over a {@link GitHubApiClient}
 * (Vault token provider + the per-review numeric installation id from the input), and delegates to
 * {@link doUpdatePrDescriptionSummary}. Per-review routing (replaces the removed
 * `CODEMASTER_GITHUB_INSTALLATION_ID` env pin): ONE token provider → ONE GitHubApiClient → wrapped in the
 * PR-description client at the input's installation id.
 */
export async function updatePrDescriptionSummary(input: UpdatePrDescriptionInputV1): Promise<void> {
  // Per-review routing: the numeric installation id comes from the input. Defensive null guard — the
  // PR-description update runs only after a successful review (post-clone), so this should never fire.
  const installationId = input.github_installation_id;
  if (installationId === null) {
    throw new Error(
      "github_installation_id is null in the update_pr_description_summary input — cannot patch the PR " +
        "description without a per-review installation id (per-review routing).",
    );
  }
  const clock = new WallClock();
  // One GitHub HTTP transport shared by the token-provider's JWT→installation-token mint AND the
  // GitHubApiClient's PR GET/PATCH calls (mirrors the frozen-Python worker passing one `_http_client` to
  // both). Vault is read via its own env-built transport.
  const githubHttp = new FetchGitHubHttpClient({});
  const vault = VaultHttpPort.fromEnv();
  const tokenProvider = await GitHubAppTokenProvider.fromEnv({
    vault,
    http: githubHttp,
    clock,
  });
  const api = new GitHubApiClient({
    tokenProvider: tokenProvider.getToken.bind(tokenProvider),
    http: githubHttp,
    clock,
  });
  const ghClient = new GitHubApiPrDescriptionClient({ api, installationId });

  await doUpdatePrDescriptionSummary({
    owner: input.owner,
    repo: input.repo,
    prNumber: input.pr_number,
    aggregated: input.aggregated,
    ghClient,
    installationId,
  });
}
