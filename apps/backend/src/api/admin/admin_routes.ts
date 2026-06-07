// Fastify admin router — port of the codemaster/api/admin/* READ endpoints (operator visibility).
// Each route sits behind the makeRequireRole gate (Stage 5) with the SAME per-route allow-set as the
// frozen Python require_role(...). Registered on an encapsulated scope (@fastify/cookie scoped here) like
// the auth router.
//
// Batch 1 (the tsReady=ready READ endpoints from the admin-read-endpoint survey):
//   GET /api/admin/orgs       — distinct orgs visible to the session (the Reviews org filter)
//   GET /api/admin/dashboard  — operator landing summary (static zero-DB shim, 1:1 with the shipped Python)

import cookie from "@fastify/cookie";
import { type Kysely } from "kysely";
import type { FastifyInstance } from "fastify";

import type { Clock } from "#platform/clock.js";

import {
  AuditSearchResponseV1,
  DashboardSummaryV1,
  FindingListResponseV1,
  FlagListV1,
  IntegrationListPageV1,
  LearningDetailV1,
  LearningListPageV1,
  LlmModelListV1,
  LlmProviderConfigV1,
  LlmPurposeModelListV1,
  NotificationRulesPageV1,
  NotificationRuleV1,
  OrgsListV1,
  PullRequestListResponseV1,
  ReviewsListPageV1,
  TaxonomyGapListV1,
} from "#contracts/admin.v1.js";

import { CursorInvalidError } from "#backend/api/admin/_keyset_cursor.js";
import {
  getLearningWithRevisions,
  getLlmProviderConfig,
  getNotificationRule,
  listFindings,
  listFlags,
  listIntegrationsPage,
  listLearningsPage,
  listLlmModels,
  listLlmPurposeModels,
  listNotificationRules,
  listOrgs,
  listPullRequests,
  listTaxonomyGaps,
  searchReviews,
} from "#backend/api/admin/admin_read_repo.js";
import {
  AUDIT_DEFAULT_PAGE_SIZE,
  AUDIT_MAX_PAGE_SIZE,
  AUDIT_READ_ROLES,
  AuditCrossTenantRefusedError,
  AuditCursorInvalidError,
  AuditWindowTooWideError,
  searchAuditEvents,
} from "#backend/api/admin/audit_events_read.js";
import { makeRequireRole } from "#backend/api/admin/_authz.js";

const TAXONOMY_DEFAULT_LIMIT = 50;
const TAXONOMY_MAX_LIMIT = 200;
const FINDINGS_DEFAULT_LIMIT = 50;
const FINDINGS_MAX_LIMIT = 200;
const PR_DEFAULT_LIMIT = 50;
const PR_MAX_LIMIT = 200;
const REVIEWS_DEFAULT_SIZE = 50;
const REVIEWS_MAX_SIZE = 100;

type AdminQuery = Record<string, unknown>;

/** The common "any signed-in admin" read allow-set (reader through super_admin). */
const READER_ROLES = ["reader", "platform_operator", "platform_owner", "super_admin"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Clamp a ?limit param to [1, max] with a default (the paginated reads). */
function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : fallback;
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(n)));
}

/** Read an optional string query param (undefined/empty → null). */
function optStr(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export type AdminRoutesOptions = {
  db: Kysely<unknown>;
  signingKey: Buffer | Uint8Array;
  clock: Clock;
};

/** The static dashboard summary (1:1 with the shipped Python: _HealthyProbe for the 4 services +
 *  _ZeroMetrics). The real aggregating reader is unbuilt in the Python too. */
export function buildDashboardSummary(now: Date): DashboardSummaryV1 {
  const services = (["api", "workers", "postgres", "bedrock"] as const).map((name) => ({
    name,
    state: "healthy" as const,
    detail: "",
  }));
  return {
    schema_version: 1,
    services,
    reviews_this_hour: 0,
    latency_p95_ms: 0,
    in_flight_reviews: 0,
    last_updated_at: now.toISOString(),
  };
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  opts: AdminRoutesOptions,
): Promise<void> {
  const requireRole = makeRequireRole({ signingKey: opts.signingKey, clock: opts.clock });

  await app.register(async (scope) => {
    await scope.register(cookie);

    scope.get(
      "/api/admin/orgs",
      { preHandler: requireRole(["platform_operator", "platform_owner", "super_admin"]) },
      async (request, reply) => {
        const orgs = await listOrgs(opts.db, request.authPrincipal!.installationId);
        return reply.code(200).send(OrgsListV1.parse({ orgs }));
      },
    );

    scope.get(
      "/api/admin/knowledge",
      { preHandler: requireRole([...READER_ROLES]) },
      async (request, reply) => {
        const q = request.query as AdminQuery;
        const size = clampLimit(q.size, 50, 200);
        try {
          const { rows, nextCursor } = await listLearningsPage(
            opts.db,
            request.authPrincipal!.installationId,
            optStr(q.cursor),
            size,
          );
          return reply.code(200).send(LearningListPageV1.parse({ rows, next_cursor: nextCursor }));
        } catch (e) {
          if (e instanceof CursorInvalidError) {
            return reply.code(400).send({ detail: "invalid cursor" });
          }
          throw e;
        }
      },
    );

    scope.get(
      "/api/admin/knowledge/:learning_id",
      { preHandler: requireRole([...READER_ROLES]) },
      async (request, reply) => {
        const learningId = (request.params as { learning_id: string }).learning_id;
        if (!UUID_RE.test(learningId)) {
          return reply.code(422).send({ detail: "learning_id must be a UUID" });
        }
        const detail = await getLearningWithRevisions(
          opts.db,
          learningId,
          request.authPrincipal!.installationId,
        );
        if (detail === null) {
          return reply.code(404).send({ detail: "learning not found" });
        }
        return reply.code(200).send(LearningDetailV1.parse(detail));
      },
    );

    scope.get(
      "/api/admin/integrations",
      { preHandler: requireRole([...READER_ROLES]) },
      async (request, reply) => {
        const q = request.query as AdminQuery;
        const size = clampLimit(q.size, 50, 200);
        try {
          const { rows, nextCursor } = await listIntegrationsPage(opts.db, optStr(q.cursor), size);
          return reply.code(200).send(IntegrationListPageV1.parse({ rows, next_cursor: nextCursor }));
        } catch (e) {
          if (e instanceof CursorInvalidError) {
            return reply.code(400).send({ detail: "invalid cursor" });
          }
          throw e;
        }
      },
    );

    scope.get(
      "/api/admin/notification-rules",
      { preHandler: requireRole(["super_admin", "platform_owner", "platform_operator"]) },
      async (request, reply) => {
        // Notification rules are platform-scope since migration 0061 — a legacy installation_id param 422s.
        if ((request.query as AdminQuery).installation_id !== undefined) {
          return reply
            .code(422)
            .send({ detail: "installation_id query param removed — notification rules are platform-scope" });
        }
        const rules = await listNotificationRules(opts.db);
        return reply.code(200).send(NotificationRulesPageV1.parse({ rules }));
      },
    );

    scope.get(
      "/api/admin/notification-rules/:rule_id",
      { preHandler: requireRole(["super_admin", "platform_owner", "platform_operator"]) },
      async (request, reply) => {
        const ruleId = (request.params as { rule_id: string }).rule_id;
        if (!UUID_RE.test(ruleId)) {
          return reply.code(422).send({ detail: "rule_id must be a UUID" });
        }
        const rule = await getNotificationRule(opts.db, ruleId);
        if (rule === null) {
          return reply.code(404).send({ detail: `rule ${ruleId} not found` });
        }
        return reply.code(200).send(NotificationRuleV1.parse(rule));
      },
    );

    scope.get(
      "/api/admin/llm-models",
      { preHandler: requireRole([...READER_ROLES]) },
      async (_request, reply) =>
        reply.code(200).send(LlmModelListV1.parse({ models: await listLlmModels(opts.db) })),
    );

    scope.get(
      "/api/admin/llm-purpose-routing",
      { preHandler: requireRole([...READER_ROLES]) },
      async (_request, reply) =>
        reply
          .code(200)
          .send(LlmPurposeModelListV1.parse({ assignments: await listLlmPurposeModels(opts.db) })),
    );

    scope.get(
      "/api/admin/llm-provider-config",
      { preHandler: requireRole([...READER_ROLES]) },
      async (_request, reply) => {
        const config = await getLlmProviderConfig(opts.db);
        if (config === null) {
          return reply
            .code(404)
            .send({ detail: "LLM provider not configured; PUT /api/admin/llm-provider-config to seed." });
        }
        return reply.code(200).send(LlmProviderConfigV1.parse(config));
      },
    );

    scope.get(
      "/api/admin/flags",
      {
        preHandler: requireRole(["reader", "platform_operator", "platform_owner", "super_admin"]),
      },
      async (request, reply) => {
        const flags = await listFlags(opts.db, request.authPrincipal!.installationId);
        return reply.code(200).send(FlagListV1.parse(flags));
      },
    );

    scope.get(
      "/api/admin/taxonomy/gaps",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const limit = clampLimit(
          (request.query as AdminQuery).limit,
          TAXONOMY_DEFAULT_LIMIT,
          TAXONOMY_MAX_LIMIT,
        );
        const rows = await listTaxonomyGaps(opts.db, limit);
        return reply.code(200).send(TaxonomyGapListV1.parse({ rows }));
      },
    );

    scope.get(
      "/api/admin/audit-events",
      { preHandler: requireRole([...AUDIT_READ_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const q = request.query as AdminQuery;
        try {
          const { rows, nextCursor } = await searchAuditEvents(opts.db, {
            role: principal.role,
            callerInstallationId: principal.installationId,
            query: {
              actorUserId: optStr(q.actor),
              action: optStr(q.action),
              targetId: optStr(q.target_id),
              fromAt: optStr(q.from_at),
              toAt: optStr(q.to_at),
              crossTenant: q.cross_tenant === "true" || q.cross_tenant === true,
            },
            cursor: optStr(q.cursor),
            size: clampLimit(q.size, AUDIT_DEFAULT_PAGE_SIZE, AUDIT_MAX_PAGE_SIZE),
            now: opts.clock.now(),
          });
          return reply.code(200).send(AuditSearchResponseV1.parse({ rows, next_cursor: nextCursor }));
        } catch (e) {
          if (e instanceof AuditCrossTenantRefusedError || e instanceof AuditWindowTooWideError) {
            return reply.code(403).send({ detail: e.message });
          }
          if (e instanceof AuditCursorInvalidError) {
            return reply.code(400).send({ detail: e.message });
          }
          throw e;
        }
      },
    );

    scope.get(
      "/api/admin/reviews",
      { preHandler: requireRole(["platform_operator", "platform_owner", "super_admin"]) },
      async (request, reply) => {
        const q = request.query as AdminQuery;
        const page = Math.max(1, Math.floor(Number(q.page ?? 1)) || 1);
        const size = clampLimit(q.size, REVIEWS_DEFAULT_SIZE, REVIEWS_MAX_SIZE);
        const { items, total } = await searchReviews(opts.db, {
          installationId: request.authPrincipal!.installationId,
          repo: optStr(q.repo),
          q: optStr(q.q),
          state: optStr(q.state),
          org: optStr(q.org),
          page,
          size,
        });
        return reply.code(200).send(ReviewsListPageV1.parse({ items, total, page, size }));
      },
    );

    scope.get(
      "/api/admin/pull-requests",
      { preHandler: requireRole(["super_admin", "platform_operator"]) },
      async (request, reply) => {
        const q = request.query as AdminQuery;
        const pageSize = clampLimit(q.limit, PR_DEFAULT_LIMIT, PR_MAX_LIMIT);
        const rows = await listPullRequests(opts.db, {
          installationId: request.authPrincipal!.installationId,
          repositoryId: optStr(q.repository_id),
          state: optStr(q.state),
          openedAfter: optStr(q.opened_after),
          openedBefore: optStr(q.opened_before),
          cursorOpenedAt: optStr(q.cursor_opened_at),
          cursorPrId: optStr(q.cursor_pr_id),
          limit: pageSize + 1,
        });
        const hasMore = rows.length > pageSize;
        const emitted = rows.slice(0, pageSize);
        let nextCursor: Record<string, string> | null = null;
        if (hasMore && emitted.length > 0) {
          const last = emitted[emitted.length - 1]!;
          nextCursor = { cursor_opened_at: last.opened_at, cursor_pr_id: last.pr_id };
        }
        return reply
          .code(200)
          .send(PullRequestListResponseV1.parse({ rows: emitted, next_cursor: nextCursor }));
      },
    );

    scope.get(
      "/api/admin/findings",
      { preHandler: requireRole(["super_admin", "platform_operator"]) },
      async (request, reply) => {
        const q = request.query as AdminQuery;
        const pageSize = clampLimit(q.limit, FINDINGS_DEFAULT_LIMIT, FINDINGS_MAX_LIMIT);
        // Over-fetch one row to detect has-more without a COUNT.
        const rows = await listFindings(opts.db, {
          installationId: request.authPrincipal!.installationId,
          repositoryId: optStr(q.repository_id),
          severity: optStr(q.severity),
          category: optStr(q.category),
          filePathSubstring: optStr(q.file_path_substring),
          createdAfter: optStr(q.created_after),
          createdBefore: optStr(q.created_before),
          cursorCreatedAt: optStr(q.cursor_created_at),
          cursorFindingId: optStr(q.cursor_finding_id),
          limit: pageSize + 1,
        });
        const hasMore = rows.length > pageSize;
        const emitted = rows.slice(0, pageSize);
        let nextCursor: Record<string, string> | null = null;
        if (hasMore && emitted.length > 0) {
          const last = emitted[emitted.length - 1]!;
          nextCursor = {
            cursor_created_at: last.created_at,
            cursor_finding_id: last.review_finding_id,
          };
        }
        return reply
          .code(200)
          .send(FindingListResponseV1.parse({ rows: emitted, next_cursor: nextCursor }));
      },
    );

    scope.get(
      "/api/admin/dashboard",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (_request, reply) =>
        reply.code(200).send(DashboardSummaryV1.parse(buildDashboardSummary(opts.clock.now()))),
    );
  });
}
