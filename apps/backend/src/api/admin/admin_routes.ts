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
import type { FastifyInstance, FastifyReply } from "fastify";

import type { Clock } from "#platform/clock.js";
import type { KeyRegistry } from "#platform/crypto/key_registry.js";

import {
  AuditSearchResponseV1,
  CostCapChangeRequestV1,
  CostCapPageV1,
  CostCapPendingChangeV1,
  DashboardSummaryV1,
  DefaultCorpusHealthV1,
  EmbedderCoverageV1,
  EmbedderStateV1,
  EmbeddingGenerationV1,
  FindingListResponseV1,
  FlagListV1,
  IntegrationListPageV1,
  LearningDetailV1,
  LearningListPageV1,
  LlmModelListV1,
  LlmModelUpsertV1,
  LlmModelV1,
  LlmProviderConfigV1,
  LlmPurposeAssignmentUpdateV1,
  LlmPurposeModelListV1,
  LlmPurposeModelV1,
  MemberApproverBodyV1,
  MembersPageV1,
  NotificationRuleCreateRequestV1,
  NotificationRuleDryRunResponseV1,
  NotificationRulesPageV1,
  NotificationRuleUpdateRequestV1,
  NotificationRuleV1,
  OrgsListV1,
  ProposalListPageV1,
  PullRequestListResponseV1,
  PutFlagRequestV1,
  PutFlagResponseV1,
  RetrievalAggregatePRListV1,
  RetrievalAggregateV1,
  RepositoryEnableUpdateV1,
  RepositoryV1,
  RetrievalTraceListPageV1,
  ReviewsListPageV1,
  RoleChangePendingV1,
  RoleChangeRequestV1,
  FindingFeedbackResponseV1,
  SubmitFindingFeedbackRequestV1,
  TaxonomyGapListV1,
  TaxonomySuggestionAcceptedV1,
  TaxonomySuggestionV1,
} from "#contracts/admin.v1.js";

import { CursorInvalidError } from "#backend/api/admin/_keyset_cursor.js";
import { CostCapSettingsMissingError, buildCostCapsPage } from "#backend/api/admin/cost_caps_read.js";
import {
  CostCapConcurrentPendingChangeError,
  CostCapInvalidRequestError,
  CostCapPendingChangeNotFoundError,
  CostCapPendingChangeStaleError,
  CostCapSelfApprovalError,
  approveCostCapChange,
  rejectCostCapChange,
  requestCostCapChange,
} from "#backend/api/admin/cost_caps_write.js";
import { buildDefaultCorpusHealth } from "#backend/api/admin/default_corpus_read.js";
import {
  buildEmbedderCoverage,
  buildEmbedderState,
  getGeneration,
} from "#backend/api/admin/embedder_read.js";
import { buildMembersPage } from "#backend/api/admin/members_read.js";
import {
  NotificationRuleNotFoundError,
  type NotificationRulePatch,
  createRule,
  deleteRule,
  recipientSummary,
  ruleAuditPayload,
  updateRule,
} from "#backend/api/admin/notification_rules_write.js";
import {
  MemberConcurrentPendingChangeError,
  MemberExpiredApprovalError,
  MemberRoleChangePendingNotFoundError,
  MemberRoleChangePendingStaleError,
  MemberSelfApprovalError,
  type MemberAuditEmitter,
  approveRoleChange,
  rejectRoleChange,
  requestRoleChange,
} from "#backend/api/admin/members_write.js";
import {
  RetrievalAggregateDataIntegrityError,
  RetrievalAggregateTraceNotFoundError,
  getByReview,
  listByPr,
} from "#backend/api/admin/retrieval_aggregate_read.js";
import {
  BEDROCK_MODELS,
  deleteModel,
  upsertModel,
  upsertPurposeModel,
} from "#backend/api/admin/llm_catalog_write.js";
import { setEnabled } from "#backend/api/admin/repositories_write.js";
import { submitFindingFeedback } from "#backend/api/admin/finding_feedback_write.js";
import {
  FlagNotFoundError,
  FlagStaleWriteError,
  putFlag,
  SelfSecondApproverError,
  TypedConfirmRequiredError,
  typedConfirmPhraseFor,
} from "#backend/api/admin/flags_write.js";
import { deleteIntegration, IntegrationNotFoundError } from "#backend/api/admin/integrations_write.js";
import { insertTaxonomySuggestion } from "#backend/api/admin/taxonomy_write.js";
import {
  getRetrievalTrace,
  listRetrievalTraces,
} from "#backend/api/admin/retrieval_traces_read.js";
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
  listProposalsPage,
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
  /** Field-encryption registry for decrypting core.users.email in the members read. server.ts always
   *  provides it; the field is optional only so endpoint tests that don't exercise members need no crypto. */
  registry?: KeyRegistry;
  /** Optional audit-emit seam for the admin WRITE endpoints (members role-changes). Undefined → no-op
   *  (the TS audit-emit pg-client wiring is dormant — FOLLOW-UP). Mirrors login.ts's audit callback. */
  audit?: MemberAuditEmitter;
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
      "/api/admin/members",
      { preHandler: requireRole(["super_admin", "platform_owner"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const installationId = optStr((request.query as AdminQuery).installation_id);
        if (installationId === null || !UUID_RE.test(installationId)) {
          return reply.code(422).send({ detail: "installation_id must be a UUID" });
        }
        // Tenancy guard: platform_owner is scoped to their session install; super_admin may cross-tenant read.
        if (principal.role !== "super_admin" && installationId !== principal.installationId) {
          return reply.code(403).send({
            detail:
              "platform_owner cannot read members of another installation; super_admin is required for cross-tenant reads",
          });
        }
        if (opts.registry === undefined) {
          throw new Error("members endpoint requires a key registry (server misconfiguration)");
        }
        const page = await buildMembersPage({ db: opts.db, registry: opts.registry, installationId });
        return reply.code(200).send(MembersPageV1.parse(page));
      },
    );

    const MEMBER_MUTATION_ROLES = ["super_admin", "platform_owner"] as const;
    const ROLE_CHANGE_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000; // 7-day TTL (Python _DEFAULT_EXPIRES_IN).

    // Translate the orchestration's typed errors to HTTP (shared by approve + reject).
    function pendingChangeErrorReply(e: unknown, reply: FastifyReply): boolean {
      if (e instanceof MemberRoleChangePendingNotFoundError) {
        void reply.code(404).send({ detail: e.message });
        return true;
      }
      if (e instanceof MemberRoleChangePendingStaleError) {
        void reply.code(409).send({ detail: e.message });
        return true;
      }
      if (e instanceof MemberSelfApprovalError) {
        void reply.code(403).send({ detail: e.message });
        return true;
      }
      if (e instanceof MemberExpiredApprovalError) {
        void reply.code(410).send({ detail: e.message });
        return true;
      }
      return false;
    }

    scope.post(
      "/api/admin/members/:subject_kind/:subject_id/role-changes",
      { preHandler: requireRole([...MEMBER_MUTATION_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const params = request.params as { subject_kind: string; subject_id: string };
        if (params.subject_kind !== "user" && params.subject_kind !== "team") {
          return reply.code(422).send({ detail: "subject_kind must be 'user' or 'team'" });
        }
        if (!UUID_RE.test(params.subject_id)) {
          return reply.code(422).send({ detail: "subject_id must be a UUID" });
        }
        const parsed = RoleChangeRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;
        // Path subject_kind / subject_id MUST agree with the body — reject inconsistency at 400.
        if (body.subject_kind !== params.subject_kind || body.subject_id !== params.subject_id) {
          return reply.code(400).send({ detail: "path subject_kind / subject_id must match the request body" });
        }
        // Platform-scope grants cross every installation; only super_admin may stage them.
        if (body.scope === "platform" && principal.role !== "super_admin") {
          return reply.code(403).send({
            detail: "platform-scope grants require super_admin; platform_owner is scoped to a single installation",
          });
        }
        try {
          const row = await requestRoleChange({
            db: opts.db,
            body,
            installationId: principal.installationId,
            requesterUserId: principal.userId,
            now: opts.clock.now(),
            expiresInMs: ROLE_CHANGE_EXPIRES_MS,
            audit: opts.audit,
          });
          return reply.code(201).send(RoleChangePendingV1.parse(row));
        } catch (e) {
          if (e instanceof MemberConcurrentPendingChangeError) {
            return reply.code(409).send({ detail: { existing_pending_id: e.existingPendingId } });
          }
          throw e;
        }
      },
    );

    scope.post(
      "/api/admin/members/role-changes/:pending_id/approve",
      { preHandler: requireRole([...MEMBER_MUTATION_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const pendingId = (request.params as { pending_id: string }).pending_id;
        if (!UUID_RE.test(pendingId)) {
          return reply.code(422).send({ detail: "pending_id must be a UUID" });
        }
        const parsed = MemberApproverBodyV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        try {
          const row = await approveRoleChange({
            db: opts.db,
            pendingId,
            installationId: principal.installationId,
            approverUserId: parsed.data.approver_user_id,
            now: opts.clock.now(),
            audit: opts.audit,
          });
          return reply.code(200).send(RoleChangePendingV1.parse(row));
        } catch (e) {
          if (pendingChangeErrorReply(e, reply)) return reply;
          throw e;
        }
      },
    );

    scope.post(
      "/api/admin/members/role-changes/:pending_id/reject",
      { preHandler: requireRole([...MEMBER_MUTATION_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const pendingId = (request.params as { pending_id: string }).pending_id;
        if (!UUID_RE.test(pendingId)) {
          return reply.code(422).send({ detail: "pending_id must be a UUID" });
        }
        const parsed = MemberApproverBodyV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        try {
          const row = await rejectRoleChange({
            db: opts.db,
            pendingId,
            installationId: principal.installationId,
            approverUserId: parsed.data.approver_user_id,
            now: opts.clock.now(),
            audit: opts.audit,
          });
          return reply.code(200).send(RoleChangePendingV1.parse(row));
        } catch (e) {
          if (pendingChangeErrorReply(e, reply)) return reply;
          throw e;
        }
      },
    );

    const EMBEDDER_ROLES = ["platform_owner", "super_admin"] as const;

    scope.get(
      "/api/admin/embedder/state",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (_request, reply) =>
        reply.code(200).send(EmbedderStateV1.parse(await buildEmbedderState(opts.db))),
    );

    scope.get(
      "/api/admin/embedder/coverage",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (_request, reply) =>
        reply.code(200).send(EmbedderCoverageV1.parse(await buildEmbedderCoverage(opts.db))),
    );

    scope.get(
      "/api/admin/embedder/reembed/status",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const raw = optStr((request.query as AdminQuery).generation_id);
        // Required int query param (FastAPI 422s on missing / non-int) — mirror with strict int parsing.
        const generationId = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
        if (generationId === null) {
          return reply.code(422).send({ detail: "generation_id must be an integer" });
        }
        const gen = await getGeneration(opts.db, generationId);
        if (gen === null) {
          return reply.code(404).send({
            detail: { error: "generation_not_found", msg: `generation_id=${generationId} does not exist` },
          });
        }
        return reply.code(200).send(EmbeddingGenerationV1.parse(gen));
      },
    );

    scope.get(
      "/api/admin/retrieval-traces",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const q = request.query as AdminQuery;
        const cursor = optStr(q.cursor);
        // cursor is a stringified non-negative integer OFFSET (max 512 chars). Python's int(cursor) would
        // 500 on a non-int; the port returns 422 instead (documented divergence; never a latent crash).
        if (cursor !== null && (cursor.length > 512 || !/^\d+$/.test(cursor))) {
          return reply.code(422).send({ detail: "cursor must be a non-negative integer" });
        }
        const offset = cursor === null ? 0 : Number(cursor);
        const pageSize = clampLimit(q.page_size, 50, 200);
        const starvationOnly = q.starvation_only === "true" || q.starvation_only === "1";
        const { rows, nextCursor } = await listRetrievalTraces(opts.db, {
          offset,
          pageSize,
          starvationOnly,
        });
        return reply.code(200).send(RetrievalTraceListPageV1.parse({ rows, next_cursor: nextCursor }));
      },
    );

    scope.get(
      "/api/admin/retrieval-traces/:trace_id",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const traceId = (request.params as { trace_id: string }).trace_id;
        if (!UUID_RE.test(traceId)) {
          return reply.code(422).send({ detail: "trace_id must be a UUID" });
        }
        const trace = await getRetrievalTrace(opts.db, traceId);
        if (trace === null) {
          return reply.code(404).send({ detail: { code: "trace_not_found", trace_id: traceId } });
        }
        return reply.code(200).send(trace);
      },
    );

    scope.get(
      "/api/admin/retrieval-aggregates/reviews/:review_id",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const reviewId = (request.params as { review_id: string }).review_id;
        if (!UUID_RE.test(reviewId)) {
          return reply.code(422).send({ detail: "review_id must be a UUID" });
        }
        try {
          const agg = await getByReview(opts.db, reviewId);
          return reply.code(200).send(RetrievalAggregateV1.parse(agg));
        } catch (e) {
          if (e instanceof RetrievalAggregateTraceNotFoundError) {
            return reply
              .code(404)
              .send({ detail: { code: "review_traces_not_found", review_id: reviewId } });
          }
          if (e instanceof RetrievalAggregateDataIntegrityError) {
            return reply
              .code(500)
              .send({ detail: { code: "data_integrity_error", kind: e.kind, details: e.details } });
          }
          throw e;
        }
      },
    );

    scope.get(
      "/api/admin/retrieval-aggregates/pull-requests/:pr_id",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const prId = (request.params as { pr_id: string }).pr_id;
        if (!UUID_RE.test(prId)) {
          return reply.code(422).send({ detail: "pr_id must be a UUID" });
        }
        try {
          const page = await listByPr(opts.db, prId);
          return reply.code(200).send(RetrievalAggregatePRListV1.parse(page));
        } catch (e) {
          if (e instanceof RetrievalAggregateTraceNotFoundError) {
            return reply.code(404).send({ detail: { code: "pr_traces_not_found", pr_id: prId } });
          }
          if (e instanceof RetrievalAggregateDataIntegrityError) {
            return reply
              .code(500)
              .send({ detail: { code: "data_integrity_error", kind: e.kind, details: e.details } });
          }
          throw e;
        }
      },
    );

    scope.get(
      "/api/admin/default-corpus/health",
      { preHandler: requireRole(["super_admin", "platform_owner"]) },
      async (_request, reply) =>
        reply
          .code(200)
          .send(DefaultCorpusHealthV1.parse(await buildDefaultCorpusHealth(opts.db, opts.clock.now()))),
    );

    scope.get(
      "/api/admin/cost-caps",
      { preHandler: requireRole(["super_admin", "platform_owner"]) },
      async (_request, reply) => {
        try {
          const page = await buildCostCapsPage(opts.db, opts.clock.now());
          return reply.code(200).send(CostCapPageV1.parse(page));
        } catch (e) {
          if (e instanceof CostCapSettingsMissingError) {
            return reply.code(500).send({ detail: e.message });
          }
          throw e;
        }
      },
    );

    // ── cost-caps WRITE (two-person; super_admin / platform_owner) ──
    const CC_MUTATION_ROLES = ["super_admin", "platform_owner"] as const;

    // approve + reject share this error→HTTP mapping.
    function costCapPendingErrorReply(e: unknown, reply: FastifyReply): boolean {
      if (e instanceof CostCapPendingChangeNotFoundError) {
        void reply.code(404).send({ detail: e.message });
        return true;
      }
      if (e instanceof CostCapPendingChangeStaleError) {
        void reply.code(409).send({ detail: e.message });
        return true;
      }
      if (e instanceof CostCapSelfApprovalError) {
        void reply.code(403).send({ detail: e.message });
        return true;
      }
      if (e instanceof CostCapSettingsMissingError) {
        void reply.code(500).send({ detail: e.message });
        return true;
      }
      return false;
    }

    scope.post(
      "/api/admin/cost-caps/changes",
      { preHandler: requireRole([...CC_MUTATION_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = CostCapChangeRequestV1.safeParse(request.body);
        if (!parsed.success) {
          // new_cap_cents outside [0, HARD_CEILING] etc.
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        try {
          const row = await requestCostCapChange({
            db: opts.db,
            body: parsed.data,
            installationId: principal.installationId,
            requesterUserId: principal.userId,
            now: opts.clock.now(),
            audit: opts.audit,
          });
          return reply.code(202).send(CostCapPendingChangeV1.parse(row)); // 202 ACCEPTED (staged, not applied)
        } catch (e) {
          if (e instanceof CostCapInvalidRequestError) {
            return reply.code(400).send({ detail: e.message });
          }
          if (e instanceof CostCapConcurrentPendingChangeError) {
            return reply.code(409).send({ detail: { existing_pending_change_id: e.existingPendingChangeId } });
          }
          throw e;
        }
      },
    );

    scope.post(
      "/api/admin/cost-caps/changes/:pending_change_id/approve",
      { preHandler: requireRole([...CC_MUTATION_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const id = (request.params as { pending_change_id: string }).pending_change_id;
        if (!UUID_RE.test(id)) {
          return reply.code(422).send({ detail: "pending_change_id must be a UUID" });
        }
        try {
          const row = await approveCostCapChange({
            db: opts.db,
            pendingChangeId: id,
            installationId: principal.installationId,
            approverUserId: principal.userId,
            now: opts.clock.now(),
            audit: opts.audit,
          });
          return reply.code(200).send(CostCapPendingChangeV1.parse(row));
        } catch (e) {
          if (costCapPendingErrorReply(e, reply)) return reply;
          throw e;
        }
      },
    );

    scope.post(
      "/api/admin/cost-caps/changes/:pending_change_id/reject",
      { preHandler: requireRole([...CC_MUTATION_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const id = (request.params as { pending_change_id: string }).pending_change_id;
        if (!UUID_RE.test(id)) {
          return reply.code(422).send({ detail: "pending_change_id must be a UUID" });
        }
        try {
          const row = await rejectCostCapChange({
            db: opts.db,
            pendingChangeId: id,
            installationId: principal.installationId,
            approverUserId: principal.userId,
            now: opts.clock.now(),
            audit: opts.audit,
          });
          return reply.code(200).send(CostCapPendingChangeV1.parse(row));
        } catch (e) {
          if (costCapPendingErrorReply(e, reply)) return reply;
          throw e;
        }
      },
    );

    scope.put(
      "/api/admin/repositories/:github_repo_id/enable",
      { preHandler: requireRole(["super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const raw = (request.params as { github_repo_id: string }).github_repo_id;
        if (!/^\d+$/.test(raw)) {
          return reply.code(422).send({ detail: "github_repo_id must be a positive integer" });
        }
        const githubRepoId = Number(raw);
        const parsed = RepositoryEnableUpdateV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const now = opts.clock.now();
        const { repo, changed } = await setEnabled(opts.db, {
          githubRepoId,
          enabled: parsed.data.enabled,
          now,
        });
        if (repo === null) {
          return reply.code(404).send({
            detail: `repository github_repo_id=${githubRepoId} not found; it must be seen via a webhook before enable applies`,
          });
        }
        if (changed) {
          // The audit's installation_id is the REPO's (tenant-affected), not the actor's session.
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: repo.installation_id,
            action: "repository.enabled.set",
            targetKind: "repository",
            targetId: repo.repository_id,
            before: { enabled: !parsed.data.enabled },
            after: { enabled: parsed.data.enabled },
            now,
          });
        }
        return reply.code(200).send(RepositoryV1.parse(repo));
      },
    );

    // Static path → Fastify matches this before the parametric /api/admin/knowledge/:learning_id below.
    scope.get(
      "/api/admin/knowledge/proposals",
      { preHandler: requireRole([...READER_ROLES]) },
      async (request, reply) => {
        const q = request.query as AdminQuery;
        const size = clampLimit(q.size, 50, 200);
        try {
          const { rows, nextCursor } = await listProposalsPage(
            opts.db,
            request.authPrincipal!.installationId,
            optStr(q.cursor),
            size,
          );
          return reply.code(200).send(ProposalListPageV1.parse({ rows, next_cursor: nextCursor }));
        } catch (e) {
          if (e instanceof CursorInvalidError) {
            return reply.code(400).send({ detail: "invalid cursor" });
          }
          throw e;
        }
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

    scope.delete(
      "/api/admin/integrations/:integration_id",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const integrationId = (request.params as { integration_id: string }).integration_id;
        if (!UUID_RE.test(integrationId)) {
          return reply.code(422).send({ detail: "integration_id must be a uuid" });
        }
        try {
          await deleteIntegration(opts.db, {
            integrationId,
            actorUserId: principal.userId,
            now: opts.clock.now(),
            audit: opts.audit,
          });
          return reply.code(204).send();
        } catch (err) {
          if (err instanceof IntegrationNotFoundError) {
            return reply.code(404).send({ detail: "integration not found" });
          }
          throw err;
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

    // ── notification-rules WRITE (super_admin / platform_owner only) ──
    const NR_MUTATION_ROLES = ["super_admin", "platform_owner"] as const;

    scope.post(
      "/api/admin/notification-rules",
      { preHandler: requireRole([...NR_MUTATION_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = NotificationRuleCreateRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const b = parsed.data;
        const row = await createRule(opts.db, {
          name: b.name,
          triggerEvent: b.trigger_event,
          filters: b.filters,
          recipients: b.recipients,
          scheduleCron: b.schedule_cron,
          now: opts.clock.now(),
        });
        const rule = NotificationRuleV1.parse(row);
        await opts.audit?.({
          actorUserId: principal.userId,
          installationId: principal.installationId,
          action: "notification_rule.created",
          targetKind: "notification_rule",
          targetId: rule.rule_id,
          before: null,
          after: ruleAuditPayload(rule),
          now: opts.clock.now(),
        });
        return reply.code(201).send(rule);
      },
    );

    scope.patch(
      "/api/admin/notification-rules/:rule_id",
      { preHandler: requireRole([...NR_MUTATION_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const ruleId = (request.params as { rule_id: string }).rule_id;
        if (!UUID_RE.test(ruleId)) {
          return reply.code(422).send({ detail: "rule_id must be a UUID" });
        }
        const parsed = NotificationRuleUpdateRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const beforeRow = await getNotificationRule(opts.db, ruleId);
        if (beforeRow === null) {
          return reply.code(404).send({ detail: `rule ${ruleId} not found` });
        }
        // exclude-unset: the update schema has no defaults, so parsed.data holds only the provided keys.
        // updateRule writes only the allowed keys (it ignores schema_version), so pass the parsed body.
        const patch = parsed.data as NotificationRulePatch;
        try {
          const updated = NotificationRuleV1.parse(
            await updateRule(opts.db, ruleId, patch, opts.clock.now()),
          );
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: principal.installationId,
            action: "notification_rule.updated",
            targetKind: "notification_rule",
            targetId: ruleId,
            before: ruleAuditPayload(NotificationRuleV1.parse(beforeRow)),
            after: ruleAuditPayload(updated),
            now: opts.clock.now(),
          });
          return reply.code(200).send(updated);
        } catch (e) {
          if (e instanceof NotificationRuleNotFoundError) {
            return reply.code(404).send({ detail: e.message });
          }
          throw e;
        }
      },
    );

    scope.delete(
      "/api/admin/notification-rules/:rule_id",
      { preHandler: requireRole([...NR_MUTATION_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const ruleId = (request.params as { rule_id: string }).rule_id;
        if (!UUID_RE.test(ruleId)) {
          return reply.code(422).send({ detail: "rule_id must be a UUID" });
        }
        const beforeRow = await getNotificationRule(opts.db, ruleId);
        if (beforeRow === null) {
          return reply.code(404).send({ detail: `rule ${ruleId} not found` });
        }
        const deleted = await deleteRule(opts.db, ruleId);
        if (!deleted) {
          // Concurrent-deletion race — surface as 404 rather than swallowing.
          return reply.code(404).send({ detail: `rule ${ruleId} not found` });
        }
        await opts.audit?.({
          actorUserId: principal.userId,
          installationId: principal.installationId,
          action: "notification_rule.deleted",
          targetKind: "notification_rule",
          targetId: ruleId,
          before: ruleAuditPayload(NotificationRuleV1.parse(beforeRow)),
          after: null,
          now: opts.clock.now(),
        });
        return reply.code(204).send();
      },
    );

    scope.post(
      "/api/admin/notification-rules/:rule_id/dry-run",
      { preHandler: requireRole([...NR_MUTATION_ROLES]) },
      async (request, reply) => {
        const ruleId = (request.params as { rule_id: string }).rule_id;
        if (!UUID_RE.test(ruleId)) {
          return reply.code(422).send({ detail: "rule_id must be a UUID" });
        }
        const row = await getNotificationRule(opts.db, ruleId);
        if (row === null) {
          return reply.code(404).send({ detail: `rule ${ruleId} not found` });
        }
        const rule = NotificationRuleV1.parse(row);
        return reply.code(200).send(
          NotificationRuleDryRunResponseV1.parse({
            would_dispatch_to: rule.recipients.map(recipientSummary),
          }),
        );
      },
    );

    scope.get(
      "/api/admin/llm-models",
      { preHandler: requireRole([...READER_ROLES]) },
      async (_request, reply) =>
        reply.code(200).send(LlmModelListV1.parse({ models: await listLlmModels(opts.db) })),
    );

    scope.put(
      "/api/admin/llm-models",
      { preHandler: requireRole(["super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = LlmModelUpsertV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const b = parsed.data;
        // ADR-0060 guardrail: reject at config time a model the engine can't invoke (provider-agnostic).
        if (!BEDROCK_MODELS.has(b.model_id)) {
          return reply.code(422).send({
            detail: {
              code: "llm_model_not_supported",
              message: `model '${b.model_id}' is not in the engine's accepted set ${JSON.stringify([...BEDROCK_MODELS].sort())}`,
            },
          });
        }
        await upsertModel(opts.db, {
          provider: b.provider,
          modelId: b.model_id,
          displayName: b.display_name,
          enabled: b.enabled,
          createdByUserId: principal.userId,
        });
        // Re-read so the response reflects persisted status (untested on a fresh row — preflight is /test).
        const row = (await listLlmModels(opts.db)).find(
          (m) => m.provider === b.provider && m.model_id === b.model_id,
        );
        if (row === undefined) {
          return reply.code(500).send({ detail: "internal: model upsert succeeded but read returned no row" });
        }
        return reply.code(200).send(LlmModelV1.parse(row));
      },
    );

    scope.delete(
      "/api/admin/llm-models/:provider/:model_id",
      { preHandler: requireRole(["super_admin"]) },
      async (request, reply) => {
        const params = request.params as { provider: string; model_id: string };
        // Dependents check: any purpose routing to this model_id blocks the delete (match model_id only).
        const dependents = (await listLlmPurposeModels(opts.db))
          .filter((m) => m.model_id === params.model_id)
          .map((m) => m.purpose)
          .sort();
        if (dependents.length > 0) {
          return reply.code(409).send({
            detail: { code: "llm_model_in_use", message: `model in use by: ${dependents.join(", ")}`, purposes: dependents },
          });
        }
        const deleted = await deleteModel(opts.db, { provider: params.provider, modelId: params.model_id });
        if (!deleted) {
          return reply.code(404).send({ detail: `no such model: ${params.provider}/${params.model_id}` });
        }
        return reply.code(204).send();
      },
    );

    scope.get(
      "/api/admin/llm-purpose-routing",
      { preHandler: requireRole([...READER_ROLES]) },
      async (_request, reply) =>
        reply
          .code(200)
          .send(LlmPurposeModelListV1.parse({ assignments: await listLlmPurposeModels(opts.db) })),
    );

    scope.put(
      "/api/admin/llm-purpose-routing",
      { preHandler: requireRole(["super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = LlmPurposeAssignmentUpdateV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;
        // ADR-0060 §4 guardrail: a purpose may only be assigned a catalog model that is enabled AND has
        // passed preflight (last_validation_status === 'ok'). Match on model_id only (provider-agnostic).
        const match = (await listLlmModels(opts.db)).find((m) => m.model_id === body.model_id);
        if (match === undefined) {
          return reply.code(422).send({
            detail: { code: "llm_model_not_in_catalog", message: `model '${body.model_id}' not in catalog; add it first` },
          });
        }
        if (!match.enabled) {
          return reply.code(422).send({
            detail: { code: "llm_model_disabled", message: `model '${body.model_id}' is disabled; enable it first` },
          });
        }
        if (match.last_validation_status !== "ok") {
          return reply.code(422).send({
            detail: {
              code: "llm_model_not_validated",
              message: `model '${body.model_id}' has not passed preflight (status=${match.last_validation_status}); run /test first`,
            },
          });
        }
        await upsertPurposeModel(opts.db, {
          purpose: body.purpose,
          modelId: body.model_id,
          updatedByUserId: principal.userId,
        });
        return reply.code(200).send(LlmPurposeModelV1.parse({ purpose: body.purpose, model_id: body.model_id }));
      },
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

    scope.put(
      "/api/admin/flags/:flag_name",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const flagName = (request.params as { flag_name: string }).flag_name;
        const parsed = PutFlagRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        // Optimistic-concurrency token. If-Match is REQUIRED on every PUT (428 if absent) and parsed as an
        // ISO-8601 timestamp (ETag-style surrounding quotes tolerated) — 400 if unparseable. 1:1 with put_route.
        const ifMatchRaw = request.headers["if-match"];
        const ifMatch = Array.isArray(ifMatchRaw) ? ifMatchRaw[0] : ifMatchRaw;
        if (ifMatch === undefined) {
          return reply.code(428).send({ detail: "If-Match header is required (locked-time-iso)" });
        }
        const ifMatchChangedAt = new Date(ifMatch.replace(/^"|"$/g, ""));
        if (Number.isNaN(ifMatchChangedAt.getTime())) {
          return reply.code(400).send({ detail: "If-Match must be an ISO-8601 timestamp" });
        }
        const typedConfirmRaw = request.headers["x-typed-confirm-phrase"];
        const typedConfirm = (Array.isArray(typedConfirmRaw) ? typedConfirmRaw[0] : typedConfirmRaw) ?? null;
        try {
          const result = await putFlag(opts.db, {
            flagName,
            installationId: principal.installationId,
            newValueJson: parsed.data.value_json,
            ifMatchChangedAt,
            actorUserId: principal.userId,
            typedConfirmPhrase: typedConfirm,
            now: opts.clock.now(),
            audit: opts.audit,
          });
          return reply.code(200).send(PutFlagResponseV1.parse(result));
        } catch (err) {
          if (err instanceof FlagNotFoundError) {
            return reply.code(404).send({ detail: "flag not found" });
          }
          if (err instanceof TypedConfirmRequiredError) {
            return reply
              .code(400)
              .send({ detail: { code: "typed_confirm_required", expected_phrase: typedConfirmPhraseFor(flagName) } });
          }
          if (err instanceof SelfSecondApproverError) {
            return reply.code(409).send({ detail: { code: "self_second_approver" } });
          }
          if (err instanceof FlagStaleWriteError) {
            return reply.code(409).send({
              detail: {
                code: "stale_write",
                current_value_json: err.currentValueJson,
                current_changed_at: err.currentChangedAt.toISOString(),
              },
            });
          }
          throw err;
        }
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

    scope.post(
      "/api/admin/taxonomy/suggestions",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = TaxonomySuggestionV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const accepted = await insertTaxonomySuggestion(opts.db, {
          suggestion: parsed.data,
          actorUserId: principal.userId,
          now: opts.clock.now(),
        });
        return reply.code(201).send(TaxonomySuggestionAcceptedV1.parse(accepted));
      },
    );

    scope.post(
      "/api/admin/reviews/:review_id/findings/:finding_id/feedback",
      { preHandler: requireRole(["platform_operator", "platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const { review_id: reviewId, finding_id: findingId } = request.params as {
          review_id: string;
          finding_id: string;
        };
        if (!UUID_RE.test(reviewId) || !UUID_RE.test(findingId)) {
          return reply.code(422).send({ detail: "review_id and finding_id must be UUIDs" });
        }
        const parsed = SubmitFindingFeedbackRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        if (opts.registry === undefined) {
          throw new Error("finding-feedback endpoint requires a key registry (server misconfiguration)");
        }
        const feedbackEventId = await submitFindingFeedback(opts.db, {
          reviewId,
          findingId,
          installationId: principal.installationId,
          verb: parsed.data.verb,
          actorUserId: principal.userId,
          now: opts.clock.now(),
          registry: opts.registry,
          audit: opts.audit,
        });
        if (feedbackEventId === null) {
          return reply.code(404).send({ detail: "finding not found in this tenant" });
        }
        return reply.code(201).send(FindingFeedbackResponseV1.parse({ feedback_event_id: feedbackEventId }));
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
