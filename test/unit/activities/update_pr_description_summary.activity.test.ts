/**
 * Unit tests for the `updatePrDescriptionSummary` activity — the 1:1 port of the frozen Python
 * `update_pr_description_summary` (vendor/codemaster-py/.../update_pr_description_summary.py +
 * tests/unit/activities/test_update_pr_description_summary.py).
 *
 * Two layers, mirroring the Python suite:
 *
 *   1. PURE HELPERS (stripExistingSummary / buildSummaryMarkdown / composeNewBody) — the byte-significant
 *      strip+recompose + summary render. These are ALSO Tier-1 parity-checked char-for-char against the
 *      frozen interpreter in test/parity/update_pr_description.parity.test.ts; here we assert the same
 *      behavioural properties the Python unit suite asserts (idempotency, developer-text preservation,
 *      empty-findings render, count-desc ordering) as a fast, interpreter-free guard.
 *
 *   2. GET-modify-PATCH choreography over a REAL GitHubApiClient backed by the deterministic
 *      CassetteHttpClient transport — proving doUpdatePrDescriptionSummary + GitHubApiPrDescriptionClient
 *      issue the GET then the PATCH with the recomposed body. The cassette matches the PATCH JSON body via
 *      deep-equal, so the recomposed-body BYTES are asserted at the wire boundary (the cassette MISMATCHes
 *      if the composed body drifts a single character). This is the stub-vs-real split's "real" side: the
 *      pure logic is parity-proven; the network round-trip is cassette-proven. No live GitHub.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { load as yamlLoad } from "js-yaml";
import { describe, it, expect } from "vitest";

import { FakeClock } from "#platform/clock.js";
import { CassetteHttpClient } from "#backend/infra/cassettes.js";
import { GitHubApiClient, type TokenProvider } from "#backend/integrations/github/api_client.js";
import { GitHubApiPrDescriptionClient } from "#backend/integrations/github/pr_description_client.js";
import {
  SUMMARY_END,
  SUMMARY_START,
  buildSummaryMarkdown,
  composeNewBody,
  doUpdatePrDescriptionSummary,
  stripExistingSummary,
} from "#backend/activities/update_pr_description_summary.activity.js";

import { AggregatedFindingsV1 } from "#contracts/aggregated_findings.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// test/unit/activities -> test/cassettes/github
const GH_CASSETTES = resolve(HERE, "..", "..", "cassettes", "github");

function cassetteClient(name: string): CassetteHttpClient {
  return CassetteHttpClient.fromPath(resolve(GH_CASSETTES, name));
}

/** A constant in-memory token provider (no 401-refresh exercised here). */
const tokenProvider: TokenProvider = async () => {
  await Promise.resolve();
  return "tok";
};

const INSTALLATION_ID = 42;

function finding(overrides: Record<string, unknown> = {}): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: "src/foo.py",
    start_line: 10,
    end_line: 10,
    severity: "issue",
    category: "bug",
    title: "A finding",
    body: "Body text describing the issue at hand.",
    confidence: 0.8,
    ...overrides,
  });
}

function aggregated(findings: ReadonlyArray<ReviewFindingV1>): AggregatedFindingsV1 {
  return AggregatedFindingsV1.parse({
    findings,
    dedupe_stats: {
      input_count: findings.length,
      exact_dropped: 0,
      semantic_merged: 0,
      capped: 0,
      semantic_skipped: false,
    },
    policy_revision: 1,
  });
}

// ── pure helpers (port of the Python pure-helper unit suite) ─────────────────────────────────────

describe("stripExistingSummary", () => {
  it("returns the body (rstrip'd) unchanged when no codemaster block exists", () => {
    const body = "This PR refactors the auth module.\n\nFixes #42.";
    expect(stripExistingSummary(body)).toBe(body.replace(/\s+$/u, ""));
  });

  it("removes a prior block in place (re-runs must not duplicate the section)", () => {
    const body =
      "Original developer description.\n\n" +
      `${SUMMARY_START}\n## old summary\n- stale item\n${SUMMARY_END}\n`;
    const cleaned = stripExistingSummary(body);
    expect(cleaned).not.toContain("codemaster-summary");
    expect(cleaned).not.toContain("old summary");
    expect(cleaned).toContain("Original developer description.");
  });

  it("strips an inline block while preserving the surrounding developer text", () => {
    const body = `Top text.\n${SUMMARY_START}\nold\n${SUMMARY_END}\nBottom text.`;
    const cleaned = stripExistingSummary(body);
    expect(cleaned).toContain("Top text.");
    expect(cleaned).toContain("Bottom text.");
    expect(cleaned).not.toContain("old");
  });
});

describe("buildSummaryMarkdown", () => {
  it("renders the block with the count-desc category breakdown", () => {
    const md = buildSummaryMarkdown([
      finding({ category: "bug" }),
      finding({ category: "bug" }),
      finding({ category: "style" }),
    ]);
    expect(md.startsWith(SUMMARY_START)).toBe(true);
    expect(md.endsWith(SUMMARY_END)).toBe(true);
    expect(md).toContain("Summary by codemaster");
    // bug appears twice, style once → bug leads (count desc).
    expect(md.indexOf("**Bug**")).toBeLessThan(md.indexOf("**Style**"));
    expect(md).toContain("**Bug**: 2");
    expect(md).toContain("**Style**: 1");
  });

  it("still renders a block when there are no findings (bot-ran visibility)", () => {
    const md = buildSummaryMarkdown([]);
    expect(md).toContain(SUMMARY_START);
    expect(md).toContain(SUMMARY_END);
    expect(md).toContain("No findings");
  });
});

describe("composeNewBody", () => {
  it("preserves the developer text verbatim above the markers", () => {
    const original = "This PR adds a feature flag.\n\nFixes #100.";
    const summary = buildSummaryMarkdown([finding()]);
    const composed = composeNewBody({ originalBody: original, summaryMarkdown: summary });
    const [pre, post] = composed.split(SUMMARY_START);
    expect(pre).toContain("This PR adds a feature flag.");
    expect(pre).toContain("Fixes #100.");
    expect(post).toContain("Summary by codemaster");
  });

  it("replaces a prior summary in place (re-runs do not duplicate)", () => {
    const original =
      "Developer text.\n\n" + `${SUMMARY_START}\n## old summary\n${SUMMARY_END}\n`;
    const summary = buildSummaryMarkdown([finding({ category: "bug" })]);
    const composed = composeNewBody({ originalBody: original, summaryMarkdown: summary });
    expect(composed.split(SUMMARY_START).length - 1).toBe(1);
    expect(composed.split(SUMMARY_END).length - 1).toBe(1);
    expect(composed).not.toContain("old summary");
    expect(composed).toContain("**Bug**: 1");
  });

  it("treats a blank original body (GitHub null → '') correctly", () => {
    const composed = composeNewBody({
      originalBody: "",
      summaryMarkdown: buildSummaryMarkdown([]),
    });
    expect(composed).toContain(SUMMARY_START);
  });
});

// ── GET-modify-PATCH over a REAL GitHubApiClient + cassette transport ─────────────────────────────

describe("doUpdatePrDescriptionSummary — GET then PATCH round-trip (cassette)", () => {
  it("reads the current body then PATCHes the recomposed body byte-for-byte", async () => {
    const http = cassetteClient("update_pr_description_get_then_patch.yaml");
    const clock = new FakeClock();
    const api = new GitHubApiClient({ tokenProvider, http, clock });
    const ghClient = new GitHubApiPrDescriptionClient({ api, installationId: INSTALLATION_ID });

    await doUpdatePrDescriptionSummary({
      owner: "acme",
      repo: "widget",
      prNumber: 123,
      aggregated: aggregated([finding({ category: "bug" })]),
      ghClient,
      installationId: INSTALLATION_ID,
    });

    // Both interactions consumed in order (GET, then PATCH). The cassette's body_json deep-equal on the
    // PATCH already asserted the recomposed body bytes; an unused/extra interaction would throw here.
    http.assertFullyConsumed();
  });

  it("the recomposed body the activity sends equals the cassette's recorded PATCH body byte-for-byte", () => {
    // INDEPENDENT wire-body oracle: parse the cassette's recorded PATCH `body` directly off disk and
    // assert it equals compose() over the SAME inputs the recording was made from. The round-trip test
    // above proves the activity SENDS this body (cassette deep-equal would MISMATCH otherwise); this test
    // pins the recorded bytes to the pure helper, so a drift in either the helper or the cassette
    // surfaces as a failure (not a silent skip).
    const expectedBody = composeNewBody({
      originalBody: "Developer description.\n",
      summaryMarkdown: buildSummaryMarkdown([finding({ category: "bug" })]),
    });

    const raw = readFileSync(
      resolve(GH_CASSETTES, "update_pr_description_get_then_patch.yaml"),
      "utf8",
    );
    const cassette = yamlLoad(raw) as {
      interactions: ReadonlyArray<{
        request: { method: string; body_json?: { body?: string } };
      }>;
    };
    const patch = cassette.interactions.find((i) => i.request.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.request.body_json?.body).toBe(expectedBody);

    // And the bytes are exactly the frozen render (heading emoji + breakdown + trailing newline).
    expect(expectedBody).toContain("## 🤖 Summary by codemaster");
    expect(expectedBody).toContain("**Bug**: 1");
    expect(expectedBody.endsWith("\n")).toBe(true);
  });
});

// ── GitHubApiPrDescriptionClient — null-body collapse + installation-id guard ─────────────────────

describe("GitHubApiPrDescriptionClient", () => {
  it("rejects a non-positive installation_id at construction (defense in depth)", () => {
    const clock = new FakeClock();
    const api = new GitHubApiClient({ tokenProvider, http: cassetteClient("get_pr.yaml"), clock });
    expect(() => new GitHubApiPrDescriptionClient({ api, installationId: 0 })).toThrow(
      /installation_id/,
    );
  });
});
