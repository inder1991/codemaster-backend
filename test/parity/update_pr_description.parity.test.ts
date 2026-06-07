import { beforeAll, afterAll, describe, expect, it } from "vitest";

import {
  pyBuildSummary,
  pyCompose,
  pyMarkers,
  pyStrip,
  shutdownUpdatePrDescriptionRef,
} from "./update_pr_description_oracle.js";

import {
  SUMMARY_END,
  SUMMARY_START,
  buildSummaryMarkdown,
  composeNewBody,
  pyTitle,
  stripExistingSummary,
} from "#backend/activities/update_pr_description_summary.activity.js";

import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

// Tier-1 parity for the update_pr_description_summary DETERMINISTIC surface — the GitHub GET-modify-PATCH
// choreography is proven separately via a cassette round-trip. This suite proves the TS port is
// byte-identical to the frozen Python over:
//   1. the marker delimiter STRINGS (SUMMARY_START / SUMMARY_END) — they MUST match Python byte-for-byte
//      so a body written by the Python worker and re-read by the TS worker (mixed-version deploy) strips
//      correctly;
//   2. strip_existing_summary — CHAR-FOR-CHAR across no-block / trailing-block / inline-block bodies;
//   3. build_summary_markdown — CHAR-FOR-CHAR across empty + findings (the 🤖 heading, the
//      str.title()-cased category breakdown, the Counter.most_common count-desc + insertion-order tie
//      ordering, the em-dash in the no-findings line);
//   4. compose_new_body — CHAR-FOR-CHAR across blank / no-trailing-newline / prior-block bodies.
// Both sides operate on the IDENTICAL wire dict: the TS findings fixtures are parsed through the Zod
// ReviewFindingV1 contract (producing the wire shape), serialized to JSON, and `model_validate`d on the
// Python side. Fixtures live ONLY here.

afterAll(() => shutdownUpdatePrDescriptionRef());

// Warm up the long-lived Python ref ONCE (cold venv import can exceed the default 5s timeout).
beforeAll(async () => {
  await pyMarkers();
}, 30_000);

/** Parse a findings array through Zod ReviewFindingV1 → JSON-safe wire dicts (identical to production). */
function wireFindings(input: ReadonlyArray<Record<string, unknown>>): Array<unknown> {
  return input.map((f) => JSON.parse(JSON.stringify(ReviewFindingV1.parse(f))));
}

/** A minimal valid finding; `category` is the only field the summary render reads. */
function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file: "src/foo.py",
    start_line: 10,
    end_line: 10,
    severity: "issue",
    category: "bug",
    title: "A finding",
    body: "Body text describing the issue at hand.",
    confidence: 0.8,
    ...overrides,
  };
}

// ── marker constants ──────────────────────────────────────────────────────────────────────────────

describe("update_pr_description markers — byte-exact vs frozen Python", () => {
  it("SUMMARY_START / SUMMARY_END match the frozen module-level delimiters char-for-char", async () => {
    const { start, end } = await pyMarkers();
    expect(SUMMARY_START).toBe(start);
    expect(SUMMARY_END).toBe(end);
    // Pin the literal bytes too — a regression that "looks right" but shifts a space/char would break the
    // mixed-version-deploy idempotency the markers exist to guarantee.
    expect(SUMMARY_START).toBe("<!-- codemaster-summary-start -->");
    expect(SUMMARY_END).toBe("<!-- codemaster-summary-end -->");
  });
});

// ── str.title() port (the category-label transform) ────────────────────────────────────────────────

describe("pyTitle — Python str.title() port", () => {
  // Every Category enum value the render can hand pyTitle, plus the general boundary cases proven against
  // the frozen interpreter (digits/underscore/uppercase-run boundaries).
  it.each([
    ["bug", "Bug"],
    ["security", "Security"],
    ["performance", "Performance"],
    ["style", "Style"],
    ["test", "Test"],
    ["docs", "Docs"],
    ["config", "Config"],
    ["context_breaks_consumer", "Context_Breaks_Consumer"],
    ["other", "Other"],
    ["", ""],
    ["ABC", "Abc"],
    ["a_b", "A_B"],
    ["a1a", "A1A"],
    ["a-b-c", "A-B-C"],
  ])("title(%j) === %j", (input, expected) => {
    expect(pyTitle(input)).toBe(expected);
  });
});

// ── strip_existing_summary parity ───────────────────────────────────────────────────────────────────

describe("stripExistingSummary — byte-exact vs frozen Python", () => {
  const bodies: ReadonlyArray<[string, string]> = [
    ["no block (no-op modulo rstrip)", "This PR refactors the auth module.\n\nFixes #42."],
    ["no block with trailing whitespace", "Clean description.   \n\n  "],
    [
      "prior block at tail",
      "Original developer description.\n\n" +
        "<!-- codemaster-summary-start -->\n" +
        "## old summary\n- stale item\n" +
        "<!-- codemaster-summary-end -->\n",
    ],
    [
      "inline block within developer text",
      "Top text.\n" +
        "<!-- codemaster-summary-start -->\nold\n<!-- codemaster-summary-end -->\n" +
        "Bottom text.",
    ],
    [
      "two stray blocks (non-greedy strips each)",
      "A\n<!-- codemaster-summary-start -->\nx\n<!-- codemaster-summary-end -->\nB\n" +
        "<!-- codemaster-summary-start -->\ny\n<!-- codemaster-summary-end -->\nC",
    ],
    ["empty string", ""],
  ];

  it.each(bodies)("strips %s identically", async (_label, body) => {
    expect(stripExistingSummary(body)).toBe(await pyStrip(body));
  });
});

// ── build_summary_markdown parity ───────────────────────────────────────────────────────────────────

describe("buildSummaryMarkdown — byte-exact vs frozen Python", () => {
  const cases: ReadonlyArray<[string, ReadonlyArray<Record<string, unknown>>]> = [
    ["no findings", []],
    ["single bug", [finding({ category: "bug" })]],
    [
      "count-desc ordering (bug x2 leads style x1)",
      [finding({ category: "bug" }), finding({ category: "bug" }), finding({ category: "style" })],
    ],
    [
      "tie broken by first-insertion order (security before bug)",
      [finding({ category: "security" }), finding({ category: "bug" })],
    ],
    [
      "underscored category title-cases each word",
      [finding({ category: "context_breaks_consumer" })],
    ],
    [
      "every category once",
      [
        finding({ category: "bug" }),
        finding({ category: "security" }),
        finding({ category: "performance" }),
        finding({ category: "style" }),
        finding({ category: "test" }),
        finding({ category: "docs" }),
        finding({ category: "config" }),
        finding({ category: "context_breaks_consumer" }),
        finding({ category: "other" }),
      ],
    ],
  ];

  it.each(cases)("renders %s identically", async (_label, findings) => {
    const wire = wireFindings(findings);
    const ours = buildSummaryMarkdown(wire.map((f) => ReviewFindingV1.parse(f)));
    expect(ours).toBe(await pyBuildSummary(wire));
  });
});

// ── compose_new_body parity ─────────────────────────────────────────────────────────────────────────

describe("composeNewBody — byte-exact vs frozen Python", () => {
  const cases: ReadonlyArray<[string, string, ReadonlyArray<Record<string, unknown>>]> = [
    ["blank original body", "", [finding()]],
    ["original without trailing newline", "Adds a feature flag.\n\nFixes #100.", [finding()]],
    ["original with trailing newline", "Developer description.\n", [finding({ category: "bug" })]],
    [
      "original with prior block (replaced in place)",
      "Developer text.\n\n" +
        "<!-- codemaster-summary-start -->\n## old summary\n<!-- codemaster-summary-end -->\n",
      [finding({ category: "bug" })],
    ],
    ["no findings", "Just a description.", []],
  ];

  it.each(cases)("composes %s identically", async (_label, original, findings) => {
    const wire = wireFindings(findings);
    const summary = buildSummaryMarkdown(wire.map((f) => ReviewFindingV1.parse(f)));
    const ours = composeNewBody({ originalBody: original, summaryMarkdown: summary });
    expect(ours).toBe(await pyCompose(original, wire));
  });
});
