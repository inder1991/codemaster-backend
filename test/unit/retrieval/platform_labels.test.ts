// Tier-1 PARITY test for PLATFORM_EXPOSED_LABELS — port of the frozen Python
//   vendor/codemaster-py/codemaster/retrieval/platform_labels.py::PLATFORM_EXPOSED_LABELS.
//
// The EXPECTED set below was extracted by running the frozen Python directly (via the project venv):
//   .venv/bin/python -c "from codemaster.retrieval.platform_labels import PLATFORM_EXPOSED_LABELS; \
//       print(sorted(PLATFORM_EXPOSED_LABELS))"
// so the TS ceiling is asserted byte-equal to the Python frozenset (order-invariant via sort()). A drift
// in any of the three detector mapping tables (lang / framework / infra) or the curated topic list
// surfaces here as a failing assertion — the audit lever for platform-ceiling drift.

import { describe, expect, it } from "vitest";

import { PLATFORM_EXPOSED_LABELS } from "#backend/retrieval/platform_labels.js";

// Extracted from the frozen Python (sorted). 54 labels: 1 default + 1 topic + 19 lang + 30 framework + 9 infra.
const EXPECTED_PLATFORM_LABELS: ReadonlyArray<string> = [
  "default",
  "framework:aiohttp",
  "framework:angular",
  "framework:aspnetcore",
  "framework:django",
  "framework:echo",
  "framework:express",
  "framework:fastapi",
  "framework:fastify",
  "framework:fiber",
  "framework:flask",
  "framework:gin",
  "framework:jax",
  "framework:koa",
  "framework:ktor",
  "framework:nestjs",
  "framework:nextjs",
  "framework:nuxt",
  "framework:preact",
  "framework:pytorch",
  "framework:rails",
  "framework:react",
  "framework:sinatra",
  "framework:solid",
  "framework:spring-boot",
  "framework:starlette",
  "framework:svelte",
  "framework:tensorflow",
  "framework:tornado",
  "framework:vue",
  "infra:azure-pipelines",
  "infra:circleci",
  "infra:docker",
  "infra:github-actions",
  "infra:gitlab-ci",
  "infra:helm",
  "infra:kubernetes",
  "infra:kustomize",
  "infra:terraform",
  "lang:c",
  "lang:cpp",
  "lang:csharp",
  "lang:go",
  "lang:java",
  "lang:javascript",
  "lang:kotlin",
  "lang:php",
  "lang:python",
  "lang:ruby",
  "lang:rust",
  "lang:scala",
  "lang:swift",
  "lang:typescript",
  "topic:security_policy",
];

describe("PLATFORM_EXPOSED_LABELS — Tier-1 parity with the frozen Python frozenset", () => {
  it("matches the frozen Python set byte-for-byte (sorted, order-invariant)", () => {
    expect([...PLATFORM_EXPOSED_LABELS].sort()).toEqual([...EXPECTED_PLATFORM_LABELS].sort());
  });

  it("always contains the always-emitted `default` label", () => {
    expect(PLATFORM_EXPOSED_LABELS.has("default")).toBe(true);
  });

  it("contains the curated topic label `topic:security_policy`", () => {
    expect(PLATFORM_EXPOSED_LABELS.has("topic:security_policy")).toBe(true);
  });

  it("is the restrictive CEILING — a non-platform label is NOT a member (visibility-violation surface)", () => {
    expect(PLATFORM_EXPOSED_LABELS.has("topic:secret_internal_corpus")).toBe(false);
  });
});
