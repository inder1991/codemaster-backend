import { type Kysely, Transaction } from "kysely";

/**
 * Assert `db` is an already-open Kysely `Transaction` (1:1 with the Python `session.in_transaction()`
 * guards on the SERIAL+SUPERSEDE primitives). NON-NARROWING by design: a `if (!(db instanceof Transaction))`
 * check inline would narrow `db` to `Transaction<any>`, which then fails to pass to the `Kysely<unknown>`
 * params of sibling primitives (`fn.any` variance). Calling this helper leaves the caller's `db` typed
 * `Kysely<unknown>` so it still flows to those calls, while still throwing loudly when not in a transaction
 * (FOR UPDATE / optimistic-UPDATE locks release at autocommit otherwise, collapsing serialization).
 */
export function assertOpenTransaction(db: Kysely<unknown>, primitive: string): void {
  if (!(db instanceof Transaction)) {
    throw new Error(
      `${primitive} requires an already-open transaction — the FOR UPDATE / optimistic-UPDATE locks ` +
        `release at autocommit otherwise, collapsing the serialization guarantee.`,
    );
  }
}
