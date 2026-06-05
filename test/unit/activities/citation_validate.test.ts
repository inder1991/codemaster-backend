// Unit tests for citation_validate.activity.ts + its CitationValidator core's observability surface.
//
// The behavioral (findings → surviving/dropped partition) parity is covered byte-for-byte against the
// frozen Python in test/parity/citation_validate.parity.test.ts. THIS file pins:
//   (a) the activity's 1-arg typed envelope wiring (fresh validator per call, scoped to workspace_path),
//       mirroring the frozen Python unit tests (tests/unit/activities/test_citation_validate_activity.py);
//   (b) the `onWarn` sink the core threads (the Python `_LOG.warning(...)` drop + observe-mismatch logs);
//   (c) the `codemaster_policy_invalid_citation_total{enforcement_mode}` counter the policy_rule path
//       emits — the observability the parity oracle can't see (the Python ref dumps only the partition,
//       not its counter deltas).
//
// COUNTER-TIMING GOTCHA (verified empirically; same as chunk_response_parser.counters.test.ts): an OTel
// counter created BEFORE a MeterProvider is registered binds to the no-op meter and never records to a
// later-registered provider. policy_metrics.ts caches its counter at MODULE scope, and
// citation_validator.ts imports it eagerly. So the provider is registered in `beforeAll` and BOTH modules
// are DYNAMICALLY IMPORTED afterward, so the module-scope counter binds to the in-memory provider.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  type DataPoint,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CitationValidateInputV1 } from "#contracts/citation_validate_input.v1.js";
import { PolicyCitationContextV1 } from "#contracts/policy_citation.v1.js";
import { ReviewFindingV1 } from "#contracts/review_findings.v1.js";

// Hand-written structural types for the dynamically-imported modules. We deliberately do NOT statically
// import them (that would EAGERLY bind their module-scope counter to the no-op meter BEFORE `beforeAll`
// registers the provider). The Zod contracts above are pure (no counter cache) so importing them eagerly
// is harmless.
type CitationValidateFn = (
  input: CitationValidateInputV1,
) => Promise<{ surviving: Array<ReviewFindingV1>; dropped: Array<{ finding: ReviewFindingV1; reason: string }> }>;

type CitationValidatorWarning =
  | { readonly kind: "drop"; readonly file: string; readonly title: string; readonly reason: string }
  | {
      readonly kind: "policy_observe_mismatch";
      readonly locator: string;
      readonly valid_rule_ids_count: number;
      readonly enforcement: string;
    };

type CitationValidatorClass = new (args: {
  readonly workspace: string;
  readonly knowledgeChunkIds: ReadonlySet<string> | null;
  readonly policyCitation?: PolicyCitationContextV1 | null;
  readonly onWarn?: (w: CitationValidatorWarning) => void;
}) => {
  validate(findings: ReadonlyArray<ReviewFindingV1>): {
    surviving: Array<ReviewFindingV1>;
    dropped: Array<{ finding: ReviewFindingV1; reason: string }>;
  };
};

const INVALID_CITATION_NAME = "codemaster_policy_invalid_citation_total";

let exporter: InMemoryMetricExporter;
let provider: MeterProvider;
let citationValidate: CitationValidateFn;
let CitationValidator: CitationValidatorClass;

beforeAll(async () => {
  // DELTA temporality + per-test exporter.reset() → each test asserts EXACTLY its own counter adds.
  exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 2_147_483_647 });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  // Dynamic import AFTER provider registration so policy_metrics' module-scope counter binds to it.
  ({ citationValidate } = await import("#backend/activities/citation_validate.activity.js"));
  ({ CitationValidator } = await import("#backend/review/citation_validator.js"));
});

beforeEach(async () => {
  // Drain ANY pending DELTA points (incl. counter emits from the activity-wiring tests, which never
  // flush) BEFORE resetting, so each counter test starts from a truly empty exporter regardless of
  // shuffle order. forceFlush collects since the last collection; reset() then drops that batch.
  await provider.forceFlush();
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
  metrics.disable();
});

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "citation-validate-unit-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

/** One finding wire dict, ReviewFindingV1.parse-applied (sources/scope/evidence_refs defaults filled). */
function finding(overrides: Record<string, unknown> = {}): ReviewFindingV1 {
  return ReviewFindingV1.parse({
    file: "src/foo.py",
    start_line: 1,
    end_line: 1,
    severity: "issue",
    category: "bug",
    title: "T",
    body: "B",
    confidence: 0.5,
    ...overrides,
  });
}

/** Sum the `enforcement_mode`-labeled invalid-citation counter for this test's single flush. */
async function invalidCitationCount(enforcementMode: string): Promise<number> {
  await provider.forceFlush();
  let total = 0;
  for (const rm of exporter.getMetrics()) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        if (m.descriptor.name === INVALID_CITATION_NAME) {
          for (const dp of m.dataPoints as Array<DataPoint<number>>) {
            if (dp.attributes["enforcement_mode"] === enforcementMode) total += dp.value;
          }
        }
      }
    }
  }
  return total;
}

describe("citationValidate activity — typed envelope wiring (1:1 with the Python unit tests)", () => {
  it("empty findings → empty surviving + empty dropped (no fs touch)", async () => {
    const out = await citationValidate(
      CitationValidateInputV1.parse({ workspace_path: ws, findings: [], knowledge_chunk_ids: null }),
    );
    expect(out.surviving).toHaveLength(0);
    expect(out.dropped).toHaveLength(0);
  });

  it("finding without repo_path source → survives untouched (linter_rule has no check)", async () => {
    const f = finding({ sources: [{ kind: "linter_rule", locator: "no-unused-vars" }] });
    const out = await citationValidate(
      CitationValidateInputV1.parse({ workspace_path: ws, findings: [f], knowledge_chunk_ids: null }),
    );
    expect(out.surviving).toHaveLength(1);
    expect(out.dropped).toHaveLength(0);
  });

  it("repo_path source that does not exist → dropped with a reason naming the locator", async () => {
    const f = finding({ sources: [{ kind: "repo_path", locator: "nonexistent.py" }] });
    const out = await citationValidate(
      CitationValidateInputV1.parse({ workspace_path: ws, findings: [f], knowledge_chunk_ids: null }),
    );
    expect(out.surviving).toHaveLength(0);
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0]!.reason).toContain("nonexistent.py");
  });

  it("3-arg-equivalent call (no policy_citation) preserves policy_rule skip-mode", async () => {
    const f = finding({ sources: [{ kind: "policy_rule", locator: "ANY-rule-id" }] });
    const out = await citationValidate(
      CitationValidateInputV1.parse({ workspace_path: ws, findings: [f], knowledge_chunk_ids: null }),
    );
    expect(out.surviving).toHaveLength(1);
  });

  it("observe-mode keeps a fabricated policy_rule; enforce-mode drops it", async () => {
    const f = finding({ sources: [{ kind: "policy_rule", locator: "FABRICATED-rule" }] });

    const observed = await citationValidate(
      CitationValidateInputV1.parse({
        workspace_path: ws,
        findings: [f],
        knowledge_chunk_ids: null,
        policy_citation: { valid_rule_ids: ["REAL-rule-aaaaaaaa"], enforcement: "observe" },
      }),
    );
    expect(observed.surviving).toHaveLength(1);
    expect(observed.dropped).toHaveLength(0);

    const enforced = await citationValidate(
      CitationValidateInputV1.parse({
        workspace_path: ws,
        findings: [f],
        knowledge_chunk_ids: null,
        policy_citation: { valid_rule_ids: ["REAL-rule-aaaaaaaa"], enforcement: "enforce" },
      }),
    );
    expect(enforced.surviving).toHaveLength(0);
    expect(enforced.dropped).toHaveLength(1);
    expect(enforced.dropped[0]!.reason).toContain("FABRICATED-rule");
  });

  it("enforce-mode keeps a VALID policy_rule (locator in the set)", async () => {
    const f = finding({ sources: [{ kind: "policy_rule", locator: "REAL-rule-aaaaaaaa" }] });
    const out = await citationValidate(
      CitationValidateInputV1.parse({
        workspace_path: ws,
        findings: [f],
        knowledge_chunk_ids: null,
        policy_citation: { valid_rule_ids: ["REAL-rule-aaaaaaaa"], enforcement: "enforce" },
      }),
    );
    expect(out.surviving).toHaveLength(1);
  });
});

describe("CitationValidator.recordInvalidCitation counter (codemaster_policy_invalid_citation_total)", () => {
  it("observe-mode mismatch emits {enforcement_mode=observe} once", async () => {
    const validator = new CitationValidator({
      workspace: ws,
      knowledgeChunkIds: null,
      policyCitation: PolicyCitationContextV1.parse({
        valid_rule_ids: ["REAL-rule-aaaaaaaa"],
        enforcement: "observe",
      }),
    });
    validator.validate([finding({ sources: [{ kind: "policy_rule", locator: "FABRICATED-rule" }] })]);
    expect(await invalidCitationCount("observe")).toBe(1);
    expect(await invalidCitationCount("enforce")).toBe(0);
  });

  it("enforce-mode mismatch emits {enforcement_mode=enforce} once", async () => {
    const validator = new CitationValidator({
      workspace: ws,
      knowledgeChunkIds: null,
      policyCitation: PolicyCitationContextV1.parse({
        valid_rule_ids: ["REAL-rule-aaaaaaaa"],
        enforcement: "enforce",
      }),
    });
    validator.validate([finding({ sources: [{ kind: "policy_rule", locator: "FABRICATED-rule" }] })]);
    expect(await invalidCitationCount("enforce")).toBe(1);
  });

  it("a VALID policy_rule emits NO counter (membership hit)", async () => {
    const validator = new CitationValidator({
      workspace: ws,
      knowledgeChunkIds: null,
      policyCitation: PolicyCitationContextV1.parse({
        valid_rule_ids: ["REAL-rule-aaaaaaaa"],
        enforcement: "enforce",
      }),
    });
    validator.validate([finding({ sources: [{ kind: "policy_rule", locator: "REAL-rule-aaaaaaaa" }] })]);
    expect(await invalidCitationCount("observe")).toBe(0);
    expect(await invalidCitationCount("enforce")).toBe(0);
  });

  it("skip-mode (no context) emits NO counter even on an unknown policy_rule", async () => {
    const validator = new CitationValidator({ workspace: ws, knowledgeChunkIds: null });
    validator.validate([finding({ sources: [{ kind: "policy_rule", locator: "WHATEVER" }] })]);
    expect(await invalidCitationCount("observe")).toBe(0);
    expect(await invalidCitationCount("enforce")).toBe(0);
  });
});

describe("CitationValidator onWarn sink (mirrors the Python _LOG.warning calls)", () => {
  it("fires a `drop` warning when a finding is dropped for an unresolvable repo_path", () => {
    const warnings: Array<CitationValidatorWarning> = [];
    const validator = new CitationValidator({
      workspace: ws,
      knowledgeChunkIds: null,
      onWarn: (w) => warnings.push(w),
    });
    validator.validate([finding({ title: "X", sources: [{ kind: "repo_path", locator: "gone.py" }] })]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe("drop");
    if (warnings[0]!.kind === "drop") {
      expect(warnings[0]!.title).toBe("X");
      expect(warnings[0]!.reason).toContain("gone.py");
    }
  });

  it("fires a `policy_observe_mismatch` warning in observe-mode (finding still kept)", () => {
    const warnings: Array<CitationValidatorWarning> = [];
    const validator = new CitationValidator({
      workspace: ws,
      knowledgeChunkIds: null,
      policyCitation: PolicyCitationContextV1.parse({
        valid_rule_ids: ["REAL-rule-aaaaaaaa"],
        enforcement: "observe",
      }),
      onWarn: (w) => warnings.push(w),
    });
    const out = validator.validate([
      finding({ sources: [{ kind: "policy_rule", locator: "FABRICATED-rule" }] }),
    ]);
    expect(out.surviving).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe("policy_observe_mismatch");
    if (warnings[0]!.kind === "policy_observe_mismatch") {
      expect(warnings[0]!.locator).toBe("FABRICATED-rule");
      expect(warnings[0]!.valid_rule_ids_count).toBe(1);
    }
  });

  it("knowledge_chunk strict membership: in-set survives, out-of-set dropped; empty set drops all", () => {
    const validator = new CitationValidator({ workspace: ws, knowledgeChunkIds: new Set(["chunk-A"]) });
    const out = validator.validate([
      finding({ title: "in", sources: [{ kind: "knowledge_chunk", locator: "chunk-A" }] }),
      finding({ title: "out", sources: [{ kind: "knowledge_chunk", locator: "chunk-Z" }] }),
    ]);
    expect(out.surviving.map((x) => x.title)).toEqual(["in"]);
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0]!.reason).toContain("chunk-Z");

    const strictEmpty = new CitationValidator({ workspace: ws, knowledgeChunkIds: new Set() });
    const out2 = strictEmpty.validate([
      finding({ sources: [{ kind: "knowledge_chunk", locator: "chunk-A" }] }),
    ]);
    expect(out2.surviving).toHaveLength(0);
    expect(out2.dropped).toHaveLength(1);
  });
});
