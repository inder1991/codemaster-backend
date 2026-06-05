import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { load as yamlLoad } from "js-yaml";
import { describe, expect, it } from "vitest";

import { type CassetteSpec, cassetteCache } from "#backend/integrations/llm/cassette_sdk.js";
import { doReview } from "#backend/review/review_activity.js";

import { computeChunkId } from "#contracts/diff_chunking.v1.js";
import { ReviewContextV1 } from "#contracts/review_context.v1.js";

// Cassette dual-run — mirrors the frozen Python
// tests/integration/test_bedrock_review_chunk_cassettes.py::test_replay_review_chunk_cassette.
//
// Replays each `bedrock/review_chunk/*.yaml` cassette through doReview with the cassette replay seam
// (CassetteSdk + InMemoryCostCapEnforcer + InMemoryBlobStoreAdapter + CacheShim), then asserts the
// documented `expected` shape (finding_count / files / severities). This is the proof that the ported
// LLM-invocation transform + parser compose into the same observable output the Python produces on the
// SAME recorded LLM interaction. The cassettes are byte-identical to the frozen ones.

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/test/integration/activities
const CASSETTE_DIR = join(HERE, "..", "..", "cassettes", "bedrock", "review_chunk");

function cassetteFiles(): Array<string> {
  return readdirSync(CASSETTE_DIR)
    .filter((n) => n.endsWith(".yaml"))
    .sort();
}

function context(): ReviewContextV1 {
  const chunkId = computeChunkId({
    path: "src/foo.py",
    start_line: 1,
    end_line: 20,
    body: "def foo():\n    return 1\n",
  });
  return ReviewContextV1.parse({
    pr_id: "12345678-1234-5678-1234-567812345678",
    installation_id: "12345678-1234-5678-1234-567812345678",
    repo: "acme/widget",
    pr_title: "Cassette-driven review",
    pr_description: "## Summary\n\nReplay this cassette.",
    chunk: {
      chunk_id: chunkId,
      path: "src/foo.py",
      language: "python",
      start_line: 1,
      end_line: 20,
      body: "def foo():\n    return 1\n",
      chunk_kind: "function",
      token_estimate: 20,
    },
    policy_revision: 1,
  });
}

describe("bedrock_review_chunk cassette dual-run", () => {
  it("has the four documented cassettes", () => {
    const names = new Set(cassetteFiles().map((n) => n.replace(/\.yaml$/, "")));
    expect(names).toEqual(new Set(["clean", "five_findings", "fifty_findings", "malformed_block"]));
  });

  for (const file of cassetteFiles()) {
    it(`replays ${file} to the expected finding shape`, async () => {
      const spec = yamlLoad(readFileSync(join(CASSETTE_DIR, file), "utf8")) as CassetteSpec;
      const { findings } = await doReview(context(), { cache: cassetteCache(spec) });

      const expected = spec.expected ?? {};
      expect(findings.length, `${file}: finding_count`).toBe(expected["finding_count"]);

      if (Array.isArray(expected["files"])) {
        expect(findings.map((f) => f.file)).toEqual(expected["files"]);
      }
      if (Array.isArray(expected["severities"])) {
        expect(findings.map((f) => f.severity)).toEqual(expected["severities"]);
      }
    });
  }
});
