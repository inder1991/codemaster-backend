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
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { Clock } from "#platform/clock.js";
import type { KeyRegistry } from "#platform/crypto/key_registry.js";

import {
  ActivateGenerationRequestV1,
  AddConfluenceSpaceRequestV1,
  AuditSearchResponseV1,
  BedrockConfigV1,
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
  IntegrationListItemV1,
  IntegrationListPageV1,
  LearningDetailV1,
  LearningListPageV1,
  LegacyBedrockConfigUpdateBodyV1,
  LlmModelListV1,
  LlmModelUpsertV1,
  LlmModelV1,
  LlmConnectionTestResultV1,
  LlmCredentialsTestV1,
  LlmProviderConfigUpdateV1,
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
  PagesListPageV1,
  PatchPlatformCredentialsRequestV1,
  PlatformCredentialsMetaV1,
  ProposalListPageV1,
  QuarantinedChunksPageV1,
  PullRequestListResponseV1,
  PutFlagRequestV1,
  PutFlagResponseV1,
  RejectProposalV1,
  RetrievalModeRequestV1,
  RollbackGenerationRequestV1,
  StaleWriteV1,
  StartReembedRequestV1,
  UpdateLearningBodyV1,
  RetrievalAggregatePRListV1,
  RetrievalAggregateV1,
  RepositoryEnableUpdateV1,
  RepositoryV1,
  RetrievalTraceListPageV1,
  ReviewDetailV1,
  ReviewsListPageV1,
  YourReviewsPageV1,
  RoleChangePendingV1,
  RoleChangeRequestV1,
  FindingFeedbackResponseV1,
  SubmitFindingFeedbackRequestV1,
  TaxonomyGapListV1,
  TestPlatformCredentialsResponseV1,
  TaxonomySuggestionAcceptedV1,
  TaxonomySuggestionV1,
} from "#contracts/admin.v1.js";
import {
  ConfluencePageApprovalV1,
  CreatePageApprovalRequestV1,
} from "#contracts/page_approval.v1.js";

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
import { PostgresEmbeddingGenerationsRepo } from "#backend/domain/repos/embedding_generations_repo.js";
import { PostgresEmbedderRuntimeStateRepo } from "#backend/domain/repos/embedder_runtime_state_repo.js";
import {
  CoverageGapPresentError,
  EmbedderGenerationService,
  EmbeddingDimensionInvariantError,
  GCRetentionNotElapsedError,
  GenerationDataAlreadyCollectedError,
  GenerationNotFoundError,
  InvalidStateTransitionError,
  PendingGenerationInFlightError,
  ValidationNotPassedError,
} from "#backend/domain/services/embedder_generation_service.js";
import {
  activateReembedGeneration,
  cancelReembedGeneration,
  gcReembedGeneration,
  manualRetireReembedGeneration,
  rollbackReembedGeneration,
  setRetrievalMode,
  startReembedGeneration,
  toEmbeddingGenerationV1,
} from "#backend/api/admin/embedder_write.js";
import { buildMembersPage } from "#backend/api/admin/members_read.js";
import type { AdminTemporalPort } from "#backend/api/admin/_admin_temporal_port.js";
import {
  ReviewDetailNotFoundError,
  buildReviewDetail,
} from "#backend/api/admin/reviews_detail_read.js";
import { buildYourReviews } from "#backend/api/admin/reviews_your_read.js";
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
  setValidation,
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
import {
  deleteIntegration,
  insertConfluenceSpace,
  IntegrationDuplicateError,
  IntegrationNotFoundError,
  IntegrationValidationError,
} from "#backend/api/admin/integrations_write.js";
import {
  getSpaceKeyForIntegration,
  listPagesForIntegration,
  listQuarantinedChunksForIntegration,
  IntegrationNotFoundError as ConfluenceIntegrationNotFoundError,
} from "#backend/api/admin/confluence_pages_read.js";
import {
  createPageApproval,
  revokePageApproval,
  type PageResyncDispatcherPort,
} from "#backend/api/admin/confluence_pages_write.js";
import { type GetConfluenceValidator } from "#backend/integrations/confluence/confluence_validator.js";
import { PostgresPlatformCredentialsMetaRepo } from "#backend/api/admin/platform_credentials_repo.js";
import {
  type GetPlatformCredentialProbe,
  type UserEmailResolverPort,
  shimUserEmailResolver,
} from "#backend/api/admin/platform_credentials_probe.js";
import {
  getCredential,
  patchCredential,
  PlatformCredentialError,
  type PlatformCredentialKey,
  type PlatformCredentialsDeps,
  testCredential,
} from "#backend/api/admin/platform_credentials_write.js";
import { type DnsResolver } from "#backend/security/url_validator.js";
import { type VaultPort } from "#backend/adapters/vault_port.js";
import { PostgresLlmProviderSettingsRepo } from "#backend/integrations/llm/llm_provider_settings_repo.js";
import { type GetPreflightValidator } from "#backend/integrations/llm/preflight_validator.js";
import { PLATFORM_SCOPE_AUDIT_INSTALLATION_ID } from "#backend/infra/sentinels.js";
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
import {
  KnowledgeStaleWriteError,
  ProposalAlreadyDecidedError,
  ProposalNotFoundError,
  RejectReasonInvalidError,
  SelfApprovalRefusedError,
  updateLearningBody,
  validateApproveProposal,
  validateRejectProposal,
  workflowIdFor,
} from "#backend/api/admin/knowledge_write.js";

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

/** Coerce a boolean query param the way FastAPI/pydantic-v2 does — absent → false; truthy/falsy token sets
 *  (case-insensitive) → the bool; any other present value → "invalid" (the route 422s). */
function coerceBoolQueryParam(raw: string | undefined): boolean | "invalid" {
  if (raw === undefined) {
    return false;
  }
  const v = raw.toLowerCase();
  if (["true", "1", "yes", "on", "t", "y"].includes(v)) {
    return true;
  }
  if (["false", "0", "no", "off", "f", "n"].includes(v)) {
    return false;
  }
  return "invalid";
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
  /** Vault Transit port for the llm-provider-config credential write (encrypt). Undefined → the
   *  PUT/preflight/test-credentials credential-write routes 503 (unwired at the composition root). */
  vault?: VaultPort;
  /** Injected preflight-validator factory (1:1 with the Python get_preflight_validator). Undefined → the
   *  llm-provider-config credential routes 503. Production wires the real Bedrock/AnthropicDirect SDK
   *  validators; tests inject a stub. */
  getPreflightValidator?: GetPreflightValidator;
  /** Injected Confluence space-validator factory. Undefined → the integrations CREATE route 503. Production
   *  wires the real Confluence v2 adapter (deferred — live-untested surface); tests inject a stub. */
  getConfluenceValidator?: GetConfluenceValidator;
  /** Injected platform-credential probe factory. Undefined → the platform-credentials PATCH/test routes 503.
   *  Real Confluence/Qwen probe adapters deferred; tests inject a stub. */
  getPlatformCredentialProbe?: GetPlatformCredentialProbe;
  /** Resolves an actor user_id → email for the credential-rotation + page-approval audit (P0-1). Defaults to
   *  the shim resolver. */
  userEmailResolver?: UserEmailResolverPort;
  /** Optional Temporal dispatch seam for TriggerPageResyncWorkflow on page-approval revoke. Undefined → the
   *  resync is skipped (the retrieval LEFT JOIN excludes the page's chunks immediately regardless). */
  pageResyncDispatcher?: PageResyncDispatcherPort;
  /** Injected DNS resolver for the SSRF URL validator (platform-credentials base_url). Defaults to node:dns. */
  dnsResolver?: DnsResolver;
  /** Optional Temporal dispatch/signal seam for knowledge-proposal + embedder write endpoints.
   *  Undefined → those endpoints return 503. Mirrors opts.audit. */
  temporal?: AdminTemporalPort;
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

    // The embedder WRITE endpoints (Batch 4) share a single service constructed over the process-wide pool
    // (ADR-0062). The service is the sole authorized writer of embedder lifecycle transitions (spec §5).
    const embedderGensRepo = new PostgresEmbeddingGenerationsRepo({ db: opts.db });
    const embedderStateRepo = new PostgresEmbedderRuntimeStateRepo({ db: opts.db });
    const embedderService = new EmbedderGenerationService({
      gensRepo: embedderGensRepo,
      stateRepo: embedderStateRepo,
    });

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

    // ─── Embedder WRITE lifecycle (Batch 4 — platform_owner / super_admin) ───────────────────────────
    // 1:1 with codemaster/api/admin/embedder.py. The service is the sole authorized writer; the route owns
    // body parse, Temporal dispatch/signal, audit emit, and the wire serialization. Audit target_kind is
    // 'embedder_generation' for every endpoint (retrieval-mode uses target_id='singleton'); installation_id
    // is the actor's session install (mirrors the Python _emit, which passes _require_owner()'s install id).
    const EMBEDDER_GENERATION_ID_BODY = z
      .object({ schema_version: z.literal(1).default(1), generation_id: z.number().int().min(1) })
      .strict();

    scope.post(
      "/api/admin/embedder/retrieval-mode",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = RetrievalModeRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;
        try {
          await setRetrievalMode(embedderService, body, principal.userId);
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: principal.installationId,
            action: "embedder.retrieval_mode.set",
            targetKind: "embedder_generation",
            targetId: "singleton",
            before: null,
            after: { mode: body.mode },
            now: opts.clock.now(),
          });
          return reply.code(200).send(EmbedderStateV1.parse(await buildEmbedderState(opts.db)));
        } catch (e) {
          if (e instanceof CoverageGapPresentError) {
            return reply.code(422).send({ detail: { error: "coverage_gap_present", msg: e.message } });
          }
          throw e;
        }
      },
    );

    scope.post(
      "/api/admin/embedder/reembed/start",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = StartReembedRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;
        try {
          const gen = await startReembedGeneration(embedderService, body, principal.userId);
          // Mirror the service fallback (source = active when caller omits) so the workflow input carries the
          // same value the service persisted; defensive '1' for the unreachable NULL branch.
          const sourceForWorkflow = gen.created_from_generation ?? 1;
          if (opts.temporal) {
            await opts.temporal.dispatchWorkflow({
              workflowType: "ReembedGenerationWorkflow",
              workflowId: `reembed-generation-${gen.generation_id}`,
              taskQueue: "embedder-maintenance",
              input: {
                schema_version: 1,
                generation_id: gen.generation_id,
                target_model_name: body.target_model_name,
                source_generation_id: sourceForWorkflow,
                triggered_by_email: principal.userId,
              },
              idReusePolicy: "REJECT_DUPLICATE",
            });
          }
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: principal.installationId,
            action: "embedder.generation.created",
            targetKind: "embedder_generation",
            targetId: String(gen.generation_id),
            before: null,
            after: {
              generation_id: gen.generation_id,
              target_model_name: body.target_model_name,
              generation_label: body.generation_label,
              generation_reason: body.generation_reason,
              source_generation_id: sourceForWorkflow,
            },
            now: opts.clock.now(),
          });
          return reply.code(200).send(EmbeddingGenerationV1.parse(toEmbeddingGenerationV1(gen)));
        } catch (e) {
          if (e instanceof PendingGenerationInFlightError) {
            return reply.code(409).send({ detail: { error: "pending_generation_in_flight", msg: e.message } });
          }
          if (e instanceof EmbeddingDimensionInvariantError) {
            return reply.code(422).send({ detail: { error: "dimension_mismatch", msg: e.message } });
          }
          throw e;
        }
      },
    );

    scope.post(
      "/api/admin/embedder/reembed/cancel",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = EMBEDDER_GENERATION_ID_BODY.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;
        try {
          const updated = await cancelReembedGeneration(embedderService, body.generation_id, principal.userId);
          // Best-effort cancel signal AFTER persistence — swallow not-found / already-completed.
          if (opts.temporal) {
            try {
              await opts.temporal.signalWorkflow({
                workflowId: `reembed-generation-${body.generation_id}`,
                signalName: "cancel",
              });
            } catch {
              // Workflow may already be terminal + GC'd by Temporal; the DB row already says 'retired'.
            }
          }
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: principal.installationId,
            action: "embedder.generation.cancelled",
            targetKind: "embedder_generation",
            targetId: String(body.generation_id),
            before: null,
            after: { generation_id: body.generation_id, retire_reason: updated.retire_reason },
            now: opts.clock.now(),
          });
          return reply.code(200).send(EmbeddingGenerationV1.parse(toEmbeddingGenerationV1(updated)));
        } catch (e) {
          if (e instanceof GenerationNotFoundError) {
            return reply.code(404).send({ detail: { error: "generation_not_found", msg: e.message } });
          }
          if (e instanceof InvalidStateTransitionError) {
            return reply.code(409).send({ detail: { error: "invalid_state_transition", msg: e.message } });
          }
          throw e;
        }
      },
    );

    scope.post(
      "/api/admin/embedder/reembed/validate",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const bodySchema = z
          .object({
            schema_version: z.literal(1).default(1),
            generation_id: z.number().int().min(1),
            sample_size: z.number().int().min(10).max(1000).nullable().default(null),
          })
          .strict();
        const parsed = bodySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;

        const gen = await getGeneration(opts.db, body.generation_id);
        if (gen === null) {
          return reply.code(404).send({
            detail: { error: "generation_not_found", msg: `generation_id=${body.generation_id} does not exist` },
          });
        }
        if (gen.state !== "backfilling" && gen.state !== "ready") {
          return reply.code(409).send({
            detail: {
              error: "invalid_state_transition",
              msg: `validate: gen ${body.generation_id} state='${gen.state}'; validation only permitted on 'backfilling' or 'ready' generations`,
            },
          });
        }

        // Dispatch AFTER the state-check. Default sample_size from the workflow contract when omitted.
        if (opts.temporal) {
          await opts.temporal.dispatchWorkflow({
            workflowType: "ValidateGenerationWorkflow",
            workflowId: `validate-generation-${body.generation_id}`,
            taskQueue: "embedder-maintenance",
            input:
              body.sample_size === null
                ? { schema_version: 1, generation_id: body.generation_id }
                : { schema_version: 1, generation_id: body.generation_id, sample_size: body.sample_size },
            idReusePolicy: "ALLOW_DUPLICATE",
          });
        }
        await opts.audit?.({
          actorUserId: principal.userId,
          installationId: principal.installationId,
          action: "embedder.generation.validated",
          targetKind: "embedder_generation",
          targetId: String(body.generation_id),
          before: null,
          after: { generation_id: body.generation_id, sample_size: body.sample_size },
          now: opts.clock.now(),
        });
        // Pre-validation snapshot — caller polls /reembed/status for the result.
        return reply.code(200).send(EmbeddingGenerationV1.parse(gen));
      },
    );

    scope.post(
      "/api/admin/embedder/reembed/activate",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = ActivateGenerationRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;
        try {
          await activateReembedGeneration(embedderService, body.generation_id, principal.userId);
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: principal.installationId,
            action: "embedder.generation.activated",
            targetKind: "embedder_generation",
            targetId: String(body.generation_id),
            before: null,
            after: { generation_id: body.generation_id },
            now: opts.clock.now(),
          });
          return reply.code(200).send(EmbedderStateV1.parse(await buildEmbedderState(opts.db)));
        } catch (e) {
          if (e instanceof GenerationNotFoundError) {
            return reply.code(404).send({ detail: { error: "generation_not_found", msg: e.message } });
          }
          if (e instanceof InvalidStateTransitionError) {
            return reply.code(409).send({ detail: { error: "invalid_state_transition", msg: e.message } });
          }
          if (e instanceof GenerationDataAlreadyCollectedError) {
            return reply.code(409).send({ detail: { error: "generation_data_collected", msg: e.message } });
          }
          if (e instanceof ValidationNotPassedError) {
            return reply.code(422).send({ detail: { error: "validation_not_passed", msg: e.message } });
          }
          throw e;
        }
      },
    );

    scope.post(
      "/api/admin/embedder/reembed/rollback",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = RollbackGenerationRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;
        try {
          await rollbackReembedGeneration(embedderService, body.target_generation_id, principal.userId);
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: principal.installationId,
            action: "embedder.generation.rolled_back",
            targetKind: "embedder_generation",
            targetId: String(body.target_generation_id),
            before: null,
            after: { target_generation_id: body.target_generation_id },
            now: opts.clock.now(),
          });
          return reply.code(200).send(EmbedderStateV1.parse(await buildEmbedderState(opts.db)));
        } catch (e) {
          if (e instanceof GenerationNotFoundError) {
            return reply.code(404).send({ detail: { error: "generation_not_found", msg: e.message } });
          }
          if (e instanceof InvalidStateTransitionError) {
            return reply.code(409).send({ detail: { error: "invalid_state_transition", msg: e.message } });
          }
          if (e instanceof GenerationDataAlreadyCollectedError) {
            return reply.code(409).send({ detail: { error: "generation_data_collected", msg: e.message } });
          }
          if (e instanceof ValidationNotPassedError) {
            return reply.code(422).send({ detail: { error: "validation_not_passed", msg: e.message } });
          }
          throw e;
        }
      },
    );

    scope.post(
      "/api/admin/embedder/reembed/manual-retire",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = EMBEDDER_GENERATION_ID_BODY.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;
        try {
          const updated = await manualRetireReembedGeneration(
            embedderService,
            body.generation_id,
            principal.userId,
          );
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: principal.installationId,
            action: "embedder.generation.manual_retired",
            targetKind: "embedder_generation",
            targetId: String(body.generation_id),
            before: null,
            after: { generation_id: body.generation_id, retire_reason: updated.retire_reason },
            now: opts.clock.now(),
          });
          return reply.code(200).send(EmbeddingGenerationV1.parse(toEmbeddingGenerationV1(updated)));
        } catch (e) {
          if (e instanceof GenerationNotFoundError) {
            return reply.code(404).send({ detail: { error: "generation_not_found", msg: e.message } });
          }
          if (e instanceof InvalidStateTransitionError) {
            return reply.code(409).send({ detail: { error: "invalid_state_transition", msg: e.message } });
          }
          throw e;
        }
      },
    );

    scope.post(
      "/api/admin/embedder/reembed/gc",
      { preHandler: requireRole([...EMBEDDER_ROLES]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = EMBEDDER_GENERATION_ID_BODY.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;
        try {
          const updated = await gcReembedGeneration(
            embedderService,
            body.generation_id,
            principal.userId,
            opts.clock.now(),
          );
          // Dispatch the GC workflow ONLY after a successful service.gc() (which set gc_started_at).
          if (opts.temporal) {
            await opts.temporal.dispatchWorkflow({
              workflowType: "GarbageCollectGenerationWorkflow",
              workflowId: `gc-generation-${body.generation_id}`,
              taskQueue: "embedder-maintenance",
              input: { schema_version: 1, generation_id: body.generation_id },
              idReusePolicy: "ALLOW_DUPLICATE",
            });
          }
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: principal.installationId,
            action: "embedder.generation.gc_started",
            targetKind: "embedder_generation",
            targetId: String(body.generation_id),
            before: null,
            after: { generation_id: body.generation_id },
            now: opts.clock.now(),
          });
          return reply.code(200).send(EmbeddingGenerationV1.parse(toEmbeddingGenerationV1(updated)));
        } catch (e) {
          if (e instanceof GenerationNotFoundError) {
            return reply.code(404).send({ detail: { error: "generation_not_found", msg: e.message } });
          }
          if (e instanceof InvalidStateTransitionError) {
            return reply.code(409).send({ detail: { error: "invalid_state_transition", msg: e.message } });
          }
          if (e instanceof GCRetentionNotElapsedError) {
            // IMPORTANT: do NOT dispatch the workflow on this failure (gc_started_at was never written).
            return reply.code(409).send({ detail: { error: "gc_retention_not_elapsed", msg: e.message } });
          }
          throw e;
        }
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

    // PUT /api/admin/knowledge/{learning_id} — optimistic-concurrency body edit (If-Match on version).
    // 1:1 with knowledge.py put_route: 428 missing If-Match, 400 unparseable, 422 bad body, 409 stale.
    scope.put(
      "/api/admin/knowledge/:learning_id",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const learningId = (request.params as { learning_id: string }).learning_id;
        if (!UUID_RE.test(learningId)) {
          return reply.code(422).send({ detail: "learning_id must be a UUID" });
        }

        const ifMatch = request.headers["if-match"];
        if (ifMatch === undefined) {
          return reply.code(428).send({ detail: "If-Match header is required" });
        }
        const ifMatchVersion = Number.parseInt(
          (Array.isArray(ifMatch) ? (ifMatch[0] ?? "") : ifMatch).replace(/^"(.*)"$/, "$1"),
          10,
        );
        if (!Number.isInteger(ifMatchVersion)) {
          return reply.code(400).send({ detail: "If-Match must be an integer version" });
        }

        const body = UpdateLearningBodyV1.safeParse(request.body);
        if (!body.success) {
          return reply.code(422).send(body.error);
        }

        const installationId = request.authPrincipal!.installationId;
        try {
          await updateLearningBody(opts.db, {
            learningId,
            installationId,
            newBodyMarkdown: body.data.body_markdown,
            ifMatchVersion,
            editedByUserId: request.authPrincipal!.userId,
            now: opts.clock.now(),
          });
        } catch (err) {
          if (err instanceof KnowledgeStaleWriteError) {
            return reply.code(409).send(
              StaleWriteV1.parse({
                code: "stale_write",
                current_body: err.current_body,
                current_version: err.current_version,
              }),
            );
          }
          throw err;
        }

        // Re-read the learning + recent revisions for the detail response (same shape as the GET route).
        const detail = await getLearningWithRevisions(opts.db, learningId, installationId);
        if (detail === null) {
          return reply.code(404).send({ detail: "learning not found" });
        }
        return reply.code(200).send(LearningDetailV1.parse(detail));
      },
    );

    // POST /api/admin/knowledge/proposals/{proposal_id}/approve — signal KnowledgeApprovalWorkflow.
    // 503 when the Temporal seam is unwired; 403 self-approval; 404 unknown; 409 already-decided.
    scope.post(
      "/api/admin/knowledge/proposals/:proposal_id/approve",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const proposalId = (request.params as { proposal_id: string }).proposal_id;
        if (!UUID_RE.test(proposalId)) {
          return reply.code(422).send({ detail: "proposal_id must be a UUID" });
        }
        if (opts.temporal === undefined) {
          return reply.code(503).send({ detail: "approval signal seam unwired" });
        }

        const approverUserId = request.authPrincipal!.userId;
        try {
          await validateApproveProposal(opts.db, {
            proposalId,
            installationId: request.authPrincipal!.installationId,
            approverUserId,
          });
        } catch (err) {
          if (err instanceof ProposalNotFoundError) {
            return reply.code(404).send({ detail: "proposal not found" });
          }
          if (err instanceof SelfApprovalRefusedError) {
            return reply.code(403).send({ detail: err.message });
          }
          if (err instanceof ProposalAlreadyDecidedError) {
            return reply.code(409).send({ code: "already_decided", current_state: err.current_state });
          }
          throw err;
        }

        await opts.temporal.signalWorkflow({
          workflowId: workflowIdFor(proposalId),
          signalName: "approve",
          input: { approver_user_id: approverUserId },
        });
        return reply.code(204).send();
      },
    );

    // POST /api/admin/knowledge/proposals/{proposal_id}/reject — signal with a bounded reason.
    // 503 when the Temporal seam is unwired; 422 bad reason; 404 unknown; 409 already-decided.
    scope.post(
      "/api/admin/knowledge/proposals/:proposal_id/reject",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const proposalId = (request.params as { proposal_id: string }).proposal_id;
        if (!UUID_RE.test(proposalId)) {
          return reply.code(422).send({ detail: "proposal_id must be a UUID" });
        }
        if (opts.temporal === undefined) {
          return reply.code(503).send({ detail: "approval signal seam unwired" });
        }

        const body = RejectProposalV1.safeParse(request.body);
        if (!body.success) {
          return reply.code(422).send(body.error);
        }

        const approverUserId = request.authPrincipal!.userId;
        const reason = body.data.reason.trim();
        try {
          await validateRejectProposal(opts.db, {
            proposalId,
            installationId: request.authPrincipal!.installationId,
            reason,
          });
        } catch (err) {
          if (err instanceof ProposalNotFoundError) {
            return reply.code(404).send({ detail: "proposal not found" });
          }
          if (err instanceof RejectReasonInvalidError) {
            return reply.code(422).send({ detail: "reason must be 10–2048 characters" });
          }
          if (err instanceof ProposalAlreadyDecidedError) {
            return reply.code(409).send({ code: "already_decided", current_state: err.current_state });
          }
          throw err;
        }

        await opts.temporal.signalWorkflow({
          workflowId: workflowIdFor(proposalId),
          signalName: "reject",
          input: { approver_user_id: approverUserId, reason },
        });
        return reply.code(204).send();
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

    // POST /integrations/confluence-spaces — register a Confluence space. 1:1 with add_confluence_space.
    // platform_owner+. dedup → validate (injected Confluence validator) → INSERT → audit. 201 on success.
    scope.post(
      "/api/admin/integrations/confluence-spaces",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = AddConfluenceSpaceRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        if (opts.getConfluenceValidator === undefined) {
          return reply.code(503).send({ detail: "confluence validator unwired" });
        }
        const body = parsed.data;
        try {
          const item = await insertConfluenceSpace(opts.db, {
            spaceKey: body.space_key,
            spaceName: body.space_name,
            scope: body.scope,
            pageTreeRootId: body.page_tree_root_id,
            trustTier: body.trust_tier,
            governanceAck: body.governance_ack,
            visibility: body.visibility,
            strictLabelMode: body.strict_label_mode,
            actorUserId: principal.userId,
            now: opts.clock.now(),
            validator: opts.getConfluenceValidator(),
            audit: opts.audit,
          });
          return reply.code(201).send(IntegrationListItemV1.parse(item));
        } catch (err) {
          if (err instanceof IntegrationDuplicateError) {
            return reply.code(409).send({ detail: { code: "duplicate", space_key: body.space_key } });
          }
          if (err instanceof IntegrationValidationError) {
            if (err.code === "rate_limited") {
              // Retry-After header + 503 (1:1 with the Python rate-limit branch).
              return reply
                .code(503)
                .header("Retry-After", "60")
                .send({ detail: { code: "rate_limited", detail: err.validationDetail } });
            }
            // auth_error | not_found | validation_failed → 422 with the nested {code, detail} body.
            return reply.code(422).send({ detail: { code: err.code, detail: err.validationDetail } });
          }
          throw err;
        }
      },
    );

    // ─── Confluence pages (per-space page list + approval lifecycle + quarantined chunks) ────────────
    // 1:1 with codemaster/api/admin/page_approvals.py + quarantined_chunks.py. platform_owner / super_admin.
    // The page-approval POST/DELETE and the quarantined-chunks GET emit NO audit action (the Python routers
    // are audit-exempt — mirrored here). // audit-test-exempt

    // GET /pages — list pages with approval status. Paginated (offset cursor + page_size). 404 on unknown
    // integration_id.
    scope.get(
      "/api/admin/integrations/confluence-spaces/:integration_id/pages",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const integrationId = (request.params as { integration_id: string }).integration_id;
        const q = request.query as AdminQuery;
        const cursor = optStr(q.cursor);
        const pageSize = clampLimit(q.page_size, 50, 200);
        try {
          const page = await listPagesForIntegration(opts.db, integrationId, { cursor, pageSize });
          return reply.code(200).send(PagesListPageV1.parse(page));
        } catch (err) {
          if (err instanceof ConfluenceIntegrationNotFoundError) {
            return reply.code(404).send({
              detail: { code: "integration_not_found", integration_id: integrationId },
            });
          }
          throw err;
        }
      },
    );

    // POST /pages/{page_id}/approval — create/upsert approval. Derives actor email from session (audit P0-1).
    // F-72: cross-checks body.space_key against the URL integration's space_key. 201 on success.
    scope.post(
      "/api/admin/integrations/confluence-spaces/:integration_id/pages/:page_id/approval",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const integrationId = (request.params as { integration_id: string }).integration_id;
        const parsed = CreatePageApprovalRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        const body = parsed.data;
        const emailResolver = opts.userEmailResolver ?? shimUserEmailResolver;
        try {
          // F-72 (P2): the URL integration's space_key is the source of truth — a body whose space_key
          // names a DIFFERENT integration is rejected (pre-fix the body silently won).
          const urlSpaceKey = await getSpaceKeyForIntegration(opts.db, integrationId);
          if (body.space_key !== urlSpaceKey) {
            return reply.code(400).send({
              detail: {
                code: "url_body_mismatch",
                detail: `body.space_key '${body.space_key}' != URL integration space_key '${urlSpaceKey}'`,
              },
            });
          }
          const approvalId = await createPageApproval(opts.db, body, {
            actorUserId: principal.userId,
            emailResolver,
          });
          // Reconstruct the response from the request + the freshly-minted id + the resolved actor email.
          const actorEmail = await emailResolver.resolveEmail(principal.userId);
          const response = ConfluencePageApprovalV1.parse({
            approval_id: approvalId,
            space_key: body.space_key,
            page_id: body.page_id,
            approver_email: actorEmail,
            approved_at_utc: body.approved_at_utc,
            approval_artifact_url: body.approval_artifact_url,
            scope_justification: body.scope_justification,
            default_scope: body.default_scope,
            revoked_at: null,
            revoked_by: null,
            created_at: body.approved_at_utc,
            updated_at: body.approved_at_utc,
          });
          return reply.code(201).send(response);
        } catch (err) {
          if (err instanceof ConfluenceIntegrationNotFoundError) {
            return reply.code(404).send({
              detail: { code: "integration_not_found", integration_id: integrationId },
            });
          }
          throw err;
        }
      },
    );

    // DELETE /pages/{page_id}/approval — revoke approval. Derives revoked_by email from session (audit P0-1).
    // 204 on success; 404 when no active approval exists. F-26: space_key derived from the URL integration.
    scope.delete(
      "/api/admin/integrations/confluence-spaces/:integration_id/pages/:page_id/approval",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const integrationId = (request.params as { integration_id: string }).integration_id;
        const pageId = (request.params as { page_id: string }).page_id;
        try {
          const spaceKey = await getSpaceKeyForIntegration(opts.db, integrationId);
          const ok = await revokePageApproval(opts.db, {
            spaceKey,
            pageId,
            actorUserId: principal.userId,
            emailResolver: opts.userEmailResolver ?? shimUserEmailResolver,
            ...(opts.pageResyncDispatcher ? { resyncDispatcher: opts.pageResyncDispatcher } : {}),
            onWarn: (e) => request.log.warn(e, "trigger_page_resync_enqueue_failed"),
          });
          if (!ok) {
            return reply.code(404).send({
              detail: { code: "approval_not_found", space_key: spaceKey, page_id: pageId },
            });
          }
          return reply.code(204).send();
        } catch (err) {
          if (err instanceof ConfluenceIntegrationNotFoundError) {
            return reply.code(404).send({
              detail: { code: "integration_not_found", integration_id: integrationId },
            });
          }
          throw err;
        }
      },
    );

    // GET /quarantined-chunks — list quarantined chunks. Paginated (offset cursor + page_size). 404 on
    // unknown integration_id.
    scope.get(
      "/api/admin/integrations/confluence-spaces/:integration_id/quarantined-chunks",
      { preHandler: requireRole(["platform_owner", "super_admin"]) },
      async (request, reply) => {
        const integrationId = (request.params as { integration_id: string }).integration_id;
        const q = request.query as AdminQuery;
        const cursor = optStr(q.cursor);
        const pageSize = clampLimit(q.page_size, 50, 200);
        try {
          const page = await listQuarantinedChunksForIntegration(opts.db, integrationId, {
            cursor,
            pageSize,
          });
          return reply.code(200).send(QuarantinedChunksPageV1.parse(page));
        } catch (err) {
          if (err instanceof ConfluenceIntegrationNotFoundError) {
            return reply.code(404).send({
              detail: { code: "integration_not_found", integration_id: integrationId },
            });
          }
          throw err;
        }
      },
    );

    // ─── Platform credentials (Vault KV-backed: confluence + embedder/qwen) ────────────────────────
    // 1:1 with platform_credentials.py. platform_owner+. GET (meta only — never the secret) / PATCH
    // (probe-first-then-write, ?force=true override) / POST /test (probe the existing Vault credential).
    // 503 when the vault/probe seam is unwired at the composition root.
    const PLATFORM_CRED_ROUTES: ReadonlyArray<{ key: PlatformCredentialKey; segment: string }> = [
      { key: "confluence", segment: "confluence" },
      { key: "embedder.qwen", segment: "embedder/qwen" },
    ];
    for (const { key, segment } of PLATFORM_CRED_ROUTES) {
      const base = `/api/admin/platform-credentials/${segment}`;
      scope.get(base, { preHandler: requireRole(["platform_owner", "super_admin"]) }, async (_request, reply) => {
        if (opts.vault === undefined) {
          return reply.code(503).send({ detail: "platform-credentials not configured (vault unwired)" });
        }
        const meta = await getCredential(
          { vault: opts.vault, metaRepo: new PostgresPlatformCredentialsMetaRepo(opts.db) },
          key,
        );
        return reply.code(200).send(PlatformCredentialsMetaV1.parse(meta));
      });

      scope.patch(base, { preHandler: requireRole(["platform_owner", "super_admin"]) }, async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = PatchPlatformCredentialsRequestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        // FastAPI parses the `force: bool` query param before the handler — a non-boolean token 422s.
        const force = coerceBoolQueryParam((request.query as { force?: string }).force);
        if (force === "invalid") {
          return reply.code(422).send({ detail: "force query param must be a boolean" });
        }
        if (opts.vault === undefined || opts.getPlatformCredentialProbe === undefined) {
          return reply.code(503).send({ detail: "platform-credentials write not configured (vault + probe unwired)" });
        }
        const deps: PlatformCredentialsDeps = {
          db: opts.db,
          vault: opts.vault,
          probe: opts.getPlatformCredentialProbe(),
          metaRepo: new PostgresPlatformCredentialsMetaRepo(opts.db),
          userEmailResolver: opts.userEmailResolver ?? shimUserEmailResolver,
          clock: opts.clock,
          audit: opts.audit,
          ...(opts.dnsResolver ? { dnsResolver: opts.dnsResolver } : {}),
        };
        try {
          const meta = await patchCredential(deps, key, parsed.data, principal.userId, force);
          return reply.code(200).send(PlatformCredentialsMetaV1.parse(meta));
        } catch (err) {
          if (err instanceof PlatformCredentialError) {
            return reply.code(422).send({ error: err.errorCode, msg: err.msg });
          }
          throw err;
        }
      });

      scope.post(`${base}/test`, { preHandler: requireRole(["platform_owner", "super_admin"]) }, async (_request, reply) => {
        if (opts.vault === undefined || opts.getPlatformCredentialProbe === undefined) {
          return reply.code(503).send({ detail: "platform-credentials probe not configured" });
        }
        try {
          const res = await testCredential(
            {
              vault: opts.vault,
              probe: opts.getPlatformCredentialProbe(),
              metaRepo: new PostgresPlatformCredentialsMetaRepo(opts.db),
              clock: opts.clock,
            },
            key,
          );
          return reply.code(200).send(TestPlatformCredentialsResponseV1.parse(res));
        } catch (err) {
          if (err instanceof PlatformCredentialError) {
            return reply.code(422).send({ error: err.errorCode, msg: err.msg });
          }
          throw err;
        }
      });
    }

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

    // POST /llm-models/{provider}/{model_id}/test — per-model credential ping. 1:1 with llm_models_router.py
    // test_model. super_admin only. Reads DECRYPTED provider creds → validate(model_id) → persist the catalog
    // row's validation status. Returns 200 {ok,message} in every non-auth case (no-creds, ping-ok/fail);
    // 503 when the vault/validator seam is unwired (TS credential-route convention).
    scope.post(
      "/api/admin/llm-models/:provider/:model_id/test",
      { preHandler: requireRole(["super_admin"]) },
      async (request, reply) => {
        const params = request.params as { provider: string; model_id: string };
        if (opts.vault === undefined || opts.getPreflightValidator === undefined) {
          return reply.code(503).send({ detail: "llm-models preflight not configured (vault + preflight validator unwired)" });
        }
        const noCreds = (provider: string) =>
          reply.code(200).send(
            LlmConnectionTestResultV1.parse({
              ok: false,
              message: `no enabled credentials configured for provider ${provider}; configure /admin/llm-provider-config first`,
            }),
          );
        // Provider-narrowing guard: an unknown provider has no settings row (CHECK-constrained column) →
        // the faithful no-creds outcome, AND it avoids getPreflightValidator throwing on an unknown provider.
        if (params.provider !== "bedrock" && params.provider !== "anthropic_direct") {
          return noCreds(params.provider);
        }
        const repo = new PostgresLlmProviderSettingsRepo({ db: opts.db, vault: opts.vault, clock: opts.clock });
        const creds = await repo.readDecryptedForProvider(params.provider);
        if (creds === null) {
          return noCreds(params.provider);
        }
        const result = await opts
          .getPreflightValidator(params.provider)
          .validate({ apiKey: creds.apiKey, modelId: params.model_id, region: creds.region });
        // Persist the probe outcome on the catalog row (bare UPDATE — no-ops on an unregistered model_id).
        await setValidation(opts.db, {
          provider: params.provider,
          modelId: params.model_id,
          status: result.ok ? "ok" : "failed",
          error: result.errorMessage,
          validatedAt: opts.clock.now(),
        });
        return reply.code(200).send(LlmConnectionTestResultV1.parse({ ok: result.ok, message: result.errorMessage || "validated" }));
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

    // PUT /llm-provider-config — rotate platform LLM credentials. super_admin only. 1:1 with
    // llm_provider_config.py put_route: preflight (skipped when disabling) → Vault-Transit-encrypted UPSERT
    // → dual rotation-audit (post-write seam) → re-read metadata. The credential routes 503 when the vault /
    // validator seam is unwired at the composition root (server.ts does not yet inject them).
    scope.put(
      "/api/admin/llm-provider-config",
      { preHandler: requireRole(["super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = LlmProviderConfigUpdateV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        if (opts.vault === undefined || opts.getPreflightValidator === undefined) {
          return reply
            .code(503)
            .send({ detail: "llm-provider-config write not configured (vault + preflight validator unwired)" });
        }
        const body = parsed.data;
        // Skip preflight when disabling — the intent is to halt traffic, not validate the token.
        if (body.enabled) {
          const result = await opts
            .getPreflightValidator(body.provider)
            .validate({ apiKey: body.api_key, modelId: body.model_id, region: body.region });
          if (!result.ok) {
            return reply.code(400).send({
              detail: { code: "llm_provider_preflight_failed", message: result.errorMessage || "preflight failed" },
            });
          }
        }
        const rotatedAt = opts.clock.now();
        const repo = new PostgresLlmProviderSettingsRepo({ db: opts.db, vault: opts.vault, clock: opts.clock });
        await repo.writeSettings({
          role: body.role,
          provider: body.provider,
          apiKeyPlaintext: body.api_key,
          modelId: body.model_id,
          region: body.region,
          enabled: body.enabled,
          validatedAt: rotatedAt,
          validationStatus: "ok",
          rotatedAt,
          rotatedByUserId: principal.userId,
        });
        // Dual rotation audit (legacy + new action strings) via the post-write seam (the Python emits these
        // in-transaction; the TS audit seam is post-action — see writeSettings divergence note).
        const after = {
          provider: body.provider,
          role: body.role,
          model_id: body.model_id,
          region: body.region,
          enabled: body.enabled,
          rotated_at: rotatedAt.toISOString(),
          validation_status: "ok",
        };
        for (const [action, targetKind] of [
          ["bedrock_credential.rotated", "bedrock_credential"],
          ["llm_provider_credential.rotated", "llm_provider_credential"],
        ] as const) {
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: PLATFORM_SCOPE_AUDIT_INSTALLATION_ID,
            action,
            targetKind,
            targetId: "global",
            before: null,
            after,
            now: rotatedAt,
          });
        }
        // Re-read the PRIMARY slot unconditionally — 1:1 with Python read_metadata_for_ui() (no role arg →
        // defaults role='primary'; docstring "Return the primary slot's metadata"). So a role='secondary'
        // PUT returns the primary slot's body (a Python latent quirk), and 500s when no primary row exists.
        const meta = await getLlmProviderConfig(opts.db);
        if (meta === null) {
          return reply.code(500).send({ detail: "internal: write succeeded but read returned no row" });
        }
        return reply.code(200).send(LlmProviderConfigV1.parse(meta));
      },
    );

    // POST /llm-provider-config/preflight — run preflight WITHOUT writing (the save-path re-runs it). 200
    // regardless of outcome; the UI shows {ok, message} inline. super_admin only.
    scope.post(
      "/api/admin/llm-provider-config/preflight",
      { preHandler: requireRole(["super_admin"]) },
      async (request, reply) => {
        const parsed = LlmProviderConfigUpdateV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        if (opts.getPreflightValidator === undefined) {
          return reply.code(503).send({ detail: "preflight validator unwired" });
        }
        const body = parsed.data;
        const result = await opts
          .getPreflightValidator(body.provider)
          .validate({ apiKey: body.api_key, modelId: body.model_id, region: body.region });
        return reply.code(200).send(LlmConnectionTestResultV1.parse({ ok: result.ok, message: result.errorMessage || "ok" }));
      },
    );

    // POST /llm-provider-config/test-credentials — model-LESS connection check (ADR-0060). super_admin only.
    scope.post(
      "/api/admin/llm-provider-config/test-credentials",
      { preHandler: requireRole(["super_admin"]) },
      async (request, reply) => {
        const parsed = LlmCredentialsTestV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        if (opts.getPreflightValidator === undefined) {
          return reply.code(503).send({ detail: "preflight validator unwired" });
        }
        const body = parsed.data;
        const result = await opts
          .getPreflightValidator(body.provider)
          .validateCredentials({ apiKey: body.api_key, region: body.region });
        return reply.code(200).send(LlmConnectionTestResultV1.parse({ ok: result.ok, message: result.errorMessage || "ok" }));
      },
    );

    // ─── Legacy bedrock-config GET/PUT — DEPRECATED compat shim over the llm-provider-config machinery,
    // hardcoding provider='bedrock', role='primary'. 1:1 with bedrock_config.py. Migrate callers to
    // /api/admin/llm-provider-config.
    scope.get(
      "/api/admin/bedrock-config",
      { preHandler: requireRole([...READER_ROLES]) },
      async (_request, reply) => {
        const config = await getLlmProviderConfig(opts.db);
        if (config === null) {
          return reply.code(404).send({ detail: "Bedrock not configured; PUT /api/admin/bedrock-config to seed." });
        }
        return reply.code(200).send(BedrockConfigV1.parse(config));
      },
    );

    scope.put(
      "/api/admin/bedrock-config",
      { preHandler: requireRole(["super_admin"]) },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const parsed = LegacyBedrockConfigUpdateBodyV1.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(422).send({ detail: "request body failed schema validation" });
        }
        if (opts.vault === undefined || opts.getPreflightValidator === undefined) {
          return reply.code(503).send({ detail: "bedrock-config write not configured (vault + preflight validator unwired)" });
        }
        request.log.warn(
          { rule: "bedrock-config-deprecated", installation_id: principal.installationId },
          "DEPRECATED: PUT /api/admin/bedrock-config is a compat shim; migrate callers to PUT /api/admin/llm-provider-config",
        );
        const body = parsed.data;
        if (body.enabled) {
          const result = await opts
            .getPreflightValidator("bedrock")
            .validate({ apiKey: body.api_key, modelId: body.model_id, region: body.region });
          if (!result.ok) {
            // DIVERGENCE from the canonical route: the legacy code is `bedrock_preflight_failed` (Python :219).
            return reply.code(400).send({
              detail: { code: "bedrock_preflight_failed", message: result.errorMessage || "preflight failed" },
            });
          }
        }
        const rotatedAt = opts.clock.now();
        const repo = new PostgresLlmProviderSettingsRepo({ db: opts.db, vault: opts.vault, clock: opts.clock });
        await repo.writeSettings({
          role: "primary",
          provider: "bedrock",
          apiKeyPlaintext: body.api_key,
          modelId: body.model_id,
          region: body.region,
          enabled: body.enabled,
          validatedAt: rotatedAt,
          validationStatus: "ok",
          rotatedAt,
          rotatedByUserId: principal.userId,
        });
        const after = {
          provider: "bedrock",
          role: "primary",
          model_id: body.model_id,
          region: body.region,
          enabled: body.enabled,
          rotated_at: rotatedAt.toISOString(),
          validation_status: "ok",
        };
        for (const [action, targetKind] of [
          ["bedrock_credential.rotated", "bedrock_credential"],
          ["llm_provider_credential.rotated", "llm_provider_credential"],
        ] as const) {
          await opts.audit?.({
            actorUserId: principal.userId,
            installationId: PLATFORM_SCOPE_AUDIT_INSTALLATION_ID,
            action,
            targetKind,
            targetId: "global",
            before: null,
            after,
            now: rotatedAt,
          });
        }
        const meta = await getLlmProviderConfig(opts.db, "primary");
        if (meta === null) {
          return reply.code(500).send({ detail: "internal: write succeeded but read returned no row" });
        }
        return reply.code(200).send(BedrockConfigV1.parse(meta));
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
      "/api/admin/reviews/:review_id",
      { preHandler: requireRole(["platform_operator", "platform_owner", "super_admin"]) },
      async (request, reply) => {
        const reviewId = (request.params as { review_id: string }).review_id;
        if (!UUID_RE.test(reviewId)) {
          return reply.code(422).send({ detail: "review_id must be a UUID" });
        }
        try {
          const detail = await buildReviewDetail(opts.db, {
            installationId: request.authPrincipal!.installationId,
            reviewId,
          });
          return reply.code(200).send(ReviewDetailV1.parse(detail));
        } catch (e) {
          if (e instanceof ReviewDetailNotFoundError) {
            return reply.code(404).send({ detail: e.message });
          }
          throw e;
        }
      },
    );

    scope.get(
      "/api/admin/your-reviews",
      {
        preHandler: requireRole([
          "reader",
          "platform_operator",
          "platform_owner",
          "super_admin",
          "security_auditor",
        ]),
      },
      async (request, reply) => {
        const principal = request.authPrincipal!;
        const { authored, assigned } = await buildYourReviews(opts.db, {
          installationId: principal.installationId,
          userId: principal.userId,
        });
        return reply
          .code(200)
          .send(YourReviewsPageV1.parse({ authored, assigned, user_id: principal.userId }));
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
