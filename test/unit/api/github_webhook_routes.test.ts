// Unit tests for the GitHub webhook route (F1·b — the verification edge). Ports the status-code contract
// of codemaster/api/github_webhook.py::receive_webhook (no-persistence path): header checks → body cap →
// HMAC verify → 204/400/401/413. Persistence (audit + idempotency + run allocator + outbox) is a later slice.

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildApp } from "#backend/api/app.js";
import {
  GITHUB_WEBHOOK_PATH,
  registerGithubWebhookRoutes,
  type WebhookSecretProvider,
} from "#backend/api/github_webhook_routes.js";

const SECRET = new Uint8Array(Buffer.from("test-webhook-secret"));
const provider: WebhookSecretProvider = { currentSecret: async () => SECRET };

function sign(body: Buffer): string {
  return "sha256=" + createHmac("sha256", Buffer.from(SECRET)).update(body).digest("hex");
}

async function makeApp() {
  const app = buildApp({});
  await registerGithubWebhookRoutes(app, { secretProvider: provider });
  await app.ready();
  return app;
}

const BODY = Buffer.from(JSON.stringify({ action: "opened", number: 1 }));
function validHeaders(b: Buffer): Record<string, string> {
  return {
    "x-hub-signature-256": sign(b),
    "x-github-event": "pull_request",
    "x-github-delivery": "deliv-1",
    "content-type": "application/json",
  };
}

describe("POST /v1/github/webhook (verification edge)", () => {
  it("valid signature + headers → 204", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: GITHUB_WEBHOOK_PATH, headers: validHeaders(BODY), payload: BODY });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("invalid signature → 401", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: GITHUB_WEBHOOK_PATH,
      headers: { ...validHeaders(BODY), "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      payload: BODY,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("missing X-Hub-Signature-256 → 401", async () => {
    const app = await makeApp();
    const h = validHeaders(BODY);
    delete h["x-hub-signature-256"];
    const res = await app.inject({ method: "POST", url: GITHUB_WEBHOOK_PATH, headers: h, payload: BODY });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("missing X-GitHub-Event → 400", async () => {
    const app = await makeApp();
    const h = validHeaders(BODY);
    delete h["x-github-event"];
    const res = await app.inject({ method: "POST", url: GITHUB_WEBHOOK_PATH, headers: h, payload: BODY });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("missing X-GitHub-Delivery → 400", async () => {
    const app = await makeApp();
    const h = validHeaders(BODY);
    delete h["x-github-delivery"];
    const res = await app.inject({ method: "POST", url: GITHUB_WEBHOOK_PATH, headers: h, payload: BODY });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("signature is verified over the EXACT raw bytes (not re-serialized JSON)", async () => {
    // A body with non-canonical spacing — if the route re-serialized the JSON, the HMAC would mismatch.
    const app = await makeApp();
    const raw = Buffer.from('{ "action":   "opened" ,  "number": 7 }');
    const res = await app.inject({ method: "POST", url: GITHUB_WEBHOOK_PATH, headers: validHeaders(raw), payload: raw });
    expect(res.statusCode).toBe(204);
    await app.close();
  });
});
