/**
 * Custom Temporal PayloadConverter module — the wire-marshalling seam for the Phase-2.0
 * Temporal-TS walking skeleton (ADR-0065).
 *
 * ## How Temporal loads this module
 *
 * The worker is configured with `dataConverter: { payloadConverterPath: require.resolve("./data_converter") }`.
 * Temporal imports THIS module — by path — into BOTH the main Node thread (where activity args / results
 * are marshalled) AND the workflow V8-isolate sandbox (where workflow args / results are marshalled). It
 * looks for a single named export called `payloadConverter` that implements the {@link PayloadConverter}
 * interface. Because the module is imported into the sandbox, it MUST be:
 *
 *   - **crypto-free** (the sandbox bans `node:crypto`; see ADR-0065). This module imports ONLY from
 *     `@temporalio/common` — no contract module, no `node:crypto`, no minting helper.
 *   - **deterministic** (no `Date.now()` / `Math.random()` / timers; enforced by
 *     `scripts/gates/check_clock_random.ts`). This module performs pure JSON marshalling only.
 *
 * ## The decision: a thin CompositePayloadConverter wrapping the stock JsonPayloadConverter
 *
 * Our Zod contracts are already **wire-clean**: every UUID is `z.string().uuid()` and every datetime is
 * `z.string().datetime()` (an ISO-8601 string), so a `PersistReviewFindingsInputV1` (and every contract
 * reachable through it) is a plain JSON-serializable value graph — no `uuid.UUID` objects, no `Date`
 * objects, no `BigInt`, no `Map`/`Set` to marshal. That is the deliberate divergence from the frozen
 * Python `pydantic_data_converter`, which had to special-case `uuid.UUID` / `datetime` because Python
 * pydantic models carry rich runtime types. On the TS side, `JSON.stringify(input)` round-trips losslessly.
 *
 * Therefore the SDK's stock {@link JsonPayloadConverter} (encoding `json/plain`) is the minimal correct
 * marshalling. Temporal's required `payloadConverter` export must implement the {@link PayloadConverter}
 * interface, whose `toPayload` returns a NON-optional `Payload` (it must throw if it cannot convert),
 * whereas a single {@link JsonPayloadConverter} is a `PayloadConverterWithEncoding` whose `toPayload`
 * returns `Payload | undefined`. The minimal correct adapter from the latter to the former is the SDK's
 * own {@link CompositePayloadConverter}: it tries each wrapped converter in order and throws `ValueError`
 * if none handles the value — exactly the `PayloadConverter` contract. We construct it with the single
 * `JsonPayloadConverter` so the ONLY encoding the skeleton emits/accepts is `json/plain`.
 *
 * ## Stage 1 — `undefined` MUST marshal (void activity results)
 *
 * The Phase-2.0 skeleton's single activity returned `Array<string>`, so the composite wrapped ONLY the
 * `JsonPayloadConverter` (`json/plain`). The Stage-1 review SPINE adds activities that return `void` —
 * `persistReviewWalkthrough` and `releaseWorkspace` (`Promise<void>`), whose result is `undefined`. A
 * `json/plain`-only converter CANNOT marshal `undefined` (its `toPayload` returns `undefined` for an
 * `undefined` value), so the composite throws `ValueError` when an activity completes with no value — which
 * Temporal surfaces as an activity-result-encoding failure and RETRIES the activity (the composition proof
 * surfaced exactly this: `persistReviewWalkthrough` + `cleanup` ran 3× / 2× under their retry budgets
 * before failing). The fix is to prepend the SDK's stock {@link UndefinedPayloadConverter} (encoding
 * `binary/null`) to the composite — the SAME ordering the SDK's own {@link DefaultPayloadConverter} uses —
 * so a void result marshals as `binary/null` and round-trips losslessly back to `undefined`. JSON object
 * shapes still take the `json/plain` branch (the JSON converter is tried second). This is the minimal
 * correct extension; we still do NOT re-export `defaultPayloadConverter` (it additionally handles
 * `Uint8Array` / protobufs the spine never emits) — pinning the explicit two-encoding composite documents
 * the spine's wire surface precisely (`binary/null` for void; `json/plain` for every contract object).
 *
 * ## 2.5 deferral (OUT OF SCOPE for the skeleton)
 *
 * Full **byte-parity** with the Python `pydantic_data_converter` is deferred to the Sprint-2.5 dual-run
 * harness. The known residual quirk is the bare-float serialization gap: Python `model_dump(mode="json")`
 * emits a `confidence` of `1.0` while JS `JSON.stringify` emits `1`. The frozen-Python repo canonicalizer
 * already strips `aggregated.findings[*].confidence` from the canonical diff for exactly this reason (see
 * the headers of `libs/contracts/src/review_findings.v1.ts` and `persist_review_findings.v1.ts`). The
 * skeleton does not attempt to reproduce Python's float spelling on the wire; the dual-run oracle accounts
 * for it at the comparison layer, not the converter layer.
 */

import {
  CompositePayloadConverter,
  JsonPayloadConverter,
  type PayloadConverter,
  UndefinedPayloadConverter,
} from "@temporalio/common";

/**
 * The named export Temporal requires (`payloadConverter`). A {@link CompositePayloadConverter} wrapping the
 * stock {@link UndefinedPayloadConverter} (`binary/null`) THEN the {@link JsonPayloadConverter}
 * (`json/plain`). Order matters: a void activity result (`undefined`) takes the `binary/null` branch; every
 * contract OBJECT is wire-clean plain-JSON (wire-clean Zod contracts; see module header) and takes the
 * `json/plain` branch. This is the SAME `undefined`-then-JSON ordering the SDK's {@link DefaultPayloadConverter}
 * uses. The composite satisfies the {@link PayloadConverter} interface (non-optional `toPayload`, throws if
 * it cannot convert); a future swap to a bespoke per-encoding converter is a drop-in change at this symbol.
 */
export const payloadConverter: PayloadConverter = new CompositePayloadConverter(
  new UndefinedPayloadConverter(),
  new JsonPayloadConverter(),
);
