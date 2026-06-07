// GitHub webhook ROUTE (F1·b) — the Fastify port of the FastAPI router in
// vendor/codemaster-py/codemaster/api/github_webhook.py::build_router (the receive_webhook endpoint).
//
// This is the "verification edge" slice: header validation → body-size cap → HMAC verification → status
// code. PERSISTENCE (audit.webhook_events + cache.cache_idempotency dedup + the SERIAL+SUPERSEDE run
// allocator + outbox emission) is a SUBSEQUENT slice — it threads a session_factory + clock through here.
//
// Raw body: GitHub signs the EXACT bytes it sends, so the route must HMAC over the raw request body, not a
// re-serialized JSON parse. We register the route inside an encapsulated Fastify scope that removes the
// inherited content-type parsers and captures every content-type as a raw Buffer — so the rest of the app
// keeps its normal JSON parsing.

import type { FastifyInstance } from "fastify";

import { verifyGithubSignature } from "./github_webhook.js";

/** Path constants — 1:1 with the frozen Python (GITHUB_WEBHOOK_PREFIX + GITHUB_WEBHOOK_ROUTE). */
export const GITHUB_WEBHOOK_PREFIX = "/v1/github";
export const GITHUB_WEBHOOK_ROUTE = "/webhook";
export const GITHUB_WEBHOOK_PATH = `${GITHUB_WEBHOOK_PREFIX}${GITHUB_WEBHOOK_ROUTE}`;
/** 10 MB — Python WEBHOOK_BODY_CAP_BYTES. */
export const WEBHOOK_BODY_CAP_BYTES = 10 * 1024 * 1024;

/**
 * The webhook-secret source (Python `WebhookSecretProvider` Protocol). `currentSecret()` reads the secret
 * fresh on every call (the Vault-backed impl does no in-process caching, so rotations take effect
 * immediately). Returns the raw secret bytes (Python `bytes`).
 */
export type WebhookSecretProvider = { currentSecret(): Promise<Uint8Array> };

/**
 * Persistence seam (the W3 wiring). When provided, it runs on EVERY verified-or-not delivery (forensics-
 * first: the audit row is written even for a spoofed signature), BEFORE the 401. Omitted in
 * verification-edge unit tests (no DB); server.ts wires the real {@link persistWebhook} bound to a pool.
 */
export type WebhookPersist = (args: {
  body: Uint8Array;
  headers: Record<string, string>;
  signatureValid: boolean;
}) => Promise<unknown>;

export type GithubWebhookRoutesOptions = {
  secretProvider: WebhookSecretProvider;
  persist?: WebhookPersist;
};

/** Coerce a Fastify header value to a non-empty string, or null. */
function headerStr(value: string | Array<string> | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Register `POST /v1/github/webhook` onto `app`. Encapsulated in its own scope so the raw-body
 * content-type parser does not leak to other routes (auth/admin keep JSON parsing).
 */
export async function registerGithubWebhookRoutes(
  app: FastifyInstance,
  opts: GithubWebhookRoutesOptions,
): Promise<void> {
  await app.register(async (scope) => {
    // Capture the EXACT bytes for HMAC: drop the inherited parsers, treat every content-type as a Buffer.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
      done(null, body);
    });

    scope.post(
      GITHUB_WEBHOOK_PATH,
      // Allow slightly above the cap so the route itself enforces the exact 10 MB boundary + message
      // (matching the Python `len(body) > cap` check) before Fastify's hard ceiling rejects.
      { bodyLimit: WEBHOOK_BODY_CAP_BYTES + 1024 },
      async (request, reply) => {
        const signature = headerStr(request.headers["x-hub-signature-256"]);
        const event = headerStr(request.headers["x-github-event"]);
        const delivery = headerStr(request.headers["x-github-delivery"]);

        if (signature === null) {
          return reply.code(401).send({ detail: "missing X-Hub-Signature-256" });
        }
        if (event === null) {
          return reply.code(400).send({ detail: "missing X-GitHub-Event" });
        }
        if (delivery === null) {
          return reply.code(400).send({ detail: "missing X-GitHub-Delivery" });
        }

        const body = (request.body ?? Buffer.alloc(0)) as Buffer;
        if (body.length > WEBHOOK_BODY_CAP_BYTES) {
          return reply.code(413).send({ detail: `body exceeds ${WEBHOOK_BODY_CAP_BYTES}-byte cap` });
        }

        const secret = await opts.secretProvider.currentSecret();
        const valid = verifyGithubSignature({ body: new Uint8Array(body), header: signature, secret });

        // Persist BEFORE the 401 (forensics-first — the audit row is written even for a spoofed delivery;
        // persistWebhook skips the idempotency + enqueue when signatureValid=false). Persist errors
        // propagate to Fastify's 500 (GitHub redelivers).
        if (opts.persist !== undefined) {
          await opts.persist({
            body: new Uint8Array(body),
            headers: { "x-github-delivery": delivery, "x-github-event": event },
            signatureValid: valid,
          });
        }

        if (!valid) {
          return reply.code(401).send({ detail: "invalid signature" });
        }
        return reply.code(204).send();
      },
    );
  });
}
