// Unit tests for PostgresConfluenceRetrieval — port of the frozen Python
//   vendor/codemaster-py/codemaster/adapters/postgres_confluence_retrieval.py::PostgresConfluenceRetrieval.
//
// These cover the DB-FREE behavior: the `topK <= 0` and empty-`effectiveLabels` short-circuits that
// return `[]` BEFORE any DB call (1:1 with the Python `search` guards). DB-backed behavior (the
// approval-drift LEFT JOIN, skip-hygiene, label overlap, pgvector ordering) is exercised against a
// disposable Postgres in test/integration/adapters/postgres_confluence_retrieval.integration.test.ts.

import { type Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import { PostgresConfluenceRetrieval } from "#backend/adapters/postgres_confluence_retrieval.js";

/** A Kysely stand-in whose every use throws — proves the short-circuit returns before touching the DB. */
const EXPLODING_DB = new Proxy(
  {},
  {
    get() {
      throw new Error("DB must NOT be touched on a short-circuit path");
    },
  },
) as unknown as Kysely<unknown>;

describe("PostgresConfluenceRetrieval short-circuits (no DB call)", () => {
  it("returns [] when topK <= 0 without touching the DB", async () => {
    const adapter = new PostgresConfluenceRetrieval({ db: EXPLODING_DB });
    await expect(
      adapter.search({ queryEmbedding: [0.1, 0.2], topK: 0, effectiveLabels: new Set(["default"]) }),
    ).resolves.toEqual([]);
    await expect(
      adapter.search({ queryEmbedding: [0.1, 0.2], topK: -3, effectiveLabels: new Set(["default"]) }),
    ).resolves.toEqual([]);
  });

  it("returns [] when effectiveLabels is empty without touching the DB", async () => {
    const adapter = new PostgresConfluenceRetrieval({ db: EXPLODING_DB });
    await expect(
      adapter.search({ queryEmbedding: [0.1, 0.2], topK: 5, effectiveLabels: new Set() }),
    ).resolves.toEqual([]);
  });

  it("returns [] when effectiveLabels is omitted (defaults to empty) without touching the DB", async () => {
    const adapter = new PostgresConfluenceRetrieval({ db: EXPLODING_DB });
    await expect(adapter.search({ queryEmbedding: [0.1, 0.2], topK: 5 })).resolves.toEqual([]);
  });
});
